/**
 * downloadfile-stream_core.js
 *
 * Copyright 2026-Present Prescient Devices, Inc.
 *
 **/

/* jshint esversion: 8 */

// NodeJS imports
const crypto = require("crypto")

/**
 * @typedef {object} ClosedInfo - how a closed stream ended, for the messages passed on after it
 * @property {string} state - done, expired, cancelled or error
 * @property {boolean | string} error - `false`, or the error text
 * @property {string} filename - the sanitised download file name
 *
 * @typedef {object} ClosedStream - one remembered closed stream
 * @property {string} state - done, expired, cancelled or error
 * @property {boolean | string} error - `false`, or the error text
 * @property {string} filename - the sanitised download file name
 * @property {string} nodeKey - the `nodeKey()` of the node that ran the stream
 * @property {string} streamID - the stream's `_streamID`
 * @property {number} seenAt - epoch milliseconds of the last message of the stream
 *
 * @typedef {object} DownloadInfo - what every Stream mode output message carries in `msg.download`
 * @property {string} state - waiting, claimed, streaming, done, expired, cancelled or error
 * @property {string} filename - the sanitised download file name
 * @property {number} bytes - bytes handed to the HTTP response so far
 * @property {number} messages - input messages whose payload has been written so far
 * @property {number} elapsedMs - milliseconds since the first message of the stream
 * @property {boolean | string} error - `false`, or a message when the state is "error"
 *
 * @typedef {object} HeldMessage - one input message waiting for its payload to be written
 * @property {any} msg - the input message
 * @property {Function} send - the per-message send function Node-RED handed in
 * @property {Function} done - the per-message done function Node-RED handed in
 * @property {Buffer} chunk - the bytes this message adds to the file
 * @property {boolean} final - `true` for the message that carries `msg.complete === true`
 *
 * @typedef {object} RegistryEntry - one registered download
 * @property {any} node - the runtime node that owns the download
 * @property {string} downloadId - 32 hex characters
 * @property {DownloadStream} stream - the stream that writes the file
 * @property {boolean} claimed - `true` once the claim route has handed out a ticket
 * @property {string | null} ticket - 32 hex characters, single use, or `null`
 * @property {number} ticketExpiresAt - epoch milliseconds; `0` when no ticket stands
 * @property {NodeJS.Timeout | null} timer - the arm timer or the ticket timer
 */

// Constants
// How long a registered download waits for a user to click Download, before it is
// dropped. The editor tab can close while the banner is up, and nothing would ever
// arrive to release the node.
const ARM_TIMEOUT_MS = 10 * 60 * 1000
// Most `_streamID`s of closed streams (aborted or done) the registry remembers. The
// registry is per runtime and outlives a redeploy of the node, so a new node instance
// can see that a message belongs to a stream that is already over and pass it
// through, rather than open a second download that has no first part. Each entry is a
// short string and a few numbers; 1000 of them is a few hundred KB at most. When the
// map is full, the entry seen longest ago goes first.
const CLOSED_STREAMS_MAX = 1000
// How long the registry remembers a closed `_streamID` after the last message of it
// arrived. The same ten minutes as `PASS_THROUGH_IDLE_MS`: a stream that sends
// nothing for that long is treated as gone on both paths.
const CLOSED_STREAMS_TTL_MS = 10 * 60 * 1000
// Bytes of input held in memory while the browser is not reading, before the stream
// is stopped. With a source that waits for each output message, at most one message
// is ever held, so this cap is only reached when the source does not wait.
const DEFAULT_MAX_HELD_BYTES = 16 * 1024 * 1024
// Messages held in memory before the stream is stopped. The byte cap counts
// `msg.payload` only, so it does not bound a flood of empty payloads, nor messages
// that carry other large properties, such as `msg.req` and `msg.res` from `http in`.
const DEFAULT_MAX_HELD_MESSAGES = 10000
// The message property read for a source error when the node config has no
// `errorProperty`. It is the same value the editor saves by default.
const DEFAULT_ERROR_PROPERTY = "error"
// A download id and a ticket are both 16 bytes of `crypto.randomBytes` as hex, so
// one pattern checks both. Applied before any lookup, on every route.
const DOWNLOAD_ID_RE = /^[0-9a-f]{32}$/
// Hard limit on one streaming download, armed when the ticket is spent. The socket
// timeout below measures inactivity only, so a reader that takes one byte a minute
// would otherwise hold the node for ever.
const DOWNLOAD_MAX_MS = 4 * 60 * 60 * 1000
// Longest file extension, in code points, that `sanitizeFilename()` keeps apart from
// the rest of the name when it cuts a long name.
const FILENAME_EXT_MAX_LEN = 16
// Bound on the file name written into `Content-Disposition`, in code points.
const FILENAME_MAX_LEN = 120
// How much of a proposed name `sanitizeFilename()` reads at all, in UTF-16 units.
// `msg.filename` can be any string a flow copies into it. Eight times the kept length
// leaves room for the characters the walk deletes.
const FILENAME_SCAN_LEN = FILENAME_MAX_LEN * 8
// Ceiling on claimed or streaming downloads across the whole runtime.
const MAX_CONCURRENT_DOWNLOADS = 8
// The runtime event id prefix. It must not start with `DOWNLOAD-FILE`, because the
// editor code for the one-file-per-message mode matches that prefix.
const NOTIFICATION_PREFIX = "STREAM-DOWNLOAD-FILE-"
// How long the node passes messages of an aborted stream straight through while no
// message of that stream arrives. The source may stop before it sends
// `msg.complete`, and without a limit the node would pass every later message
// through for ever and never start a new download. The timer restarts on each
// message passed through. When it fires, the node returns to idle and the next
// message starts a new stream. Ten minutes matches the wait for a click.
const PASS_THROUGH_IDLE_MS = 10 * 60 * 1000
// One registry per Node-RED runtime, so a second load of the module reaches the same
// maps as the routes. Keyed weakly so a test that builds several RED doubles does not
// pin them.
const REGISTRIES = new WeakMap()
// The URL prefix of the three admin routes.
const ROUTE_PREFIX = "/node-red-contrib-downloadfile"
// Most refused `_streamID`s the registry remembers: streams that reached a node while
// another download was open on it. The rest of such a stream, its final message
// included, must pass through even after the first download ends; without the
// record it would open a new download halfway, with no header. Sized and ordered like
// the closed-stream memory.
const REFUSED_STREAMS_MAX = 1000
// How long the registry remembers a refused `_streamID` after the last message of it
// arrived. Every message of the stream restarts the clock, and its final message
// deletes the record. Ten minutes, as for a closed stream.
const REFUSED_STREAMS_TTL_MS = 10 * 60 * 1000
// Socket inactivity timeout for a download response. It must exceed the longest
// legitimate stall: the time between two input messages, and the time a browser
// takes to accept one socket buffer.
const SOCKET_TIMEOUT_MS = 15 * 60 * 1000
// Minimum gap between two "downloading" node status updates.
const STATUS_INTERVAL_MS = 1000
// How long a minted ticket may sit unused.
const TICKET_TTL_MS = 60 * 1000

