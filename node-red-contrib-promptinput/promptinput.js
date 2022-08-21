/**
 * Copyright 2022-Present Prescient Devices, Inc.
 **/

/* jshint laxbreak: true */
/* jshint esversion: 8 */
/* jshint -W030 */
/* jshint -W121 */
/* jshint forin: false */

const fs = require("fs")
const globalIsInTest =
  ["true", "1"].includes((process.env["__PDI_TEST__"] || "").toLowerCase()) ||
  typeof global.it === "function"
const globalFailMode = globalIsInTest && process.env["__PDI_TEST_FAIL_MODE__"]
module.exports = function (RED) {
  function errorMsg(arg1, arg2) {
    return globalIsInTest ? arg1 : RED._(arg1, arg2)
  }
  RED.httpAdmin.post(
    "/node-red-contrib-promptinput/prompt/:id",
    RED.auth.needsPermission("node-red-contrib-promptinput.write"),
    function (req, res) {
      let node = RED.nodes.getNode(req.params.id)
      if (!node || globalFailMode === "NO-NODE") {
        return res.sendStatus(404)
      }
      try {
        if (globalFailMode === "MESSAGE") {
          throw new Error("Message error")
        }
        if (req.body) {
          let msg = { payload: req.body.input || "" }
          node.receive(msg)
          return res.sendStatus(200)
        }
      } catch (error) {
        node.error(errorMsg("promptinput.errors.failed", { error: error.toString() }))
        res.sendStatus(500)
      }
    }
  )

  function PromptInput(config) {
    RED.nodes.createNode(this, config)
    let node = this
    node.on("input", function (inMsg) {
      node.status({})
      let payload = inMsg.payload
      let prop = config.property
      let type = config.datatype
      for (const item of ["str", "num", "obj", "bool", "buf"]) {
        if (payload.trim().toLowerCase().startsWith(`${item}:`)) {
          type = item
          payload = payload.slice(item.length + 1)
          break
        }
      }
      const props = prop.split(".").map((item) => item.trim())
      if (props.some((item) => !item)) {
        return node.error(errorMsg("promptinput.errors.property"))
      }
      let obj = {}
      let outMsg = obj
      for (let prop of props.slice(0, -1)) {
        outMsg[prop] = {}
        outMsg = outMsg[prop]
      }
      prop = props.slice(-1)[0]
      try {
        if (type === "obj") {
          outMsg[prop] = JSON.parse(payload)
        } else if (type === "buf") {
          outMsg[prop] = Buffer.from(payload)
        } else if (type === "num") {
          outMsg[prop] = Number(payload)
          if (isNaN(outMsg[prop])) {
            return node.error(errorMsg("promptinput.errors.number"))
          }
        } else if (type === "bool") {
          const tmp = payload.toString().trim().toLowerCase()
          if (!["true", "false", "0", "1"].includes(tmp)) {
            return node.error(errorMsg("promptinput.errors.boolean"))
          }
          outMsg[prop] = Boolean(["1", "true"].includes(tmp))
        } else {
          outMsg[prop] = payload.toString()
        }
      } catch (error) {
        console.log(error)
        return node.error(errorMsg("promptinput.errors.conversion"))
      }
      console.log(JSON.stringify(obj))
      node.send(obj)
    })
  }
  RED.nodes.registerType("promptinput", PromptInput)
}
