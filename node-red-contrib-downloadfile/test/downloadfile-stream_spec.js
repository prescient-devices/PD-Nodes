/**
 * downloadfile-stream_spec.js
 *
 * Copyright 2026-present Prescient Devices, Inc.
 **/

/* jshint esversion: 11 */
/* jshint -W030 */

// NodeJS imports
const { execFileSync } = require("child_process")
const crypto = require("crypto")
const { EventEmitter } = require("events")
const fs = require("fs")
const http = require("http")
const path = require("path")
// Third-party imports
const { expect } = require("chai")
const express = require("express")
const sinon = require("sinon")
// The real Node-RED helper, so the specs exercise its property path syntax.
const { getMessageProperty } = require("@node-red/util").util
// Code under test
const downloadFileModule = require(path.resolve(__dirname, "..", "downloadfile.js"))
const { sanitizeFilename } = require(
  path.resolve(__dirname, "..", "downloadfile-stream_core.js")
)

// Constants
const HOST = "127.0.0.1"
const NOW = 1700000000000
const MIB = 1024 * 1024
const MAX_HELD_BYTES = 16 * MIB
const MAX_HELD_MESSAGES = 10000
const CLOSED_STREAMS_MAX = 1000
const CLOSED_STREAMS_TTL_MS = 10 * 60 * 1000
const REFUSED_STREAMS_MAX = 1000
const REFUSED_STREAMS_TTL_MS = 10 * 60 * 1000
const PASS_THROUGH_IDLE_MS = 10 * 60 * 1000
const ROUTE = "/node-red-contrib-downloadfile"
const TEXT = {
  badPayloadPrefix: "A payload could not be turned into text: ",
  holdCap:
    "Too much data arrived before the browser could take it. Turn on flow control in the source.",
  inProgress: "A download is already in progress on this node",
  noEditor: "The editor is not available, so a file download cannot be started",
  nodeClosed: "The node was stopped or redeployed, so the download was stopped",
}

// ---- helpers ------------------------------------------------------------------

/**
 * Build a fake Node-RED runtime, load the module into it, and optionally serve its
 * admin routes on a real HTTP server.
 * @param {object} [options] - input arguments
 * @param {boolean} [options.editor] - `false` builds a runtime with no admin app
 * @returns {object} the runtime double
 */
function buildRuntime({ editor = true } = {}) {
  const events = new EventEmitter()
  const runtimeEvents = []
  events.on("runtime-event", (event) => runtimeEvents.push(event))
  const permissions = []
  const types = {}
  let idCounter = 0
  const RED = {
    _: (key) => key,
    events,
    util: {
      generateId: () => {
        idCounter += 1
        return `generated-${idCounter}`
      },
      getMessageProperty,
    },
    nodes: {
      createNode(node, config) {
        node.id = config.id
        // Node-RED sets these for a node inside a subflow instance.
        if (config.z !== undefined) {
          node.z = config.z
        }
        if (config._alias !== undefined) {
          node._alias = config._alias
        }
        node.handlers = {}
        node.on = (name, fn) => {
          node.handlers[name] = fn
        }
        node.outputs = []
        node.dones = []
        node.warns = []
        node.errors = []
        node.statuses = []
        node.thrown = []
        node.warn = (text) => node.warns.push(text)
        node.error = (text) => node.errors.push(text)
        node.status = (status) => node.statuses.push(status)
        node.send = (msg) => node.outputs.push(msg)
      },
      registerType(name, ctor) {
        types[name] = ctor
      },
    },
  }
  let app = null
  if (editor) {
    app = express()
    RED.httpAdmin = app
    RED.auth = {
      needsPermission(permission) {
        permissions.push(permission)
        return (req, res, next) => next()
      },
    }
  }
  downloadFileModule(RED)
  const nodes = []
  const runtime = {
    RED,
    app,
    permissions,
    runtimeEvents,
    nodes,
    server: null,
    port: 0,
    createNode(config) {
      const node = new types.downloadfile(Object.assign({ id: "n1" }, config))
      nodes.push(node)
      return node
    },
    async listen() {
      runtime.server = http.createServer(app)
      await new Promise((resolve) => runtime.server.listen(0, HOST, resolve))
      runtime.port = runtime.server.address().port
    },
    async closeAll() {
      for (const node of nodes.splice(0)) {
        await closeNode(node)
      }
      if (runtime.server) {
        const server = runtime.server
        runtime.server = null
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
      }
    },
  }
  return runtime
}

/**
 * Hand one message to a node the way Node-RED 1.x does.
 * @param {any} node - the node double
 * @param {any} msg - the input message
 * @returns {void}
 */
function input(node, msg) {
  const send = (out) => node.outputs.push(out)
  const done = (error) => node.dones.push(error)
  try {
    node.handlers.input(msg, send, done)
  } catch (error) {
    node.thrown.push(String(error && error.message))
  }
}

/**
 * Run a node's close handler and wait for its `done`.
 * @param {any} node - the node double
 * @returns {Promise<void>}
 */
function closeNode(node) {
  if (!node.handlers.close) {
    return Promise.resolve()
  }
  return new Promise((resolve) => node.handlers.close(false, resolve))
}

/**
 * Poll until a condition holds, on the real clock.
 * @param {Function} predicate - the condition
 * @param {number} [timeoutMs] - how long to wait
 * @returns {Promise<void>}
 */
async function waitFor(predicate, timeoutMs = 5000) {
  const start = process.hrtime.bigint()
  while (!predicate()) {
    if (Number(process.hrtime.bigint() - start) / 1e6 > timeoutMs) {
      throw new Error("waitFor: condition not met in time")
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/**
 * Wait a fixed time on the real clock.
 * @param {number} ms - milliseconds
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Open an HTTP request and resolve when the response headers arrive.
 * @param {number} port - the server port
 * @param {string} method - GET or POST
 * @param {string} urlPath - the request path
 * @returns {Promise<{req: http.ClientRequest, res: http.IncomingMessage}>}
 */
function open(port, method, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: HOST, port, path: urlPath, method, agent: false },
      (res) => {
        res.on("error", () => {})
        resolve({ req, res })
      }
    )
    req.on("error", reject)
    req.end()
  })
}

/**
 * Read a response body to its end.
 * @param {http.IncomingMessage} res - the response
 * @returns {Promise<Buffer>}
 */
function readBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = []
    res.on("data", (chunk) => chunks.push(chunk))
    res.on("end", () => resolve(Buffer.concat(chunks)))
    res.on("error", reject)
  })
}

/**
 * Make one whole request and answer its status and parsed body.
 * @param {number} port - the server port
 * @param {string} method - GET or POST
 * @param {string} urlPath - the request path
 * @returns {Promise<{status: number, body: any}>}
 */
async function call(port, method, urlPath) {
  const { res } = await open(port, method, urlPath)
  const raw = (await readBody(res)).toString("utf8")
  let body = raw
  if (/json/.test(res.headers["content-type"] || "")) {
    body = JSON.parse(raw)
  }
  return { status: res.statusCode, body }
}

/**
 * The newest download id a node announced to the editors.
 * @param {object} runtime - the runtime double
 * @param {string} nodeId - the node id
 * @returns {string} the download id
 */
function announcedId(runtime, nodeId) {
  const found = runtime.runtimeEvents.filter(
    (event) =>
      event.id === `STREAM-DOWNLOAD-FILE-${nodeId}` &&
      event.payload.filename !== undefined
  )
  return found[found.length - 1].payload.downloadId
}

/**
 * Claim the newest download of a node and answer its ticket.
 * @param {object} runtime - the runtime double
 * @param {string} nodeId - the node id
 * @returns {Promise<string>} the ticket
 */
async function claim(runtime, nodeId) {
  const downloadId = announcedId(runtime, nodeId)
  const answer = await call(runtime.port, "POST", `${ROUTE}/claim/${downloadId}`)
  expect(answer.status).to.equal(200)
  return answer.body.ticket
}

/**
 * Build the `msg.download` value the node reports.
 * @param {object} fields - the fields that differ from the defaults
 * @returns {object} the download report
 */
function download(fields) {
  return Object.assign(
    {
      state: "streaming",
      filename: "data.txt",
      bytes: 0,
      messages: 0,
      elapsedMs: 0,
      error: false,
    },
    fields
  )
}

/**
 * Build the one terminal message an aborted stream sends.
 * @param {any} base - the latest input message, as it was before any output
 * @param {string} msgid - the generated message id
 * @param {object} info - the download report
 * @returns {object} the terminal message
 */
function terminal(base, msgid, info) {
  return Object.assign({}, base, {
    payload: "",
    complete: true,
    _msgid: msgid,
    download: info,
  })
}

/**
 * Build the `msg.download` value of a message refused as another stream.
 * @returns {object} the download report
 */
function refusedInfo() {
  return {
    state: "error",
    filename: "",
    bytes: 0,
    messages: 0,
    elapsedMs: 0,
    error: TEXT.inProgress,
  }
}

/**
 * Count the downloads the runtime announced to the editors.
 * @param {object} runtime - the runtime double
 * @returns {number} the number of banners raised
 */
function registerCount(runtime) {
  return runtime.runtimeEvents.filter((event) => event.payload.filename !== undefined)
    .length
}

/**
 * Replace a large Buffer payload with a short description, so a comparison stays
 * quick and its failure stays readable.
 * @param {Array<any>} msgs - output messages
 * @returns {Array<any>} copies with big payloads described
 */
function describeBig(msgs) {
  return msgs.map((msg) =>
    Buffer.isBuffer(msg.payload) && msg.payload.length > 1024
      ? Object.assign({}, msg, { payload: digest(msg.payload) })
      : msg
  )
}

/**
 * @param {Buffer} buffer - bytes
 * @returns {string} length and hash of the bytes
 */
function digest(buffer) {
  return `buffer:${buffer.length}:${crypto
    .createHash("sha256")
    .update(buffer)
    .digest("hex")}`
}

/**
 * Count the active resources of the process by type.
 * @returns {object} type -> count
 */
