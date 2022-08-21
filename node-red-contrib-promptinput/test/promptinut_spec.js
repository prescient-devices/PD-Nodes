/**
 *
 * promptinput_spec.js
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

// Functions
function _capitalize(arg) {
  return arg[0].toUpperCase() + arg.slice(1)
}

function getFlow(filename, config) {
  config = config || {}
  const property = config.property || "payload"
  let flowArray = [
    {
      id: "7950429b416904f2",
      type: "tab",
      label: "Test flow",
      disabled: false,
      info: "",
      env: [],
    },
    {
      id: "249ad3e92a93790e",
      type: "file",
      z: "7950429b416904f2",
      name: "",
      filename: "",
      appendNewline: true,
      createDir: false,
      overwriteFile: "true",
      encoding: "none",
      x: 500,
      y: 60,
      wires: [[]],
    },
    {
      id: "eccd274036e3c9f4",
      type: "promptinput",
      z: "7950429b416904f2",
      name: "Prompt input",
      datatype: config.datatype || "str",
      prompt: config.prompt || null,
      property: property,
      propertyType: "msg",
      x: 130,
      y: 80,
      wires: [["cb0203238ed43718"]],
    },
    {
      id: "cb0203238ed43718",
      type: "function",
      z: "7950429b416904f2",
      name: "Process input",
      func: `msg.filename = '${filename}'\nmsg.payload = JSON.stringify({\n    type: typeof msg.${property},\n    value: msg.${property}\n})\nreturn msg`,
      outputs: 1,
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 320,
      y: 80,
      wires: [["249ad3e92a93790e", "b92176149d1b409d"]],
    },
    {
      id: "b92176149d1b409d",
      type: "debug",
      z: "f43f796d9f81196b",
      name: "Display name",
      active: true,
      tosidebar: true,
      console: false,
      tostatus: false,
      complete: "payload",
      targetType: "msg",
      statusVal: "",
      statusType: "auto",
      x: 520,
      y: 100,
      wires: [],
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

function getError(stdout) {
  const sentinel = "[promptinput:Prompt input]"
  return stdout
    .split("\n")
    .filter((item) => item.includes(sentinel))
    .map((item) => {
      const tokens = item.split("[error]")
      return tokens[1].slice(sentinel.length + 1).trim()
    })[0]
}

async function handlePrompt(page, msg) {
  return new Promise(function (resolve) {
    page.on("dialog", async function (dialog) {
      await dialog.accept(msg)
      return resolve(dialog.message())
    })
  })
}

// Tests
describe("node-red-contrib-promptinput", function () {
  let execObj, stdout
  const testDir = path.resolve(__dirname, ".node-red")
  const outputFile = path.resolve(testDir, "output.json")
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
        JSON.stringify(getFlow(outputFile, config), null, 2)
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
  async function runTest(config, input, omitFile, env, readOnly) {
    let title, browserStdout
    try {
      await startNodeRed(config, env, readOnly)
      const browser = await puppeteer.launch({
        headless: true,
        args: ["--user-agent=__pdi-test-puppeteer__"],
      })
      browserStdout = ""
      const page = await browser.newPage()
      page.on("console", async function (data) {
        const prefix = "promptinput"
        const args = await (
          await Promise.all(data.args().map((item) => item.jsonValue()))
        )
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
      let dialogPromise = handlePrompt(page, input)
      while (true) {
        await page.mouse.click(225, 155, { button: "left" })
        title = await dialogPromise
        if (title) {
          break
        }
        await delay(2 * 1000)
      }
      await delay(2 * 1000)
      await browser.close()
    } catch (error) {
      console.log(error)
    }
    let msg = ""
    if (!omitFile) {
      msg = JSON.parse(fs.readFileSync(outputFile))
    }
    return { title, msg, stdout: browserStdout }
  }
  afterEach(function () {
    delete process.env["__PDI_TEST__"]
    delete process.env["__PDI_TEST_FAIL_MODE__"]
    try {
      execObj.kill()
    } catch (_) {}
    rimraf.sync(testDir)
  })
  it("Nested property", async function () {
    let env = {}
    env["__PDI_TEST__"] = "1"
    let config = { property: "payload.city.name" }
    const msg = "Hello world"
    const act = await runTest(config, msg, false, env)
    act.should.eql({
      stdout: "promptinput.notification.success",
      title: "promptinput.label.default_prompt",
      msg: {
        type: "string",
        value: msg,
      },
    })
  })
  describe("Dialog title", function () {
    const tests = [
      { desc: "Custom", prompt: "My window" },
      { desc: "Default", ref: "promptinput.label.default_prompt" },
    ]
    tests.forEach(function (testObj) {
      it(testObj.desc, async function () {
        let act = await runTest({ prompt: testObj.prompt }, "John")
        act.should.eql({
          stdout: "promptinput.notification.success",
          title: testObj.ref || testObj.prompt,
          msg: { type: "string", value: "John" },
        })
      })
    })
  })
  describe("Type conversion", function () {
    const tests = [
      { dataType: "num", longType: "number", input: 5 },
      { dataType: "str", longType: "string", input: "hello" },
      { dataType: "obj", longType: "object", input: { a: "5" } },
      { dataType: "bool", longType: "boolean", input: true },
      {
        dataType: "buf",
        longType: "buffer",
        input: "a",
        refType: "object",
        refinput: JSON.parse(JSON.stringify(new Buffer.from("a"))),
      },
    ]
    for (let mode of ["configuration", "override"]) {
      describe(`Type specified in ${mode}`, function () {
        tests.forEach(function (testObj) {
          it(_capitalize(testObj.longType), async function () {
            let input =
              (mode === "configuration" ? "" : `${testObj.dataType}:`) +
              (testObj.dataType === "obj"
                ? JSON.stringify(testObj.input)
                : testObj.input.toString())
            let configDataType =
              mode === "configuration"
                ? testObj.dataType
                : testObj.dataType === "str"
                ? "num"
                : "str"
            let config = { datatype: configDataType }
            let act = await runTest(config, input)
            act.should.eql({
              stdout: "promptinput.notification.success",
              title: "promptinput.label.default_prompt",
              msg: {
                type: testObj.refType || testObj.longType,
                value: testObj.refinput || testObj.input,
              },
            })
          })
        })
      })
    }
  })
  describe("Editor messages when cannot inject message", function () {
    const tests = [
      { desc: "No node", mode: "NO-NODE", code: 404 },
      { desc: "Message decoding", mode: "MESSAGE", code: 500 },
    ]
    tests.forEach((test) => {
      it(test.desc, async function () {
        let env = {}
        env["__PDI_TEST__"] = "1"
        env["__PDI_TEST_FAIL_MODE__"] = test.mode
        let act = await runTest({}, "John", true, env)
        act.should.eql({
          stdout: `promptinput.notification.failure (${test.code})`,
          title: "promptinput.label.default_prompt",
          msg: "",
        })
      })
    })
    it("Authorization", async function () {
      let env = { __PDI_TEST__: "1" }
      let act = await runTest({}, "John", true, env, true)
      act.should.eql({
        stdout: `promptinput.notification.authorization (401)`,
        title: "promptinput.label.default_prompt",
        msg: "",
      })
    })
  })
  describe("Runtime errors", function () {
    it("Wrong Boolean data type", async function () {
      let env = { __PDI_TEST__: "1" }
      await runTest({}, "bool:John", true, env)
      const act = getError(stdout)
      act.should.equal("promptinput.errors.boolean")
    })
    it("Cannot convert to number", async function () {
      let env = { __PDI_TEST__: "1" }
      await runTest({}, "num:A", true, env)
      const act = getError(stdout)
      act.should.equal("promptinput.errors.number")
    })
    it("General conversion error", async function () {
      let env = { __PDI_TEST__: "1" }
      await runTest({}, "obj:A", true, env)
      const act = getError(stdout)
      act.should.equal("promptinput.errors.conversion")
    })
    it("Illegal property", async function () {
      let env = { __PDI_TEST__: "1" }
      await runTest({ property: "payload.city.....name" }, "Hello", true, env)
      const act = getError(stdout)
      act.should.equal("promptinput.errors.property")
    })
  })
})
