/**
 * Copyright 2022-Present Prescient Devices, Inc.
 **/

/* jshint laxbreak: true */
/* jshint esversion: 8 */
/* jshint -W030 */
/* jshint -W121 */
/* jshint forin: false */

// const fs = require("fs")
//const stream = require("stream")

const globalIsInTest =
  ["true", "1"].includes((process.env["__FILEINPUT_TEST__"] || "").toLowerCase()) ||
  typeof global.it === "function"
const globalFailMode = globalIsInTest
  ? process.env["__FILEINPUT_TEST_FAIL_MODE__"] || ""
  : ""
module.exports = function (RED) {
  function errorMsg(arg1, arg2) {
    return globalIsInTest ? arg1 : RED._(arg1, arg2)
  }
  // Object.create(null) here and for the three maps below it. All four are keyed
  // by ids that reach the runtime from the browser, and on a plain object
  // "__proto__" is not a key at all: writing it runs the inherited accessor and
  // moves the map's prototype, and reading it hands back Object.prototype, which
  // every truthiness guard in this file would take for a live entry. No pollution
  // is reachable today - a node id has to resolve to a deployed fileinput node
  // before it is used as a key, and the one wire-supplied key that is not an id
  // (a message's streamId, read by the backpressure node) survives only because
  // comparing a number against the undefined it finds on Object.prototype happens
  // to be false - which is far too thin a reason for it to hold. Nothing reads
  // these maps by a dotted property name or calls hasOwnProperty() on them, so
  // having no prototype costs them nothing.
  let globalHash = Object.create(null)
  // node id -> true while a wire message is waiting for the editor user to
  // choose a file. The cancel route reads it so a cancel can only ever clear a
  // request that is genuinely armed, rather than let any editor session wipe the
  // primed message of a node that was never prompted.
  let globalArmed = Object.create(null)
  // How long an armed request lives with the editor not acting on it. The editor
  // holds the other half of this handshake and it can simply vanish: the tab is
  // closed or reloaded while the request is parked, and nothing would ever
  // arrive to clear it. Without a bound the node would show "waiting" for the
  // life of the flow and keep the wire message primed, so a much later and
  // entirely unrelated upload would merge that stale message's properties into
  // its output.
  const globalArmTimeoutMs = 10 * 60 * 1000
  // How long a metadata POST's claim on a node may sit with no data request
  // having arrived to adopt it. Past this the handshake is treated as abandoned
  // rather than as an upload in progress; see liveClaim() below. Deliberately
  // far longer than the sub-second gap a direct browser connection needs: an
  // intermediary that buffers the request body before forwarding it - nginx does
  // by default - can leave a genuine upload without a dataOwner for minutes, and
  // discarding a live claim would let two bodies cross into one stream. Erring
  // long only delays the reaping of an abandoned handshake. Overridable in test
  // only, alongside the other __FILEINPUT_TEST_* knobs: what the reap itself does
  // is worth asserting, and five minutes is not a wait a test can sit through.
  const globalClaimTtlMs =
    (globalIsInTest && Number(process.env["__FILEINPUT_TEST_CLAIM_TTL_MS__"])) ||
    5 * 60 * 1000
  let globalStreamSeq = 0
  // streamId -> { resume }. A streaming upload with backpressure enabled parks
  // its resume handle here so a downstream fileinput-backpressure node can
  // release the next chunk once the current one has been consumed.
  let globalStreamControls = Object.create(null)
  // streamId -> { committedIndex }. How many fixed-size blocks the receiver has
  // durably acknowledged, tracked by the fileinput-backpressure node from each
  // ack. A replayed/retried upload (see the data-path notes below) reuses this to
  // fast-forward past the blocks already delivered and resume from committedIndex,
  // instead of re-sending the whole file and crossing streams.
  let globalStreamProgress = Object.create(null)
  // Fixed streaming block size. Framing the upload into fixed-size blocks makes
  // block N always the same bytes ([N*FIXED, (N+1)*FIXED)) regardless of how the
  // HTTP body is split across `data` events, so a replay can resume by block index.
  const globalStreamBlock = 64 * 1024
  // How long an upload waits for a chunk acknowledgement before it gives up
  // (e.g. the fileinput-backpressure node is missing or its consumer stalled).
  const globalBpTimeoutMs = 30 * 1000
  // Bound on a caller-supplied value written into a log line.
  const globalLogValueMaxLen = 120
  // Everything a caller controls goes through here before it reaches a log line.
  // A request header is whatever the caller chose to put in it, and both readers
  // of the runtime log act on control characters: a terminal treats several of
  // them as a line break or as the start of an escape sequence, so a caller could
  // forge log entries around the warning it triggered, and an unbounded header
  // would be copied into the line whole. This is the same refusal to echo caller
  // input verbatim that keeps the abort route from naming the streamId it was
  // handed; there the value is simply left out, here the line says nothing
  // without it. req.params.id is deliberately not run through this: it reaches a
  // log line only once it has resolved to a deployed fileinput node, which no
  // string of the caller's choosing does.
  function safeLogValue(arg) {
    const raw = String(arg === null || arg === undefined ? "" : arg)
    // The whole of C0 including tab, plus DEL and the C1 range. A value carrying
    // any of them has nothing to say that their removal loses. Matched by code
    // point rather than written as a literal character class, as safeLabel() in
    // the editor script is for the same reason: these characters are invisible in
    // a source file. Iterating by code point also keeps the truncation below from
    // halving a surrogate pair and emitting a lone surrogate into the log.
    const chars = []
    for (const ch of raw) {
      const code = ch.codePointAt(0)
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
        continue
      }
      chars.push(ch)
    }
    const text =
      chars.length > globalLogValueMaxLen
        ? `${chars.slice(0, globalLogValueMaxLen).join("")}...`
        : chars.join("")
    if (!text) {
      // Nothing was sent, or nothing survived. "?" is what these lines already
      // show for a value that is not available, where an empty interpolation
      // reads as a field the log itself failed to fill in.
      return "?"
    }
    return text
  }
  // The single reader of globalHash for every guard that asks "is an upload
  // actually running on this node". A claim is created by the metadata POST and
  // adopted by the data POST that follows; between the two it has no dataOwner
  // and no socket behind it. If that data POST never arrives - the tab was
  // closed, the metadata response was lost, or a caller simply stopped - the
  // claim would otherwise stand for the life of the flow, and every guard that
  // reads it would go on believing an upload was draining: further uploads
  // rejected as overlapping, the cancel route refusing every dismissal, and the
  // node's own expiry timer skipping its cleanup so the primed wire message was
  // never dropped. Reap the abandoned claim here instead, so all three readers
  // agree on what "live" means.
  function liveClaim(id) {
    const claim = globalHash[id]
    if (!claim) {
      return null
    }
    if (claim.dataOwner || Date.now() - (claim.createdAt || 0) <= globalClaimTtlMs) {
      return claim
    }
    globalHash[id] = null
    if (claim.streamId) {
      delete globalStreamProgress[claim.streamId]
    }
    // The node is still showing whatever the claim just reaped last put there -
    // the progress badge its metadata POST raised, or the waiting badge of the
    // request that armed it - and nothing else would take that down until the arm
    // timer fires, up to ten minutes later. Nothing is in flight on this node any
    // more, so show nothing. Only the badge is touched: the editor's notification
    // for the same request may still be on screen, and an upload the user starts
    // from it must still carry the properties of the wire message that armed it,
    // which reporting an error here would drop. Reaping is lazy - it happens on
    // the next read of the claim rather than on a timer - so this lands exactly
    // when something asks about the claim, which is when the stale badge is about
    // to be contradicted anyway.
    const node = RED.nodes.getNode(id)
    if (node) {
      node.status({})
    }
    return null
  }
  // Drop a claim and everything hanging off it. Callers must first have
  // established that no data request owns it: releasing a claim out from under a
  // live socket leaves that request pumping into state nothing points at any
  // more, which is the failure the dataOwner tests before each call site guard
  // against.
  function dropClaim(id, claim) {
    if (claim.streamId) {
      delete globalStreamControls[claim.streamId]
      delete globalStreamProgress[claim.streamId]
    }
    globalHash[id] = null
  }
  // The editor calls this when an upload it started is over without a file
  // having reached the node: the data POST was refused, the connection never
  // opened, or it timed out in the browser. Only the editor can report that. A
  // request rejected before this route runs - the permission check above, an
  // expired token, a proxy - is never seen by the runtime at all, so nothing
  // here knows the upload ended and the claim its metadata POST created stands
  // for the whole of globalClaimTtlMs. Inside that window every retry is refused
  // as an overlapping upload and every dismissal was refused too, which is how
  // one failed upload came to read as a node that had stopped working.
  RED.httpAdmin.post(
    "/node-red-contrib-fileinput/abort/:id",
    RED.auth.needsPermission("node-red-contrib-fileinput.write"),
    function (req, res) {
      const node = RED.nodes.getNode(req.params.id)
      // As on every route here: the id comes from the browser, so confirm it
      // names a fileinput node before acting on it. This one injects a message.
      if (!node || node.type !== "fileinput") {
        return res.sendStatus(404)
      }
      const claim = liveClaim(req.params.id)
      if (!claim) {
        // Nothing to release: the upload never claimed the node, or it failed
        // late enough that the runtime saw its socket go and released it there.
        // The editor calls this on every failure without being able to tell
        // those apart, so answer plainly rather than make it interpret an error.
        return res.sendStatus(200)
      }
      // Which claim the caller means. Its data POST may fail as much as half an
      // hour after the metadata POST that made the claim, while the claim itself
      // is reaped after globalClaimTtlMs, so a late abort can arrive to find a
      // claim another editor session has since created for this same node.
      // Releasing that one fails an upload doing nothing wrong and injects an
      // error into its flow. Release only what the caller actually named. An
      // editor too old to name anything keeps the original behaviour on purpose:
      // a cached editor tab outlives a runtime upgrade. Anything other than the
      // exact string handed out simply fails to match, which declines to release
      // rather than releasing the wrong thing.
      const streamId = req.query && req.query.streamId
      if (streamId && streamId !== claim.streamId) {
        // 200, the same answer as for a claim that is already gone, because from
        // this caller's side that is what happened - its claim was reaped or
        // dismissed and what stands now is not its own. The editor calls this
        // only after it has already told the user the upload failed, so an error
        // status would be a second report of one failure, and one it must not
        // act on: retrying it is asking to release someone else's upload. The
        // log line is the only trace a 200 leaves that the race happened. The
        // caller's id is deliberately not echoed into it - it is unvalidated
        // input and this string reaches the log verbatim.
        node.warn(
          `fileinput: ignored editor abort on node ${req.params.id}; the upload ` +
            `it names no longer holds the node - upload ${claim.streamId} does`
        )
        return res.sendStatus(200)
      }
      if (claim.dataOwner) {
        // A data request owns this claim, so bytes are moving on a socket that
        // releases the claim itself when it ends. Releasing it here would pull
        // the state out from under a live upload - including a resume in
        // progress - so refuse, and say so in the log: an editor that reports an
        // upload dead while the runtime is still receiving its body is worth
        // seeing.
        node.warn(
          `fileinput: refused editor abort on node ${req.params.id}; upload ` +
            `${claim.streamId} is owned by an active data request`
        )
        return res.status(409).json({
          error: "upload in progress",
          code: "upload_in_progress",
        })
      }
      dropClaim(req.params.id, claim)
      // The node is showing progress for a file that is not coming, and the
      // input message that armed it is still primed to be merged into a later
      // upload. Report it exactly as a severed upload is reported, so the flow
      // learns the file never arrived instead of the node sitting on a stale
      // badge until the arm timeout clears it.
      node.receive({
        __msgSrc: "editor",
        status: "error",
        error: "Upload aborted by the editor",
      })
      return res.sendStatus(200)
    }
  )
  // The editor calls this when the user dismisses the notification raised by a
  // wire message. Without it the node would keep showing that it is waiting for
  // a file the user has already declined to choose.
  RED.httpAdmin.post(
    "/node-red-contrib-fileinput/cancel/:id",
    RED.auth.needsPermission("node-red-contrib-fileinput.write"),
    function (req, res) {
      const node = RED.nodes.getNode(req.params.id)
      // The id comes from the browser, so confirm it names a fileinput node
      // before injecting anything: every other node type must be unreachable
      // through this route.
      if (!node || node.type !== "fileinput") {
        return res.sendStatus(404)
      }
      const claim = liveClaim(req.params.id)
      if (claim && claim.dataOwner) {
        // An upload is genuinely draining for this node, so the armed request
        // has been answered. Clearing the primed wire message now would strip
        // its properties from the remaining chunks only, leaving a downstream
        // consumer with one stream arriving in two different shapes.
        return res.status(409).json({
          error: "upload in progress",
          code: "upload_in_progress",
        })
      }
      if (claim) {
        // A claim with no data request behind it is a handshake, not an upload:
        // the metadata POST landed and no body ever arrived to adopt it, so not
        // one chunk has yet carried the primed message's properties and a
        // dismissal cannot leave a stream in two shapes - the whole of what the
        // refusal above exists to prevent. Refusing here as well is what made
        // Dismiss do nothing at all for five minutes after a data POST was
        // rejected, which is precisely the state the user needs it in. The user
        // has said no file is coming: take the dead handshake with the request,
        // so the next upload is accepted instead of being refused as
        // overlapping.
        //
        // The cost, deliberately accepted: a body-less claim is not always dead.
        // Behind a request-buffering proxy a genuine upload can sit without a
        // dataOwner for minutes - the case globalClaimTtlMs was lengthened for -
        // so a dismissal from another editor session can drop it. Dismiss being
        // inert for five minutes after every rejected upload is the worse of the
        // two failures.
        dropClaim(req.params.id, claim)
      } else if (!globalArmed[req.params.id]) {
        // Nothing armed and no claim standing: nothing is waiting on this node,
        // so there is nothing to cancel.
        return res.status(409).json({ error: "no armed request", code: "not_armed" })
      }
      node.receive({ __msgSrc: "editor", status: "cancelled" })
      return res.sendStatus(200)
    }
  )
  RED.httpAdmin.post(
    "/node-red-contrib-fileinput/file/:id",
    RED.auth.needsPermission("node-red-contrib-fileinput.write"),
    async function (req, res) {
      // Scoped to this one request, despite sitting among the module-level
      // global* state above; naming it as such is what let a read-after-null slip
      // through below.
      let requestError
      function procError(error, desc) {
        if (!requestError) {
          requestError = error || desc
          res.sendStatus(500).end()
        }
      }
      let node = RED.nodes.getNode(req.params.id)
      // The id comes from the browser and this route calls node.receive() on
      // whatever it resolves to, with a payload the caller supplies. Without this
      // check any deployed node is reachable: `streaming` is read from the
      // TARGET's config, so a non-fileinput node always takes the non-streaming
      // branch and is simply handed the bytes as msg.payload - against an exec
      // node that is command execution. The node type is the boundary, so it is
      // tested here, before anything at all is done with the node: the branch
      // below injects a message too, and every node inside a subflow instance
      // reaches it (see the config lookup).
      if (!node || node.type !== "fileinput") {
        // Deleting rather than nulling: a caller naming ids that resolve to
        // nothing would otherwise add a key to this map on every request.
        delete globalHash[req.params.id]
        return res.sendStatus(404)
      }
      // A subflow instance's runtime node is given a freshly generated id when it
      // is instantiated and never appears in the stored flow config, so looking
      // the config up by the runtime id misses and every upload from inside a
      // subflow 404s. _alias names the template node the config actually lives
      // on, and the template's stream/backpressure/datatype values are the ones
      // every instance runs with.
      const configId = node._alias || req.params.id
      // eachNode has no early-exit contract, so this walks every node and keeps
      // the match rather than pretending to break out of the iteration.
      let config = null
      RED.nodes.eachNode(function (item) {
        if (item.id === configId) {
          config = item
        }
      })
      if (!config || globalFailMode === "NO-NODE") {
        delete globalHash[req.params.id]
        // requestError is still undefined here - nothing has run that could set
        // it - so a fallback is needed: the consumer stringifies this field, and
        // handing it undefined threw before the status could be set, leaving the
        // node showing whatever badge it had before.
        node.receive({
          __msgSrc: "editor",
          status: "error",
          error: requestError || "Node configuration not found",
        })
        return res.sendStatus(404)
      }
      // "yes"/"no" are legacy (pre-checkbox) values; the checkbox stores a Boolean
      const streaming = config.stream === true || config.stream === "yes"
      const backpressure =
        streaming && (config.backpressure === true || config.backpressure === "yes")
      // Backpressure watchdog: armed whenever the socket is paused waiting for a
      // downstream acknowledgement, cleared when the ack (or an end/error) lands.
      let bpTimer = null
      function clearBpTimer() {
        if (bpTimer) {
          clearTimeout(bpTimer)
          bpTimer = null
        }
      }
      function cleanupBp() {
        clearBpTimer()
        const meta = globalHash[req.params.id]
        if (meta && meta.streamId) {
          delete globalStreamControls[meta.streamId]
        }
      }
      function armBpTimer(streamId) {
        clearBpTimer()
        bpTimer = setTimeout(function () {
          // No downstream node acknowledged the last chunk; abort so the request
          // and node status do not hang indefinitely.
          delete globalStreamControls[streamId]
          // The committed-index progress goes with it, the same narrowing of
          // adopt-and-resume that releaseClaimOnAbort() makes and for the same
          // reason: this path reports the upload failed, which clears the primed
          // wire message, so blocks sent before the timeout carried its properties
          // and blocks a resume sent afterwards would not. Left behind, the entry
          // is unreachable - a streamId is issued once - and never reclaimed.
          delete globalStreamProgress[streamId]
          procError(
            new Error("Backpressure acknowledgement timeout"),
            "Backpressure timeout"
          )
          globalHash[req.params.id] = null
          try {
            req.destroy()
          } catch (_) {}
          node.receive({
            __msgSrc: "editor",
            status: "error",
            error: "Backpressure acknowledgement timeout",
          })
        }, globalBpTimeoutMs)
      }
      try {
        if (globalFailMode === "GENERAL") {
          throw new Error("Test error (general)")
        }
        if (req.body) {
          if (req.body.hasOwnProperty("filename") && req.body.hasOwnProperty("size")) {
            if (globalFailMode === "METADATA") {
              throw new Error("Test error (metadata)")
            }
            // Concurrency guard: only one streaming upload may be in flight per
            // fileinput node. A second metadata POST would clobber this node's
            // streamId/index, crossing the two streams so the receiver appends
            // both and the file grows past its declared size. Reject the
            // overlapping POST instead of overwriting live state. liveClaim()
            // reaps an abandoned handshake rather than counting it as an upload.
            const inFlight = liveClaim(req.params.id)
            if (inFlight && inFlight.streamId) {
              // Report what is actually known about the upload being protected.
              // A chunk index only means anything when this node is streaming -
              // it is fixed at 0 otherwise, and there is no stream to be in
              // flight - and whether a body has arrived at all is the part that
              // tells a live upload apart from a handshake nothing ever came
              // back for, which is the case a reader of this line most needs to
              // recognise.
              const framing = streaming
                ? `streaming, chunk index ${inFlight.index}`
                : "buffered, not chunked"
              const body = inFlight.dataOwner
                ? "receiving the file"
                : "no file data received yet"
              node.warn(
                `fileinput: rejected overlapping upload on node ${req.params.id}; ` +
                  `upload ${inFlight.streamId} still in flight (${framing}; ${body})`
              )
              return res.status(409).json({
                error: "upload already in progress",
                streamId: inFlight.streamId,
              })
            }
            node.receive({
              __msgSrc: "editor",
              status: "start",
              filename: req.body.filename,
            })
            let size = Math.max(1, req.body.size)
            // Prefix the streamId with the node id so a second fileinput node's
            // streams can never collide with this one's in shared module state.
            const streamSuffix =
              Date.now().toString(36) + (globalStreamSeq++).toString(36)
            const streamId = `${req.params.id}-${streamSuffix}`
            globalHash[req.params.id] = {
              size,
              per: 0,
              streamId,
              index: 0,
              createdAt: Date.now(),
            }
            // Name the claim this handshake just created, so the caller can say
            // which one it means when it later reports the upload dead. Without
            // a name the abort route can only release whatever stands for the
            // node, and by then that may be a different session's upload - see
            // the correlation check there. The same value already appears in
            // this route's own 409 body, so a caller holding write scope learns
            // nothing here it could not already read.
            return res.status(200).json({ streamId })
          }
          // --- data-body request (the file bytes) ---
          // One upload is TWO requests: the metadata POST above (which created
          // globalHash[nodeId] with the streamId + index) and this data POST. A
          // proxy or the browser can REPLAY the data body WITHOUT re-posting
          // metadata (e.g. a load balancer re-issuing the upload as a second request,
          // or a connection-reuse retry). That replay reuses the live
          // globalHash[nodeId] — continuing the shared index and streamId while
          // restarting its own byte counter — so two streams cross into the
          // receiver and the file grows past its real size. The metadata guard
          // above cannot see it (the replay never posts metadata). Guard the DATA
          // path directly: the first data request claims the node's stream; a
          // second concurrent data request is rejected instead of sharing state.
          const reqNonce = `${Date.now().toString(36)}${(globalStreamSeq++).toString(
            36
          )}`
          // Both are headers, so both are the caller's own text and neither may
          // reach the log lines below as it arrived; see safeLogValue(), which
          // also supplies the "?" these two used to default to.
          const reqSrc = safeLogValue(
            req.headers["x-forwarded-for"] || (req.socket && req.socket.remoteAddress)
          )
          const reqLen = safeLogValue(req.headers["content-length"])
          const claim = globalHash[req.params.id]
          if (!claim) {
            // data body with no active manifest (orphaned or replayed after the
            // stream already completed) — drop it rather than crash on meta.size
            node.warn(
              `fileinput: data POST for node ${req.params.id} with no active stream ` +
                `(req ${reqNonce}, src ${reqSrc}, len ${reqLen}); ignoring`
            )
            return res.status(409).json({ error: "no active stream" })
          }
          // The claim in globalHash is the invariant every other guard rests on:
          // a truthy entry means an upload is genuinely live. Nothing released it
          // when the socket went away, so an aborted or dropped upload wedged the
          // node permanently - further uploads rejected as overlapping, the
          // cancel route rejected as busy so the user's Dismiss stopped working,
          // and the arm timeout skipping its own cleanup because it saw an upload
          // still draining. Release the claim on whichever event marks the end of
          // this request, however it ended.
          let claimReleased = false
          const releaseClaimOnAbort = function () {
            if (claimReleased) {
              // Both events can fire for one teardown; the claim goes once.
              return
            }
            const meta = globalHash[req.params.id]
            if (!meta || meta.dataOwner !== reqNonce) {
              // Either the upload already settled, or a later data request
              // adopted this stream and owns the claim now, and clearing it here
              // would pull the state out from under that live request.
              //
              // This is deliberately the only test for a finished response.
              // Every path that completes nulls the claim BEFORE ending the
              // response, so this recognises all of them. Testing
              // res.writableEnded alongside it looks equivalent and is not:
              // procError() answers 500 without releasing the claim, and on a
              // request that errors mid-body no "end" event follows to release it
              // either - so the response is finished while the claim is still
              // held, and this handler is the last chance to free it. Returning
              // early there left the claim standing with a live dataOwner, which
              // makes liveClaim() short-circuit its own TTL and report the node
              // busy for the life of the flow.
              return
            }
            claimReleased = true
            clearBpTimer()
            if (meta.streamId) {
              delete globalStreamControls[meta.streamId]
              // Dropping the committed-index progress here is a deliberate
              // narrowing of adopt-and-resume, not an oversight. Resuming a
              // severed upload would mean keeping the claim alive for a retry to
              // adopt, and this request has already reported the failure, which
              // clears the primed wire message: blocks before the break carried
              // its properties and blocks after it would not, so a downstream
              // consumer would see one upload arrive in two shapes. Adoption
              // still works for its other case, a duplicate body arriving while
              // the first socket is alive. See the note in the node's help.
              delete globalStreamProgress[meta.streamId]
            }
            globalHash[req.params.id] = null
            node.receive({
              __msgSrc: "editor",
              status: "error",
              error: "Upload aborted",
            })
          }
          // Both, because which one fires for a severed connection has moved
          // between Node versions and this package supports a wide range.
          req.on("aborted", releaseClaimOnAbort)
          res.on("close", releaseClaimOnAbort)
          if (!streaming) {
            // ---- non-streaming: buffer the whole body, emit once at end ----
            // A replayed body here would just re-emit the file; reject a second
            // concurrent data request rather than double-emit.
            if (claim.dataOwner && claim.dataOwner !== reqNonce) {
              node.warn(
                `fileinput: rejected duplicate data POST on node ${req.params.id} ` +
                  `(req ${reqNonce}, src ${reqSrc}, len ${reqLen}); already owned by ` +
                  `${claim.dataOwner}`
              )
              return res.status(409).json({ error: "upload already in progress" })
            }
            claim.dataOwner = reqNonce
            let reqBuf = new Buffer.from("")
            let bytes = 0
            req.on("end", function () {
              cleanupBp()
              if (requestError) {
                // Captured before the reset, as the streaming path already does:
                // reading it afterwards reported the error as a bare null and
                // lost whatever actually went wrong.
                const error = requestError
                globalHash[req.params.id] = null
                requestError = null
                return node.receive({ __msgSrc: "editor", status: "error", error })
              }
              node.receive({ __msgSrc: "editor", payload: reqBuf })
              node.receive({ __msgSrc: "editor", status: "success" })
              globalHash[req.params.id] = null
              res.sendStatus(200)
            })
            req.on("error", function (error) {
              cleanupBp()
              procError(error, "Request error")
            })
            if (globalFailMode === "RECEIVER") {
              req.emit("error")
            }
            req.on("data", (data) => {
              try {
                if (requestError) {
                  return
                }
                if (globalFailMode === "DATA") {
                  throw new Error("Test error (DATA)")
                }
                bytes += data.length
                reqBuf = Buffer.concat([reqBuf, data])
                const meta = globalHash[req.params.id]
                const per = Math.round((100 * bytes) / meta.size)
                if (per != meta.per) {
                  meta.per = per
                  node.receive({ __msgSrc: "editor", status: "progress", per })
                }
              } catch (error) {
                procError(error, "Data error")
              }
            })
            return
          }
          // ---- streaming: fixed-size framing + resume-by-index ----
          // The upload is framed into fixed globalStreamBlock-sized blocks so block
          // N is always the same bytes no matter how the HTTP body splits across
          // `data` events. If another data request already owns this stream, this
          // POST is a replay/retry (e.g. a load balancer re-issuing the upload as a
          // second request): rather than reject it and lose the transfer, ADOPT it —
          // supersede the previous owner and resume from the last acknowledged block
          // index, fast-forwarding (dropping) the blocks already delivered.
          const streamId = claim.streamId
          const progress =
            globalStreamProgress[streamId] ||
            (globalStreamProgress[streamId] = { committedIndex: 0 })
          if (claim.dataOwner && claim.dataOwner !== reqNonce && claim.supersede) {
            const previousOwner = claim.dataOwner
            const supersedePrevious = claim.supersede
            // Ownership moves BEFORE the previous owner's socket is destroyed.
            // req.destroy() runs IncomingMessage._destroy synchronously and that
            // emits "aborted" inline, so the superseded request's abort handler
            // runs to completion before control returns here. Were the claim
            // still in its name at that moment it would release the claim, delete
            // the committed-index progress this resume depends on, and emit a
            // spurious upload error - and this request would then pump against a
            // detached claim and never answer its client. Assigning first makes
            // the handler see a mismatch and do nothing, on any Node version.
            claim.dataOwner = reqNonce
            node.warn(
              `fileinput: adopting replayed data POST on node ${req.params.id} ` +
                `(req ${reqNonce}, src ${reqSrc}, len ${reqLen}); superseding ` +
                `${previousOwner}, resuming stream ${streamId} at committed index ` +
                `${progress.committedIndex}`
            )
            supersedePrevious() // destroy the previous owner's request, silence it
          }
          claim.dataOwner = reqNonce
          let acc = Buffer.alloc(0) // fixed-block framing accumulator
          let blockIndex = 0 // next block number this request will produce
          let ended = false // request body fully received
          let waiting = false // paused awaiting a downstream ack
          let pumping = false // re-entrancy guard for pump()
          let finished = false // success emitted once
          let superseded = false // a newer data POST took over this stream
          // Let a future replay supersede THIS request: mark it silenced, clear its
          // watchdog, and destroy its socket so it stops feeding the stream.
          claim.supersede = function () {
            superseded = true
            clearBpTimer()
            try {
              req.destroy()
            } catch (_) {}
          }
          const finishOk = function () {
            if (finished || superseded) {
              return
            }
            finished = true
            cleanupBp()
            node.receive({ __msgSrc: "editor", status: "success" })
            globalHash[req.params.id] = null
            delete globalStreamProgress[streamId]
            try {
              res.sendStatus(200)
            } catch (_) {}
          }
          const pump = function () {
            if (superseded || pumping) {
              return
            }
            pumping = true
            try {
              while (!waiting && !superseded) {
                const isFull = acc.length >= globalStreamBlock
                const isFinalPartial = ended && acc.length > 0 && !isFull
                if (!isFull && !isFinalPartial) {
                  break
                }
                const take = isFull ? globalStreamBlock : acc.length
                const block = Buffer.from(acc.subarray(0, take))
                acc = acc.subarray(take)
                const N = blockIndex++
                if (N < progress.committedIndex) {
                  // already durably received — this is a resume re-sending a
                  // delivered prefix. Drop it with no downstream round-trip so the
                  // socket keeps flowing and fast-forwards to the resume point.
                  continue
                }
                const meta = globalHash[req.params.id]
                if (!meta) {
                  superseded = true
                  break
                }
                meta.index = N
                const isLast = ended && acc.length === 0
                const fwdBytes = Math.min((N + 1) * globalStreamBlock, meta.size)
                const per = meta.size ? Math.round((100 * fwdBytes) / meta.size) : 0
                if (per != meta.per) {
                  meta.per = per
                  node.receive({ __msgSrc: "editor", status: "progress", per })
                }
                const chunkMsg = {
                  __msgSrc: "editor",
                  payload: block,
                  streamId: meta.streamId,
                  index: N,
                  start: N === 0,
                  end: isLast,
                  size: meta.size,
                  bytes: fwdBytes,
                  percent: per,
                }
                if (backpressure) {
                  // Pause reads until the fileinput-backpressure node acks this
                  // block; register the resume BEFORE dispatching so a synchronous
                  // ack does not race the pause. Resume re-enters pump().
                  waiting = true
                  req.pause()
                  armBpTimer(meta.streamId)
                  globalStreamControls[meta.streamId] = {
                    resume: function () {
                      clearBpTimer()
                      waiting = false
                      if (superseded) {
                        return
                      }
                      req.resume()
                      pump()
                    },
                  }
                }
                node.receive(chunkMsg)
                if (waiting) {
                  break
                }
              }
            } catch (error) {
              procError(error, "Data error")
            } finally {
              pumping = false
            }
            if (!superseded && ended && acc.length === 0 && !waiting) {
              finishOk()
            }
          }
          req.on("end", function () {
            if (superseded) {
              return
            }
            if (requestError) {
              cleanupBp()
              const e = requestError
              globalHash[req.params.id] = null
              requestError = null
              return node.receive({ __msgSrc: "editor", status: "error", error: e })
            }
            ended = true
            pump()
          })
          req.on("error", function (error) {
            if (superseded) {
              return // the socket was destroyed on purpose during an adopt
            }
            cleanupBp()
            procError(error, "Request error")
          })
          if (globalFailMode === "RECEIVER") {
            req.emit("error")
          }
          req.on("data", (data) => {
            try {
              if (requestError || superseded) {
                return
              }
              if (globalFailMode === "DATA") {
                throw new Error("Test error (DATA)")
              }
              acc = acc.length ? Buffer.concat([acc, data]) : data
              pump()
            } catch (error) {
              procError(error, "Data error")
            }
          })
        }
      } catch (error) {
        node.receive({ __msgSrc: "editor", status: "error", error })
        globalHash[req.params.id] = null
        res.sendStatus(500)
      }
    }
  )

  function FileInput(config) {
    RED.nodes.createNode(this, config)
    let node = this
    let globalFilename = ""
    let globalDone = false
    // Properties primed by the most recent wire (non-editor) message; merged
    // into every output so a message on the input port acts like the button.
    let receivedMsg = null
    // Bounds the life of the primed wire message; see globalArmTimeoutMs.
    let armTimer = null
    // Nothing is waiting on the editor any more, and no bound is owed: the
    // request was answered to completion, or abandoned, or the node is going
    // away. Note this leaves nothing to emit the expiry event, which is why a
    // node destroyed by a deploy relies on the editor's own deploy handler to
    // clear its notification rather than on that event.
    function disarm() {
      delete globalArmed[node.id]
      if (armTimer) {
        clearTimeout(armTimer)
        armTimer = null
      }
    }
    // (Re)start the bound on how long the primed wire message may live. It has
    // to survive the start of an upload as well as the wait before one: an
    // upload that claims the node and then never delivers a body would otherwise
    // leave the message primed for the life of the flow, and a much later
    // upload would silently merge its properties into an unrelated file.
    function armExpiryTimer() {
      if (armTimer) {
        clearTimeout(armTimer)
      }
      armTimer = setTimeout(function () {
        armTimer = null
        delete globalArmed[node.id]
        if (liveClaim(node.id)) {
          // An upload really is draining, so this is a slow transfer rather than
          // an abandoned one. Clearing the primed message now would strip the
          // wire properties from the remaining chunks only, leaving a downstream
          // consumer with one stream in two shapes. Extend the bound instead of
          // dropping it, so the message still cannot outlive the upload.
          return armExpiryTimer()
        }
        receivedMsg = null
        node.status({})
        // The editor has to be told as well. Its notification may still be on
        // screen with a live button, and answering it now would upload a file
        // whose output silently carried none of this message's properties.
        RED.events.emit("runtime-event", {
          id: `FILE-INPUT-${node._alias || node.id}`,
          retain: false,
          payload: { realId: node.id, expired: true },
        })
      }, globalArmTimeoutMs)
    }
    node.on("close", function () {
      // A redeploy replaces this node, and the timer would otherwise outlive it
      // and fire against a status nobody is watching.
      disarm()
    })
    node.on("input", function (inMsg) {
      // Messages injected by the editor upload are tagged; anything arriving on
      // the input port is a wire message. A wire message asks the editor for a
      // file, and its properties are remembered so they can be merged into the
      // emitted output.
      if (inMsg.__msgSrc !== "editor") {
        receivedMsg = inMsg
        // The arming and expiry events share one topic and are told apart by a
        // payload flag, so neither depends on the order two branches are tested
        // in, in another file.
        RED.events.emit("runtime-event", {
          id: `FILE-INPUT-${node._alias || node.id}`,
          retain: false,
          payload: { realId: node.id },
        })
        // The editor cannot open the file picker from this event: a browser only
        // opens one while a user gesture is live, and a websocket callback has
        // none. It arms a request the user must click instead, so the node waits
        // here until that click (or a dismissal) arrives.
        globalArmed[node.id] = true
        armExpiryTimer()
        return node.status({
          fill: "blue",
          shape: "ring",
          text: RED._("fileinput.status.waiting"),
        })
      }
      delete inMsg.__msgSrc
      if (inMsg.hasOwnProperty("status")) {
        if (inMsg.status === "cancelled") {
          // The user dismissed the editor's file request, so no file is coming.
          // Drop the primed wire message and clear the waiting status rather
          // than leaving the node stuck on it. The route refuses while a body is
          // actually being received, so this cannot cut into a stream already
          // carrying those properties. It does inject for a claim that never
          // received a body, which by definition has carried nothing yet.
          disarm()
          receivedMsg = null
          return node.status({})
        }
        if (inMsg.status === "start") {
          // An upload has begun, so nothing is waiting on the editor any more.
          // The bound stays, restarted to cover the upload: cancelling it here
          // is what let one metadata POST with no body behind it pin the primed
          // message and this status for the life of the flow. The timer checks
          // for a genuinely draining upload before it clears anything.
          delete globalArmed[node.id]
          armExpiryTimer()
          node.status({})
          globalFilename = inMsg.filename
          globalDone = false
          inMsg.status = "progress"
          inMsg.per = 0
        }
        if (inMsg.status === "success") {
          disarm()
          globalDone = true
          receivedMsg = null
        }
        if (inMsg.status === "progress" && globalDone) {
          return
        }
        const fill =
          inMsg.status === "progress"
            ? "yellow"
            : inMsg.status === "success"
            ? "green"
            : "red"
        const shape = "dot"
        if (inMsg.status === "error") {
          disarm()
          receivedMsg = null
          // String() rather than .toString(): a nullish error threw here, and
          // the throw landed before the status below could be set, so a failed
          // upload left the node showing whatever badge it had before - since
          // this release, potentially "waiting" on a request already disarmed.
          node.error(
            errorMsg("fileinput.errors.failed", {
              error:
                inMsg.error === undefined || inMsg.error === null
                  ? "unknown error"
                  : String(inMsg.error),
            })
          )
        }
        const text = RED._(`fileinput.status.${inMsg.status}`, {
          filename: globalFilename,
          per: inMsg.per,
        })
        return node.status({ fill, shape, text })
      }
      let payload = inMsg.payload
      const prop = config.property
      let type = config.datatype
      const streaming = config.stream === true || config.stream === "yes"
      // Start from a clone of the wire message (if any) so its properties ride
      // along on every emitted message; the node's own properties win below.
      let outMsg = receivedMsg ? RED.util.cloneMessage(receivedMsg) : {}
      outMsg.filename = globalFilename
      outMsg.end = streaming ? inMsg.end : true
      if (streaming) {
        outMsg.streamId = inMsg.streamId
        outMsg.index = inMsg.index
        outMsg.start = inMsg.start
        outMsg.size = inMsg.size
        outMsg.bytes = inMsg.bytes
        outMsg.percent = inMsg.percent
      }
      outMsg[prop] = payload
      try {
        if (type === "obj") {
          outMsg[prop] = JSON.parse(payload)
        } else if (type === "buf") {
          outMsg[prop] = Buffer.from(payload)
        } else {
          outMsg[prop] = payload.toString()
        }
      } catch (error) {
        // The sanitised message rather than the error itself: V8 quotes a slice of
        // the input it choked on into a JSON parse message, so the uploaded file's
        // own bytes reach this log line - control characters and all - and that is
        // the same forging vector the request headers were sanitised for. Dropping
        // the stack with it loses nothing: the only statements this catch covers
        // are the three conversions above.
        console.log(safeLogValue(error && error.message ? error.message : error))
        return node.error(errorMsg("fileinput.errors.conversion"))
      }
      node.send(outMsg)
    })
  }
  RED.nodes.registerType("fileinput", FileInput)

  // Companion pace-gate for streaming uploads with backpressure enabled. Placed
  // downstream of the work that consumes each chunk, it acknowledges a chunk
  // (by streamId) once the chunk reaches it, letting the fileinput node release
  // the next one. The message is passed through unchanged.
  function FileInputBackpressure(config) {
    RED.nodes.createNode(this, config)
    let node = this
    node.on("input", function (msg, send, done) {
      send = send || node.send.bind(node)
      const streamId = msg.streamId
      // Record how far the receiver has durably committed, so a replayed/retried
      // upload can resume from committedIndex instead of re-sending from the start.
      // A success ack for block seq means blocks 0..seq are on disk -> next needed
      // block is seq + 1.
      if (
        streamId &&
        globalStreamProgress[streamId] &&
        msg.payload &&
        msg.payload.ok &&
        typeof msg.payload.ackSeq === "number"
      ) {
        const nextNeeded = msg.payload.ackSeq + 1
        if (nextNeeded > globalStreamProgress[streamId].committedIndex) {
          globalStreamProgress[streamId].committedIndex = nextNeeded
        }
      }
      const ctrl = streamId ? globalStreamControls[streamId] : null
      if (ctrl) {
        // On the final chunk this also lets the HTTP request end so the
        // fileinput node emits its "success" status.
        if (msg.end) {
          delete globalStreamControls[streamId]
        }
        ctrl.resume()
      }
      send(msg)
      if (done) {
        done()
      }
    })
  }
  RED.nodes.registerType("fileinput-backpressure", FileInputBackpressure)
}
