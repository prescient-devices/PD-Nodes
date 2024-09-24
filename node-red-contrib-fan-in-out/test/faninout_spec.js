/**
 * faninout_spec.js
 * Copyright 2024-present Prescient Devices, Inc.
 **/

// NodeJS imports
const fs = require("fs")
const path = require("path")
// npm imports
const should = require("should")
// Node-RED imports
const helper = require("node-red-node-test-helper")
const nodeRedNodesDir = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "@node-red",
  "nodes"
)
const InjectNode = require(path.resolve(
  nodeRedNodesDir,
  "core",
  "common",
  "20-inject.js"
))
const DebugNode = require(path.resolve(
  nodeRedNodesDir,
  "core",
  "common",
  "21-debug.js"
))

// Local imports
const FanInOutNodes = require(path.resolve(__dirname, "..", "faninout.js"))

const globalNodes = [InjectNode, FanInOutNodes, DebugNode]
const globalExampleFileName = path.resolve(
  __dirname,
  "..",
  "examples",
  "Four virtual inputs.json"
)

// Functions
function delay(ms) {
  return new Promise(function (resolve) {
    let timer = setTimeout(() => {
      clearTimeout(timer)
      return resolve()
    }, ms)
  })
}

function getFlow(config) {
  config = config || {}
  const fname = globalExampleFileName
  const flowArr = JSON.parse(fs.readFileSync(fname))
  const subflowNode = flowArr.find((item) => item.id === "f39a9fc8a7764dea")
  subflowNode.wires[0].push("h1")
  subflowNode.wires[1].push("h2")
  subflowNode.wires[3].push("h4")
  flowArr.push(
    ...[
      { id: "h1", type: "helper" },
      { id: "h2", type: "helper" },
      { id: "h4", type: "helper" },
    ]
  )
  if (config) {
    for (const [id, prop] of Object.entries(config)) {
      for (const node of flowArr) {
        if (node.id === id) {
          Object.assign(node, prop)
        }
      }
    }
  }
  return flowArr
}

function testStartError(config, errorLine) {
  return new Promise(function (resolve) {
    const flowArr = getFlow(config)
    helper.load(globalNodes, flowArr, function () {
      const lines = helper.log().args.map((item) => item[0].msg)
      return resolve(Boolean(lines.find((item) => item === errorLine)))
    })
  })
}

function getAlias(helper, id) {
  const lines = helper.log().args.map((item) => item[0].msg)
  for (const line of lines) {
    const tokens = line.split("|").map((item) => item.trim())
    const nodeId = tokens[0]
    const aliasId = tokens[2]
    if (nodeId === id || aliasId === id) {
      return nodeId
    }
  }
  throw new Error(`Node ID ${id} could not be found`)
}

function testNodeFunctinality(rxId, msg) {
  return new Promise(function (resolve) {
    const flowArr = getFlow()
    let msgs = [null, null, null, null]
    helper.load(globalNodes, flowArr, async function () {
      const n1 = helper.getNode(getAlias(helper, rxId))
      const h1 = helper.getNode(getAlias(helper, "h1"))
      const h2 = helper.getNode(getAlias(helper, "h2"))
      const h4 = helper.getNode(getAlias(helper, "h4"))
      h1.on("input", (arg) => {
        delete arg._msgid
        msgs[0] = arg
      })
      h2.on("input", (arg) => {
        delete arg._msgid
        msgs[1] = arg
      })
      h4.on("input", (arg) => {
        delete arg._msgid
        msgs[3] = arg
      })
      n1.receive(msg)
      await delay(1000)
      return resolve(msgs)
      // console.log(helper.log().args.map((item) => item[0].msg))
    })
  })
}

function testNodeErrorOrWarning(type, config, { rxId, txId }, msg) {
  return new Promise(function (resolve) {
    const flowArr = getFlow(config)
    helper.load(globalNodes, flowArr, function () {
      const n1 = helper.getNode(rxId)
      txId = txId || rxId
      const n2 = helper.getNode(getAlias(helper, txId))
      n1.receive(msg)
      n2.on(type, (arg) => {
        if (type === "input") {
          return resolve(arg)
        }
        return resolve(arg.args[0])
      })
      // console.log(helper.log().args.map((item) => item[0].msg))
    })
  })
}

helper.init(require.resolve("node-red"))

// Tests
describe("node-red-contrib-faninout", function () {
  beforeEach(function (done) {
    helper.startServer(done)
  })
  afterEach(function (done) {
    helper.unload().then(function () {
      return done()
    })
  })
  describe("Errors", function () {
    it("Illegal input number", async function () {
      const act = await testNodeErrorOrWarning(
        "call:error",
        { "0a9ae935d5bedbd7": { inputNum: "a" } },
        { rxId: "0a9ae935d5bedbd7" },
        { payload: "a" }
      )
      act.should.eql("faninout.errors.illegal_input_number")
    })
    it("Illegal number of inputs", async function () {
      const act = await testStartError(
        { "3cafc3ff05670a73": { outputs: "a" } },
        "faninout.errors.illegal_number_of_inputs"
      )
      act.should.be.true
    })
    it("msg._input override", async function () {
      const act = await testNodeErrorOrWarning(
        "call:warn",
        {},
        { rxId: "0a9ae935d5bedbd7" },
        { _input: "a" }
      )
      act.should.eql("faninout.errors.private_prop_override")
    })
    it("Input number greater than fanout", async function () {
      const act = await testNodeErrorOrWarning(
        "call:warn",
        {},
        { rxId: "a8576a2730171262", txId: "3cafc3ff05670a73" },
        { payload: "a" }
      )
      act.should.eql("faninout.errors.input_number_greater_than_fanout")
    })
  })
  describe("Functionality", function () {
    it("Single input", async function () {
      const msg = { payload: "a" }
      const act = await testNodeFunctinality("d35d67e5b548496d", Object.assign({}, msg))
      act.should.eql([null, msg, null, null])
    })
    it("Broadcast", async function () {
      const msg = { payload: "a" }
      const act = await testNodeFunctinality("3cafc3ff05670a73", Object.assign({}, msg))
      act.should.eql([msg, msg, null, msg])
    })
  })
})
