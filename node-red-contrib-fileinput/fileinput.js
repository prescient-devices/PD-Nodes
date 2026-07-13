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
  ["true", "1"].includes((process.env["__PDI_TEST__"] || "").toLowerCase()) ||
  typeof global.it === "function"
const globalFailMode = globalIsInTest ? process.env["__PDI_TEST_FAIL_MODE__"] || "" : ""
module.exports = function (RED) {
  function errorMsg(arg1, arg2) {
    return globalIsInTest ? arg1 : RED._(arg1, arg2)
  }
  let globalHash = {}
  let globalStreamSeq = 0
  // streamId -> { resume }. A streaming upload with backpressure enabled parks
  // its resume handle here so a downstream fileinput-backpressure node can
  // release the next chunk once the current one has been consumed.
  let globalStreamControls = {}
  // streamId -> { committedIndex }. How many fixed-size blocks the receiver has
  // durably acknowledged, tracked by the fileinput-backpressure node from each
  // ack. A replayed/retried upload (see the data-path notes below) reuses this to
  // fast-forward past the blocks already delivered and resume from committedIndex,
  // instead of re-sending the whole file and crossing streams.
  let globalStreamProgress = {}
  // Fixed streaming block size. Framing the upload into fixed-size blocks makes
  // block N always the same bytes ([N*FIXED, (N+1)*FIXED)) regardless of how the
  // HTTP body is split across `data` events, so a replay can resume by block index.
  const globalStreamBlock = 64 * 1024
  // How long an upload waits for a chunk acknowledgement before it gives up
  // (e.g. the fileinput-backpressure node is missing or its consumer stalled).
  const globalBpTimeoutMs = 30 * 1000
  RED.httpAdmin.post(
    "/node-red-contrib-fileinput/file/:id",
    RED.auth.needsPermission("node-red-contrib-fileinput.write"),
    async function (req, res) {
      let globalError
      function procError(error, desc) {
        if (!globalError) {
          globalError = error || desc
          res.sendStatus(500).end()
        }
      }
      let node = RED.nodes.getNode(req.params.id)
      let config = await new Promise(function (resolve) {
        RED.nodes.eachNode((item) => {
          if (item.id === req.params.id) {
            return resolve(item)
          }
        })
        return resolve()
      })
      if (!node || !config || globalFailMode === "NO-NODE") {
        globalHash[req.params.id] = null
        node.receive({ __msgSrc: "editor", status: "error", error: globalError })
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
            // fileinput node. globalHash[id] holds a non-null object for the life of
            // an upload (cleared to null on end/error/timeout), so a truthy entry
            // here means a prior upload is still draining. A second metadata POST
            // would clobber this node's streamId/index, crossing the two streams so
            // the receiver appends both and the file grows past its declared size.
            // Reject the overlapping POST instead of overwriting live state.
            const inFlight = globalHash[req.params.id]
            if (inFlight && inFlight.streamId) {
              node.warn(
                `fileinput: rejected overlapping upload on node ${req.params.id}; ` +
                  `stream ${inFlight.streamId} still in flight (chunk index ${inFlight.index})`
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
            }
            return res.sendStatus(200)
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
          const reqSrc =
            req.headers["x-forwarded-for"] ||
            (req.socket && req.socket.remoteAddress) ||
            "?"
          const reqLen = req.headers["content-length"] || "?"
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
              if (globalError) {
                globalHash[req.params.id] = null
                globalError = null
                return node.receive({
                  __msgSrc: "editor",
                  status: "error",
                  error: globalError,
                })
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
                if (globalError) {
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
            node.warn(
              `fileinput: adopting replayed data POST on node ${req.params.id} ` +
                `(req ${reqNonce}, src ${reqSrc}, len ${reqLen}); superseding ` +
                `${claim.dataOwner}, resuming stream ${streamId} at committed index ` +
                `${progress.committedIndex}`
            )
            claim.supersede() // destroy the previous owner's request, silence it
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
            if (globalError) {
              cleanupBp()
              const e = globalError
              globalHash[req.params.id] = null
              globalError = null
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
              if (globalError || superseded) {
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
    node.on("input", function (inMsg) {
      // Messages injected by the editor upload are tagged; anything arriving on
      // the input port is a wire message. A wire message behaves like clicking
      // the button: it opens the file picker in the editor and its properties
      // are remembered so they can be merged into the emitted output.
      if (inMsg.__msgSrc !== "editor") {
        receivedMsg = inMsg
        RED.events.emit("runtime-event", {
          id: `FILE-INPUT-${node._alias || node.id}`,
          retain: false,
          payload: { realId: node.id },
        })
        return
      }
      delete inMsg.__msgSrc
      if (inMsg.hasOwnProperty("status")) {
        if (inMsg.status === "start") {
          node.status({})
          globalFilename = inMsg.filename
          globalDone = false
          inMsg.status = "progress"
          inMsg.per = 0
        }
        if (inMsg.status === "success") {
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
          receivedMsg = null
          node.error(
            errorMsg("fileinput.errors.failed", { error: inMsg.error.toString() })
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
        console.log(error)
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
