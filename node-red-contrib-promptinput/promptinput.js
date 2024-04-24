/**
 * Copyright 2022-Present Prescient Devices, Inc.
 **/

/* jshint laxbreak: true */
/* jshint esversion: 8 */
/* jshint -W030 */
/* jshint -W121 */
/* jshint forin: false */

const fs = require("fs")
const jsonata = require("jsonata")

const globalIsInTest =
  ["true", "1"].includes((process.env["__PDI_TEST__"] || "").toLowerCase()) ||
  typeof global.it === "function"
const globalFailMode = globalIsInTest && process.env["__PDI_TEST_FAIL_MODE__"]
module.exports = function (RED) {
  function errorMsg(arg1, arg2) {
    return globalIsInTest ? arg1 : RED._(arg1, arg2)
  }
  function signalError(node, arg1, arg2) {
    const text = errorMsg(arg1, arg2)
    node.status({ text, fill: "red", shape: "dot" })
    node.error(text)
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
          let msg = { __msgSrc: "editor", payload: req.body.input || "" }
          node.receive(msg)
          return res.sendStatus(200)
        }
      } catch (error) {
        signalError(node, "promptinput.errors.failed", { error: error.toString() })
        res.sendStatus(500)
      }
    }
  )
  function hasValidStringProp(obj, prop) {
    return obj.hasOwnProperty(prop) && typeof obj[prop] === "string" && obj[prop].trim()
  }
  function PromptInput(config) {
    RED.nodes.createNode(this, config)
    let node = this
    let receivedMsg = null
    node.expression = ""
    if (hasValidStringProp(config, "validation")) {
      try {
        node.expression = jsonata(config.validation)
      } catch (_) {
        signalError(node, "promptinput.errors.validation")
        node.expression = null
      }
    }
    node.on("input", async function (inMsg) {
      if (hasValidStringProp(inMsg, "validation")) {
        let tmp
        try {
          tmp = jsonata(inMsg.validation)
          inMsg.__expression = tmp
        } catch (_) {
          signalError(node, "promptinput.errors.validation")
        }
      }
      const { __msgSrc: msgSrc, prompt } = inMsg
      delete inMsg.__msgSrc
      if (msgSrc !== "editor") {
        receivedMsg = inMsg
        RED.events.emit("runtime-event", {
          id: `PROMPT-INPUT-${node.id}`,
          retain: false,
          payload: {
            prompt: typeof prompt === "string" && prompt.trim() ? prompt.trim() : null,
          },
        })
        return
      }
      let expression = node.expression
      if (receivedMsg && receivedMsg.__expression) {
        expression = receivedMsg.__expression
        delete receivedMsg.__expression
      }
      if (expression === null) {
        return node.warn(errorMsg("promptinput.errors.validation_disabled"))
      }
      node.status({})
      let payload = inMsg.payload
      let prop = config.property
      let type = config.datatype
      const validTypes = ["str", "num", "obj", "bool", "buf"]
      if (receivedMsg && hasValidStringProp(receivedMsg, "type")) {
        const msgType = receivedMsg.type.trim().toLowerCase()
        if (validTypes.includes(msgType)) {
          type = msgType
        } else {
          node.warn(errorMsg("promptinput.errors.type_ignored", { type: msgType }))
        }
      }
      for (const item of validTypes) {
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
      let pass = true
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
        if (expression) {
          pass = false
          try {
            const tmp = await expression.evaluate({ [prop]: outMsg[prop] })
            pass = Boolean(tmp)
          } catch (error) {
            return signalError(node, "promptinput.errors.validation_evaluation")
          }
          node.status({
            text: RED._(`promptinput.validation.${pass}`),
            fill: pass ? "green" : "yellow",
            shape: "dot",
          })
        }
      } catch (error) {
        if (globalIsInTest) {
          console.log(error)
        }
        return signalError(node, "promptinput.errors.conversion")
      }
      if (pass) {
        node.send(Object.assign(receivedMsg || {}, obj))
      } else {
        node.warn(errorMsg("promptinput.validation.false"))
      }
      receivedMsg = null
    })
  }
  RED.nodes.registerType("promptinput", PromptInput)
}
