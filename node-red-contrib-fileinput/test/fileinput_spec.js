/**
 *
 * fileinput_spec.js
 *
 * Copyright 2022-Present Prescient Devices, Inc.
 *
 **/

// NodeJS imports
const fs = require("fs")
const http = require("http")
const path = require("path")
// npm imports
const clone = require("clone")
const puppeteer = require("puppeteer")
const rimraf = require("rimraf")
const should = require("chai").should()
// Node-RED imports
const { spawn, spawnSync } = require("child_process")

const globalTestDir = path.resolve(__dirname, ".node-red")
const globalOutFile = path.resolve(globalTestDir, "out.dat")
const globalDataFile = path.resolve(globalTestDir, "data.txt")
// Editor port. 1880 is deliberately not the default: a development machine
// commonly has a Node-RED instance of its own parked there, and binding to it
// would either fail outright or require taking that instance down for the
// length of a run. Both the spawned runtime (through settings.uiPort) and the
// browser read this one value, so overriding it moves the whole suite.
const globalUiPort = Number(process.env["__FILEINPUT_TEST_UI_PORT__"] || 18880)
const globalEditorUrl = `http://127.0.0.1:${globalUiPort}`
// The single user the adminAuth fixtures configure. The password is what the
// login form is driven with and the hash is what the settings file wants, so
// both halves live together: a change to one that missed the other would leave
// every authenticated test unable to log in for a reason neither one shows.
const globalAdminUser = "admin"
const globalAdminPassword = "111111"
const globalAdminPasswordHash =
  "$2b$08$v/98KrBPLWFtFc6FyzHuNuspzrQ6PZktnT2SYgTDJECpibZAk8YC6"
// Node ids the tests address directly, either over HTTP or through an assertion
// on the runtime log.
const globalFileId = "9036244af13e1199"
const globalFileInputId = "fbeed8ed651b1fff"
const globalFunctionId = "a189a1e310b89cd0"
const globalInjectId = "c8f0f2a1b3d4e5f6"
const globalSubflowFileInputId = "b7c6d5e4f3a2b1c0"
const globalSubflowId = "e1a2b3c4d5e6f708"
const globalSubflowInstanceId = "d0c1b2a3948576e5"
const globalTabId = "f95964b82673fe40"
// Contents and wire-message properties used by the arm-then-click tests. The
// topic is what proves the wire message that armed the request was merged into
// the upload's output rather than dropped.
const globalWireFileData = "wired file contents"
const globalWireTopic = "wire-topic"
// Contents for the authenticated upload fixture. Deliberately not the wire
// fixture's, so a file one test left behind cannot satisfy another.
const globalAuthFileData = "authenticated file contents"
// Stands in for the generated half of a streamId; see maskStreamId().
const globalStreamIdMask = "<generated>"
// Reports what the fileinput node actually emitted, so a test can compare the
// whole emitted message against a reference rather than a single property.
const globalReportFunc = [
  "node.warn(",
  "  JSON.stringify({",
  "    topic: msg.topic,",
  "    payload: msg.payload,",
  "    filename: msg.filename,",
  "  })",
  ")",
  "return msg",
].join("\n")

// Functions
function _capitalize(arg) {
  return arg[0].toUpperCase() + arg.slice(1)
}

function getFlow(config) {
  config = config || {}
  if (config.backpressure) {
    return getBackpressureFlow(config)
  }
  if (config.subflow) {
    return getSubflowFlow(config)
  }
  if (config.wired) {
    return getWiredFlow(config)
  }
  let flowArray = [
    {
      id: globalTabId,
      type: "tab",
      label: "Test flow",
      disabled: false,
      info: "",
      env: [],
    },
    {
      id: globalFileInputId,
      type: "fileinput",
      z: globalTabId,
      name: "Load file",
      datatype: config.datatype || "str",
      stream: config.stream || "yes",
      property: config.property || "payload",
      propertyType: "msg",
      x: 130,
      y: 80,
      wires: [[globalFunctionId]],
    },
    {
      id: globalFunctionId,
      type: "function",
      z: globalTabId,
      name: "Process",
      func: 'let data\nif (env.get("__FILEINPUT-TEST__") && env.get("__FILEINPUT-TEST-STREAMING__")) {\n    let data = global.get("data") || ""\n    data += msg.payload\n    global.set("data", data)\n    if (msg.end) {\n        msg.payload = data\n        node.warn(typeof msg.payload)\n        return msg\n    }\n    return\n}\nnode.warn(typeof msg.payload)\nreturn msg',
      outputs: 1,
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 280,
      y: 80,
      wires: [[globalFileId]],
    },
    getSaveNode(globalTabId),
  ]
  return flowArray
}

