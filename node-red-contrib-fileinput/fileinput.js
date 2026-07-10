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
          procError(new Error("Backpressure acknowledgement timeout"), "Backpressure timeout")
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
            node.receive({
              __msgSrc: "editor",
              status: "start",
              filename: req.body.filename,
            })
            let size = Math.max(1, req.body.size)
            globalHash[req.params.id] = {
              size,
              per: 0,
              streamId: `${Date.now().toString(36)}${(globalStreamSeq++).toString(36)}`,
              index: 0,
            }
            return res.sendStatus(200)
          }
          let reqBuf = new Buffer.from("")
          let bytes = 0
          req.on("end", function () {
            cleanupBp()
            if (globalError) {
              globalHash[req.params.id] = null
              globalError = null
              return node.receive({ __msgSrc: "editor", status: "error", error: globalError })
            }
            //ws.end()
            if (!streaming) {
              node.receive({ __msgSrc: "editor", payload: reqBuf })
            }
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
              if (streaming) {
                // self-describing envelope so downstream nodes (e.g. a paced
                // transmitter) can correlate a stream and know its bounds
                const meta = globalHash[req.params.id]
                const chunkMsg = {
                  __msgSrc: "editor",
                  payload: data,
                  streamId: meta.streamId,
                  index: meta.index,
                  start: meta.index === 0,
                  end: bytes === meta.size,
                  size: meta.size,
                }
                meta.index++
                if (backpressure) {
                  // Stop consuming the socket until a downstream
                  // fileinput-backpressure node acknowledges this chunk by
                  // resuming the stream. Because reads stop, TCP flow control
                  // propagates back to the HTTP client and at most one chunk is
                  // in flight through the flow at a time. Pause and register the
                  // resume handle BEFORE dispatching the chunk, so the ack is
                  // honoured even if Node-RED delivers the message synchronously.
                  req.pause()
                  armBpTimer(meta.streamId)
                  globalStreamControls[meta.streamId] = {
                    resume: function () {
                      clearBpTimer()
                      req.resume()
                    },
                  }
                }
                node.receive(chunkMsg)
              } else {
                reqBuf = Buffer.concat([reqBuf, data])
              }
              const per = Math.round((100 * bytes) / globalHash[req.params.id].size)
              if (per != globalHash[req.params.id].per) {
                globalHash[req.params.id].per = per
                node.receive({ __msgSrc: "editor", status: "progress", per })
              }
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
