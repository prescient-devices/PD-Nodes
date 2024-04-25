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
const { firefox, webkit, chromium } = require("playwright")
const freePort = require("find-free-port")
const should = require("chai").should()
// Node-RED imports
const { spawn, spawnSync } = require("child_process")

// Functions
function _capitalize(arg) {
  return arg[0].toUpperCase() + arg.slice(1)
}

function getFlow(filename, config) {
  config = config || {}
  let {
    datatype = "str",
    prompt = null,
    property = "payload",
    validation = "",
    propOverride = "",
    promptOverride = "",
    validationOverride = "",
    typeOverride = "",
  } = config
  const filterProp = propOverride || property
  const flowArray = [
    {
      id: "7950429b416904f2",
      type: "tab",
      label: "Test flow",
      disabled: false,
      info: "",
      env: [],
    },
    {
      id: "de23be199256aca4",
      type: "inject",
      z: "7950429b416904f2",
      name: "Overrides",
      props: [
        {
          p: "prop",
          v: propOverride,
          vt: "str",
        },
        {
          p: "prompt",
          v: promptOverride,
          vt: "str",
        },
        {
          p: "validation",
          v: validationOverride,
          vt: "str",
        },
        {
          p: "type",
          v: typeOverride,
          vt: "str",
        },
      ],
      repeat: "",
      crontab: "",
      once: false,
      onceDelay: 0.1,
      topic: "",
      x: 120,
      y: 120,
      wires: [["eccd274036e3c9f4", "zaf934569d1b409d"]],
    },
    {
      id: "zaf934569d1b409d",
      type: "debug",
      z: "7950429b416904f2",
      name: "Overrides visibility",
      active: true,
      tosidebar: true,
      console: false,
      tostatus: false,
      complete: "true",
      targetType: "full",
      statusVal: "",
      statusType: "auto",
      x: 330,
      y: 160,
      wires: [],
    },
    {
      id: "eccd274036e3c9f4",
      type: "promptinput",
      z: "7950429b416904f2",
      name: "Prompt input",
      datatype,
      prompt,
      property: property,
      propertyType: "msg",
      validation: validation,
      validationType: "ejsonata",
      x: 310,
      y: 80,
      wires: [["cb0203238ed43718"]],
    },
    {
      id: "cb0203238ed43718",
      type: "function",
      z: "7950429b416904f2",
      name: "Process input",
      func: `msg.filename = '${filename}'\nmsg.payload = JSON.stringify({\n    type: typeof msg.${filterProp},\n    value: msg.${filterProp}\n})\nreturn msg`,
      outputs: 1,
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 500,
      y: 80,
      wires: [["249ad3e92a93790e", "b92176149d1b409d"]],
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
      x: 680,
      y: 60,
      wires: [[]],
    },
    {
      id: "b92176149d1b409d",
      type: "debug",
      z: "7950429b416904f2",
      name: "Display name",
      active: true,
      tosidebar: true,
      console: false,
      tostatus: false,
      complete: "payload",
      targetType: "msg",
      statusVal: "",
      statusType: "auto",
      x: 700,
      y: 100,
      wires: [],
    },
  ]
  return flowArray
}

async function getPort(minPort) {
  let ports
  try {
    ports = await freePort(minPort || 1882)
  } catch (error) {
    return console.error(error)
  }
  if (!ports || ports.length === 0) {
    return console.error("Could not find a free port")
  }
  return parseInt(ports[0])
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
  return getLogProp("error", stdout)
}

function getLogProp(prop, stdout) {
  const nodeSentinel = "[promptinput:Prompt input]"
  const propSentinel = `[${prop}]`
  return stdout
    .split("\n")
    .filter((item) => item.includes(nodeSentinel) && item.includes(propSentinel))
    .map((item) => {
      const tokens = item.split(propSentinel)
      return tokens[1].slice(nodeSentinel.length + 1).trim()
    })[0]
}

function getWarning(stdout) {
  return getLogProp("warn", stdout)
}

async function handlePrompt(page, msg) {
  return new Promise(function (resolve) {
    page.on("dialog", async function (dialog) {
      await dialog.accept(msg)
      return resolve(dialog.message())
    })
  })
}

