/**
 *
 * fileinput.js
 *
 * Copyright 2022-present Prescient Devices, Inc.
 *
 **/

// NodeJS imports
const fs = require("fs")
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

// Functions
function _capitalize(arg) {
  return arg[0].toUpperCase() + arg.slice(1)
}

function getFlow(config) {
  config = config || {}
  let flowArray = [
    {
      id: "f95964b82673fe40",
      type: "tab",
      label: "Test flow",
      disabled: false,
      info: "",
      env: [],
    },
    {
      id: "fbeed8ed651b1fff",
      type: "fileinput",
      z: "f95964b82673fe40",
      name: "Load file",
      datatype: config.datatype || "str",
      stream: config.stream || "yes",
      property: config.property || "payload",
      propertyType: "msg",
      x: 130,
      y: 80,
      wires: [["a189a1e310b89cd0"]],
    },
    {
      id: "a189a1e310b89cd0",
      type: "function",
      z: "f95964b82673fe40",
      name: "Process",
      func: 'let data\nif (env.get("__PDI-TEST__") && env.get("__PDI-TEST-STREAMING__")) {\n    let data = global.get("data") || ""\n    data += msg.payload\n    global.set("data", data)\n    if (msg.end) {\n        msg.payload = data\n        node.warn(typeof msg.payload)\n        return msg\n    }\n    return\n}\nnode.warn(typeof msg.payload)\nreturn msg',
      outputs: 1,
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 280,
      y: 80,
      wires: [["9036244af13e1199"]],
    },
    {
      id: "9036244af13e1199",
      type: "file",
      z: "f95964b82673fe40",
      name: "Save file",
      filename: globalOutFile,
      appendNewline: false,
      createDir: false,
      overwriteFile: "true",
      encoding: "none",
      x: 440,
      y: 80,
      wires: [[]],
    },
  ]
  return flowArray
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

// Tests
describe("node-red-contrib-fileinput", function () {
  let execObj, stdout
  const testDir = path.resolve(__dirname, ".node-red")
  function startNodeRed(config, env, readOnly) {
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
      if (readOnly) {
        settings.adminAuth = {
          type: "credentials",
          users: [
            {
              username: "admin",
              password: "$2b$08$v/98KrBPLWFtFc6FyzHuNuspzrQ6PZktnT2SYgTDJECpibZAk8YC6",
              permissions: ["read"],
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
  async function runTest(config, fileData, env, readOnly) {
    const debug = false
    let browserStdout
    try {
      await startNodeRed(config, env, readOnly)
      fileData = fileData || ""
      fs.writeFileSync(globalDataFile, fileData)
      const browser = await puppeteer.launch({
        headless: true,
        args: ["--user-agent=__pdi-test-puppeteer__"],
      })
      browserStdout = ""
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
          .filter((item) => item.startsWith(prefix))
          .map((item) => item.slice(prefix.length + 2))
          .join("\n")
        browserStdout += args.trim()
      })
      await page.goto("http://127.0.0.1:1880")
      if (readOnly) {
        await page.waitForSelector("#node-dialog-login-username")
        await page.type("#node-dialog-login-username", "admin")
        await page.type("#node-dialog-login-password", "111111")
        await page.click("#node-dialog-login-submit")
        await page.waitForNavigation()
      }
      await page.waitForSelector("#red-ui-sidebar-tabs")
      await delay(5 * 1000)
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
    return { stdout: browserStdout }
  }
  afterEach(function () {
    delete process.env["__PDI_TEST__"]
    delete process.env["__PDI_TEST_FAIL_MODE__"]
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
        env["__PDI_TEST__"] = "1"
        env["__PDI_TEST_FAIL_MODE__"] = test.mode
        let act = await runTest({}, "Hello world!", env)
        const codeStr = test.code ? ` (${test.code})` : ""
        act.should.eql({
          stdout: `fileinput.notification.failure${codeStr}`,
        })
      })
    })
    it("Authorization", async function () {
      let env = { __PDI_TEST__: "1" }
      let act = await runTest({}, "Hellow world!", env, true)
      act.should.eql({
        stdout: `fileinput.notification.authorization (401)`,
      })
    })
  })
  describe("Runtime errors", function () {
    it("General conversion error", async function () {
      let env = { __PDI_TEST__: "1" }
      await runTest({ datatype: "obj" }, "A", env)
      const act = getNodeMessages(stdout)
      act.should.equal("fileinput.errors.conversion")
    })
  })
})