// Flow for exercising streaming backpressure end to end:
//   fileinput (stream + backpressure) -> fileinput-backpressure -> accumulate -> file
// The fileinput-backpressure node sits directly downstream of the fileinput node
// so it sees (and acknowledges) every chunk; the accumulator reassembles the
// whole file and emits it once on the final chunk, and reports the chunk count.
function getBackpressureFlow(config) {
  const z = globalTabId
  const bpId = "bp00000000000001"
  const funcId = globalFunctionId
  const fileId = globalFileId
  const accumulate = [
    'let data = flow.get("acc") || ""',
    "data += msg.payload",
    "if (msg.end) {",
    '  flow.set("acc", "")',
    "  msg.payload = data",
    "  node.warn(msg.index + 1)",
    "  return msg",
    "}",
    'flow.set("acc", data)',
    "return null",
  ].join("\n")
  return [
    { id: z, type: "tab", label: "Test flow", disabled: false, info: "", env: [] },
    {
      id: globalFileInputId,
      type: "fileinput",
      z: z,
      name: "Load file",
      datatype: config.datatype || "str",
      stream: config.stream || "yes",
      backpressure: true,
      property: config.property || "payload",
      propertyType: "msg",
      x: 130,
      y: 80,
      wires: [[bpId]],
    },
    {
      id: bpId,
      type: "fileinput-backpressure",
      z: z,
      name: "Ack",
      x: 300,
      y: 80,
      wires: [[funcId]],
    },
    {
      id: funcId,
      type: "function",
      z: z,
      name: "Process",
      func: accumulate,
      outputs: 1,
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 460,
      y: 80,
      wires: [[fileId]],
    },
    {
      id: fileId,
      type: "file",
      z: z,
      name: "Save file",
      filename: globalOutFile,
      appendNewline: false,
      createDir: false,
      overwriteFile: "true",
      encoding: "none",
      x: 620,
      y: 80,
      wires: [[]],
    },
  ]
}

// Wire-message source for the arm-then-click fixtures. Triggered over the inject
// node's own admin route rather than by a configured schedule, so the message is
// raised at a moment the test controls: the arming event is not retained, and one
// raised before the editor has subscribed would simply be lost.
function getInjectNode(z, wires) {
  return {
    id: globalInjectId,
    type: "inject",
    z: z,
    name: "Trigger",
    props: [{ p: "payload" }, { p: "topic", vt: "str" }],
    repeat: "",
    crontab: "",
    once: false,
    onceDelay: 0.1,
    topic: globalWireTopic,
    payload: "wire payload",
    payloadType: "str",
    x: 130,
    y: 80,
    wires: [wires],
  }
}

function getReportNode(z, wires) {
  return {
    id: globalFunctionId,
    type: "function",
    z: z,
    name: "Process",
    func: globalReportFunc,
    outputs: 1,
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 460,
    y: 80,
    wires: [wires],
  }
}

function getSaveNode(z) {
  return {
    id: globalFileId,
    type: "file",
    z: z,
    name: "Save file",
    filename: globalOutFile,
    appendNewline: false,
    createDir: false,
    overwriteFile: "true",
    encoding: "none",
    x: 620,
    y: 80,
    wires: [[]],
  }
}

// Flow placing the fileinput node inside a subflow, driven by a wire message on
// the instance's input:
//   inject -> subflow instance [ fileinput ] -> report -> file
// A subflow instance's runtime node is given a generated id that appears nowhere
// in the stored flow config, so this is the fixture that catches an upload route
// looking its configuration up by the runtime id instead of by the alias.
function getSubflowFlow(config) {
  return [
    {
      id: globalTabId,
      type: "tab",
      label: "Test flow",
      disabled: false,
      info: "",
      env: [],
    },
    {
      id: globalSubflowId,
      type: "subflow",
      name: "File subflow",
      info: "",
      category: "",
      in: [{ x: 40, y: 60, wires: [{ id: globalSubflowFileInputId }] }],
      out: [{ x: 400, y: 60, wires: [{ id: globalSubflowFileInputId, port: 0 }] }],
      env: [],
    },
    {
      id: globalSubflowFileInputId,
      type: "fileinput",
      z: globalSubflowId,
      name: "Load file",
      datatype: config.datatype || "str",
      stream: config.stream || "no",
      property: config.property || "payload",
      propertyType: "msg",
      x: 200,
      y: 60,
      wires: [[]],
    },
    getInjectNode(globalTabId, [globalSubflowInstanceId]),
    {
      id: globalSubflowInstanceId,
      type: `subflow:${globalSubflowId}`,
      z: globalTabId,
      name: "Instance",
      x: 300,
      y: 80,
      wires: [[globalFunctionId]],
    },
    getReportNode(globalTabId, [globalFileId]),
    getSaveNode(globalTabId),
  ]
}

// Flow with something wired into the fileinput node's input port:
//   inject -> fileinput -> report -> file
// The toolbar-button fixtures leave that port unconnected, so this is the only
// one that raises a wire message and therefore the only one that reaches the
// arming path.
function getWiredFlow(config) {
  return [
    {
      id: globalTabId,
      type: "tab",
      label: "Test flow",
      disabled: false,
      info: "",
      env: [],
    },
    getInjectNode(globalTabId, [globalFileInputId]),
    {
      id: globalFileInputId,
      type: "fileinput",
      z: globalTabId,
      name: "Load file",
      datatype: config.datatype || "str",
      stream: config.stream || "no",
      property: config.property || "payload",
      propertyType: "msg",
      x: 300,
      y: 80,
      wires: [[globalFunctionId]],
    },
    getReportNode(globalTabId, [globalFileId]),
    getSaveNode(globalTabId),
  ]
}

function delay(ms) {
  return new Promise(function (resolve) {
    let timer = setTimeout(() => {
      clearTimeout(timer)
      return resolve()
    }, ms)
  })
}