async function runTest({
  browserCls,
  config,
  input,
  omitFile,
  env,
  readOnly,
  point = "node",
}) {
  let title, browserStdout
  const selSuffix = " > .red-ui-flow-node-button > .red-ui-flow-node-button-button"
  const selectors = {
    node: `#eccd274036e3c9f4${selSuffix}`,
    injector: `#de23be199256aca4${selSuffix}`,
  }
  try {
    const port = await getPort()
    if (isNaN(port)) {
      return
    }
    this.test.nodeRedObj = new NodeRED(config, env, readOnly, port)
    await this.test.nodeRedObj.start()
    const browser = await browserCls.launch()
    const context = await browser.newContext({ userAgent: "__pdi-test__" })
    const page = await context.newPage()
    browserStdout = ""
    page.on("console", async function (data) {
      const prefix = "promptinput"
      const args = (await Promise.all(data.args().map((item) => item.jsonValue())))
        .filter((item) => item.startsWith(prefix))
        .map((item) => item.slice(prefix.length + 2))
        .join("\n")
      browserStdout += args.trim()
    })
    await page.goto(`http://127.0.0.1:${port}`)
    if (readOnly) {
      await page.getByLabel("Username:").fill("admin")
      await page.getByLabel("Password:").fill("111111")
      await page.getByRole("button", { name: "Login" }).click()
    }
    //await page.waitForSelector("#red-ui-sidebar-tabs")
    await Promise.all(
      Object.values(selectors).map((item) => page.waitForSelector(item))
    )
    let dialogPromise = handlePrompt(page, input)
    while (true) {
      await page.locator(selectors[point]).click({ button: "left" })
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
    msg = JSON.parse(fs.readFileSync(this.test.nodeRedObj.outputFile))
  }
  return { title, msg, stdout: browserStdout }
}

class NodeRED {
  constructor(config, env, readOnly, port) {
    this.config = config
    this.env = env
    this.readOnly = readOnly
    this.port = port
    this.testDir = path.resolve(__dirname, `.node-red-${port}`)
    this.outputFile = path.resolve(this.testDir, "output.json")
    this.debug = false
    this.stdout = ""
    this.execObj = null
  }
  start() {
    const that = this
    return new Promise(function (resolve) {
      const nodeRedBin = path.resolve(
        __dirname,
        "..",
        "node_modules",
        ".bin",
        "node-red"
      )
      try {
        fs.rmSync(that.testDir, { recursive: true })
      } catch (_) {}
      fs.mkdirSync(that.testDir, { recursive: true })
      fs.writeFileSync(
        path.resolve(that.testDir, "flows.json"),
        JSON.stringify(getFlow(that.outputFile, that.config), null, 2)
      )
      spawnSync("npm", [
        "install",
        "--production",
        "--prefix",
        path.resolve(that.testDir),
        path.resolve(__dirname, ".."),
      ])
      let settings = {}
      const settingsFile = path.resolve(that.testDir, "settings.js")
      if (fs.existsSync(settingsFile)) {
        settings = require(settingsFile)
      }
      settings.editorTheme = settings.editorTheme || {}
      settings.editorTheme.tours = false
      settings.flowFile = "flows.json"
      if (that.readOnly) {
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
      let cmdEnv = Object.assign(clone(process.env), that.env || {})
      that.execObj = spawn(
        nodeRedBin,
        [`--userDir=${that.testDir}`, `--port=${that.port}`],
        { env: cmdEnv }
      )
      that.stdout = ""
      that.execObj.stdout.on("data", function (data) {
        that.stdout += data.toString()
        that.debug && console.log(data.toString().trimEnd())
        if (that.stdout.includes("Started flows")) {
          return resolve()
        }
      })
      that.execObj.stderr.on("data", function (data) {
        that.debug && console.log(data.toString().trim())
      })
    })
  }
  stop() {
    try {
      this.execObj.kill()
    } catch (_) {}
    try {
      fs.rmSync(this.testDir, { recursive: true })
    } catch (_) {}
  }
}

// Tests
const browsers = { Firefox: firefox, WebKit: webkit, Chromium: chromium }
describe("node-red-contrib-promptinput", function () {
  for (const [browserDesc, browserCls] of Object.entries(browsers)) {
    describe(`Browser: ${browserDesc}`, function () {
      afterEach(function () {
        const keys = ["__PDI_TEST__", "__PDI_TEST_FAIL_MODE__"]
        keys.forEach((key) => delete process.env[key])
        this.currentTest.nodeRedObj.stop()
      })
      for (const mode of ["configuration", "message override"]) {
        it(`Nested property (${mode})`, async function () {
          let env = {}
          env["__PDI_TEST__"] = "1"
          const config = {
            [mode === "configuration" ? "property" : "propOverride"]:
              "payload.city.name",
          }
          const msg = "Hello world"
          const act = await runTest.call(this, {
            browserCls,
            config,
            input: msg,
            omitFile: false,
            env,
            point: mode === "configuration" ? "node" : "injector",
          })
          act.should.eql({
            stdout: "promptinput.notification.success",
            title: "promptinput.label.default_prompt",
            msg: {
              type: "string",
              value: msg,
            },
          })
        })
      }
      describe("Dialog title", function () {
        const tests = [
          { desc: "Custom", prompt: "My window" },
          { desc: "Default", ref: "promptinput.label.default_prompt" },
          { desc: "Message", promptOverride: "Message prompt", point: "injector" },
        ]
        tests.forEach(function (testObj) {
          it(testObj.desc, async function () {
            const { ref, prompt = "", promptOverride = "", point } = testObj
            let act = await runTest.call(this, {
              browserCls,
              config: { prompt, promptOverride },
              input: "John",
              point,
            })
            act.should.eql({
              stdout: "promptinput.notification.success",
              title: ref || prompt || promptOverride,
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
        for (let mode of ["configuration", "input override", "message override"]) {
          describe(`Type specified in ${mode}`, function () {
            tests.forEach(function (testObj) {
              it(_capitalize(testObj.longType), async function () {
                const input =
                  (["configuration", "message override"].includes(mode)
                    ? ""
                    : `${testObj.dataType}:`) +
                  (testObj.dataType === "obj"
                    ? JSON.stringify(testObj.input)
                    : testObj.input.toString())
                const configDataType =
                  mode === "configuration"
                    ? testObj.dataType
                    : testObj.dataType === "str"
                    ? "num"
                    : "str"
                let config = { datatype: configDataType }
                let point = "node"
                if (mode === "message override") {
                  Object.assign(config, { typeOverride: testObj.dataType })
                  point = "injector"
                }
                const act = await runTest.call(this, {
                  browserCls,
                  config,
                  input,
                  point,
                })
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
            let act = await runTest.call(this, {
              browserCls,
              config: {},
              input: "John",
              omitFile: true,
              env,
            })
            act.should.eql({
              stdout: `promptinput.notification.failure (${test.code})`,
              title: "promptinput.label.default_prompt",
              msg: "",
            })
          })
        })
        it("Authorization", async function () {
          const env = { __PDI_TEST__: "1" }
          const act = await runTest.call(this, {
            browserCls,
            config: {},
            input: "John",
            omitFile: true,
            env,
            readOnly: true,
          })
          act.should.eql({
            stdout: `promptinput.notification.authorization (401)`,
            title: "promptinput.label.default_prompt",
            msg: "",
          })
        })
      })
      describe("Validation", function () {
        const env = { __PDI_TEST__: "1" }
        it("Invalid JSONata expression in configuration", async function () {
          await runTest.call(this, {
            browserCls,
            config: { validation: "$upper( = n" },
            input: "YES",
            omitFile: true,
            env,
          })
          let act = getError(this.test.nodeRedObj.stdout)
          act.should.eql("promptinput.errors.validation")
          act = getWarning(this.test.nodeRedObj.stdout)
          act.should.eql("promptinput.errors.validation_disabled")
        })
        it("Invalid JSONata expression in message override", async function () {
          await runTest.call(this, {
            browserCls,
            config: { validationOverride: "$upper( = n" },
            input: "YES",
            omitFile: true,
            env,
            point: "injector",
          })
          const act = getError(this.test.nodeRedObj.stdout)
          act.should.eql("promptinput.errors.validation")
        })
        for (const mode of ["configuration", "message override"]) {
          for (const result of ["success", "failure"]) {
            it(`In ${mode} (${result})`, async function () {
              const validation = '$uppercase(answer) = "YES"'
              const config =
                mode === "configuration"
                  ? { validation }
                  : { validationOverride: validation }
              Object.assign(config, { property: "answer" })
              const act = await runTest.call(this, {
                browserCls,
                config,
                input: result === "success" ? "YeS" : "No",
                omitFile: result !== "success",
                env,
                point: mode === "configuration" ? "node" : "injector",
              })
              if (result === "success") {
                act.msg.should.eql({ type: "string", value: "YeS" })
              } else {
                const act = getWarning(this.test.nodeRedObj.stdout)
                act.should.eql("promptinput.validation.false")
              }
            })
          }
        }
      })
      describe("Runtime errors and warnings", function () {
        it("Unsupported data type in message override", async function () {
          let env = { __PDI_TEST__: "1" }
          await runTest.call(this, {
            browserCls,
            config: { typeOverride: "abc" },
            input: "John",
            omitFile: true,
            env,
            point: "injector",
          })
          const act = getWarning(this.test.nodeRedObj.stdout)
          act.should.equal("promptinput.errors.type_ignored")
        })
        it("Wrong Boolean data type", async function () {
          let env = { __PDI_TEST__: "1" }
          await runTest.call(this, {
            browserCls,
            config: {},
            input: "bool:John",
            omitFile: true,
            env,
          })
          const act = getError(this.test.nodeRedObj.stdout)
          act.should.equal("promptinput.errors.boolean")
        })
        it("Cannot convert to number", async function () {
          let env = { __PDI_TEST__: "1" }
          await runTest.call(this, {
            browserCls,
            config: {},
            input: "num:A",
            omitFile: true,
            env,
          })
          const act = getError(this.test.nodeRedObj.stdout)
          act.should.equal("promptinput.errors.number")
        })
        it("General conversion error", async function () {
          let env = { __PDI_TEST__: "1" }
          await runTest.call(this, {
            browserCls,
            config: {},
            input: "obj:A",
            omitFile: true,
            env,
          })
          const act = getError(this.test.nodeRedObj.stdout)
          act.should.equal("promptinput.errors.conversion")
        })
        for (const mode of ["configuration", "message override"]) {
          it(`Illegal property (${mode})`, async function () {
            let env = { __PDI_TEST__: "1" }
            const config = {
              [mode === "configuration" ? "property" : "propOverride"]:
                "payload.city.....name",
            }
            await runTest.call(this, {
              browserCls,
              config,
              input: "Hello",
              omitFile: true,
              env,
              point: mode === "configuration" ? "node" : "injector",
            })
            const act = getError(this.test.nodeRedObj.stdout)
            act.should.equal("promptinput.errors.property")
          })
        }
      })
    })
  }
})
