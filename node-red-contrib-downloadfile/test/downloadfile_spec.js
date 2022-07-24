/**
 *
 * downloadfile_spec.js
 *
 * Copyright 2022-present Prescient Devices, Inc.
 *
 **/

// NodeJS imports
const fs = require("fs")
const path = require("path")
// npm imports
const puppeteer = require("puppeteer")
const rimraf = require("rimraf")
const should = require("should")
// Node-RED imports
const helper = require("node-red-node-test-helper")
const { spawn, spawnSync } = require("child_process")
const { agent } = require("supertest")
const { allowedNodeEnvironmentFlags } = require("process")
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
// Local imports
const DownloadFileNode = require(path.resolve(__dirname, "..", "downloadfile.js"))

const globalNodes = [InjectNode, DownloadFileNode]
const globalExampleFileName = path.resolve(
  __dirname,
  "..",
  "examples",
  "Save hello world message.json"
)

// Functions
function getFlow(config) {
  let flowArray = JSON.parse(fs.readFileSync(globalExampleFileName))
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

function testNodeWarning(config, msg) {
  return new Promise(function (resolve) {
    helper.load(globalNodes, getFlow(config), function () {
      let n1 = helper.getNode("bb6ffc1b678054c6")
      n1.receive(msg)
      n1.on("call:warn", (call) => {
        return resolve(call.args[0])
      })
    })
  })
}

helper.init(require.resolve("node-red"))

// Tests
describe("downloadfile", function () {
  describe("Errors", function () {
    beforeEach(function (done) {
      helper.startServer(done)
    })
    afterEach(function (done) {
      helper
        .unload()
        .then(function () {
          return new Promise(function (resolve) {
            helper.stopServer(resolve)
          })
        })
        .then(function () {
          return done()
        })
    })
    it("No payload", async function () {
      const act = await testNodeWarning({}, { topic: "a" })
      act.should.eql("warn.no_payload")
    })
    it("Cannot convert payload to string", async function () {
      const act = await testNodeWarning({}, { payload: BigInt(1) })
      act.should.eql("warn.cannot_convert_to_string")
    })
  })
  describe("Browser tests", function () {
    let execObj
    const testDir = path.resolve(__dirname, ".node-red")
    const outputFile = path.resolve(testDir, "myfile.txt")
    beforeEach(function () {
      const nodeRedBin = path.resolve(
        __dirname,
        "..",
        "node_modules",
        ".bin",
        "node-red"
      )
      rimraf.sync(testDir)
      fs.mkdirSync(testDir, { recursive: true })
      fs.copyFileSync(globalExampleFileName, path.resolve(testDir, "flows.json"))
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
        settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"))
      }
      settings.editorTheme = settings.editorTheme || {}
      settings.editorTheme.tours = false
      settings.flowFile = "flows.json"
      const data = `module.exports = ${JSON.stringify(settings, null, 2)}`
      fs.writeFileSync(settingsFile, data)
      execObj = spawn(nodeRedBin, [`--userDir=${testDir}`])
      const debug = false
      if (debug) {
        execObj.stdout.on("data", function (data) {
          console.log(data.toString().trim())
        })
        execObj.stderr.on("data", function (data) {
          console.log(data.toString().trim())
        })
      }
    })
    afterEach(function () {
      try {
        execObj.kill()
      } catch (_) {}
      rimraf.sync(testDir)
    })
    it("Download message", async function () {
      const browser = await puppeteer.launch()
      const page = await browser.newPage()
      const client = await page.target().createCDPSession()
      await client.send("Page.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: path.resolve(testDir),
      })
      while (true) {
        await delay(1 * 1000)
        try {
          await page.goto("http://127.0.0.1:1880")
          break
        } catch (_) {}
      }
      await delay(5 * 1000)
      await page.mouse.click(225, 135, { button: "left" })
      await delay(5 * 1000)
      await browser.close()
      let result = false
      try {
        const data = fs.readFileSync(outputFile, "utf8").toString().trim()
        result = data === "Hello world!"
      } catch (_) {}
      result.should.eql(true, "File downloaded")
    })
  })
})