function getNodeMessages(stdout) {
  const sentinel1 = "[fileinput:Load file]"
  const sentinel2 = "[function:Process]"
  return stdout
    .split("\n")
    .filter((item) => item.includes(sentinel1) || item.includes(sentinel2))
    .map((item) => {
      let tokens = item.split("[error]")
      if (tokens.length > 1) {
        return tokens[1].slice(sentinel1.length + 1).trim()
      }
      tokens = item.split("[warn]")
      if (tokens.length > 1) {
        return tokens[1].slice(sentinel2.length + 1).trim()
      }
      return item
    })[0]
}

// The streamId a metadata POST answers with - and names again when it refuses an
// overlapping upload - is built from a clock and a counter, so it cannot be
// written down in advance. What it must be is namespaced to the node it was
// issued for: that prefix keeps two nodes' streams from colliding in shared
// runtime state, and it is what an abort has to name to release this claim
// rather than one another editor session has since created. So only the
// generated half is masked. A value of any other shape is left alone and reaches
// the diff as itself, rather than a whole response being dropped from the
// comparison for the sake of one unpredictable field.
function maskStreamId(response, id) {
  const streamId = response.body && response.body.streamId
  if (typeof streamId !== "string") {
    return response
  }
  return {
    status: response.status,
    body: Object.assign({}, response.body, {
      streamId: streamId.replace(
        new RegExp(`^${id}-[0-9a-z]+$`),
        `${id}-${globalStreamIdMask}`
      ),
    }),
  }
}

// What the flow's file node wrote, or null when it wrote nothing. Reading it
// outright throws when an upload was refused, and the missing file is then all a
// failure reports - burying the refusal, which is the finding, under the
// downstream symptom of it. Null keeps that inside the comparison.
function getSavedFile() {
  return fs.existsSync(globalOutFile) ? fs.readFileSync(globalOutFile).toString() : null
}

// Every message the report node emitted, parsed, in order. getNodeMessages()
// answers only the first line either node logged, which on any flow where the
// fileinput node also reports an error is that error rather than the output
// being asserted on - and an upload the editor aborted logs exactly that before
// the upload under test ever runs.
function getReportedMessages(stdout) {
  const sentinel = "[function:Process]"
  return stdout
    .split("\n")
    .filter((item) => item.includes("[warn]") && item.includes(sentinel))
    .map((item) =>
      JSON.parse(
        item
          .split("[warn]")[1]
          .slice(sentinel.length + 1)
          .trim()
      )
    )
}

// The notification's buttons are built from literal catalogue strings, which in
// test mode are the raw keys, so a button is located by the key it renders.
async function getNotificationButton(page, key) {
  const selector = "#red-ui-notifications .ui-dialog-buttonset button"
  await page.waitForSelector(selector, { visible: true })
  const buttons = await page.$$(selector)
  for (const button of buttons) {
    const text = await page.evaluate((item) => item.textContent, button)
    if (text === key) {
      return button
    }
  }
  throw new Error(`Notification button "${key}" not found`)
}

// Reads back what the notification pane is showing: the message body of every
// notification and the buttons offered on them.
async function getNotificationState(page) {
  return await page.evaluate(function () {
    return {
      text: Array.from(
        document.querySelectorAll("#red-ui-notifications .red-ui-notification p")
      ).map((item) => item.textContent),
      buttons: Array.from(
        document.querySelectorAll("#red-ui-notifications .ui-dialog-buttonset button")
      ).map((item) => item.textContent),
    }
  })
}

// Minimal admin-API client. The routes exercised through it answer either a bare
// status body or JSON, so the body is parsed when it parses and handed back raw
// when it does not.
function httpPost(urlPath, options) {
  options = options || {}
  return new Promise(function (resolve, reject) {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: globalUiPort,
        path: urlPath,
        method: "POST",
        headers: options.headers || {},
      },
      function (res) {
        let body = ""
        res.on("data", (data) => (body += data.toString()))
        res.on("end", function () {
          let parsed = body
          try {
            parsed = JSON.parse(body)
          } catch (_) {}
          return resolve({ status: res.statusCode, body: parsed })
        })
      }
    )
    req.on("error", reject)
    if (options.body !== undefined) {
      req.write(options.body)
    }
    req.end()
  })
}

// Opens a data POST and deliberately leaves it open, so the route is inside a
// request that owns the node's claim for as long as the caller holds the handle.
// This is the only state in which a dismissal is refused, and it cannot be
// reached with httpPost(), which always ends its request.
function httpPostOpen(urlPath) {
  const req = http.request({
    host: "127.0.0.1",
    port: globalUiPort,
    path: urlPath,
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
  })
  // Severing the socket is how this handle is closed, so the hang-up it causes
  // is the expected outcome rather than a failure. Without a listener it is an
  // unhandled request error, which mocha reports against whichever test happens
  // to be running when it lands.
  req.on("error", function () {})
  // Written but not ended: the route handler runs as soon as the headers land
  // and claims the node there, and the body stays unfinished until close().
  req.write("partial")
  return {
    close: function () {
      try {
        req.destroy()
      } catch (_) {}
    },
  }
}

