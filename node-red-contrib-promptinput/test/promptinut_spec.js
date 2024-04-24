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
const { firefox } = require("playwright")
const should = require("chai").should()
// Node-RED imports
const { spawn, spawnSync } = require("child_process")

let page, browser, context

// Functions
function _capitalize(arg) {
  return arg[0].toUpperCase() + arg.slice(1)
}

function getFlow(filename, config) {
  config = config || {}
  let { property, validation, promptOveride, validationOverride, typeOverride } = config
  property = property || "payload"
  validation = validation || ""
  promptOveride = promptOveride || ""
  validationOverride = validationOverride || ""
  typeOverride = typeOverride || ""
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
          p: "prompt",
          v: promptOveride,
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
      datatype: config.datatype || "str",
      prompt: config.prompt || null,
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
      func: `msg.filename = '${filename}'\nmsg.payload = JSON.stringify({\n    type: typeof msg.${property},\n    value: msg.${property}\n})\nreturn msg`,
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
      try {
        fs.rmSync(testDir, { recursive: true })
      } catch (_) {}
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
  async function runTest({ config, input, omitFile, env, readOnly, point = "node" }) {
    let title, browserStdout
    try {
      await startNodeRed(config, env, readOnly)
      const browser = await firefox.launch()
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
        const id = point === "node" ? "eccd274036e3c9f4" : "de23be199256aca4"
        await page
          .locator(
            `#${id} > .red-ui-flow-node-button > .red-ui-flow-node-button-button`
          )
          .click({ button: "left" })
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
    try {
      fs.rmSync(testDir, { recursive: true })
    } catch (_) {}
  })
  it("Nested property", async function () {
    let env = {}
    env["__PDI_TEST__"] = "1"
    let config = { property: "payload.city.name" }
    const msg = "Hello world"
    const act = await runTest({ config, input: msg, omitFile: false, env })
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
      { desc: "Message", promptOveride: "Message prompt", point: "injector" },
    ]
    tests.forEach(function (testObj) {
      it(testObj.desc, async function () {
        const { ref, prompt = "", promptOveride = "", point = {} } = testObj
        let act = await runTest({
          config: { prompt, promptOveride },
          input: "John",
          point,
        })
        act.should.eql({
          stdout: "promptinput.notification.success",
          title: ref || prompt || promptOveride,
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
            const act = await runTest({ config, input, point })
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
        let act = await runTest({ config: {}, input: "John", omitFile: true, env })
        act.should.eql({
          stdout: `promptinput.notification.failure (${test.code})`,
          title: "promptinput.label.default_prompt",
          msg: "",
        })
      })
    })
    it("Authorization", async function () {
      const env = { __PDI_TEST__: "1" }
      const act = await runTest({
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
      await runTest({
        config: { validation: "$upper( = n" },
        input: "YES",
        omitFile: true,
        env,
      })
      let act = getError(stdout)
      act.should.eql("promptinput.errors.validation")
      act = getWarning(stdout)
      act.should.eql("promptinput.errors.validation_disabled")
    })
    it("Invalid JSONata expression in message override", async function () {
      await runTest({
        config: { validationOverride: "$upper( = n" },
        input: "YES",
        omitFile: true,
        env,
        point: "injector"
      })
      const act = getError(stdout)
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
          const act = await runTest({
            config,
            input: result === "success" ? "YeS" : "No",
            omitFile: result !== "success",
            env,
            point: mode === "configuration" ? "node" : "injector",
          })
          if (result === "success") {
            act.msg.should.eql({ type: "string", value: "YeS" })
          } else {
            const act = getWarning(stdout)
            act.should.eql("promptinput.validation.false")
          }
        })
      }
    }
  })
  describe("Runtime errors and warnings", function () {
    it("Unsupported data type in message override", async function () {
      let env = { __PDI_TEST__: "1" }
      await runTest({
        config: { typeOverride: "abc" },
        input: "John",
        omitFile: true,
        env,
        point: "injector",
      })
      const act = getWarning(stdout)
      act.should.equal("promptinput.errors.type_ignored")
    })
    it("Wrong Boolean data type", async function () {
      let env = { __PDI_TEST__: "1" }
      await runTest({ config: {}, input: "bool:John", omitFile: true, env })
      const act = getError(stdout)
      act.should.equal("promptinput.errors.boolean")
    })
    it("Cannot convert to number", async function () {
      let env = { __PDI_TEST__: "1" }
      await runTest({ config: {}, input: "num:A", omitFile: true, env })
      const act = getError(stdout)
      act.should.equal("promptinput.errors.number")
    })
    it("General conversion error", async function () {
      let env = { __PDI_TEST__: "1" }
      await runTest({ config: {}, input: "obj:A", omitFile: true, env })
      const act = getError(stdout)
      act.should.equal("promptinput.errors.conversion")
    })
    it("Illegal property", async function () {
      let env = { __PDI_TEST__: "1" }
      await runTest({
        config: { property: "payload.city.....name" },
        input: "Hello",
        omitFile: true,
        env,
      })
      const act = getError(stdout)
      act.should.equal("promptinput.errors.property")
    })
  })
})