/**
 * Pick the `Content-Type` for a file name.
 * @param {string} filename - the sanitised file name
 * @returns {string} the content type
 */
function contentTypeFor(filename) {
  const match = /\.([^.]+)$/.exec(filename)
  const ext = match ? match[1].toLowerCase() : ""
  if (ext === "csv") {
    return "text/csv; charset=utf-8"
  }
  if (ext === "txt" || ext === "log") {
    return "text/plain; charset=utf-8"
  }
  if (ext === "json") {
    return "application/json; charset=utf-8"
  }
  return "application/octet-stream"
}

/**
 * Render a byte count for a node status line.
 * @param {number} bytes - the byte count
 * @returns {string} the count with a unit, for example "12.3 MB"
 */
function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(1)} ${units[index]}`
}

/**
 * Is this code point one that `sanitizeFilename()` deletes as a control, invisible,
 * direction-altering or lone surrogate character?
 *
 * The list is the same one `safeLabel()` in `downloadfile.html` deletes from the
 * editor banner, so the banner and the disk show the same name. Change both together.
 * Matched by code point because these characters are invisible in a source file.
 * @param {number} code - the code point
 * @returns {boolean} `true` when the character must go
 */
function isHiddenCodePoint(code) {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x00ad ||
    code === 0x061c ||
    code === 0x180e ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x2029) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x2069) ||
    (code >= 0xd800 && code <= 0xdfff) ||
    code === 0xfeff ||
    (code >= 0xe0000 && code <= 0xe007f)
  )
}

/**
 * A key for a node that survives a redeploy and a subflow restart.
 *
 * Node-RED gives a node inside a subflow instance a new `id` at every start. The
 * subflow instance id (`z`) and the template node id (`_alias`) stay the same, so
 * the key is built from those. Outside a subflow, `_alias` is not set and `id` is
 * stable.
 * @param {any} node - the runtime node
 * @returns {string} the key
 */
function nodeKey(node) {
  return `${node.z || ""}:${node._alias || node.id}`
}

/**
 * Reduce a proposed file name to something safe to write into a header and onto a
 * disk.
 *
 * Every character deleted here changes the meaning of the header or of the path. A
 * double quote or a semicolon ends the `Content-Disposition` parameter early; a CR
 * or LF ends the header line; a slash or a backslash makes the save dialog resolve a
 * path. The name can come from `msg.filename`, which can carry data from outside the
 * flow, so every character is untrusted.
 *
 * The name keeps the extension it already has. A name with no extension gets `.txt`.
 * When the name is longer than `FILENAME_MAX_LEN` code points, the cut is made in the
 * part before the extension, so the extension survives.
 * @param {any} name - the proposed file name
 * @returns {string} a usable name, never empty, always with an extension
 */
function sanitizeFilename(name) {
  // Cut before the walk. A surrogate pair split by this cut leaves a lone surrogate,
  // and the walk deletes it.
  const raw = String(name === null || name === undefined ? "" : name).slice(
    0,
    FILENAME_SCAN_LEN
  )
  const chars = []
  for (const char of raw) {
    if (isHiddenCodePoint(char.codePointAt(0))) {
      continue
    }
    if ('/\\":;,*?<>|'.includes(char)) {
      continue
    }
    chars.push(char)
  }
  // A leading dot hides the file on a Unix desktop. Windows deletes trailing dots and
  // spaces itself, so they are deleted here too and the extension test sees the name
  // the disk will get.
  let text = chars
    .join("")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[.\s]+$/, "")
    .trim()
  const extMatch = /\.[^.\s]+$/.exec(text)
  let ext = extMatch ? extMatch[0] : ""
  if (Array.from(ext).length > FILENAME_EXT_MAX_LEN + 1) {
    // Too long to be a real extension; treat the whole thing as the stem.
    ext = ""
  }
  let stem = ext ? text.slice(0, text.length - ext.length) : text
  if (!ext) {
    ext = ".txt"
  }
  // `Array.from()` splits by code point, so the cut never halves a surrogate pair.
  const room = FILENAME_MAX_LEN - Array.from(ext).length
  const points = Array.from(stem)
  if (points.length > room) {
    stem = points.slice(0, room).join("")
  }
  stem = stem.trim().replace(/[.\s]+$/, "")
  if (!stem) {
    stem = "data"
  }
  return `${stem}${ext}`
}

/**
 * Render anything that arrived in a `catch` as a single line of text.
 * @param {any} error - the caught value
 * @returns {string} a message, never empty
 */
function tbText(error) {
  if (!error) {
    return "Unknown error"
  }
  if (typeof error === "string") {
    return error
  }
  return String(error.message || error) || "Unknown error"
}

/**
 * Turn a message payload into the bytes it adds to the file.
 *
 * A string is written as UTF-8 and a Buffer as-is. A missing payload adds nothing.
 * Anything else is written as JSON followed by a newline.
 * @param {any} msg - the input message
 * @returns {Buffer} the bytes, possibly empty
 * @throws {Error} when the payload cannot be turned into JSON, for example a circular object
 */
function toChunk(msg) {
  const payload = msg ? msg.payload : undefined
  if (typeof payload === "string") {
    return Buffer.from(payload, "utf8")
  }
  if (Buffer.isBuffer(payload)) {
    return payload
  }
  if (payload === undefined) {
    return Buffer.alloc(0)
  }
  const json = JSON.stringify(payload)
  // `JSON.stringify()` returns `undefined` for a function or a symbol.
  return json === undefined ? Buffer.alloc(0) : Buffer.from(`${json}\n`, "utf8")
}

/**
 * Build the per-runtime download registry and install its three admin routes.
 *
 * The routes are:
 * - `POST /node-red-contrib-downloadfile/claim/:downloadId` - guarded by
 *   `RED.auth.needsPermission("downloadfile.read")`; answers a single-use ticket.
 * - `GET /node-red-contrib-downloadfile/download/:ticket` - a browser navigation,
 *   which cannot carry a bearer token, so the ticket is the capability.
 * - `POST /node-red-contrib-downloadfile/cancel/:downloadId` - guarded like the claim;
 *   the editor calls it when the user dismisses the banner.
 *
 * MEMOIZED PER `RED`, so a second call returns the first registry rather than install
 * the routes twice.
 * @param {any} RED - the Node-RED runtime API
 * @returns {{available: boolean, closeStream: Function, closedStream: Function, closedTail: Function, endTail: Function, refuseStream: Function, refusedStream: Function, register: Function, release: Function, text: Function}} the registry API
 */
function DownloadRegistryFactory(RED) {
  const existing = REGISTRIES.get(RED)
  if (existing) {
    return existing
  }
  /** @type {Map<string, RegistryEntry>} downloadId -> entry */
  const pending = new Map()
  /**
   * `_streamID` -> what the stream ended with. Kept in the order each id was last
   * seen, so the first key is always the one seen longest ago.
   * @type {Map<string, ClosedStream>}
   */
  const closedStreams = new Map()
  /**
   * Node key -> the stream that node stopped before the stream's own final message
   * arrived. A FALLBACK for sources that send a final message with no `_streamID`:
   * after a redeploy such a message can only be matched by the node it reaches.
   * (A source that puts the `_streamID` on its final message is matched by
   * `closedStreams` instead.) Keyed by `nodeKey()`, which survives a redeploy and a
   * subflow restart. Same order, size cap and age limit as `closedStreams`.
   * @type {Map<string, ClosedStream>}
   */
  const openTails = new Map()
  /**
   * `_streamID` -> epoch milliseconds of the last message, for streams refused
   * because another download was open. Kept in last-seen order.
   * @type {Map<string, {seenAt: number}>}
   */
  const refusedStreams = new Map()
  /**
   * Tell every open editor about a download.
   *
   * `retain: false` is required: a retained event is replayed to every editor that
   * connects later, and would raise a banner for a download that ended hours ago.
   * `_alias` names the template node a subflow instance was built from, which is the
   * id the editor knows.
   * @param {any} node - the runtime node
   * @param {object} payload - the event payload
   * @returns {void}
   */
  function broadcast(node, payload) {
    try {
      RED.events.emit("runtime-event", {
        id: `${NOTIFICATION_PREFIX}${node._alias || node.id}`,
        retain: false,
        payload,
      })
    } catch (error) {
      try {
        node.warn(
          `downloadfile: could not tell the editors about a download - ${tbText(error)}`
        )
      } catch (_) {
        // The node is gone. There is nowhere left to warn.
      }
    }
  }
  /**
   * Count the downloads that hold a slot across the whole runtime. Derived from the
   * map rather than counted, so it cannot drift.
   * @returns {number} claimed downloads, streaming or waiting for their navigation
   */
  function claimedCount() {
    let count = 0
    for (const entry of pending.values()) {
      if (entry.claimed) {
        count += 1
      }
    }
    return count
  }
  /**
   * Is this `_streamID` a stream that is already over? A hit counts as a new
   * sighting, for the id and for the node's open tail, so both stay remembered
   * while messages of the stream keep arriving. The stream's final message also
   * ends the open tail, so a later final message without an id is not taken for it.
   * @param {any} streamID - the `_streamID` of an input message
   * @param {boolean} final - `true` when the message carries `msg.complete === true`
   * @returns {ClosedInfo | null} how the stream ended, or `null`
   */
  function closedStream(streamID, final) {
    if (typeof streamID !== "string" || !streamID) {
      return null
    }
    const entry = touch(
      closedStreams,
      streamID,
      CLOSED_STREAMS_MAX,
      CLOSED_STREAMS_TTL_MS
    )
    if (!entry) {
      return null
    }
    const tail = openTails.get(entry.nodeKey)
    if (tail && tail.streamID === streamID) {
      if (final) {
        openTails.delete(entry.nodeKey)
      } else {
        touch(openTails, entry.nodeKey, CLOSED_STREAMS_MAX, CLOSED_STREAMS_TTL_MS)
      }
    }
    return { state: entry.state, error: entry.error, filename: entry.filename }
  }
  /**
   * Take the open tail of a node: the stream it stopped whose own final message has
   * not arrived. Called for a final message that has no `_streamID`. The tail is
   * forgotten, because that message is its end.
   * @param {string} key - the node's `nodeKey()`
   * @returns {ClosedInfo | null} how the stream ended, or `null`
   */
  function closedTail(key) {
    const entry = touch(openTails, key, CLOSED_STREAMS_MAX, CLOSED_STREAMS_TTL_MS)
    if (!entry) {
      return null
    }
    openTails.delete(key)
    return { state: entry.state, error: entry.error, filename: entry.filename }
  }
  /**
   * Remember that a stream is over, so any node instance passes the rest of it
   * through. Does nothing for a stream without a `_streamID`: nothing can match the
   * rest of it.
   * @param {object} args - input arguments
   * @param {any} args.streamID - the stream's `_streamID`
   * @param {ClosedInfo} args.info - how it ended
   * @param {string} args.nodeKey - the node's `nodeKey()`
   * @param {boolean} args.finalSeen - `true` when the stream's final message already arrived
   * @returns {void}
   */
  function closeStream({ streamID, info, nodeKey, finalSeen }) {
    if (typeof streamID !== "string" || !streamID) {
      return
    }
    const entry = {
      state: info.state,
      error: info.error,
      filename: info.filename,
      nodeKey,
      streamID,
      seenAt: Date.now(),
    }
    closedStreams.delete(streamID)
    closedStreams.set(streamID, entry)
    prune(closedStreams, CLOSED_STREAMS_MAX, CLOSED_STREAMS_TTL_MS)
    openTails.delete(nodeKey)
    if (!finalSeen) {
      openTails.set(nodeKey, Object.assign({}, entry))
      prune(openTails, CLOSED_STREAMS_MAX, CLOSED_STREAMS_TTL_MS)
    }
  }
  /**
   * Forget a node's open tail, because the stream's final message has passed.
   * @param {string} key - the node's `nodeKey()`
   * @returns {void}
   */
  function endTail(key) {
    openTails.delete(key)
  }
  /**
   * Find the entry a ticket belongs to and consume the ticket.
   *
   * Compared with `crypto.timingSafeEqual`, because the ticket is a bearer
   * capability. Single use is enforced here, before a byte is written.
   * @param {string} ticket - the value from the URL, already pattern-checked
   * @returns {RegistryEntry | null} the entry, or `null` for unknown or expired
   */
  function consumeTicket(ticket) {
    const supplied = Buffer.from(ticket, "hex")
    const now = Date.now()
    for (const entry of pending.values()) {
      if (!entry.ticket || entry.ticketExpiresAt <= now) {
        continue
      }
      const stored = Buffer.from(entry.ticket, "hex")
      if (stored.length !== supplied.length) {
        continue
      }
      if (!crypto.timingSafeEqual(stored, supplied)) {
        continue
      }
      entry.ticket = null
      entry.ticketExpiresAt = 0
      disarm(entry)
      return entry
    }
    return null
  }
  /**
   * Stop an entry's timer.
   * @param {RegistryEntry} entry - the entry
   * @returns {void}
   */
  function disarm(entry) {
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
  }
  /**
   * Forget entries that are too old, then the oldest ones past the size cap. The
   * map is in last-seen order, so the walk stops at the first entry to keep.
   * @param {Map<string, {seenAt: number}>} map - `closedStreams`, `openTails` or `refusedStreams`
   * @param {number} max - the most entries to keep
   * @param {number} ttlMs - how long an unseen entry is kept
   * @returns {void}
   */
  function prune(map, max, ttlMs) {
    const oldest = Date.now() - ttlMs
    for (const [key, entry] of map) {
      if (entry.seenAt > oldest && map.size <= max) {
        break
      }
      map.delete(key)
    }
  }
  /**
   * Remember that a stream was refused because another download was open, or
   * refresh the record. The stream's final message deletes the record instead.
   * @param {any} streamID - the refused message's `_streamID`
   * @param {boolean} final - `true` when the message carries `msg.complete === true`
   * @returns {void}
   */
  function refuseStream(streamID, final) {
    if (typeof streamID !== "string" || !streamID) {
      return
    }
    refusedStreams.delete(streamID)
    if (final) {
      return
    }
    refusedStreams.set(streamID, { seenAt: Date.now() })
    prune(refusedStreams, REFUSED_STREAMS_MAX, REFUSED_STREAMS_TTL_MS)
  }
  /**
   * Was this `_streamID` refused while another download was open? A hit refreshes
   * the record; the stream's final message deletes it.
   * @param {any} streamID - the `_streamID` of an input message
   * @param {boolean} final - `true` when the message carries `msg.complete === true`
   * @returns {boolean} `true` when the message belongs to a refused stream
   */
  function refusedStream(streamID, final) {
    if (typeof streamID !== "string" || !streamID) {
      return false
    }
    const entry = touch(
      refusedStreams,
      streamID,
      REFUSED_STREAMS_MAX,
      REFUSED_STREAMS_TTL_MS
    )
    if (!entry) {
      return false
    }
    if (final) {
      refusedStreams.delete(streamID)
    }
    return true
  }
  /**
   * Register a download and raise the banner in every open editor.
   * @param {object} args - input arguments
   * @param {any} args.node - the runtime node
   * @param {DownloadStream} args.stream - the stream that writes the file
   * @param {string} args.filename - the sanitised file name
   * @returns {string} the new download id
   */
  function register({ node, stream, filename }) {
    const downloadId = crypto.randomBytes(16).toString("hex")
    /** @type {RegistryEntry} */
    const entry = {
      node,
      downloadId,
      stream,
      claimed: false,
      ticket: null,
      ticketExpiresAt: 0,
      timer: null,
    }
    pending.set(downloadId, entry)
    entry.timer = setTimeout(function () {
      entry.timer = null
      stream.abort("expired")
    }, ARM_TIMEOUT_MS)
    broadcast(node, { realId: node.id, downloadId, filename })
    return downloadId
  }
  /**
   * Drop a registered download. Safe to call for an id that is already gone.
   * @param {string} downloadId - the download id
   * @param {boolean} notify - `true` to take the banner down in every editor
   * @returns {void}
   */
  function release(downloadId, notify) {
    const entry = pending.get(downloadId)
    if (!entry) {
      return
    }
    disarm(entry)
    pending.delete(downloadId)
    if (notify) {
      broadcast(entry.node, { realId: entry.node.id, downloadId, expired: true })
    }
  }
  /**
   * Look up a translation, falling back to plain English when the catalogue has no
   * entry. `RED._()` returns the key itself for a missing entry.
   * @param {string} key - the catalogue key
   * @param {string} fallback - the English text to use when the key is missing
   * @param {object} [args] - interpolation arguments
   * @returns {string} the translated text, or `fallback`
   */
  function text(key, fallback, args) {
    try {
      const translated = RED._(key, args)
      return !translated || translated === key ? fallback : translated
    } catch (_) {
      return fallback
    }
  }
  const available = Boolean(
    RED.httpAdmin &&
    RED.auth &&
    typeof RED.auth.needsPermission === "function" &&
    typeof RED.httpAdmin.get === "function" &&
    typeof RED.httpAdmin.post === "function"
  )
  /**
   * Look up a remembered entry and, on a hit, mark it as seen now and move it to
   * the end of the last-seen order. Old entries are forgotten first.
   * @param {Map<string, any>} map - `closedStreams`, `openTails` or `refusedStreams`
   * @param {string} key - the `_streamID` or the node key
   * @param {number} max - the most entries to keep
   * @param {number} ttlMs - how long an unseen entry is kept
   * @returns {any} the entry, or `null`
   */
  function touch(map, key, max, ttlMs) {
    prune(map, max, ttlMs)
    const entry = map.get(key)
    if (!entry) {
      return null
    }
    map.delete(key)
    entry.seenAt = Date.now()
    map.set(key, entry)
    return entry
  }
  const api = {
    available,
    closeStream,
    closedStream,
    closedTail,
    endTail,
    refuseStream,
    refusedStream,
    register,
    release,
    text,
  }
  REGISTRIES.set(RED, api)
  if (!available) {
    // Only a RED object with no admin app at all reaches this branch. A Node-RED
    // runtime always has one, even with the editor turned off; there, nobody can
    // click Download, and the download expires after `ARM_TIMEOUT_MS`.
    return api
  }
  // ---- 1. claim --------------------------------------------------------------
  RED.httpAdmin.post(
    `${ROUTE_PREFIX}/claim/:downloadId`,
    RED.auth.needsPermission("downloadfile.read"),
    function (req, res) {
      const downloadId = req.params.downloadId
      if (!DOWNLOAD_ID_RE.test(downloadId)) {
        return res.sendStatus(404)
      }
      const entry = pending.get(downloadId)
      if (!entry) {
        return res.sendStatus(404)
      }
      if (entry.claimed) {
        // Every open editor shows the same banner, so a second click is ordinary.
        return res.status(409).json({ error: "already claimed", code: "claimed" })
      }
      if (claimedCount() >= MAX_CONCURRENT_DOWNLOADS) {
        // The entry keeps its arm timer and its banner, so the user can click again.
        return res
          .status(503)
          .json({ error: "too many downloads in progress", code: "busy" })
      }
      // No `await` between the test above and the set below, so two claims cannot
      // both pass.
      entry.claimed = true
      disarm(entry)
      entry.ticket = crypto.randomBytes(16).toString("hex")
      entry.ticketExpiresAt = Date.now() + TICKET_TTL_MS
      entry.timer = setTimeout(function () {
        entry.timer = null
        if (entry.ticket) {
          // The claim succeeded and the navigation never followed.
          entry.stream.abort("expired")
        }
      }, TICKET_TTL_MS)
      entry.stream.markClaimed()
      broadcast(entry.node, { realId: entry.node.id, downloadId, claimed: true })
      return res.status(200).json({ ticket: entry.ticket })
    }
  )
  // ---- 2. download -----------------------------------------------------------
  // NOT GUARDED BY `needsPermission`, and the ticket is why. This request is a
  // navigation, which cannot carry an `Authorization: Bearer` header, so a guard
  // here would refuse every download under an `adminAuth` of type `credentials`.
  // The ticket is 128 random bits, single use, valid for 60 seconds, and only the
  // guarded claim route hands one out. Any authentication middleware placed in front
  // of the whole admin app covers this route too.
  RED.httpAdmin.get(`${ROUTE_PREFIX}/download/:ticket`, function (req, res) {
    const ticket = req.params.ticket
    if (!DOWNLOAD_ID_RE.test(ticket)) {
      return res.sendStatus(404)
    }
    const entry = consumeTicket(ticket)
    if (!entry) {
      // Unknown, used, or expired. One answer for all three.
      return res.sendStatus(404)
    }
    try {
      entry.stream.attach(req, res)
    } catch (error) {
      // `attach()` handles its own failures. This is the last line of defence, so a
      // throw here cannot reach Express and take the runtime down.
      try {
        res.destroy()
      } catch (_) {
        // Already gone.
      }
      entry.stream.abort("error", tbText(error))
    }
  })
  // ---- 3. cancel -------------------------------------------------------------
  RED.httpAdmin.post(
    `${ROUTE_PREFIX}/cancel/:downloadId`,
    RED.auth.needsPermission("downloadfile.read"),
    function (req, res) {
      const downloadId = req.params.downloadId
      if (!DOWNLOAD_ID_RE.test(downloadId)) {
        return res.sendStatus(404)
      }
      const entry = pending.get(downloadId)
      if (!entry) {
        // Already claimed, expired or finished. Nothing to release.
        return res.sendStatus(200)
      }
      if (entry.claimed) {
        // Somebody clicked Download. A Dismiss in another editor must not break it,
        // not even in the seconds between the claim and the GET. A claim whose GET
        // never comes is aborted by the ticket timer, so nothing is left behind.
        return res
          .status(409)
          .json({ error: "download in progress", code: "streaming" })
      }
      entry.stream.abort("cancelled")
      return res.sendStatus(200)
    }
  )
  return api
}

/**
 * One stream of input messages written into one browser download.
 *
 * FLOW CONTROL. A message is sent on the output only after its payload is fully
 * handed to the socket: `res.write()` returned `true`, or `drain` fired. When the
 * output goes back to a source that waits for each output message, that source then
 * sends the next message, so nothing is held beyond one message. With a source that
 * does not wait, messages keep arriving and are held up to a byte cap; past the cap
 * the stream stops with an error.
 *
 * ONE OUTPUT PER INPUT, AND AT MOST ONE EXTRA. Every input message is sent exactly
 * once. After an abort, the node sends exactly one message with `complete: true` of
 * its own making. When the source's own final message is already held, that message
 * is the one: it goes out last, with the abort state. Otherwise the node sends, after
 * the held messages, a copy of the latest input with an empty payload,
 * `complete: true` and NO `_streamID`, so a source that waits for each output
 * message does not take it as the reply to one of its own messages. Messages passed
 * through after that keep `complete` only when the source set it.
 */
class DownloadStream {
  /**
   * @param {object} args - input arguments
   * @param {any} args.node - the runtime node
   * @param {any} args.RED - the Node-RED runtime API
   * @param {object} args.registry - the value `DownloadRegistryFactory()` returned
   * @param {string} args.filename - the sanitised file name
   * @param {string | undefined} args.streamID - the `_streamID` of the first message, if any
   * @param {() => void} args.onFinished - called once, when the last message of the stream has left
   * @param {number} [args.maxHeldBytes] - byte cap on held messages
   * @param {number} [args.maxHeldMessages] - message cap on held messages
   * @param {string} [args.errorProperty] - the msg property that marks a failed
   *   source on the final message; `DEFAULT_ERROR_PROPERTY` when `undefined`
   */
  constructor({
    node,
    RED,
    registry,
    filename,
    streamID,
    onFinished,
    maxHeldBytes,
    maxHeldMessages,
    errorProperty,
  }) {
    this.node = node
    this.RED = RED
    this.registry = registry
    this.filename = filename
    this.streamID = streamID
    this.onFinished = onFinished
    this.maxHeldBytes = maxHeldBytes || DEFAULT_MAX_HELD_BYTES
    this.maxHeldMessages = maxHeldMessages || DEFAULT_MAX_HELD_MESSAGES
    // `undefined` only: a config written by hand can lack the key. Any other value,
    // an empty string included, is what the user saved.
    this.errorProperty =
      errorProperty === undefined ? DEFAULT_ERROR_PROPERTY : errorProperty
    // Checked here, not in `sourceError()`: that runs before `accept()` queues the
    // message, so it must never throw, and it swallows a bad path. Without this
    // check a runtime with no `getMessageProperty` would lose every source error.
    if (!RED || !RED.util || typeof RED.util.getMessageProperty !== "function") {
      throw new Error("RED.util.getMessageProperty is not available")
    }
    this.startedAt = Date.now()
    this.state = "waiting"
    this.error = false
    this.downloadId = null
    /** @type {Array<HeldMessage>} */
    this.queue = []
    this.heldBytes = 0
    /** @type {HeldMessage | null} the message written but not yet drained */
    this.inFlight = null
    this.bytes = 0
    this.messages = 0
    /** @type {any} the latest input message, the base of the terminal message */
    this.lastMsg = null
    this.req = null
    this.res = null
    this.pumping = false
    this.ending = false
    this.finished = false
    /** `true` once the message with `msg.complete` is in the queue */
    this.sawFinal = false
    this.maxTimer = null
    this.lastStatusAt = 0
    /** @type {NodeJS.Timeout | null} the idle limit on pass-through after an abort */
    this.idleTimer = null
  }
  /**
   * Take one input message of this stream.
   * @param {any} msg - the input message
   * @param {Function} send - the per-message send function
   * @param {Function} done - the per-message done function
   * @returns {void}
   */
  accept(msg, send, done) {
    this.lastMsg = msg
    const final = msg.complete === true
    if (this.isTerminal()) {
      // The download is over. Pass the rest of the stream straight through, so an
      // upstream source that waits for each output message reaches its end.
      this.passThrough({ msg, send, done, chunk: Buffer.alloc(0), final })
      return
    }
    if (final) {
      this.sawFinal = true
    }
    const sourceError = final ? this.sourceError(msg) : undefined
    if (sourceError) {
      // THE SOURCE FAILED, AND THE FILE MUST FAIL WITH IT. A source ends a failed
      // read with `complete: true` and the configured error property set. Ending the
      // response cleanly here would hand the browser a short file that looks whole.
      // Its payload is not written: it is not data.
      this.queue.push({ msg, send, done, chunk: Buffer.alloc(0), final })
      this.abort("error", tbText(sourceError))
      return
    }
    let chunk
    try {
      chunk = toChunk(msg)
    } catch (error) {
      this.queue.push({ msg, send, done, chunk: Buffer.alloc(0), final })
      this.abort(
        "error",
        this.registry.text(
          "downloadfile.errors.bad_payload",
          `A payload could not be turned into text: ${tbText(error)}`,
          { error: tbText(error) }
        )
      )
      return
    }
    this.queue.push({ msg, send, done, chunk, final })
    this.heldBytes += chunk.length
    if (
      this.heldBytes > this.maxHeldBytes ||
      this.queue.length > this.maxHeldMessages
    ) {
      this.abort(
        "error",
        this.registry.text(
          "downloadfile.errors.too_much_held",
          "Too much data arrived before the browser could take it. Turn on flow control in the source."
        )
      )
      return
    }
    this.pump()
  }
  /**
   * Read the configured error property of a message.
   * @param {any} msg - the input message
   * @returns {any} the value at the property, or `undefined` when the path is
   *   empty or not valid, or when reading it throws
   */
  sourceError(msg) {
    if (typeof this.errorProperty !== "string" || this.errorProperty === "") {
      return undefined
    }
    try {
      return this.RED.util.getMessageProperty(msg, this.errorProperty)
    } catch (_) {
      // A bad path is not a source error; the message is treated as data.
      return undefined
    }
  }
  /**
   * Stop the download, report it, and release every held message.
   *
   * Every held message goes out without being written, and every later message of
   * the same stream does too, until its `msg.complete`. Exactly one message with
   * `complete: true` is added; see the class comment. Safe to call more than once.
   * @param {string} state - expired, cancelled or error
   * @param {string} [error] - the message when `state` is "error"
   * @returns {void}
   */
  abort(state, error) {
    if (this.isTerminal()) {
      return
    }
    this.state = state
    this.error = state === "error" ? error || "Unknown error" : false
    this.clearMaxTimer()
    // In the per-runtime registry, so a node instance built by a redeploy passes the
    // rest of this stream through too.
    this.registry.closeStream({
      streamID: this.streamID,
      info: this.info(),
      nodeKey: nodeKey(this.node),
      finalSeen: this.sawFinal,
    })
    if (this.downloadId) {
      this.registry.release(this.downloadId, true)
    }
    if (this.res && !this.res.writableFinished) {
      // `destroy()` rather than `end()`: no `Content-Length` was sent, so a clean end
      // would hand the browser a short file that looks whole.
      try {
        this.res.destroy()
      } catch (_) {
        // Already gone.
      }
    }
    if (this.error) {
      try {
        this.node.warn(`downloadfile: ${this.error}`)
      } catch (_) {
        // The node is gone.
      }
    }
    this.setStatus()
    const held = this.inFlight ? [this.inFlight].concat(this.queue) : this.queue
    this.inFlight = null
    this.queue = []
    this.heldBytes = 0
    // HELD MESSAGES FIRST, THE `complete` MESSAGE LAST. A flow that reads `complete`
    // as the end must not see data messages after it. A held final message is always
    // the last item: `accept()` treats anything that arrives after it as a message of
    // another stream. So when it is held, it is the terminal message, and it already
    // goes out last.
    for (const item of held) {
      this.passThrough(item)
    }
    if (!held.some((item) => item.final)) {
      // The source's own final message is not here yet, so it cannot carry the
      // state. Send the one terminal message of this node's making.
      this.sendTerminal()
      // The rest of the stream is still to come. Wait for it, but not for ever.
      this.restartIdleTimer()
    }
  }
  /**
   * Start writing into the browser's request. Called by the download route once the
   * ticket is spent.
   * @param {any} req - the Express request
   * @param {any} res - the Express response
   * @returns {void}
   */
  attach(req, res) {
    if (this.isTerminal()) {
      res.sendStatus(404)
      return
    }
    this.req = req
    this.res = res
    // Socket inactivity timeout, raised so flow control against a slow reader or a
    // slow upstream is not mistaken for a dead peer. No callback is given, so the
    // server's default handler destroys the socket, which reaches `close` below.
    req.setTimeout(SOCKET_TIMEOUT_MS)
    res.setTimeout(SOCKET_TIMEOUT_MS)
    if (req.socket) {
      req.socket.setTimeout(SOCKET_TIMEOUT_MS)
    }
    const asciiName = this.filename.replace(/[^\x20-\x7e]/g, "_")
    // RFC 5987 `attr-char` does not include `' ( ) *`, which `encodeURIComponent()`
    // leaves alone. The apostrophe is also the delimiter in `charset'lang'value`.
    const rfc5987Name = encodeURIComponent(this.filename).replace(
      /['()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    )
    res.writeHead(200, {
      "Content-Type": contentTypeFor(this.filename),
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${rfc5987Name}`,
      // `no-transform` tells a proxy not to compress. A compressor buffers, which
      // would undo the flow control this design exists for.
      "Cache-Control": "no-store, no-transform",
      "X-Content-Type-Options": "nosniff",
      // No `Content-Length`: the length is not known until the stream ends.
    })
    res.flushHeaders()
    const onGone = () => {
      if (!this.isTerminal() && !res.writableFinished) {
        this.abort("cancelled")
      }
    }
    // An "error" event with no listener throws and would take the runtime down.
    req.on("error", onGone)
    res.on("error", onGone)
    req.on("aborted", onGone)
    res.on("close", onGone)
    this.maxTimer = setTimeout(() => {
      this.maxTimer = null
      this.abort(
        "error",
        this.registry.text(
          "downloadfile.errors.too_long",
          `The download passed its ${Math.round(
            DOWNLOAD_MAX_MS / 60000
          )} minute limit and was stopped`,
          { minutes: Math.round(DOWNLOAD_MAX_MS / 60000) }
        )
      )
    }, DOWNLOAD_MAX_MS)
    this.state = "streaming"
    this.setStatus(true)
    this.pump()
  }
  /**
   * Build the `msg.download` value for the current moment.
   * @param {string} [state] - the state to report; defaults to the stream's own
   * @returns {DownloadInfo} the download report
   */
  info(state) {
    const reported = state || this.state
    return {
      state: reported,
      filename: this.filename,
      bytes: this.bytes,
      messages: this.messages,
      elapsedMs: Date.now() - this.startedAt,
      error: reported === "error" ? this.error || "Unknown error" : false,
    }
  }
  /**
   * @returns {boolean} `true` once the download has reached done, expired, cancelled or error
   */
  isTerminal() {
    return (
      this.state === "done" ||
      this.state === "expired" ||
      this.state === "cancelled" ||
      this.state === "error"
    )
  }
  /**
   * Record that a user clicked Download. Called by the claim route.
   * @returns {void}
   */
  markClaimed() {
    if (!this.isTerminal()) {
      this.state = "claimed"
    }
  }
  /**
   * Register the download with the editor, or refuse when there is no editor.
   * @returns {void}
   */
  open() {
    if (this.isTerminal()) {
      // The first message already stopped the stream, for example with a payload
      // that could not be turned into text.
      return
    }
    if (!this.registry.available) {
      this.abort(
        "error",
        this.registry.text(
          "downloadfile.errors.no_editor",
          "The editor is not available, so a file download cannot be started"
        )
      )
      return
    }
    this.downloadId = this.registry.register({
      node: this.node,
      stream: this,
      filename: this.filename,
    })
    this.setStatus()
  }
  // ---- internal ------------------------------------------------------------
  /**
   * Stop the idle limit on pass-through.
   * @returns {void}
   */
  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
  /**
   * Stop the four hour limit timer.
   * @returns {void}
   */
  clearMaxTimer() {
    if (this.maxTimer) {
      clearTimeout(this.maxTimer)
      this.maxTimer = null
    }
  }
  /**
   * Send a message whose payload has been written.
   * @param {HeldMessage} item - the message
   * @param {boolean} [terminal] - `true` for the final message of a finished download
   * @returns {void}
   */
  emit(item, terminal) {
    this.messages += 1
    item.msg.download = this.info(terminal ? "done" : "streaming")
    this.deliver(item)
    this.setStatus()
  }
  /**
   * Hand one message to Node-RED and close its `done`. Never throws.
   * @param {HeldMessage} item - the message
   * @returns {void}
   */
  deliver(item) {
    try {
      item.send(item.msg)
    } catch (error) {
      try {
        this.node.warn(`downloadfile: a message could not be sent - ${tbText(error)}`)
      } catch (_) {
        // The node is gone.
      }
    }
    try {
      item.done()
    } catch (_) {
      // Nothing to do; `done` only reports completion.
    }
  }
  /**
   * End the response after the final message's payload, then report `done`.
   * @param {HeldMessage} item - the message that carried `msg.complete`
   * @returns {void}
   */
  endResponse(item) {
    const res = this.res
    this.ending = true
    this.inFlight = item
    const settle = () => {
      res.removeListener("close", settle)
      if (this.isTerminal()) {
        // `close` without `finish` already aborted the stream and released `item`.
        return
      }
      if (!res.writableFinished) {
        this.abort("cancelled")
        return
      }
      this.clearMaxTimer()
      this.inFlight = null
      this.state = "done"
      this.registry.release(this.downloadId, false)
      this.registry.closeStream({
        streamID: this.streamID,
        info: this.info(),
        nodeKey: nodeKey(this.node),
        finalSeen: true,
      })
      this.setStatus()
      this.emit(item, true)
      this.finish()
    }
    if (res.destroyed) {
      settle()
      return
    }
    // Two exits: `end()`'s callback is the bytes leaving, and `close` covers a socket
    // destroyed mid-flush, which never emits `finish`.
    res.once("close", settle)
    res.end(settle)
  }
  /**
   * Mark the stream as over, once.
   * @returns {void}
   */
  finish() {
    this.clearIdleTimer()
    if (this.finished) {
      return
    }
    this.finished = true
    try {
      this.onFinished()
    } catch (_) {
      // The owner is gone.
    }
  }
  /**
   * Send a message on without writing it, after the download is over.
   * @param {HeldMessage} item - the message
   * @returns {void}
   */
  passThrough(item) {
    item.msg.download = this.info()
    this.deliver(item)
    if (item.final) {
      // The source's own end has passed, so no later node instance waits for it.
      this.registry.endTail(nodeKey(this.node))
      this.finish()
      return
    }
    this.restartIdleTimer()
  }
  /**
   * Start, or start again, the idle limit on pass-through after an abort. Does
   * nothing once the stream is finished.
   * @returns {void}
   */
  restartIdleTimer() {
    this.clearIdleTimer()
    if (this.finished) {
      return
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.finish()
      try {
        this.node.status({
          fill: "grey",
          shape: "ring",
          text: this.registry.text("downloadfile.status.idle", "idle"),
        })
      } catch (_) {
        // The node is gone.
      }
    }, PASS_THROUGH_IDLE_MS)
  }
  /**
   * Write held messages into the response while the socket accepts them.
   * @returns {void}
   */
  pump() {
    if (
      !this.res ||
      this.inFlight ||
      this.pumping ||
      this.ending ||
      this.isTerminal()
    ) {
      return
    }
    // `send()` can call back into `accept()` in a test double; the flag keeps the
    // loop below the only writer.
    this.pumping = true
    /** @type {HeldMessage | null} the message taken off the queue and not yet sent */
    let current = null
    try {
      while (this.queue.length && !this.isTerminal()) {
        const item = this.queue.shift()
        current = item
        this.heldBytes -= item.chunk.length
        let ok = true
        if (item.chunk.length) {
          this.bytes += item.chunk.length
          ok = this.res.write(item.chunk)
        }
        current = null
        if (item.final) {
          this.endResponse(item)
          return
        }
        if (!ok) {
          this.inFlight = item
          this.res.once("drain", () => {
            if (this.inFlight !== item || this.isTerminal()) {
              return
            }
            this.inFlight = null
            this.emit(item)
            this.pump()
          })
          return
        }
        this.emit(item)
      }
    } catch (error) {
      if (current) {
        // The write threw, so this message was neither sent nor held. Put it back so
        // `abort()` releases it; a source that waits for each output message waits
        // for it.
        this.queue.unshift(current)
      }
      this.abort("error", tbText(error))
    } finally {
      this.pumping = false
    }
  }
  /**
   * Send the one terminal message of an aborted download.
   * @returns {void}
   */
  sendTerminal() {
    const base = this.lastMsg || {}
    const msg = Object.assign({}, base, {
      payload: "",
      complete: true,
      download: this.info(),
    })
    // NO `_streamID`. With it, a source that waits for each output message could
    // take it as the reply to one of its own messages and send one more, for a
    // message that carries no data.
    delete msg._streamID
    if (this.RED.util && typeof this.RED.util.generateId === "function") {
      msg._msgid = this.RED.util.generateId()
    }
    try {
      this.node.send(msg)
    } catch (error) {
      try {
        this.node.warn(
          `downloadfile: the final message could not be sent - ${tbText(error)}`
        )
      } catch (_) {
        // The node is gone.
      }
    }
  }
  /**
   * Show the stream state on the node.
   * @param {boolean} [force] - `true` to skip the once-per-second limit
   * @returns {void}
   */
  setStatus(force) {
    const text = (key, fallback) =>
      this.registry.text(`downloadfile.status.${key}`, fallback)
    let status
    if (this.state === "waiting") {
      status = {
        fill: "blue",
        shape: "ring",
        text: text("waiting", "waiting for download"),
      }
    } else if (this.state === "claimed" || this.state === "streaming") {
      const now = Date.now()
      if (!force && now - this.lastStatusAt < STATUS_INTERVAL_MS) {
        return
      }
      this.lastStatusAt = now
      status = {
        fill: "blue",
        shape: "dot",
        text: `${text("downloading", "downloading")} (${formatBytes(this.bytes)})`,
      }
    } else if (this.state === "error") {
      status = { fill: "red", shape: "dot", text: text("error", "error") }
    } else {
      status = {
        fill: this.state === "done" ? "green" : "yellow",
        shape: "ring",
        text: `${text("idle", "idle")} (${this.state})`,
      }
    }
    try {
      this.node.status(status)
    } catch (_) {
      // The node is gone.
    }
  }
}

module.exports = {
  DEFAULT_MAX_HELD_BYTES,
  DownloadRegistryFactory,
  DownloadStream,
  nodeKey,
  sanitizeFilename,
  toChunk,
}