// Tests
describe("node-red-contrib-fileinput", function () {
  let execObj, stdout
  const testDir = path.resolve(__dirname, ".node-red")
  // `auth`, when given, is the single permission the one configured user holds,
  // and configuring one at all is what puts the editor behind a login. "read"
  // logs in but is refused by every route this node owns; "*" is an ordinary
  // deploy-capable session. The distinction is the whole point of having both: a
  // read-only session is refused at the FIRST of the two requests an upload
  // makes, so it never reaches the second - the one that carried no credentials
  // and broke.
  function startNodeRed(config, env, auth) {
    const debug = false
    return new Promise(function (resolve) {
      const nodeRedBin = path.resolve(
        __dirname,
        "..",
        "node_modules",
        ".bin",
        "node-red"
      )
      rimraf.sync(testDir)
      fs.mkdirSync(testDir, { recursive: true })
      fs.writeFileSync(
        path.resolve(testDir, "flows.json"),
        JSON.stringify(getFlow(config), null, 2)
      )
      spawnSync("npm", [
        "install",
        "--production",
        "--prefix",
        path.resolve(testDir),
        path.resolve(__dirname, ".."),
      ])
      let settings = {}
      const settingsFile = path.resolve(testDir, "settings.js")
      if (fs.existsSync(settingsFile)) {
        settings = require(settingsFile)
      }
      settings.editorTheme = settings.editorTheme || {}
      settings.editorTheme.tours = false
      settings.flowFile = "flows.json"
      // Keeps the run off 1880; see globalUiPort.
      settings.uiPort = globalUiPort
      if (auth) {
        settings.adminAuth = {
          type: "credentials",
          users: [
            {
              username: globalAdminUser,
              password: globalAdminPasswordHash,
              permissions: [auth],
            },
          ],
        }
      }
      const data = `module.exports = ${JSON.stringify(settings, null, 2)}`
      fs.writeFileSync(settingsFile, data)
      let cmdEnv = Object.assign(clone(process.env), env || {})
      execObj = spawn(nodeRedBin, [`--userDir=${testDir}`], { env: cmdEnv })
      stdout = ""
      execObj.stdout.on("data", function (data) {
        stdout += data.toString()
        debug && console.log(data.toString().trimEnd())
        if (stdout.includes("Started flows")) {
          return resolve()
        }
      })
      execObj.stderr.on("data", function (data) {
        debug && console.log(data.toString().trim())
      })
    })
  }
  // Opens the editor and collects the node's in-test console output into the
  // caller's array. The array is the caller's so that whatever was logged before
  // a failure is still available to report.
  async function launchEditor(messages, auth) {
    const debug = false
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--user-agent=__fileinput-test-puppeteer__"],
    })
    const page = await browser.newPage()
    page.on("console", async function (data) {
      const prefix = "fileinput"
      const args = await (
        await Promise.all(data.args().map((item) => item.jsonValue()))
      )
        .filter((item) => {
          debug && console.log(item)
          return true
        })
        .filter((item) => typeof item === "string" && item.startsWith(prefix))
        .map((item) => item.slice(prefix.length + 2))
        .join("\n")
      if (args.trim()) {
        messages.push(args.trim())
      }
    })
    await page.goto(globalEditorUrl)
    if (auth) {
      await page.waitForSelector("#node-dialog-login-username")
      await page.type("#node-dialog-login-username", globalAdminUser)
      await page.type("#node-dialog-login-password", globalAdminPassword)
      await page.click("#node-dialog-login-submit")
      await page.waitForNavigation()
    }
    await page.waitForSelector("#red-ui-sidebar-tabs")
    await delay(5 * 1000)
    return { browser, page }
  }
  async function runTest(config, fileData, env, auth) {
    const messages = []
    try {
      await startNodeRed(config, env, auth)
      fileData = fileData || ""
      fs.writeFileSync(globalDataFile, fileData)
      const { browser, page } = await launchEditor(messages, auth)
      let [fileChooser] = await Promise.all([
        page.waitForFileChooser(),
        page.mouse.click(235, 155, { button: "left" }),
      ])
      await fileChooser.accept([globalDataFile])
      await delay(5 * 1000)
      await browser.close()
    } catch (error) {
      console.log(error)
    }
    return { stdout: messages.join("\n") }
  }
  // Arms a file request by raising a wire message, then answers it the way a
  // user does: by clicking the notification's choose-file button, which is the
  // only gesture the browser accepts as activation for opening a picker.
  async function runArmedUpload(config) {
    const messages = []
    let act
    let browser
    try {
      await startNodeRed(config)
      fs.writeFileSync(globalDataFile, globalWireFileData)
      const editor = await launchEditor(messages)
      browser = editor.browser
      await httpPost(`/inject/${globalInjectId}`)
      const button = await getNotificationButton(
        editor.page,
        "fileinput.notification.choose"
      )
      // The interception has to be installed before the click rather than
      // alongside it: the button opens the picker synchronously inside that
      // click, so arming the two together races their CDP round-trips and the
      // picker can open with nothing listening for it.
      const chooserPromise = editor.page.waitForFileChooser()
      await delay(1000)
      await button.click()
      const fileChooser = await chooserPromise
      await fileChooser.accept([globalDataFile])
      await delay(5 * 1000)
      act = {
        stdout: messages.join("\n"),
        saved: fs.readFileSync(globalOutFile).toString(),
        emitted: JSON.parse(getNodeMessages(stdout)),
      }
    } finally {
      if (browser) {
        await browser.close()
      }
    }
    return act
  }
  afterEach(function () {
    delete process.env["__FILEINPUT_TEST__"]
    delete process.env["__FILEINPUT_TEST_FAIL_MODE__"]
    try {
      execObj.kill()
    } catch (_) {}
    rimraf.sync(testDir)
  })
  describe(`Type check`, function () {
    const tests = [
      { dataType: "str", longType: "string", input: "hello" },
      { dataType: "obj", longType: "object", input: { a: "5" } },
      {
        dataType: "buf",
        longType: "buffer",
        input: new Buffer.from("a"),
        refType: "object",
      },
    ]
    tests.forEach(function (testObj) {
      it(_capitalize(testObj.longType), async function () {
        let config = { datatype: testObj.dataType }
        let input =
          testObj.dataType === "obj" ? JSON.stringify(testObj.input) : testObj.input
        let act = await runTest(config, input)
        act.should.eql({
          stdout: "fileinput.notification.success",
        })
        let data = fs.readFileSync(globalDataFile)
        if (testObj.dataType === "str") {
          data = data.toString()
        } else if (testObj.dataType === "obj") {
          data = JSON.parse(data)
        }
        data.should.eql(testObj.input)
        act = getNodeMessages(stdout)
        act.should.eql(testObj.refType || testObj.longType)
      })
    })
  })
  describe("Editor notifications when cannot inject message", function () {
    const tests = [
      { desc: "No node", mode: "NO-NODE", code: 404 },
      { desc: "Metadata call", mode: "METADATA", code: 500 },
      { desc: "Data call", mode: "DATA" },
      { desc: "Receiver call", mode: "RECEIVER" },
      { desc: "General", mode: "GENERAL", code: 500 },
    ]
    tests.forEach((test) => {
      it(test.desc, async function () {
        let env = {}
        env["__FILEINPUT_TEST__"] = "1"
        env["__FILEINPUT_TEST_FAIL_MODE__"] = test.mode
        let act = await runTest({}, "Hello world!", env)
        const codeStr = test.code ? ` (${test.code})` : ""
        act.should.eql({
          stdout: `fileinput.notification.failure${codeStr}`,
        })
      })
    })
    it("Authorization", async function () {
      let env = { __FILEINPUT_TEST__: "1" }
      let act = await runTest({}, "Hellow world!", env, "read")
      act.should.eql({
        stdout: `fileinput.notification.authorization (401)`,
      })
    })
  })
  // An upload is two requests to the same route, and the editor attaches admin
  // credentials to jQuery calls only, through a global prefilter. The metadata
  // POST is jQuery and picked them up; the data POST carrying the file was a raw
  // fetch and did not. With adminAuth on, the first therefore succeeded and
  // claimed the node while the second was refused before the runtime saw it,
  // wedging the node for the life of that claim.
  //
  // The read-only fixture above cannot catch that: it is refused at the metadata
  // POST, so the data POST is never issued and the broken path is never reached.
  // Only a session permitted to write gets far enough, which is what this is.
  describe("Editor upload under adminAuth", function () {
    // Logging in, and the redirect it causes, come on top of the harness's own
    // start-up and settle delays.
    this.timeout(3 * 60 * 1000)
    it("Should complete an upload for a session permitted to write", async function () {
      // Non-streaming, so the file node is handed the whole file in one message
      // and what lands on disk is the upload rather than its last chunk.
      const result = await runTest({ stream: "no" }, globalAuthFileData, null, "*")
      const act = {
        stdout: result.stdout,
        // The file reaching disk is the assertion that matters: it can only get
        // there through the request that carried no Authorization header.
        saved: getSavedFile(),
      }
      act.should.eql({
        stdout: "fileinput.notification.success",
        saved: globalAuthFileData,
      })
    })
  })
  describe("Runtime errors", function () {
    it("General conversion error", async function () {
      let env = { __FILEINPUT_TEST__: "1" }
      await runTest({ datatype: "obj" }, "A", env)
      const act = getNodeMessages(stdout)
      act.should.equal("fileinput.errors.conversion")
    })
  })
  describe("Streaming backpressure", function () {
    it("Paces a multi-chunk streamed upload and reassembles the file", async function () {
      // Large enough that the HTTP request is delivered as many `data` events;
      // reassembly can only complete if every chunk is acknowledged and the next
      // is released, so a broken ack loop would stall (aborting after the 30s
      // watchdog) and leave the saved file incomplete.
      const data = "0123456789".repeat(50000) // ~500 KB of single-byte ASCII
      const act = await runTest({ backpressure: true }, data)
      act.should.eql({ stdout: "fileinput.notification.success" })
      const saved = fs.readFileSync(globalOutFile).toString()
      saved.should.equal(data)
      const chunkCount = Number(getNodeMessages(stdout))
      chunkCount.should.be.above(1)
    })
  })
  // A message on the input port cannot open the file picker itself: a websocket
  // callback carries no user activation and the browser refuses. It arms a
  // request and shows a notification instead, and the user's click on that
  // notification is what supplies the activation.
  describe("Wire message arm-then-click", function () {
    // These wait out the notification auto-dismiss window on top of the
    // harness's own start-up and settle delays, which does not fit inside the
    // suite-wide bound.
    this.timeout(3 * 60 * 1000)
    it("Should arm a sticky notification instead of opening a file chooser", async function () {
      const messages = []
      let act
      let browser
      try {
        await startNodeRed({ wired: true })
        fs.writeFileSync(globalDataFile, globalWireFileData)
        const editor = await launchEditor(messages)
        browser = editor.browser
        // Interception is armed before the wire message is raised, so a picker
        // opened straight from the comms callback is caught rather than missed.
        // The wait also outlasts the 5s auto-dismiss a non-fixed notification
        // gets, which is what makes the state read afterwards evidence that the
        // notification is sticky.
        const chooserPromise = editor.page.waitForFileChooser({ timeout: 10 * 1000 })
        await delay(1000)
        const injected = await httpPost(`/inject/${globalInjectId}`)
        let chooserOpened = true
        try {
          await chooserPromise
        } catch (_) {
          chooserOpened = false
        }
        const notification = await getNotificationState(editor.page)
        act = {
          injected,
          chooserOpened,
          notification,
          stdout: messages.join("\n"),
        }
      } finally {
        if (browser) {
          await browser.close()
        }
      }
      act.should.eql({
        injected: { status: 200, body: "OK" },
        chooserOpened: false,
        notification: {
          text: ["fileinput.notification.request_flow"],
          buttons: ["fileinput.notification.choose", "fileinput.notification.dismiss"],
        },
        stdout: "fileinput.notification.request_flow",
      })
    })
    it("Should open the file chooser and upload when the choose-file button is clicked", async function () {
      const act = await runArmedUpload({ wired: true })
      act.should.eql({
        stdout: "fileinput.notification.request_flow\nfileinput.notification.success",
        saved: globalWireFileData,
        // The wire message's own properties ride along into the output, which is
        // the whole point of arming from the input port rather than telling the
        // user to press the toolbar button.
        emitted: {
          topic: globalWireTopic,
          payload: globalWireFileData,
          filename: "data.txt",
        },
      })
    })
    it("Should upload into a fileinput node inside a subflow instance", async function () {
      // The instance's runtime node has a generated id that appears in no stored
      // flow config, so an upload route resolving its configuration by that id
      // finds nothing and answers 404. The arming event carries the runtime id,
      // the editor uploads to it, and the route has to fall back to the alias.
      const act = await runArmedUpload({ subflow: true })
      act.should.eql({
        stdout: "fileinput.notification.request_flow\nfileinput.notification.success",
        saved: globalWireFileData,
        emitted: {
          topic: globalWireTopic,
          payload: globalWireFileData,
          filename: "data.txt",
        },
      })
    })
  })
  // The editor posts here when the user dismisses the notification raised for a
  // wire message. The refusal that matters is a file actually being received:
  // cancelling then would strip the wire message's properties from the rest of
  // the stream. A claim that no upload ever delivered against is not that, and
  // refusing to clear one is what left a user with a Dismiss button that did
  // nothing for five minutes after an upload was rejected.
  describe("Cancel route", function () {
    // The route answers the streamId it issued for the claim, so that an abort
    // can later name which claim it means; masked here, since only its shape is
    // predictable. See maskStreamId().
    async function postMetadata(id) {
      const response = await httpPost(`/node-red-contrib-fileinput/file/${id}`, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: "data.txt",
          size: globalWireFileData.length,
        }),
      })
      return maskStreamId(response, id)
    }
    it("Should return 404 for an unknown node id", async function () {
      await startNodeRed({})
      const act = await httpPost("/node-red-contrib-fileinput/cancel/nosuchnode")
      act.should.eql({ status: 404, body: "Not Found" })
    })
    it("Should return 404 for a node that is not a fileinput node", async function () {
      await startNodeRed({})
      const act = await httpPost(
        `/node-red-contrib-fileinput/cancel/${globalFunctionId}`
      )
      act.should.eql({ status: 404, body: "Not Found" })
    })
    it("Should return 409 when nothing is armed", async function () {
      await startNodeRed({})
      const act = await httpPost(
        `/node-red-contrib-fileinput/cancel/${globalFileInputId}`
      )
      act.should.eql({
        status: 409,
        body: { error: "no armed request", code: "not_armed" },
      })
    })
    it("Should clear a claim no upload ever delivered against", async function () {
      await startNodeRed({})
      // The metadata POST claims the node. With no data request behind it that
      // claim is a handshake rather than an upload, so a dismissal takes it -
      // and the retry that follows proves the node is usable again immediately
      // instead of being refused as overlapping until the claim times out.
      const claimed = await postMetadata(globalFileInputId)
      const cancelled = await httpPost(
        `/node-red-contrib-fileinput/cancel/${globalFileInputId}`
      )
      const retried = await postMetadata(globalFileInputId)
      const act = { claimed, cancelled, retried }
      act.should.eql({
        claimed: {
          status: 200,
          body: { streamId: `${globalFileInputId}-${globalStreamIdMask}` },
        },
        cancelled: { status: 200, body: "OK" },
        retried: {
          status: 200,
          body: { streamId: `${globalFileInputId}-${globalStreamIdMask}` },
        },
      })
    })
    it("Should return 409 while the file is being received", async function () {
      await startNodeRed({})
      const claimed = await postMetadata(globalFileInputId)
      // Held open so a data request owns the claim for the length of the
      // dismissal, which is the one case the route must still refuse.
      const upload = httpPostOpen(
        `/node-red-contrib-fileinput/file/${globalFileInputId}`
      )
      await delay(1000)
      const cancelled = await httpPost(
        `/node-red-contrib-fileinput/cancel/${globalFileInputId}`
      )
      upload.close()
      const act = { claimed, cancelled }
      act.should.eql({
        claimed: {
          status: 200,
          body: { streamId: `${globalFileInputId}-${globalStreamIdMask}` },
        },
        cancelled: {
          status: 409,
          body: { error: "upload in progress", code: "upload_in_progress" },
        },
      })
    })
  })
  // The editor posts here when an upload it started fails. A data POST refused
  // before the upload route runs is never seen by the runtime, so nothing there
  // can release the claim its metadata POST created; without this the node is
  // refused every retry until that claim times out.
  describe("Abort route", function () {
    // Contents of the upload that follows an aborted one. Not the arming
    // fixture's, so which of the two landed is never in question.
    const laterFileData = "later file contents"
    // An upload id of the right shape that no claim in these tests was ever
    // issued: what a stale editor tab names when the upload it is reporting on
    // was reaped long ago and another session's claim stands in its place.
    const staleStreamId = `${globalFileInputId}-nosuchupload`
    // The route answers the streamId it issued for the claim; masked here, since
    // only its shape is predictable. See maskStreamId().
    async function postMetadata(id) {
      const response = await httpPost(`/node-red-contrib-fileinput/file/${id}`, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: "data.txt",
          size: globalWireFileData.length,
        }),
      })
      return maskStreamId(response, id)
    }
    // A whole upload as the editor makes one: the metadata POST that claims the
    // node, then the data POST carrying the bytes.
    async function uploadFile(id, data) {
      const metadata = await httpPost(`/node-red-contrib-fileinput/file/${id}`, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: "data.txt", size: data.length }),
      })
      const posted = await httpPost(`/node-red-contrib-fileinput/file/${id}`, {
        headers: { "Content-Type": "application/octet-stream" },
        body: data,
      })
      return { metadata: maskStreamId(metadata, id), posted }
    }
    it("Should return 404 for an unknown node id", async function () {
      await startNodeRed({})
      const act = await httpPost("/node-red-contrib-fileinput/abort/nosuchnode")
      act.should.eql({ status: 404, body: "Not Found" })
    })
    it("Should return 404 for a node that is not a fileinput node", async function () {
      await startNodeRed({})
      const act = await httpPost(
        `/node-red-contrib-fileinput/abort/${globalFunctionId}`
      )
      act.should.eql({ status: 404, body: "Not Found" })
    })
    it("Should accept an abort with nothing claimed", async function () {
      await startNodeRed({})
      // The editor cannot tell an upload the runtime already released from one
      // it never saw, so it reports every failure and this answers plainly.
      const act = await httpPost(
        `/node-red-contrib-fileinput/abort/${globalFileInputId}`
      )
      act.should.eql({ status: 200, body: "OK" })
    })
    it("Should release a claim whose data POST never arrived", async function () {
      await startNodeRed({})
      const claimed = await postMetadata(globalFileInputId)
      const aborted = await httpPost(
        `/node-red-contrib-fileinput/abort/${globalFileInputId}`
      )
      // The retry is the point of the whole route: before the release it was
      // refused as an overlapping upload for the claim's full lifetime.
      const retried = await postMetadata(globalFileInputId)
      const act = { claimed, aborted, retried }
      act.should.eql({
        claimed: {
          status: 200,
          body: { streamId: `${globalFileInputId}-${globalStreamIdMask}` },
        },
        aborted: { status: 200, body: "OK" },
        retried: {
          status: 200,
          body: { streamId: `${globalFileInputId}-${globalStreamIdMask}` },
        },
      })
    })
    it("Should refuse to release a claim a live data request owns", async function () {
      await startNodeRed({})
      const claimed = await postMetadata(globalFileInputId)
      const upload = httpPostOpen(
        `/node-red-contrib-fileinput/file/${globalFileInputId}`
      )
      await delay(1000)
      const aborted = await httpPost(
        `/node-red-contrib-fileinput/abort/${globalFileInputId}`
      )
      upload.close()
      const act = { claimed, aborted }
      act.should.eql({
        claimed: {
          status: 200,
          body: { streamId: `${globalFileInputId}-${globalStreamIdMask}` },
        },
        aborted: {
          status: 409,
          body: { error: "upload in progress", code: "upload_in_progress" },
        },
      })
    })
    // An abort names the claim it means, because it can arrive long after the
    // one it is reporting on is gone: a data POST may fail half an hour out
    // while a claim is reaped in five minutes, so by then this node can be held
    // by an upload another editor session started. Releasing that one fails an
    // upload doing nothing wrong and injects an error into its flow. An abort
    // that names nothing keeps the old behaviour on purpose - a cached editor
    // tab outlives a runtime upgrade - which is what every test above relies on.
    it("Should leave a claim standing when the abort names a different upload", async function () {
      await startNodeRed({})
      const claimed = await postMetadata(globalFileInputId)
      const aborted = await httpPost(
        `/node-red-contrib-fileinput/abort/${globalFileInputId}?streamId=${staleStreamId}`
      )
      // Still refused as overlapping, where the same call naming nothing leaves
      // this accepted: the claim the mismatch declined to release is the one
      // standing, and it is still the claim that was originally issued.
      const retried = await postMetadata(globalFileInputId)
      const act = { claimed, aborted, retried }
      act.should.eql({
        claimed: {
          status: 200,
          body: { streamId: `${globalFileInputId}-${globalStreamIdMask}` },
        },
        aborted: { status: 200, body: "OK" },
        retried: {
          status: 409,
          body: {
            error: "upload already in progress",
            streamId: `${globalFileInputId}-${globalStreamIdMask}`,
          },
        },
      })
    })
    it("Should answer a mismatched abort plainly even while a data request owns the claim", async function () {
      await startNodeRed({})
      const claimed = await postMetadata(globalFileInputId)
      const upload = httpPostOpen(
        `/node-red-contrib-fileinput/file/${globalFileInputId}`
      )
      await delay(1000)
      const aborted = await httpPost(
        `/node-red-contrib-fileinput/abort/${globalFileInputId}?streamId=${staleStreamId}`
      )
      // Still held, so the 200 above released nothing: it reported on the
      // caller's own upload being gone, which from that caller's side is exactly
      // what happened.
      const retried = await postMetadata(globalFileInputId)
      upload.close()
      const act = { claimed, aborted, retried }
      act.should.eql({
        claimed: {
          status: 200,
          body: { streamId: `${globalFileInputId}-${globalStreamIdMask}` },
        },
        // 200 where the same call naming nothing is refused 409: the mismatch is
        // tested before the live-upload check on purpose, so a stale abort is
        // never told anything about an upload that is not its own - and cannot
        // read a 409 as its own upload still running and act on it.
        aborted: { status: 200, body: "OK" },
        retried: {
          status: 409,
          body: {
            error: "upload already in progress",
            streamId: `${globalFileInputId}-${globalStreamIdMask}`,
          },
        },
      })
    })
    // Releasing the claim is only half of what this route does, and the half
    // every test above it sees. The wire message that armed the failed attempt is
    // still primed on the node and is merged into whatever arrives next, so the
    // upload the user retries would come out wearing the properties of a request
    // that was never answered. The status:"error" the route injects is what
    // clears it. Drop that injection and the claim is still released, every
    // assertion above still passes, and the only thing that changes is a topic
    // arriving on a message that has nothing to do with it - which is why the
    // pair below is written as a contrast rather than a single assertion: the
    // absence of a property proves nothing unless its presence is shown to be
    // what this same path otherwise produces.
    it("Should merge the armed wire message into an upload nothing aborted", async function () {
      await startNodeRed({ wired: true })
      const armed = await httpPost(`/inject/${globalInjectId}`)
      const uploaded = await uploadFile(globalFileInputId, globalWireFileData)
      // Long enough for the emitted message to cross the report node and reach
      // the file node, neither of which the upload's response waits on.
      await delay(2 * 1000)
      const act = {
        armed,
        uploaded,
        reported: getReportedMessages(stdout),
        saved: getSavedFile(),
      }
      act.should.eql({
        armed: { status: 200, body: "OK" },
        uploaded: {
          metadata: {
            status: 200,
            body: { streamId: `${globalFileInputId}-${globalStreamIdMask}` },
          },
          posted: { status: 200, body: "OK" },
        },
        reported: [
          {
            topic: globalWireTopic,
            payload: globalWireFileData,
            filename: "data.txt",
          },
        ],
        saved: globalWireFileData,
      })
    })
    it("Should not merge an aborted request's wire message into a later upload", async function () {
      await startNodeRed({ wired: true })
      const armed = await httpPost(`/inject/${globalInjectId}`)
      // The attempt that fails: it claims the node, no body ever arrives, and the
      // editor reports it here.
      const claimed = await postMetadata(globalFileInputId)
      const aborted = await httpPost(
        `/node-red-contrib-fileinput/abort/${globalFileInputId}`
      )
      const uploaded = await uploadFile(globalFileInputId, laterFileData)
      await delay(2 * 1000)
      const act = {
        armed,
        claimed,
        aborted,
        uploaded,
        reported: getReportedMessages(stdout),
        saved: getSavedFile(),
      }
      act.should.eql({
        armed: { status: 200, body: "OK" },
        claimed: {
          status: 200,
          body: { streamId: `${globalFileInputId}-${globalStreamIdMask}` },
        },
        aborted: { status: 200, body: "OK" },
        uploaded: {
          metadata: {
            status: 200,
            body: { streamId: `${globalFileInputId}-${globalStreamIdMask}` },
          },
          posted: { status: 200, body: "OK" },
        },
        // No topic, where the test above has one: this message carries what its
        // own upload produced and nothing of the wire message that armed the
        // attempt the editor abandoned.
        reported: [{ payload: laterFileData, filename: "data.txt" }],
        saved: laterFileData,
      })
    })
  })
  // The upload route calls node.receive() on whatever the browser-supplied id
  // resolves to. Without a type check any deployed node is reachable, and a
  // non-fileinput target is simply handed the posted bytes as msg.payload.
  describe("Node type guard on the upload route", function () {
    it("Should refuse an upload naming a node that is not a fileinput node", async function () {
      await startNodeRed({})
      const metadata = await httpPost(
        `/node-red-contrib-fileinput/file/${globalFunctionId}`,
        {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: "data.txt",
            size: globalWireFileData.length,
          }),
        }
      )
      const data = await httpPost(
        `/node-red-contrib-fileinput/file/${globalFunctionId}`,
        {
          headers: { "Content-Type": "application/octet-stream" },
          body: globalWireFileData,
        }
      )
      // Long enough for a message that did slip past the guard to reach the
      // function node and log there.
      await delay(2 * 1000)
      const act = {
        metadata,
        data,
        // The function node logs on every message it receives, so its absence
        // from the runtime log is what shows nothing was injected into it.
        injected: stdout.includes("[function:Process]"),
        saved: fs.existsSync(globalOutFile),
      }
      act.should.eql({
        metadata: { status: 404, body: "Not Found" },
        data: { status: 404, body: "Not Found" },
        injected: false,
        saved: false,
      })
    })
  })
})
