/**
 * downloadfile.js
 *
 * Copyright 2022-Present Prescient Devices, Inc.
 *
 **/

/* jshint laxbreak: true */
/* jshint esversion: 8 */
/* jshint -W030 */
/* jshint -W121 */
/* jshint forin: false */

// NodeJS imports
const path = require("path")
// Local imports
const { DownloadRegistryFactory, DownloadStream, nodeKey, sanitizeFilename } = require(
  path.resolve(__dirname, "downloadfile-stream_core.js")
)

// Constants
// Most foreign `_streamID`s one node remembers having warned about.
const WARNED_STREAMS_MAX = 1000

module.exports = function (RED) {
  // The admin routes of Stream mode are installed when the module loads, so they
  // exist before any flow is deployed and an editor that is already open can reach
  // them.
  const registry = DownloadRegistryFactory(RED)
  /**
   * Stream mode: write a stream of messages into one browser download.
   * @param {any} node - the runtime node
   * @param {any} config - the node configuration
   * @returns {void}
   */
  function setupStreamMode(node, config) {
    /** @type {DownloadStream | null} */
    let stream = null
    // Foreign `_streamID`s already warned about, so a refused stream of thousands of
    // messages writes one warning, not thousands. Cleared when it reaches
    // `WARNED_STREAMS_MAX`, which only costs a repeated warning.
    const warnedStreams = new Set()
    /**
     * Does this message belong to a stream other than the current one?
     * - A message that carries a different `_streamID` does.
     * - A final message that carries a `_streamID` belongs to that stream only. It
     *   never ends a download whose stream had no `_streamID` or another one.
     * - Any message that arrives after the current stream's `msg.complete`, while
     *   that stream is still ending, does.
     * Without a `_streamID`, two streams cannot be told apart in any other way.
     * @param {any} msg - the input message
     * @returns {boolean} `true` when the message is not part of the current stream
     */
    function isOtherStream(msg) {
      if (stream === null) {
        return false
      }
      if (stream.sawFinal && !stream.isTerminal()) {
        return true
      }
      if (typeof msg._streamID !== "string" || !msg._streamID) {
        return false
      }
      if (msg.complete === true) {
        return msg._streamID !== stream.streamID
      }
      return typeof stream.streamID === "string" && msg._streamID !== stream.streamID
    }
    /**
     * Pass on, unwritten, a message of a stream that is already over. The registry
     * remembers such streams across a redeploy of this node.
     * @param {any} msg - the input message
     * @param {Function} send - the per-message send function
     * @param {Function} done - the per-message done function
     * @param {{state: string, error: boolean | string, filename: string}} closed - how that stream ended
     * @returns {void}
     */
    function passClosed(msg, send, done, closed) {
      msg.download = {
        state: closed.state,
        filename: closed.filename,
        bytes: 0,
        messages: 0,
        elapsedMs: 0,
        error: closed.error,
      }
      send(msg)
      done()
    }
    /**
     * Refuse a message of a second stream while a download is still pending, and
     * pass it on unwritten. The registry records the refused `_streamID`, so the rest
     * of that stream is refused too, even after the first download ends. The
     * stream's final message deletes the record.
     * @param {any} msg - the input message
     * @param {Function} send - the per-message send function
     * @param {Function} done - the per-message done function
     * @returns {void}
     */
    function refuse(msg, send, done) {
      const error = registry.text(
        "downloadfile.errors.in_progress",
        "A download is already in progress on this node"
      )
      msg.download = {
        state: "error",
        filename: "",
        bytes: 0,
        messages: 0,
        elapsedMs: 0,
        error,
      }
      registry.refuseStream(msg._streamID, msg.complete === true)
      const key = typeof msg._streamID === "string" ? msg._streamID : ""
      if (!warnedStreams.has(key)) {
        if (warnedStreams.size >= WARNED_STREAMS_MAX) {
          warnedStreams.clear()
        }
        warnedStreams.add(key)
        node.warn(`downloadfile: ${error}`)
      }
      send(msg)
      done()
    }
    node.status({
      fill: "grey",
      shape: "ring",
      text: registry.text("downloadfile.status.idle", "idle"),
    })
    node.on("input", function (msg, send, done) {
      try {
        if (stream && stream.isTerminal() && isOtherStream(msg)) {
          // The old stream was aborted and its `msg.complete` never came. A message
          // of a new stream ends the wait.
          stream.finish()
        }
        const final = msg.complete === true
        const hasID = typeof msg._streamID === "string" && msg._streamID !== ""
        if (hasID && (!stream || stream.streamID !== msg._streamID)) {
          // A message of a stream that is already over, perhaps aborted by the node
          // instance this one replaced in a redeploy. Opening a download for it would
          // give a file with no first part and no header.
          const closed = registry.closedStream(msg._streamID, final)
          if (closed) {
            return passClosed(msg, send, done, closed)
          }
          // A message of a stream refused earlier, because another download was
          // open. The rest of it is refused too, its final message included.
          if (registry.refusedStream(msg._streamID, final)) {
            return refuse(msg, send, done)
          }
        }
        if (!stream && final && !hasID) {
          // FALLBACK for a source whose final message carries no `_streamID`. When
          // this node, or the instance it replaced, stopped a stream before that
          // message came, this is its end: pass it on rather than open an empty
          // download. A source that puts the id on its final message is matched by
          // the test above instead.
          const tail = registry.closedTail(nodeKey(node))
          if (tail) {
            return passClosed(msg, send, done, tail)
          }
        }
        if (stream && isOtherStream(msg)) {
          return refuse(msg, send, done)
        }
        if (!stream) {
          const current = new DownloadStream({
            node,
            RED,
            registry,
            filename: sanitizeFilename(msg.filename || config.filename || "data.txt"),
            streamID: typeof msg._streamID === "string" ? msg._streamID : undefined,
            // `undefined` for a node config that lacks the key; DownloadStream then
            // reads `msg.error`.
            errorProperty: config.errorProperty,
            onFinished: function () {
              if (stream === current) {
                stream = null
              }
            },
          })
          stream = current
          // Accept first, then open: `open()` may refuse at once, and the refusal
          // has to release this first message too.
          current.accept(msg, send, done)
          current.open()
          return
        }
        stream.accept(msg, send, done)
      } catch (error) {
        // The node must never take Node-RED down, and never leave upstream waiting.
        const text = String((error && error.message) || error)
        if (stream) {
          // `accept()` queues the message before anything that can throw, so the
          // abort releases it and closes its `done`.
          node.error(`downloadfile: ${text}`)
          stream.abort("error", text)
          return
        }
        // No stream holds the message, so send it on here: a source that waits for
        // each output message waits for it.
        msg.download = {
          state: "error",
          filename: "",
          bytes: 0,
          messages: 0,
          elapsedMs: 0,
          error: text,
        }
        try {
          send(msg)
        } catch (_) {
          // Nothing more can be done for this message.
        }
        done(error)
      }
    })
    node.on("close", function (removed, done) {
      // `abort()` passes the held messages on, as on every abort. During a redeploy
      // that is NOT a way to keep a stream alive, and nothing relies on it: the
      // source may send its next message, and Node-RED drops that message because
      // this instance is already gone and the new one is not yet started. A source
      // that waits for each output message then waits until its own time limit.
      // Passing the held message on is kept only because it does no harm.
      if (stream) {
        const current = stream
        stream = null
        current.abort(
          "error",
          registry.text(
            "downloadfile.errors.node_closed",
            "The node was stopped or redeployed, so the download was stopped"
          )
        )
        // `abort()` does nothing to a stream that was already aborted, and it starts
        // the pass-through idle timer on one that was not. This node is going away,
        // so end the stream here and clear that timer either way.
        current.finish()
      }
      done()
    })
  }
  function DownloadFile(config) {
    RED.nodes.createNode(this, config)
    let node = this
    if (config.stream === true) {
      return setupStreamMode(node, config)
    }
    node.on("input", function (msg) {
      if (!msg.hasOwnProperty("payload")) {
        node.warn(RED._("downloadfile.warn.no_payload"))
        return
      }
      let encoding =
        config.encoding === "none"
          ? "utf-8"
          : config.encoding === "setbymsg"
            ? msg.encoding || "utf-8"
            : config.encoding
      if (Buffer.isBuffer(msg.payload)) {
        encoding = "base64"
        msg.payload = msg.payload.toString(encoding)
      } else if (typeof msg.payload !== "string") {
        try {
          msg.payload = JSON.stringify(msg.payload)
        } catch (_) {
          node.warn(RED._("downloadfile.warn.cannot_convert_to_string"))
          return
        }
      }
      RED.events.emit("runtime-event", {
        id: `DOWNLOAD-FILE-${node.id}`,
        retain: false,
        payload: {
          filename: msg.filename || config.filename || "data.txt",
          data: msg.payload,
          encoding,
        },
      })
    })
  }
  RED.nodes.registerType("downloadfile", DownloadFile)
}
