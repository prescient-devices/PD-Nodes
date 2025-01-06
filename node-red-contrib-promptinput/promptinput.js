/**
 * Copyright 2022-Present Prescient Devices, Inc.
 **/

/* jshint laxbreak: true */
/* jshint esversion: 8 */
/* jshint -W030 */
/* jshint -W121 */
/* jshint forin: false */

// NodeJS imports
const EventEmitter = require("events")
// npm imports
const jsonata = require("jsonata")

const globalIsInTest =
  ["true", "1"].includes((process.env["__PDI_TEST__"] || "").toLowerCase()) ||
  typeof global.it === "function"
const globalFailMode = globalIsInTest && process.env["__PDI_TEST_FAIL_MODE__"]

function dependencyError(RED, node) {
    const errorKey = "promptinput.errors.dependency"
    const text = globalIsInTest ? errorKey : RED._(errorKey)
    node.status({ text, fill: "red", shape: "dot" })
    node.error(text)
}

class ImportModule extends EventEmitter {
  constructor(RED, node) {
    super()
    this.RED = RED
    this.node = node
    this.getProperty = null
    this.setProperty = null
  }
  async load() {
    this.inProgress = true
    try {
      if (globalFailMode === "dependency") {
        throw new Error("Dependency load error")
      }
      const { getProperty, setProperty } = await import("dot-prop")
      this.getProperty = getProperty
      this.setProperty = setProperty
      this.emit("done", false)
      return
    } catch (_) {}
    this.emit("done", true)
    dependencyError(this.RED, this.node)
  }
  getProperty(obj, prop) {
    return this.getProperty(obj, prop)
  }
  setProperty(obj, prop, value) {
    this.setProperty(obj, prop, value)
  }
}

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
      const node = RED.nodes.getNode(req.params.id)
      if (!node || globalFailMode === "NO-NODE") {
        return res.sendStatus(404)
      }
      try {
        if (globalFailMode === "MESSAGE") {
          throw new Error("Message error")
        }
        if (req.body && typeof req.body.input === "string") {
          const msg = { __msgSrc: "editor", __userInput: req.body.input || "" }
          node.receive(msg)
          return res.sendStatus(200)
        }
        return res.sendStatus()
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
    const modObj = new ImportModule(RED, node)
    const promise = new Promise(function (resolve) {
      modObj.once("done", (result) => resolve(result))
    })
    modObj.load()
    node.on("input", async function (inMsg) {
      const error = await promise
      if (error) {
        dependencyError(RED, node)
        return
      }
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
          id: `PROMPT-INPUT-${node._alias || node.id}`,
          retain: false,
          payload: {
            prompt: typeof prompt === "string" && prompt.trim() ? prompt.trim() : null,
            realId: node.id,
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
      let userInput = inMsg.__userInput
      delete inMsg.__userInput
      if (typeof userInput !== "string") {
        return node.error(errorMsg("promptinput.errors.user_input"))
      }
      let prop =
        receivedMsg && hasValidStringProp(receivedMsg, "prop")
          ? receivedMsg.prop.trim()
          : config.property
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
        if (userInput.trim().toLowerCase().startsWith(`${item}:`)) {
          type = item
          userInput = userInput.slice(item.length + 1)
          break
        }
      }
      const props = prop.split(".").map((item) => item.trim())
      if (props.some((item) => !item)) {
        return node.error(errorMsg("promptinput.errors.property"))
      }
      const outMsg = receivedMsg || {}
      let pass = true
      let value
      try {
        if (type === "obj") {
          value = JSON.parse(userInput)
        } else if (type === "buf") {
          value = Buffer.from(userInput)
        } else if (type === "num") {
          value = Number(userInput)
          if (isNaN(value)) {
            return node.error(errorMsg("promptinput.errors.number"))
          }
        } else if (type === "bool") {
          const tmp = userInput.toString().trim().toLowerCase()
          if (!["true", "false", "0", "1"].includes(tmp)) {
            return node.error(errorMsg("promptinput.errors.boolean"))
          }
          value = Boolean(["1", "true"].includes(tmp))
        } else {
          value = userInput.toString()
        }
        modObj.setProperty(outMsg, prop, value)
        if (expression) {
          pass = false
          try {
            const obj = modObj.setProperty({}, prop, value)
            const tmp = await expression.evaluate(obj)
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
        node.send(outMsg)
      } else {
        node.warn(errorMsg("promptinput.validation.false"))
      }
      receivedMsg = null
    })
  }
  RED.nodes.registerType("promptinput", PromptInput)
}
