/**
 * faninout.js
 * Copyright 2024-Present Prescient Devices, Inc.
 **/

module.exports = function (RED) {
  function FanInNode(config) {
    RED.nodes.createNode(this, config)
    let node = this
    node.inputNum = parseInt(config.inputNum)
    if (!(Number.isInteger(node.inputNum) && node.inputNum > 0)) {
      node.error(
        RED._("faninout.errors.illegal_input_number", { num: config.inputNum })
      )
      return
    }
    node.on("input", function (msg) {
      if (msg.hasOwnProperty("_input")) {
        node.warn(RED._("faninout.errors.private_prop_override"))
      }
      msg._input = node.inputNum
      node.send(msg)
    })
  }
  function FanOutNode(config) {
    RED.nodes.createNode(this, config)
    let node = this
    node.outputs = parseInt(config.outputs)
    if (!(Number.isInteger(node.outputs) && node.outputs > 0)) {
      node.error(
        RED._("faninout.errors.illegal_number_of_inputs", { num: config.outputs })
      )
      return
    }
    node.on("input", function (msg) {
      if (!msg.hasOwnProperty("_input")) {
        const outMsg = Array(node.outputs).fill(msg)
        return node.send(outMsg)
      }
      if (
        !(Number.isInteger(msg._input) && msg._input > 0 && msg._input <= node.outputs)
      ) {
        node.warn(
          RED._("faninout.errors.input_number_greater_than_fanout", {
            num: msg._input,
            max: node.outputs,
          })
        )
        return
      }
      const outMsg = Array(node.outputs).fill(null)
      const inputNum = msg._input - 1
      delete msg._input
      outMsg[inputNum] = msg
      node.send(outMsg)
    })
  }
  RED.nodes.registerType("fanin", FanInNode)
  RED.nodes.registerType("fanout", FanOutNode)
}
