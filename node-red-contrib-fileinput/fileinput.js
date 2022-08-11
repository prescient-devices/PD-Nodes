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
        node.receive({ status: "error", error: globalError })
        return res.sendStatus(404)
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
              status: "start",
              filename: req.body.filename,
            })
            let size = Math.max(1, req.body.size)
            globalHash[req.params.id] = { size, per: 0 }
            return res.sendStatus(200)
          }
          let reqBuf = new Buffer.from("")
          let bytes = 0
          req.on("end", function () {
            if (globalError) {
              globalHash[req.params.id] = null
              globalError = null
              return node.receive({ status: "error", error: globalError })
            }
            //ws.end()
            if (config.stream === "no") {
              node.receive({ payload: reqBuf })
            }
            node.receive({ status: "success" })
            globalHash[req.params.id] = null
            res.sendStatus(200)
          })
          req.on("error", function (error) {
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
              if (config.stream === "yes") {
                node.receive({
                  payload: data,
                  end: bytes === globalHash[req.params.id].size,
                })
              } else {
                reqBuf = Buffer.concat([reqBuf, data])
              }
              const per = Math.round((100 * bytes) / globalHash[req.params.id].size)
              if (per != globalHash[req.params.id].per) {
                globalHash[req.params.id].per = per
                node.receive({ status: "progress", per })
              }
            } catch (error) {
              procError(error, "Data error")
            }
          })
        }
      } catch (error) {
        node.receive({ status: "error", error })
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
    node.on("input", function (inMsg) {
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
      let outMsg = {
        filename: globalFilename,
        end: config.stream === "no" ? true : inMsg.end,
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
}