function resourceCounts() {
  const counts = {}
  for (const name of process.getActiveResourcesInfo()) {
    counts[name] = (counts[name] || 0) + 1
  }
  return counts
}

// ---- specs --------------------------------------------------------------------

describe("Downloadfile node", function () {
  this.timeout(20000)
  /** @type {any} */
  let clock = null
  /** @type {Array<any>} */
  let runtimes = []
  /**
   * @param {object} [options] - see buildRuntime
   * @returns {object} a runtime double that afterEach closes
   */
  function runtimeFor(options) {
    const runtime = buildRuntime(options)
    runtimes.push(runtime)
    return runtime
  }
  beforeEach(function () {
    clock = sinon.useFakeTimers({ now: NOW, toFake: ["Date"] })
  })
  afterEach(async function () {
    if (clock) {
      clock.restore()
      clock = null
    }
    for (const runtime of runtimes.splice(0)) {
      await runtime.closeAll()
    }
  })

  describe("Stream off", function () {
    it("Should emit the whole string payload as one runtime event", function () {
      const runtime = runtimeFor()
      const node = runtime.createNode({ filename: "trial", encoding: "none" })
      input(node, { payload: "a,b\n1,2\n" })
      const expected = [
        {
          id: "DOWNLOAD-FILE-n1",
          retain: false,
          payload: { filename: "trial", data: "a,b\n1,2\n", encoding: "utf-8" },
        },
      ]
      expect(runtime.runtimeEvents).to.deep.equal(expected)
    })
    it("Should take the file name and encoding from the message when set by msg", function () {
      const runtime = runtimeFor()
      const node = runtime.createNode({ filename: "trial", encoding: "setbymsg" })
      input(node, { payload: "x", filename: "other.csv", encoding: "latin1" })
      const expected = [
        {
          id: "DOWNLOAD-FILE-n1",
          retain: false,
          payload: { filename: "other.csv", data: "x", encoding: "latin1" },
        },
      ]
      expect(runtime.runtimeEvents).to.deep.equal(expected)
    })
    it("Should serialise an object payload as plain JSON", function () {
      const runtime = runtimeFor()
      const node = runtime.createNode({ encoding: "utf-8" })
      const payload = { a: 1, b: [2, "three"], c: { d: null } }
      input(node, { payload })
      const expected = [
        {
          id: "DOWNLOAD-FILE-n1",
          retain: false,
          payload: {
            filename: "data.txt",
            data: '{"a":1,"b":[2,"three"],"c":{"d":null}}',
            encoding: "utf-8",
          },
        },
      ]
      expect(runtime.runtimeEvents).to.deep.equal(expected)
    })
    it("Should send a Buffer payload to the editor as base64", function () {
      const runtime = runtimeFor()
      const node = runtime.createNode({ filename: "bytes.bin", encoding: "none" })
      input(node, { payload: Buffer.from([0x68, 0x69, 0x00, 0xff]) })
      const expected = [
        {
          id: "DOWNLOAD-FILE-n1",
          retain: false,
          payload: { filename: "bytes.bin", data: "aGkA/w==", encoding: "base64" },
        },
      ]
      expect(runtime.runtimeEvents).to.deep.equal(expected)
    })
  })

  describe("Stream on - happy path", function () {
    it("Should guard the claim and cancel routes with downloadfile.read", function () {
      const runtime = runtimeFor()
      expect(runtime.permissions).to.deep.equal([
        "downloadfile.read",
        "downloadfile.read",
      ])
    })
    it("Should write every payload into one download and send one output per input", async function () {
      const runtime = runtimeFor()
      await runtime.listen()
      const node = runtime.createNode({ stream: true, filename: "fallback.txt" })
      const m1 = { _msgid: "m1", payload: "hello,", filename: "résumé (1).csv" }
      const m2 = { _msgid: "m2", payload: Buffer.from("world", "utf8") }
      input(node, m1)
      input(node, m2)
      expect(node.outputs).to.deep.equal([])
      const downloadId = announcedId(runtime, "n1")
      const ticket = await claim(runtime, "n1")
      const { res } = await open(runtime.port, "GET", `${ROUTE}/download/${ticket}`)
      const bodyPromise = readBody(res)
      const m3 = { _msgid: "m3", payload: { a: 1 } }
      const m4 = { _msgid: "m4", payload: "end", complete: true }
      input(node, m3)
      input(node, m4)
      const body = await bodyPromise
      await waitFor(() => node.outputs.length === 4)
      const filename = "résumé (1).csv"
      const headers = {
        status: res.statusCode,
        "content-type": res.headers["content-type"],
        "content-disposition": res.headers["content-disposition"],
        "cache-control": res.headers["cache-control"],
        "x-content-type-options": res.headers["x-content-type-options"],
        "content-length": res.headers["content-length"],
        "transfer-encoding": res.headers["transfer-encoding"],
      }
      const expectedHeaders = {
        status: 200,
        "content-type": "text/csv; charset=utf-8",
        "content-disposition":
          "attachment; filename=\"r_sum_ (1).csv\"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%281%29.csv",
        "cache-control": "no-store, no-transform",
        "x-content-type-options": "nosniff",
        "content-length": undefined,
        "transfer-encoding": "chunked",
      }
      const expectedOutputs = [
        Object.assign({}, m1, {
          download: download({ filename, bytes: 6, messages: 1 }),
        }),
        Object.assign({}, m2, {
          download: download({ filename, bytes: 11, messages: 2 }),
        }),
        Object.assign({}, m3, {
          download: download({ filename, bytes: 19, messages: 3 }),
        }),
        Object.assign({}, m4, {
          download: download({ state: "done", filename, bytes: 22, messages: 4 }),
        }),
      ]
      const expectedEvents = [
        {
          id: "STREAM-DOWNLOAD-FILE-n1",
          retain: false,
          payload: { realId: "n1", downloadId, filename },
        },
        {
          id: "STREAM-DOWNLOAD-FILE-n1",
          retain: false,
          payload: { realId: "n1", downloadId, claimed: true },
        },
      ]
      expect({
        body: body.toString("utf8"),
        headers,
        outputs: node.outputs,
        dones: node.dones,
        events: runtime.runtimeEvents,
        warns: node.warns,
      }).to.deep.equal({
        body: 'hello,world{"a":1}\nend',
        headers: expectedHeaders,
        outputs: expectedOutputs,
        dones: [undefined, undefined, undefined, undefined],
        events: expectedEvents,
        warns: [],
      })
    })
    it("Should pick the Content-Type from the file extension", async function () {
      const runtime = runtimeFor()
      await runtime.listen()
      const node = runtime.createNode({ stream: true })
      const seen = {}
      for (const name of ["a.csv", "b.txt", "c.log", "d.json", "e.bin"]) {
        input(node, { payload: "x", filename: name, complete: true })
        const ticket = await claim(runtime, "n1")
        const { res } = await open(runtime.port, "GET", `${ROUTE}/download/${ticket}`)
        await readBody(res)
        seen[name] = res.headers["content-type"]
        await waitFor(() => node.dones.length === Object.keys(seen).length)
      }
      const expected = {
        "a.csv": "text/csv; charset=utf-8",
        "b.txt": "text/plain; charset=utf-8",
        "c.log": "text/plain; charset=utf-8",
        "d.json": "application/json; charset=utf-8",
        "e.bin": "application/octet-stream",
      }
      expect(seen).to.deep.equal(expected)
    })
  })

  describe("Stream on - flow control", function () {
    it("Should hold the output until a paused reader drains the write", async function () {
      const runtime = runtimeFor()
      await runtime.listen()
      const node = runtime.createNode({ stream: true, filename: "big.bin" })
      input(node, { _msgid: "m0", payload: "" })
      const ticket = await claim(runtime, "n1")
      const { res } = await open(runtime.port, "GET", `${ROUTE}/download/${ticket}`)
      await waitFor(() => node.outputs.length === 1)
      // The reader does not read. 12 MiB cannot fit in the socket buffers, so the
      // write returns false and the output must wait for `drain`.
      const big = Buffer.alloc(12 * MIB, 0x61)
      const m1 = { _msgid: "m1", payload: big }
      input(node, m1)
      await sleep(300)
      const beforeRead = describeBig(node.outputs.slice(1))
      const bodyPromise = readBody(res)
      await waitFor(() => node.outputs.length === 2)
      const m2 = { _msgid: "m2", payload: "!", complete: true }
      input(node, m2)
      const body = await bodyPromise
      await waitFor(() => node.outputs.length === 3)
      const expected = {
        beforeRead: [],
        body: digest(Buffer.concat([big, Buffer.from("!")])),
        outputs: [
          {
            _msgid: "m1",
            payload: digest(big),
            download: download({ filename: "big.bin", bytes: 12 * MIB, messages: 2 }),
          },
          Object.assign({}, m2, {
            download: download({
              state: "done",
              filename: "big.bin",
              bytes: 12 * MIB + 1,
              messages: 3,
            }),
          }),
        ],
      }
      expect({
        beforeRead,
        body: digest(body),
        outputs: describeBig(node.outputs.slice(1)),
      }).to.deep.equal(expected)
    })
    it("Should write messages held before the click in their input order", async function () {
      const runtime = runtimeFor()
      await runtime.listen()
      const node = runtime.createNode({ stream: true })
      const inputs = ["1", "22", "333", "4444"].map((payload, index) => ({
        _msgid: `m${index}`,
        payload,
      }))
      inputs.push({ _msgid: "m4", payload: "55555", complete: true })
      for (const msg of inputs) {
        input(node, msg)
      }
      const heldOutputs = node.outputs.slice()
      const ticket = await claim(runtime, "n1")
      const { res } = await open(runtime.port, "GET", `${ROUTE}/download/${ticket}`)
      const body = await readBody(res)
      await waitFor(() => node.outputs.length === 5)
      let bytes = 0
      const expectedOutputs = inputs.map((msg, index) => {
        bytes += msg.payload.length
        return Object.assign({}, msg, {
          download: download({
            state: index === 4 ? "done" : "streaming",
            bytes,
            messages: index + 1,
          }),
        })
      })
      expect({
        heldOutputs,
        body: body.toString("utf8"),
        outputs: node.outputs,
      }).to.deep.equal({
        heldOutputs: [],
        body: "1223334444" + "55555",
        outputs: expectedOutputs,
      })
    })
  })

  describe("Stream on - route guards", function () {
    it("Should answer 409 to a second claim of the same download", async function () {
      const runtime = runtimeFor()
      await runtime.listen()
      const node = runtime.createNode({ stream: true })
      input(node, { payload: "x" })
      const downloadId = announcedId(runtime, "n1")
      const first = await call(runtime.port, "POST", `${ROUTE}/claim/${downloadId}`)
      const second = await call(runtime.port, "POST", `${ROUTE}/claim/${downloadId}`)
      expect({ first: first.status, second }).to.deep.equal({
        first: 200,
        second: { status: 409, body: { error: "already claimed", code: "claimed" } },
      })
    })
    it("Should answer 404 to a ticket used a second time", async function () {
      const runtime = runtimeFor()
      await runtime.listen()
      const node = runtime.createNode({ stream: true })
      input(node, { payload: "x" })
      const ticket = await claim(runtime, "n1")
      const { res } = await open(runtime.port, "GET", `${ROUTE}/download/${ticket}`)
      readBody(res).catch(() => {})
      const again = await call(runtime.port, "GET", `${ROUTE}/download/${ticket}`)
      expect({ first: res.statusCode, again: again.status }).to.deep.equal({
        first: 200,
        again: 404,
      })
    })
    it("Should answer 404 to ids that do not match 32 lowercase hex characters", async function () {
      const runtime = runtimeFor()
      await runtime.listen()
      const node = runtime.createNode({ stream: true })
      input(node, { payload: "x" })
      const valid = announcedId(runtime, "n1")
      const bad = [valid.toUpperCase(), valid.slice(1), `${valid}0`, "g".repeat(32)]
      const seen = []
      for (const id of bad) {
        for (const route of ["claim", "cancel"]) {
          seen.push(
            (await call(runtime.port, "POST", `${ROUTE}/${route}/${id}`)).status
          )
        }
        seen.push((await call(runtime.port, "GET", `${ROUTE}/download/${id}`)).status)
      }
      const unknown = "0".repeat(32)
      const unknownAnswers = [
        (await call(runtime.port, "POST", `${ROUTE}/claim/${unknown}`)).status,
        (await call(runtime.port, "POST", `${ROUTE}/cancel/${unknown}`)).status,
        (await call(runtime.port, "GET", `${ROUTE}/download/${unknown}`)).status,
      ]
      // The download is still waiting: none of the bad calls touched it.
      const stillOpen = await call(runtime.port, "POST", `${ROUTE}/claim/${valid}`)
      expect({ seen, unknownAnswers, stillOpen: stillOpen.status }).to.deep.equal({
        seen: new Array(12).fill(404),
        unknownAnswers: [404, 200, 404],
        stillOpen: 200,
      })
    })
    it("Should answer 503 to the ninth concurrent claim", async function () {
      const runtime = runtimeFor()
      await runtime.listen()
      const ids = []
      for (let index = 0; index < 9; index += 1) {
        const node = runtime.createNode({ id: `n${index}`, stream: true })
        input(node, { payload: "x" })
        ids.push(announcedId(runtime, `n${index}`))
      }
      const statuses = []
      for (const id of ids.slice(0, 8)) {
        statuses.push((await call(runtime.port, "POST", `${ROUTE}/claim/${id}`)).status)
      }
      const ninth = await call(runtime.port, "POST", `${ROUTE}/claim/${ids[8]}`)
      expect({ statuses, ninth }).to.deep.equal({
        statuses: new Array(8).fill(200),
        ninth: {
          status: 503,
          body: { error: "too many downloads in progress", code: "busy" },
        },
      })
    })
    it("Should answer 409 to a cancel while bytes are moving", async function () {
      const runtime = runtimeFor()
      await runtime.listen()
      const node = runtime.createNode({ stream: true })
      input(node, { payload: "x" })
      const downloadId = announcedId(runtime, "n1")
      const ticket = await claim(runtime, "n1")
      const { res } = await open(runtime.port, "GET", `${ROUTE}/download/${ticket}`)
      readBody(res).catch(() => {})
      const cancel = await call(runtime.port, "POST", `${ROUTE}/cancel/${downloadId}`)
      expect(cancel).to.deep.equal({
        status: 409,
        body: { error: "download in progress", code: "streaming" },
      })
    })
  })

  describe("Stream on - abort paths", function () {
    it("Should report cancelled on Dismiss and pass the rest of the stream through", async function () {
      const runtime = runtimeFor()
      await runtime.listen()
      const node = runtime.createNode({ stream: true })
      const m1 = { _msgid: "m1", payload: "a" }
      input(node, m1)
      const downloadId = announcedId(runtime, "n1")
      const cancel = await call(runtime.port, "POST", `${ROUTE}/cancel/${downloadId}`)
      const m2 = { _msgid: "m2", payload: "b" }
      const m3 = { _msgid: "m3", payload: "c", complete: true }
      input(node, m2)
      input(node, m3)
      const cancelled = download({ state: "cancelled" })
      const expectedOutputs = [
        Object.assign({}, m1, { download: cancelled }),
        terminal({ _msgid: "m1", payload: "a" }, "generated-1", cancelled),
        Object.assign({}, m2, { download: cancelled }),
        Object.assign({}, m3, { download: cancelled }),
      ]
      const expectedEvents = [
        {
          id: "STREAM-DOWNLOAD-FILE-n1",
          retain: false,
          payload: { realId: "n1", downloadId, filename: "data.txt" },
        },
        {
          id: "STREAM-DOWNLOAD-FILE-n1",
          retain: false,
          payload: { realId: "n1", downloadId, expired: true },
        },
      ]
      expect({
        cancel: cancel.status,
        outputs: node.outputs,
        dones: node.dones,
        events: runtime.runtimeEvents,
      }).to.deep.equal({
        cancel: 200,
        outputs: expectedOutputs,
        dones: [undefined, undefined, undefined],
        events: expectedEvents,
      })
    })
    it("Should start a new stream with the message after the complete one", async function () {
      const runtime = runtimeFor()
      await runtime.listen()
      const node = runtime.createNode({ stream: true })
      input(node, { payload: "a" })
      const firstId = announcedId(runtime, "n1")
      await call(runtime.port, "POST", `${ROUTE}/cancel/${firstId}`)
      input(node, { payload: "b", complete: true })
      const before = node.outputs.length
      input(node, { payload: "c" })
      const secondId = announcedId(runtime, "n1")
      expect({
        newId: secondId !== firstId,
        idFormat: /^[0-9a-f]{32}$/.test(secondId),
        newOutputs: node.outputs.length - before,
      }).to.deep.equal({ newId: true, idFormat: true, newOutputs: 0 })
    })
    it("Should report cancelled when the browser disconnects mid-download", async function () {
      const runtime = runtimeFor()
      await runtime.listen()
      const node = runtime.createNode({ stream: true })
      const ticket = await (async () => {
        input(node, { _msgid: "m0", payload: "" })
        return claim(runtime, "n1")
      })()
      const { req, res } = await open(
        runtime.port,
        "GET",
        `${ROUTE}/download/${ticket}`
      )
      req.on("error", () => {})
      res.on("data", () => {})
      const m1 = { _msgid: "m1", payload: "abc" }
      input(node, m1)
      await waitFor(() => node.outputs.length === 2)
      req.destroy()
      await waitFor(() => node.outputs.length === 3)
      const m2 = { _msgid: "m2", payload: "d", complete: true }
      input(node, m2)
      const cancelled = download({ state: "cancelled", bytes: 3, messages: 2 })
      const expectedOutputs = [
        { _msgid: "m0", payload: "", download: download({ messages: 1 }) },
        Object.assign({}, m1, { download: download({ bytes: 3, messages: 2 }) }),
        terminal({ _msgid: "m1", payload: "abc" }, "generated-1", cancelled),
        Object.assign({}, m2, { download: cancelled }),
      ]
      expect(node.outputs).to.deep.equal(expectedOutputs)
    })
    it("Should stop with a flow control error when held bytes pass 16 MiB", function () {
      const runtime = runtimeFor()
      const node = runtime.createNode({ stream: true })
      const m1 = { _msgid: "m1", payload: Buffer.alloc(MAX_HELD_BYTES, 0x62) }
      input(node, m1)
      const afterExact = node.outputs.length
      const m2 = { _msgid: "m2", payload: "z" }
      input(node, m2)
      const failed = download({ state: "error", error: TEXT.holdCap })
      const expected = {
        afterExact: 0,
        outputs: [
          { _msgid: "m1", payload: digest(m1.payload), download: failed },
          Object.assign({}, m2, { download: failed }),
          terminal({ _msgid: "m2", payload: "z" }, "generated-1", failed),
        ],
        warns: [`downloadfile: ${TEXT.holdCap}`],
      }
      expect({
        afterExact,
        outputs: describeBig(node.outputs),
        warns: node.warns,
      }).to.deep.equal(expected)
    })
    it("Should stop with a flow control error past 10,000 held messages", function () {
      const runtime = runtimeFor()
      const node = runtime.createNode({ stream: true })
      for (let index = 0; index < MAX_HELD_MESSAGES; index += 1) {
        input(node, { payload: "" })
      }
      const afterExact = node.outputs.length
      input(node, { payload: "" })
      const failed = download({ state: "error", error: TEXT.holdCap })
      const states = node.outputs.map((msg) => msg.download)
      const expectedStates = new Array(MAX_HELD_MESSAGES + 2).fill(failed)
      expect({
        afterExact,
        last: node.outputs[node.outputs.length - 1],
        states,
        warns: node.warns,
      }).to.deep.equal({
        afterExact: 0,
        last: terminal({ payload: "" }, "generated-1", failed),
        states: expectedStates,
        warns: [`downloadfile: ${TEXT.holdCap}`],
      })
    })
    it("Should refuse Stream mode with no editor and pass the stream through", function () {
      const runtime = runtimeFor({ editor: false })
      const node = runtime.createNode({ stream: true })
      const m1 = { _msgid: "m1", payload: "a" }
      const m2 = { _msgid: "m2", payload: "b", complete: true }
      input(node, m1)
      input(node, m2)
      const failed = download({ state: "error", error: TEXT.noEditor })
      expect({
        outputs: node.outputs,
        events: runtime.runtimeEvents,
        warns: node.warns,
      }).to.deep.equal({
        outputs: [
          Object.assign({}, m1, { download: failed }),
          terminal({ _msgid: "m1", payload: "a" }, "generated-1", failed),
          Object.assign({}, m2, { download: failed }),
        ],
        events: [],
        warns: [`downloadfile: ${TEXT.noEditor}`],
      })
    })
    it("Should stop with an error when a payload cannot become JSON", function () {
      const runtime = runtimeFor()
      const node = runtime.createNode({ stream: true })
      const payload = { a: 1 }
      payload.self = payload
      let reason = ""
      try {
        JSON.stringify(payload)
      } catch (error) {
        reason = error.message
      }
      const m1 = { _msgid: "m1", payload }
      input(node, m1)
      const failed = download({
        state: "error",
        error: `${TEXT.badPayloadPrefix}${reason}`,
      })
      expect({ outputs: node.outputs, events: runtime.runtimeEvents }).to.deep.equal({
        outputs: [
          Object.assign({}, m1, { download: failed }),
          terminal({ _msgid: "m1", payload }, "generated-1", failed),
        ],
        events: [],
      })
    })
    it("Should send one terminal message when the node closes", async function () {
      const runtime = runtimeFor()
      const node = runtime.createNode({ stream: true })
      const m1 = { _msgid: "m1", payload: "a" }
      input(node, m1)
      const downloadId = announcedId(runtime, "n1")
      await closeNode(node)
      const failed = download({ state: "error", error: TEXT.nodeClosed })
      expect({
        outputs: node.outputs,
        dones: node.dones,
        lastEvent: runtime.runtimeEvents[runtime.runtimeEvents.length - 1],
      }).to.deep.equal({
        outputs: [
          Object.assign({}, m1, { download: failed }),
          terminal({ _msgid: "m1", payload: "a" }, "generated-1", failed),
        ],
        dones: [undefined],
        lastEvent: {
          id: "STREAM-DOWNLOAD-FILE-n1",
          retain: false,
          payload: { realId: "n1", downloadId, expired: true },
        },
      })
    })
    it("Should end the pass-through after 10 idle minutes and start a new stream", function () {
      clock.restore()
      clock = sinon.useFakeTimers({
        now: NOW,
        toFake: ["Date", "setTimeout", "clearTimeout"],
      })
      const runtime = runtimeFor({ editor: false })
      const node = runtime.createNode({ stream: true })
      input(node, { _msgid: "m1", payload: "a" })
      clock.tick(PASS_THROUGH_IDLE_MS - 1)
      input(node, { _msgid: "m2", payload: "b" })
      clock.tick(PASS_THROUGH_IDLE_MS - 1)
      input(node, { _msgid: "m3", payload: "c" })
      const passThroughIds = node.outputs.map((msg) => msg._msgid)
      clock.tick(PASS_THROUGH_IDLE_MS)
      const idleStatus = node.statuses[node.statuses.length - 1]
      input(node, { _msgid: "m4", payload: "d" })
      const afterIdleIds = node.outputs
        .slice(passThroughIds.length)
        .map((msg) => [msg._msgid, msg.download.state, msg.complete === true])
      expect({ passThroughIds, idleStatus, afterIdleIds }).to.deep.equal({
        // m1 passes through, then the one terminal message of its stream, then m2
        // and m3 pass through.
        passThroughIds: ["m1", "generated-1", "m2", "m3"],
        idleStatus: { fill: "grey", shape: "ring", text: "idle" },
        // m4 starts a new stream, which gets its own terminal message, last.
        afterIdleIds: [
          ["m4", "error", false],
          ["generated-2", "error", true],
        ],
      })
    })
  })

  describe("Stream on - second stream", function () {
    it("Should refuse a message of another stream while one is open", function () {
      const runtime = runtimeFor()
      const node = runtime.createNode({ stream: true })
      input(node, { _msgid: "a1", _streamID: "A", payload: "a" })
      const b1 = { _msgid: "b1", _streamID: "B", payload: "b" }
      input(node, b1)
      input(node, { _msgid: "a2", _streamID: "A", payload: "a" })
      expect({
        outputs: node.outputs,
        dones: node.dones,
        warns: node.warns,
        announced: runtime.runtimeEvents.length,
      }).to.deep.equal({
        outputs: [
          Object.assign({}, b1, {
            download: {
              state: "error",
              filename: "",
              bytes: 0,
              messages: 0,
              elapsedMs: 0,
              error: TEXT.inProgress,
            },
          }),
        ],
        dones: [undefined],
        warns: [`downloadfile: ${TEXT.inProgress}`],
        announced: 1,
      })
    })
    it("Should warn once per foreign stream, not once per message", function () {
      const runtime = runtimeFor()
      const node = runtime.createNode({ stream: true })
      input(node, { _msgid: "a1", _streamID: "A", payload: "a" })
      const foreign = [
        { _msgid: "b1", _streamID: "B", payload: "1" },
        { _msgid: "b2", _streamID: "B", payload: "2" },
        { _msgid: "b3", _streamID: "B", payload: "3" },
        { _msgid: "c1", _streamID: "C", payload: "4" },
        { _msgid: "c2", _streamID: "C", payload: "5" },
      ]
      for (const msg of foreign) {
        input(node, msg)
      }
      expect({ outputs: node.outputs, warns: node.warns }).to.deep.equal({
        outputs: foreign.map((msg) =>
          Object.assign({}, msg, { download: refusedInfo() })
        ),
        warns: [`downloadfile: ${TEXT.inProgress}`, `downloadfile: ${TEXT.inProgress}`],
      })
    })
    it("Should refuse a message that arrives after the final message before the click", function () {
      const runtime = runtimeFor()
      const node = runtime.createNode({ stream: true })
      input(node, { _msgid: "m1", payload: "a", complete: true })
      const m2 = { _msgid: "m2", payload: "b" }
      input(node, m2)
      expect({
        outputs: node.outputs,
        registers: registerCount(runtime),
      }).to.deep.equal({
        outputs: [Object.assign({}, m2, { download: refusedInfo() })],
        registers: 1,
      })
    })
    it("Should refuse a message that arrives while the response is ending", async function () {
      const runtime = runtimeFor()
      await runtime.listen()
      const node = runtime.createNode({ stream: true })
      const m0 = { _msgid: "m0", payload: "a" }
      input(node, m0)
      const ticket = await claim(runtime, "n1")
      const { res } = await open(runtime.port, "GET", `${ROUTE}/download/${ticket}`)
      const bodyPromise = readBody(res)
      await waitFor(() => node.outputs.length === 1)
      const final = { _msgid: "mf", payload: "b", complete: true }
      const late = { _msgid: "mx", payload: "x" }
      input(node, final)
      input(node, late)
      const body = await bodyPromise
      await waitFor(() => node.outputs.length === 3)
      expect({ body: body.toString("utf8"), outputs: node.outputs }).to.deep.equal({
        body: "ab",
        outputs: [
          Object.assign({}, m0, { download: download({ bytes: 1, messages: 1 }) }),
          Object.assign({}, late, { download: refusedInfo() }),
          Object.assign({}, final, {
            download: download({ state: "done", bytes: 2, messages: 2 }),
          }),
        ],
      })
    })
  })

  describe("Stream on - source error in the final message", function () {
    it("Should destroy the response and report the source error after the click", async function () {
      const runtime = runtimeFor()
      await runtime.listen()
      const node = runtime.createNode({ stream: true })
      const m0 = { _msgid: "m0", payload: "abc" }
      input(node, m0)
      const downloadId = announcedId(runtime, "n1")
      const ticket = await claim(runtime, "n1")
      const { req, res } = await open(
        runtime.port,
        "GET",
        `${ROUTE}/download/${ticket}`
      )
      req.on("error", () => {})
      const chunks = []
      res.on("data", (chunk) => chunks.push(chunk))
      const closed = new Promise((resolve) =>
        res.on("close", () => resolve(res.complete))
      )
      await waitFor(() => node.outputs.length === 1)
      const m1 = {
        _msgid: "m1",
        payload: "not data",
        complete: true,
        error: "query failed",
      }
      input(node, m1)
      const cleanEnd = await closed
      const failed = download({
        state: "error",
        bytes: 3,
        messages: 1,
        error: "query failed",
      })
      expect({
        cleanEnd,
        body: Buffer.concat(chunks).toString("utf8"),
        outputs: node.outputs,
        events: runtime.runtimeEvents.map((event) => event.payload),
        warns: node.warns,
      }).to.deep.equal({
        cleanEnd: false,
        body: "abc",
        outputs: [
          Object.assign({}, m0, { download: download({ bytes: 3, messages: 1 }) }),
          Object.assign({}, m1, { download: failed }),
        ],
        events: [
          { realId: "n1", downloadId, filename: "data.txt" },
          { realId: "n1", downloadId, claimed: true },
          { realId: "n1", downloadId, expired: true },
        ],
        warns: ["downloadfile: query failed"],
      })
    })
    it("Should take the banner down and report the source error before the click", function () {
      const runtime = runtimeFor()
      const node = runtime.createNode({ stream: true })
      const m0 = { _msgid: "m0", payload: "a" }
      const m1 = {
        _msgid: "m1",
        payload: "b",
        complete: true,
        error: new Error("read failed"),
      }
      input(node, m0)
      const downloadId = announcedId(runtime, "n1")
      input(node, m1)
      const failed = download({ state: "error", error: "read failed" })
      expect({
        outputs: node.outputs,
        completes: node.outputs.filter((msg) => msg.complete === true).length,
        events: runtime.runtimeEvents.map((event) => event.payload),
      }).to.deep.equal({
        outputs: [
          Object.assign({}, m0, { download: failed }),
          Object.assign({}, m1, { download: failed }),
        ],
        completes: 1,
        events: [
          { realId: "n1", downloadId, filename: "data.txt" },
          { realId: "n1", downloadId, expired: true },
        ],
      })
    })
  })

  describe("Stream on - error property", function () {
    const FIRST = { _msgid: "m0", payload: "abc" }
    /**
     * Run a two-message stream through a claimed download: one message after the
     * click, then the final message.
     * @param {object} config - the node config, `stream: true` added
     * @param {object} first - the first message
     * @param {object} final - the final message
     * @returns {Promise<object>} what the browser and the flow saw
     */
    async function runStream(config, first, final) {
      const runtime = runtimeFor()
      await runtime.listen()
      const node = runtime.createNode(Object.assign({ stream: true }, config))
      input(node, first)
      const ticket = await claim(runtime, "n1")
      const { req, res } = await open(
        runtime.port,
        "GET",
        `${ROUTE}/download/${ticket}`
      )
      req.on("error", () => {})
      const chunks = []
      res.on("data", (chunk) => chunks.push(chunk))
      const closed = new Promise((resolve) =>
        res.on("close", () => resolve(res.complete))
      )
      await waitFor(() => node.outputs.length === 1)
      input(node, final)
      const cleanEnd = await closed
      await waitFor(() => node.outputs.length === 2)
      return {
        cleanEnd,
        body: Buffer.concat(chunks).toString("utf8"),
        outputs: node.outputs,
        dones: node.dones,
        warns: node.warns,
        thrown: node.thrown,
      }
    }
    /**
     * @param {object} first - the first message
     * @param {object} final - the final message
     * @returns {object} what a download that ends whole looks like
     */
    function endsDone(first, final) {
      const bytes = first.payload.length + final.payload.length
      return {
        cleanEnd: true,
        body: first.payload + final.payload,
        outputs: [
          Object.assign({}, first, {
            download: download({ bytes: first.payload.length, messages: 1 }),
          }),
          Object.assign({}, final, {
            download: download({ state: "done", bytes, messages: 2 }),
          }),
        ],
        dones: [undefined, undefined],
        warns: [],
        thrown: [],
      }
    }
    /**
     * @param {object} first - the first message
     * @param {object} final - the final message
     * @param {string} error - the error text the download reports
     * @returns {object} what a download failed by the final message looks like
     */
    function endsFailed(first, final, error) {
      return {
        cleanEnd: false,
        body: first.payload,
        outputs: [
          Object.assign({}, first, {
            download: download({ bytes: first.payload.length, messages: 1 }),
          }),
          Object.assign({}, final, {
            download: download({
              state: "error",
              bytes: first.payload.length,
              messages: 1,
              error,
            }),
          }),
        ],
        dones: [undefined, undefined],
        warns: [`downloadfile: ${error}`],
        thrown: [],
      }
    }

    it("Should fail the download on msg.error in the final message by default", async function () {
      const final = { _msgid: "m1", payload: "d", complete: true, error: "boom" }
      const seen = await runStream({ errorProperty: "error" }, FIRST, final)
      expect(seen).to.deep.equal(endsFailed(FIRST, final, "boom"))
    })
    it("Should write a message that is not final even when msg.error is set", async function () {
      const first = { _msgid: "m0", payload: "abc", error: "early" }
      const final = { _msgid: "m1", payload: "d", complete: true }
      const seen = await runStream({ errorProperty: "error" }, first, final)
      expect(seen).to.deep.equal(endsDone(first, final))
    })
    it("Should ignore another field when the property is error", async function () {
      const final = {
        _msgid: "m1",
        payload: "d",
        complete: true,
        failure: "query failed",
      }
      const seen = await runStream({ errorProperty: "error" }, FIRST, final)
      expect(seen).to.deep.equal(endsDone(FIRST, final))
    })
    it("Should fail the download on a nested property path", async function () {
      const final = {
        _msgid: "m1",
        payload: "d",
        complete: true,
        meta: { err: "nested failed" },
      }
      const seen = await runStream({ errorProperty: "meta.err" }, FIRST, final)
      expect(seen).to.deep.equal(endsFailed(FIRST, final, "nested failed"))
    })
    it("Should end whole when the parent of a nested path is missing", async function () {
      const final = { _msgid: "m1", payload: "d", complete: true }
      const seen = await runStream({ errorProperty: "meta.err" }, FIRST, final)
      expect(seen).to.deep.equal(endsDone(FIRST, final))
    })
    it("Should read msg.error for a node saved with no errorProperty", async function () {
      const final = { _msgid: "m1", payload: "d", complete: true, error: "boom" }
      const seen = await runStream({}, FIRST, final)
      expect(seen).to.deep.equal(endsFailed(FIRST, final, "boom"))
    })
    it("Should ignore other fields for a node saved with no errorProperty", async function () {
      const final = {
        _msgid: "m1",
        payload: "d",
        complete: true,
        failure: "query failed",
      }
      const seen = await runStream({}, FIRST, final)
      expect(seen).to.deep.equal(endsDone(FIRST, final))
    })
    it("Should write a message that is not final with msg.error for a node saved with no errorProperty", async function () {
      const first = { _msgid: "m0", payload: "abc", error: "early" }
      const final = { _msgid: "m1", payload: "d", complete: true }
      const seen = await runStream({}, first, final)
      expect(seen).to.deep.equal(endsDone(first, final))
    })
    it("Should never fail the download when the property is empty", async function () {
      const final = {
        _msgid: "m1",
        payload: "d",
        complete: true,
        error: "boom",
        failure: "query failed",
      }
      const seen = await runStream({ errorProperty: "" }, FIRST, final)
      expect(seen).to.deep.equal(endsDone(FIRST, final))
    })
    for (const badPath of ["a..b", "payload.x["]) {
      it(`Should end whole and not throw on the invalid path ${badPath}`, async function () {
        const final = { _msgid: "m1", payload: "d", complete: true, error: "boom" }
        const seen = await runStream({ errorProperty: badPath }, FIRST, final)
        expect(seen).to.deep.equal(endsDone(FIRST, final))
      })
    }
    const falsyCases = [
      ["0", 0],
      ["an empty string", ""],
      ["false", false],
      ["null", null],
    ]
    for (const [label, value] of falsyCases) {
      it(`Should end whole when the property holds ${label}`, async function () {
        const final = { _msgid: "m1", payload: "d", complete: true, error: value }
        const seen = await runStream({ errorProperty: "error" }, FIRST, final)
        expect(seen).to.deep.equal(endsDone(FIRST, final))
      })
    }
    it("Should report an error and open no download when getMessageProperty is missing", function () {
      const runtime = runtimeFor()
      delete runtime.RED.util.getMessageProperty
      const node = runtime.createNode({ stream: true, errorProperty: "error" })
      const m1 = { _msgid: "m1", payload: "a" }
      input(node, m1)
      const text = "RED.util.getMessageProperty is not available"
      expect({
        outputs: node.outputs,
        dones: node.dones.map((error) => error && error.message),
        thrown: node.thrown,
        events: runtime.runtimeEvents,
      }).to.deep.equal({
        outputs: [
          Object.assign({}, m1, {
            // No stream exists, so the report names no file.
            download: download({ state: "error", filename: "", error: text }),
          }),
        ],
        dones: [text],
        thrown: [],
        events: [],
      })
    })
  })

  describe("Editor and help files", function () {
    const root = path.resolve(__dirname, "..")
    /**
     * @param {string} name - a file name relative to the package
     * @returns {string} the file text
     */
    function readText(name) {
      return fs.readFileSync(path.join(root, name), "utf8")
    }
    it("Should default errorProperty to error and offer the msg type only", function () {
      const html = readText("downloadfile.html")
      const defaultMatch = /errorProperty:\s*\{\s*value:\s*"([^"]*)"/.exec(html)
      const typedMatch =
        /\$\("#node-input-errorProperty"\)\.typedInput\(\{([\s\S]*?)\}\)/.exec(html)
      const typesMatch = typedMatch && /types:\s*(\[[^\]]*\])/.exec(typedMatch[1])
      expect({
        defaultValue: defaultMatch && defaultMatch[1],
        types: typesMatch && JSON.parse(typesMatch[1]),
      }).to.deep.equal({ defaultValue: "error", types: ["msg"] })
    })
    it("Should name no product in the shipped text and code files", function () {
      const productWords =
        /influxdb|influx|backpressure|designer|\bedge\b|pdi|prescient/gi
      // The only allowed mentions: the copyright holder, the npm scope, the
      // repository URL, and the palette category of the node.
      const allowed = [
        "Prescient Devices, Inc.",
        "@prescient-devices-oss",
        "github.com/prescient-devices/PD-Nodes",
        "Microsoft Edge",
      ]
      const allowedIn = { "downloadfile.html": ['category: "prescient"'] }
      const names = [
        "locales/en-US/downloadfile.html",
        "locales/en-US/downloadfile.json",
        "README.md",
        "downloadfile.html",
        "downloadfile.js",
        "downloadfile-stream_core.js",
      ]
      const found = {}
      const expected = {}
      for (const name of names) {
        let text = readText(name)
        for (const phrase of allowed.concat(allowedIn[name] || [])) {
          text = text.split(phrase).join("")
        }
        found[name] = text.match(productWords) || []
        expected[name] = []
      }
      expect(found).to.deep.equal(expected)
    })
    it("Should pack only the runtime, help, example and license files", function () {
      const out = execFileSync(
        "npm",
        ["pack", "--dry-run", "--json", "--ignore-scripts"],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      )
      const packed = JSON.parse(out)[0]
        .files.map((file) => file.path)
        .sort()
      const expected = [
        "LICENSE",
        "README.md",
        "downloadfile-stream_core.js",
        "downloadfile.html",
        "downloadfile.js",
        "examples/Save hello world message.json",
        "locales/en-US/downloadfile.html",
        "locales/en-US/downloadfile.json",
        "package.json",
      ].sort()
      expect(packed).to.deep.equal(expected)
    })
  })

  describe("Stream on - one complete message after an abort", function () {
    it("Should send the held source final last, with the abort state, and no copy", async function () {
      const runtime = runtimeFor()
      await runtime.listen()
      const node = runtime.createNode({ stream: true })
      const m1 = { _msgid: "m1", _streamID: "S", payload: "a" }
      const m2 = { _msgid: "m2", _streamID: "S", payload: "b", complete: true }
      input(node, m1)
      input(node, m2)
      const downloadId = announcedId(runtime, "n1")
      await call(runtime.port, "POST", `${ROUTE}/cancel/${downloadId}`)
      const cancelled = download({ state: "cancelled" })
      expect(node.outputs).to.deep.equal([
        Object.assign({}, m1, { download: cancelled }),
        Object.assign({}, m2, { download: cancelled }),
      ])
    })
    it("Should send a copy without _streamID when the source final is not held", async function () {
      const runtime = runtimeFor()
      await runtime.listen()
      const node = runtime.createNode({ stream: true })
      const m1 = { _msgid: "m1", _streamID: "S", payload: "a" }
      input(node, m1)
      const downloadId = announcedId(runtime, "n1")
      await call(runtime.port, "POST", `${ROUTE}/cancel/${downloadId}`)
      const m2 = { _msgid: "m2", _streamID: "S", payload: "b" }
      const m3 = { _msgid: "m3", _streamID: "S", payload: "c", complete: true }
      input(node, m2)
      input(node, m3)
      const cancelled = download({ state: "cancelled" })
      expect(node.outputs).to.deep.equal([
        Object.assign({}, m1, { download: cancelled }),
        terminal({ _msgid: "m1", payload: "a" }, "generated-1", cancelled),
        Object.assign({}, m2, { download: cancelled }),
        Object.assign({}, m3, { download: cancelled }),
      ])
    })
  })

  describe("Stream on - cancel after the claim", function () {
    it("Should answer 409 to a cancel between the claim and the GET and keep the download", async function () {
      const runtime = runtimeFor()
      await runtime.listen()
      const node = runtime.createNode({ stream: true })
      const m0 = { _msgid: "m0", payload: "a" }
      input(node, m0)
      const downloadId = announcedId(runtime, "n1")
      const ticket = await claim(runtime, "n1")
      const cancel = await call(runtime.port, "POST", `${ROUTE}/cancel/${downloadId}`)
      const { res } = await open(runtime.port, "GET", `${ROUTE}/download/${ticket}`)
      const bodyPromise = readBody(res)
      const m1 = { _msgid: "m1", payload: "b", complete: true }
      input(node, m1)
      const body = await bodyPromise
      await waitFor(() => node.outputs.length === 2)
      expect({
        cancel,
        status: res.statusCode,
        body: body.toString("utf8"),
        outputs: node.outputs,
      }).to.deep.equal({
        cancel: {
          status: 409,
          body: { error: "download in progress", code: "streaming" },
        },
        status: 200,
        body: "ab",
        outputs: [
          Object.assign({}, m0, { download: download({ bytes: 1, messages: 1 }) }),
          Object.assign({}, m1, {
            download: download({ state: "done", bytes: 2, messages: 2 }),
          }),
        ],
      })
    })
  })

  describe("Stream on - redeploy", function () {
    it("Should pass the rest of an aborted stream through the new node instance", async function () {
      const runtime = runtimeFor()
      const before = runtime.createNode({ stream: true })
      const a1 = { _msgid: "a1", _streamID: "S", payload: "a" }
      input(before, a1)
      await closeNode(before)
      const after = runtime.createNode({ stream: true })
      const b1 = { _msgid: "b1", _streamID: "S", payload: "b" }
      const b2 = { _msgid: "b2", payload: "", complete: true }
      input(after, b1)
      input(after, b2)
      const registersBeforeNext = registerCount(runtime)
      input(after, { _msgid: "c1", _streamID: "T", payload: "c" })
      const closedInfo = download({ state: "error", error: TEXT.nodeClosed })
      expect({
        beforeOutputs: before.outputs,
        afterOutputs: after.outputs,
        registersBeforeNext,
        registersAfterNext: registerCount(runtime),
        afterWarns: after.warns,
      }).to.deep.equal({
        beforeOutputs: [
          Object.assign({}, a1, { download: closedInfo }),
          terminal({ _msgid: "a1", payload: "a" }, "generated-1", closedInfo),
        ],
        afterOutputs: [
          Object.assign({}, b1, { download: closedInfo }),
          Object.assign({}, b2, { download: closedInfo }),
        ],
        registersBeforeNext: 1,
        registersAfterNext: 2,
        afterWarns: [],
      })
    })
    it("Should use the open tail for one final message without _streamID only", async function () {
      const runtime = runtimeFor()
      const before = runtime.createNode({ stream: true })
      input(before, { _msgid: "a1", _streamID: "S", payload: "a" })
      await closeNode(before)
      const after = runtime.createNode({ stream: true })
      const b1 = { _msgid: "b1", payload: "", complete: true }
      const b2 = { _msgid: "b2", payload: "x", complete: true }
      input(after, b1)
      const registersAfterFirst = registerCount(runtime)
      input(after, b2)
      const closedInfo = download({ state: "error", error: TEXT.nodeClosed })
      expect({
        afterOutputs: after.outputs,
        registersAfterFirst,
        registersAfterSecond: registerCount(runtime),
      }).to.deep.equal({
        afterOutputs: [Object.assign({}, b1, { download: closedInfo })],
        registersAfterFirst: 1,
        registersAfterSecond: 2,
      })
    })
    it("Should keep a closed stream while its messages keep coming within 10 minutes", async function () {
      clock.restore()
      clock = sinon.useFakeTimers({
        now: NOW,
        toFake: ["Date", "setTimeout", "clearTimeout"],
      })
      const runtime = runtimeFor()
      const before = runtime.createNode({ stream: true })
      input(before, { _msgid: "a1", _streamID: "S", payload: "a" })
      await closeNode(before)
      const after = runtime.createNode({ stream: true })
      clock.tick(CLOSED_STREAMS_TTL_MS - 1)
      input(after, { _msgid: "b1", _streamID: "S", payload: "b" })
      clock.tick(CLOSED_STREAMS_TTL_MS - 1)
      input(after, { _msgid: "b2", _streamID: "S", payload: "c" })
      clock.tick(CLOSED_STREAMS_TTL_MS - 1)
      input(after, { _msgid: "b3", payload: "", complete: true })
      expect({
        passed: after.outputs.map((msg) => [msg._msgid, msg.download.state]),
        registers: registerCount(runtime),
      }).to.deep.equal({
        passed: [
          ["b1", "error"],
          ["b2", "error"],
          ["b3", "error"],
        ],
        registers: 1,
      })
    })
    it("Should forget a closed stream after 10 minutes with no message", async function () {
      clock.restore()
      clock = sinon.useFakeTimers({
        now: NOW,
        toFake: ["Date", "setTimeout", "clearTimeout"],
      })
      const runtime = runtimeFor()
      const before = runtime.createNode({ stream: true })
      input(before, { _msgid: "a1", _streamID: "S", payload: "a" })
      await closeNode(before)
      const after = runtime.createNode({ stream: true })
      clock.tick(CLOSED_STREAMS_TTL_MS)
      input(after, { _msgid: "b1", _streamID: "S", payload: "b" })
      expect({
        outputs: after.outputs,
        registers: registerCount(runtime),
      }).to.deep.equal({ outputs: [], registers: 2 })
    })
    it("Should forget the closed stream seen longest ago past 1,000 entries", function () {
      const runtime = runtimeFor({ editor: false })
      const node = runtime.createNode({ stream: true })
      for (let index = 0; index <= CLOSED_STREAMS_MAX; index += 1) {
        input(node, { _streamID: `s${index}`, payload: "" })
      }
      const start = node.outputs.length
      const s1 = { _msgid: "s1", _streamID: "s1", payload: "" }
      const s0 = { _msgid: "s0", _streamID: "s0", payload: "" }
      input(node, s1)
      input(node, s0)
      const failed = download({ state: "error", error: TEXT.noEditor })
      expect(node.outputs.slice(start)).to.deep.equal([
        // s1 is still remembered: it passes through, with no new stream.
        Object.assign({}, s1, { download: failed }),
        // s0 was forgotten: it opens a new stream, which gets its own terminal,
        // last.
        Object.assign({}, s0, { download: failed }),
        terminal(
          { _msgid: "s0", payload: "" },
          `generated-${CLOSED_STREAMS_MAX + 2}`,
          failed
        ),
      ])
    })
  })

  describe("Stream on - two streams into one node", function () {
    it("Should not end download A with the final message of refused stream B", async function () {
      const runtime = runtimeFor()
      await runtime.listen()
      const node = runtime.createNode({ stream: true })
      const a1 = { _msgid: "a1", _streamID: "A", payload: "a1," }
      const b1 = { _msgid: "b1", _streamID: "B", payload: "b1," }
      const bF = { _msgid: "bF", _streamID: "B", payload: "bF", complete: true }
      input(node, a1)
      input(node, b1)
      input(node, bF)
      const ticket = await claim(runtime, "n1")
      const { res } = await open(runtime.port, "GET", `${ROUTE}/download/${ticket}`)
      const bodyPromise = readBody(res)
      const aF = { _msgid: "aF", _streamID: "A", payload: "aF", complete: true }
      input(node, aF)
      const body = await bodyPromise
      await waitFor(() => node.outputs.length === 4)
      expect({
        body: body.toString("utf8"),
        outputs: node.outputs,
        warns: node.warns,
        registers: registerCount(runtime),
      }).to.deep.equal({
        body: "a1,aF",
        outputs: [
          Object.assign({}, b1, { download: refusedInfo() }),
          Object.assign({}, bF, { download: refusedInfo() }),
          Object.assign({}, a1, { download: download({ bytes: 3, messages: 1 }) }),
          Object.assign({}, aF, {
            download: download({ state: "done", bytes: 5, messages: 2 }),
          }),
        ],
        warns: [`downloadfile: ${TEXT.inProgress}`],
        registers: 1,
      })
    })
    it("Should refuse stream B after A ends until B's final message clears the record", async function () {
      const runtime = runtimeFor()
      await runtime.listen()
      const node = runtime.createNode({ stream: true })
      input(node, { _msgid: "a1", _streamID: "A", payload: "a" })
      const b1 = { _msgid: "b1", _streamID: "B", payload: "1" }
      input(node, b1)
      const ticket = await claim(runtime, "n1")
      const { res } = await open(runtime.port, "GET", `${ROUTE}/download/${ticket}`)
      const bodyPromise = readBody(res)
      input(node, { _msgid: "aF", _streamID: "A", payload: "", complete: true })
      await bodyPromise
      await waitFor(() => node.outputs.length === 3)
      const b2 = { _msgid: "b2", _streamID: "B", payload: "2" }
      const bF = { _msgid: "bF", _streamID: "B", payload: "", complete: true }
      input(node, b2)
      input(node, bF)
      const registersAfterB = registerCount(runtime)
      const c1 = { _msgid: "c1", _streamID: "B", payload: "new" }
      input(node, c1)
      expect({
        refused: node.outputs
          .filter((msg) => msg.download.error === TEXT.inProgress)
          .map((msg) => msg._msgid),
        registersAfterB,
        registersAfterNext: registerCount(runtime),
        warns: node.warns,
      }).to.deep.equal({
        refused: ["b1", "b2", "bF"],
        registersAfterB: 1,
        registersAfterNext: 2,
        warns: [`downloadfile: ${TEXT.inProgress}`],
      })
    })
    it("Should refuse B's final message when it is the first message of B", function () {
      const runtime = runtimeFor()
      const node = runtime.createNode({ stream: true })
      input(node, { _msgid: "a1", _streamID: "A", payload: "a" })
      const bF = { _msgid: "bF", _streamID: "B", payload: "b", complete: true }
      input(node, bF)
      input(node, { _msgid: "a2", _streamID: "A", payload: "c" })
      expect({
        outputs: node.outputs,
        registers: registerCount(runtime),
      }).to.deep.equal({
        outputs: [Object.assign({}, bF, { download: refusedInfo() })],
        registers: 1,
      })
    })
    it("Should refuse a final message with an id while the open download has no id", function () {
      const runtime = runtimeFor()
      const node = runtime.createNode({ stream: true })
      input(node, { _msgid: "m1", payload: "a" })
      const xF = { _msgid: "xF", _streamID: "X", payload: "x", complete: true }
      input(node, xF)
      input(node, { _msgid: "m2", payload: "b" })
      expect({
        outputs: node.outputs,
        registers: registerCount(runtime),
      }).to.deep.equal({
        outputs: [Object.assign({}, xF, { download: refusedInfo() })],
        registers: 1,
      })
    })
  })

  describe("Stream on - final message of an unknown stream", function () {
    // A source can end an empty or early-failed stream with ONE final message that
    // carries a fresh `_streamID` no other message shares. While download A is
    // open, that message is the end of another stream, never A's.
    const UNKNOWN_ID = "0123456789abcdef0123456789abcdef"
    const cases = [
      ["an empty result", false],
      ["a failure before the first row", "Read failed"],
    ]
    for (const [label, sourceError] of cases) {
      it(`Should refuse the final message of ${label} and let open download A finish whole`, async function () {
        const runtime = runtimeFor()
        await runtime.listen()
        const node = runtime.createNode({ stream: true })
        const a1 = { _msgid: "a1", _streamID: "A", payload: "a1," }
        const xF = {
          _msgid: "xF",
          _streamID: UNKNOWN_ID,
          payload: "",
          complete: true,
          error: sourceError,
        }
        const a2 = { _msgid: "a2", _streamID: "A", payload: "a2," }
        input(node, a1)
        const downloadId = announcedId(runtime, "n1")
        input(node, xF)
        input(node, a2)
        const ticket = await claim(runtime, "n1")
        const { res } = await open(runtime.port, "GET", `${ROUTE}/download/${ticket}`)
        const bodyPromise = readBody(res)
        const aF = { _msgid: "aF", _streamID: "A", payload: "aF", complete: true }
        input(node, aF)
        const body = await bodyPromise
        await waitFor(() => node.outputs.length === 4)
        const registersAfterA = registerCount(runtime)
        // The refused final message left no refused record: a later message of
        // that id opens a new download, held until its click.
        input(node, { _msgid: "x1", _streamID: UNKNOWN_ID, payload: "x" })
        expect({
          status: res.statusCode,
          body: body.toString("utf8"),
          outputs: node.outputs,
          dones: node.dones,
          warns: node.warns,
          events: runtime.runtimeEvents.map((event) => event.payload),
          registersAfterA,
          registersAfterX: registerCount(runtime),
        }).to.deep.equal({
          status: 200,
          body: "a1,a2,aF",
          outputs: [
            Object.assign({}, xF, { download: refusedInfo() }),
            Object.assign({}, a1, { download: download({ bytes: 3, messages: 1 }) }),
            Object.assign({}, a2, { download: download({ bytes: 6, messages: 2 }) }),
            Object.assign({}, aF, {
              download: download({ state: "done", bytes: 8, messages: 3 }),
            }),
          ],
          dones: [undefined, undefined, undefined, undefined],
          warns: [`downloadfile: ${TEXT.inProgress}`],
          events: [
            { realId: "n1", downloadId, filename: "data.txt" },
            { realId: "n1", downloadId, claimed: true },
            {
              realId: "n1",
              downloadId: announcedId(runtime, "n1"),
              filename: "data.txt",
            },
          ],
          registersAfterA: 1,
          registersAfterX: 2,
        })
      })
    }
    it("Should give an empty download for an empty result's final message when no download is open", async function () {
      const runtime = runtimeFor()
      await runtime.listen()
      const node = runtime.createNode({ stream: true })
      const xF = {
        _msgid: "xF",
        _streamID: UNKNOWN_ID,
        payload: "",
        complete: true,
        error: false,
      }
      input(node, xF)
      const heldBeforeClick = node.outputs.length
      const ticketX = await claim(runtime, "n1")
      const answerX = await call(runtime.port, "GET", `${ROUTE}/download/${ticketX}`)
      await waitFor(() => node.outputs.length === 1)
      // A following new stream opens and finishes a download of its own.
      const y1 = { _msgid: "y1", _streamID: "Y", payload: "y1," }
      const yF = { _msgid: "yF", _streamID: "Y", payload: "yF", complete: true }
      input(node, y1)
      input(node, yF)
      const ticketY = await claim(runtime, "n1")
      const answerY = await call(runtime.port, "GET", `${ROUTE}/download/${ticketY}`)
      await waitFor(() => node.outputs.length === 3)
      // No open tail was left: a final message without an id opens a new
      // download, held until its click, and is not passed through at once.
      input(node, { _msgid: "zF", payload: "", complete: true })
      expect({
        heldBeforeClick,
        answerX,
        answerY,
        outputs: node.outputs,
        warns: node.warns,
        registers: registerCount(runtime),
      }).to.deep.equal({
        heldBeforeClick: 0,
        answerX: { status: 200, body: "" },
        answerY: { status: 200, body: "y1,yF" },
        outputs: [
          Object.assign({}, xF, {
            download: download({ state: "done", bytes: 0, messages: 1 }),
          }),
          Object.assign({}, y1, { download: download({ bytes: 3, messages: 1 }) }),
          Object.assign({}, yF, {
            download: download({ state: "done", bytes: 5, messages: 2 }),
          }),
        ],
        warns: [],
        registers: 3,
      })
    })
    it("Should abort at once on a failed stream's final message when no download is open", async function () {
      const runtime = runtimeFor()
      await runtime.listen()
      const node = runtime.createNode({ stream: true })
      const xF = {
        _msgid: "xF",
        _streamID: UNKNOWN_ID,
        payload: "",
        complete: true,
        error: "Read failed",
      }
      input(node, xF)
      // The first message fails the stream before `open()`, so no banner is
      // raised and the message is passed on at once.
      const afterX = {
        dones: node.dones.slice(),
        events: runtime.runtimeEvents.slice(),
        outputs: node.outputs.slice(),
      }
      // A following new stream opens and finishes a download of its own.
      const y1 = { _msgid: "y1", _streamID: "Y", payload: "y1," }
      const yF = { _msgid: "yF", _streamID: "Y", payload: "yF", complete: true }
      input(node, y1)
      input(node, yF)
      const ticketY = await claim(runtime, "n1")
      const answerY = await call(runtime.port, "GET", `${ROUTE}/download/${ticketY}`)
      await waitFor(() => node.outputs.length === 3)
      // No open tail was left: a final message without an id opens a new
      // download, held until its click, and is not passed through at once.
      input(node, { _msgid: "zF", payload: "", complete: true })
      expect({
        afterX,
        answerY,
        outputs: node.outputs.slice(1),
        warns: node.warns,
        registers: registerCount(runtime),
      }).to.deep.equal({
        afterX: {
          dones: [undefined],
          events: [],
          outputs: [
            Object.assign({}, xF, {
              download: download({ state: "error", error: "Read failed" }),
            }),
          ],
        },
        answerY: { status: 200, body: "y1,yF" },
        outputs: [
          Object.assign({}, y1, { download: download({ bytes: 3, messages: 1 }) }),
          Object.assign({}, yF, {
            download: download({ state: "done", bytes: 5, messages: 2 }),
          }),
        ],
        warns: ["downloadfile: Read failed"],
        registers: 2,
      })
    })
  })

  describe("Stream on - refused-stream memory", function () {
    it("Should forget the refused stream seen longest ago past 1,000 entries", async function () {
      const runtime = runtimeFor()
      const before = runtime.createNode({ stream: true })
      input(before, { _msgid: "a1", _streamID: "A", payload: "a" })
      for (let index = 0; index <= REFUSED_STREAMS_MAX; index += 1) {
        input(before, { _streamID: `r${index}`, payload: "" })
      }
      await closeNode(before)
      const after = runtime.createNode({ stream: true })
      const r1 = { _msgid: "r1", _streamID: "r1", payload: "" }
      const r0 = { _msgid: "r0", _streamID: "r0", payload: "" }
      input(after, r1)
      const registersBefore = registerCount(runtime)
      input(after, r0)
      expect({
        outputs: after.outputs,
        registersBefore,
        registersAfter: registerCount(runtime),
      }).to.deep.equal({
        // r1 is still refused; r0 was forgotten and opens a new download.
        outputs: [Object.assign({}, r1, { download: refusedInfo() })],
        registersBefore: 1,
        registersAfter: 2,
      })
    })
    it("Should keep a refused stream while its messages come within 10 minutes and forget it after", async function () {
      clock.restore()
      clock = sinon.useFakeTimers({
        now: NOW,
        toFake: ["Date", "setTimeout", "clearTimeout"],
      })
      const runtime = runtimeFor()
      const before = runtime.createNode({ stream: true })
      input(before, { _msgid: "a1", _streamID: "A", payload: "a" })
      input(before, { _msgid: "b1", _streamID: "B", payload: "1" })
      await closeNode(before)
      const after = runtime.createNode({ stream: true })
      clock.tick(REFUSED_STREAMS_TTL_MS - 1)
      const b2 = { _msgid: "b2", _streamID: "B", payload: "2" }
      input(after, b2)
      clock.tick(REFUSED_STREAMS_TTL_MS - 1)
      const b3 = { _msgid: "b3", _streamID: "B", payload: "3" }
      input(after, b3)
      const registersWhileKept = registerCount(runtime)
      clock.tick(REFUSED_STREAMS_TTL_MS)
      input(after, { _msgid: "b4", _streamID: "B", payload: "4" })
      expect({
        outputs: after.outputs,
        registersWhileKept,
        registersAfterForget: registerCount(runtime),
      }).to.deep.equal({
        outputs: [
          Object.assign({}, b2, { download: refusedInfo() }),
          Object.assign({}, b3, { download: refusedInfo() }),
        ],
        registersWhileKept: 1,
        registersAfterForget: 2,
      })
    })
  })

  describe("Stream on - fallback tail by node key", function () {
    it("Should pass one final message without _streamID after a subflow restart", async function () {
      const runtime = runtimeFor()
      const subflow = { z: "sf1", _alias: "tmpl", stream: true }
      const before = runtime.createNode(Object.assign({ id: "i1" }, subflow))
      input(before, { _msgid: "a1", _streamID: "S", payload: "a" })
      await closeNode(before)
      const after = runtime.createNode(Object.assign({ id: "i2" }, subflow))
      const f1 = { _msgid: "f1", payload: "", complete: true }
      input(after, f1)
      const registersAfterFirst = registerCount(runtime)
      input(after, { _msgid: "f2", payload: "", complete: true })
      const closedInfo = download({ state: "error", error: TEXT.nodeClosed })
      expect({
        outputs: after.outputs,
        registersAfterFirst,
        registersAfterSecond: registerCount(runtime),
        bannerIds: runtime.runtimeEvents.map((event) => event.id),
      }).to.deep.equal({
        outputs: [Object.assign({}, f1, { download: closedInfo })],
        registersAfterFirst: 1,
        registersAfterSecond: 2,
        bannerIds: [
          "STREAM-DOWNLOAD-FILE-tmpl",
          "STREAM-DOWNLOAD-FILE-tmpl",
          "STREAM-DOWNLOAD-FILE-tmpl",
        ],
      })
    })
    it("Should clear the tail when a final message carries the id of the closed stream", async function () {
      const runtime = runtimeFor()
      const before = runtime.createNode({ stream: true })
      input(before, { _msgid: "a1", _streamID: "S", payload: "a" })
      await closeNode(before)
      const after = runtime.createNode({ stream: true })
      const sF = { _msgid: "sF", _streamID: "S", payload: "", complete: true }
      input(after, sF)
      input(after, { _msgid: "xF", payload: "", complete: true })
      const closedInfo = download({ state: "error", error: TEXT.nodeClosed })
      expect({
        outputs: after.outputs,
        registers: registerCount(runtime),
      }).to.deep.equal({
        outputs: [Object.assign({}, sF, { download: closedInfo })],
        registers: 2,
      })
    })
  })

  describe("SanitizeFilename", function () {
    const cases = [
      ["C0 controls and DEL", "a\u0000b\u0009c\u001fd\u007f.csv", "abcd.csv"],
      ["C1 controls", "a\u0080b\u009f.csv", "ab.csv"],
      ["CR and LF", "a\r\nb.csv", "ab.csv"],
      [
        "bidi overrides and isolates",
        "\u202eab\u202a\u2066c\u2069\u061c.csv",
        "abc.csv",
      ],
      [
        "invisible characters",
        "a\u200bb\u00adc\ufeffd\u2060e\u180ef\u2028g\u200f.csv",
        "abcdefg.csv",
      ],
      ["tag characters", "a\udb40\udc41b\udb40\udc7f.csv", "ab.csv"],
      ["lone high surrogate", "a\ud800b.csv", "ab.csv"],
      ["lone low surrogate", "a\udc00b.csv", "ab.csv"],
      [
        "path and header characters",
        'a/b\\c"d:e;f,g*h?i<j>k|l.csv',
        "abcdefghijkl.csv",
      ],
      ["leading dots", "...hidden.csv", "hidden.csv"],
      ["trailing dots and spaces", "name.csv. . ", "name.csv"],
      ["no extension", "report", "report.txt"],
      ["empty string", "", "data.txt"],
      ["null", null, "data.txt"],
      ["undefined", undefined, "data.txt"],
      ["only deleted characters", '/\\"...', "data.txt"],
      ["a number", 42, "42.txt"],
      [
        "an extension too long to be one",
        `a.${"b".repeat(17)}`,
        `a.${"b".repeat(17)}.txt`,
      ],
      ["a 16 character extension", `a.${"b".repeat(16)}`, `a.${"b".repeat(16)}`],
      ["emoji kept whole", "😀 report.csv", "😀 report.csv"],
    ]
    for (const [label, name, expected] of cases) {
      it(`Should handle ${label}`, function () {
        expect(sanitizeFilename(name)).to.equal(expected)
      })
    }
    it("Should keep the extension when it cuts to 120 code points", function () {
      expect(sanitizeFilename(`${"a".repeat(200)}.csv`)).to.equal(
        `${"a".repeat(116)}.csv`
      )
    })
    it("Should add .txt within the 120 limit when there is no extension", function () {
      expect(sanitizeFilename("a".repeat(200))).to.equal(`${"a".repeat(116)}.txt`)
    })
    it("Should cut by code points and never split an emoji", function () {
      expect(sanitizeFilename(`${"a".repeat(115)}😀😀.csv`)).to.equal(
        `${"a".repeat(115)}😀.csv`
      )
    })
    it("Should count an emoji as one code point in the cut", function () {
      expect(sanitizeFilename(`${"😀".repeat(130)}.csv`)).to.equal(
        `${"😀".repeat(116)}.csv`
      )
    })
    it("Should read at most 960 UTF-16 units of the name", function () {
      expect(sanitizeFilename(`${"\u200b".repeat(958)}ab.csv`)).to.equal("ab.txt")
    })
    it("Should delete the half surrogate left by the 960 unit cut", function () {
      expect(sanitizeFilename(`${"\u200b".repeat(959)}😀.csv`)).to.equal("data.txt")
    })
  })

  describe("Resource cleanup", function () {
    it("Should leave no timers or sockets running after every node closes", async function () {
      // Mocha arms its own test timeout timer once this function returns its
      // promise, so the baseline is read after one real tick.
      await sleep(1)
      const baseline = resourceCounts()
      const runtime = runtimeFor()
      await runtime.listen()
      // n1 streams, n2 waits for a click, n3 holds an unused ticket, n4 is aborted
      // and waits in pass-through.
      const n1 = runtime.createNode({ id: "n1", stream: true })
      const n2 = runtime.createNode({ id: "n2", stream: true })
      const n3 = runtime.createNode({ id: "n3", stream: true })
      const n4 = runtime.createNode({ id: "n4", stream: true })
      input(n1, { payload: "a" })
      input(n2, { payload: "b" })
      input(n3, { payload: "c" })
      input(n4, { payload: "d" })
      const ticket = await claim(runtime, "n1")
      await claim(runtime, "n3")
      await call(runtime.port, "POST", `${ROUTE}/cancel/${announcedId(runtime, "n4")}`)
      const { res } = await open(runtime.port, "GET", `${ROUTE}/download/${ticket}`)
      res.on("data", () => {})
      await waitFor(() => n1.outputs.length === 1)
      const during = resourceCounts()
      runtimes.splice(runtimes.indexOf(runtime), 1)
      await runtime.closeAll()
      let after = resourceCounts()
      try {
        await waitFor(() => {
          after = resourceCounts()
          return (
            (after.Timeout || 0) === (baseline.Timeout || 0) &&
            (after.TCPSocketWrap || 0) === (baseline.TCPSocketWrap || 0) &&
            (after.TCPServerWrap || 0) === (baseline.TCPServerWrap || 0)
          )
        }, 2000)
      } catch (_) {
        // Fall through to the assertion, which shows the counts.
      }
      const pick = (counts) => ({
        Timeout: counts.Timeout || 0,
        TCPSocketWrap: counts.TCPSocketWrap || 0,
        TCPServerWrap: counts.TCPServerWrap || 0,
      })
      expect({
        timersWhileOpen: pick(during).Timeout > pick(baseline).Timeout,
        after: pick(after),
      }).to.deep.equal({ timersWhileOpen: true, after: pick(baseline) })
    })
  })
})
