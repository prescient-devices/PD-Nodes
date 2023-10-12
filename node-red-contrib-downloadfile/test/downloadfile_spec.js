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
const clone = require("clone")
const netstat = require("node-netstat")
const puppeteer = require("puppeteer")
const should = require("should")
// Node-RED imports
const helper = require("node-red-node-test-helper")
const { spawn, spawnSync } = require("child_process")
const nodeRedNodesDir = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "@node-red",
  "nodes"
)
const InjectNode = require(
  path.resolve(nodeRedNodesDir, "core", "common", "20-inject.js")
)
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
  let str = fs.readFileSync(config.fname).toString()
  if (config.replace) {
    for (const item of config.replace) {
      str = str.split(item.from).join(item.to)
    }
  }
  const flowArray = JSON.parse(str)
  return flowArray
}

async function getFreePort(start, stop) {
  let listeningPorts = await new Promise((resolve, reject) => {
    const res = []
    netstat(
      {
        filter: { protocol: "tcp" },
        done: (error) => {
          return error ? reject(error) : resolve(res)
        },
      },
      (item) => item.local && item.local.port && res.push(item.local.port)
    )
  })
  listeningPorts.sort((a, b) => (a > b ? +1 : a < b ? -1 : 0))
  start = start || 1
  stop = stop || 65535
  if (stop - start <= 0) {
    console.error("Illegal port range specification")
    return false
  }
  listeningPorts = listeningPorts.filter((item) => item >= start && item <= stop)
  for (let i = start; i < stop; i++) {
    if (!listeningPorts.includes(i)) {
      return i
    }
  }
  return false
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
describe("node-red-contrib-downloadfile", function () {
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
      const act = await testNodeWarning(
        { fname: globalExampleFileName },
        { topic: "a" }
      )
      act.should.eql("warn.no_payload")
    })
    it("Cannot convert payload to string", async function () {
      const act = await testNodeWarning(
        { fname: globalExampleFileName },
        {
          payload: BigInt(1),
        }
      )
      act.should.eql("warn.cannot_convert_to_string")
    })
  })
  describe("Browser tests", function () {
    let execObj
    const testDir = path.resolve(__dirname, ".node-red")
    async function startNodeRed(config, env, readOnly) {
      const debug = false
      const port = await getFreePort(1880)
      if (port === false) {
        console.error("Could not find a free port")
        return
      }
      return new Promise(function (resolve) {
        const nodeRedBin = path.resolve(
          __dirname,
          "..",
          "node_modules",
          ".bin",
          "node-red"
        )
        fs.rmSync(testDir, { recursive: true, force: true })
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
                password:
                  "$2b$08$v/98KrBPLWFtFc6FyzHuNuspzrQ6PZktnT2SYgTDJECpibZAk8YC6",
                permissions: ["read"],
              },
            ],
          }
        }
        const data = `module.exports = ${JSON.stringify(settings, null, 2)}`
        fs.writeFileSync(settingsFile, data)
        let cmdEnv = Object.assign(clone(process.env), env || {})
        execObj = spawn(nodeRedBin, [`--userDir=${testDir}`, `--port=${port}`], {
          env: cmdEnv,
        })
        stdout = ""
        execObj.stdout.on("data", function (data) {
          stdout += data.toString()
          debug && console.log(data.toString().trimEnd())
          if (stdout.includes("Started flows")) {
            return resolve(port)
          }
        })
        execObj.stderr.on("data", function (data) {
          debug && console.log(data.toString().trim())
        })
      })
    }
    async function downloadFile(config) {
      const nodeRedPort = await startNodeRed(config)
      const browser = await puppeteer.launch({
        headless: "new",
        args: ["--user-agent=__pdi-test-puppeteer__"],
      })
      const page = await browser.newPage()
      const client = await page.target().createCDPSession()
      await client.send("Page.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: path.resolve(testDir),
      })
      await page.goto(`http://127.0.0.1:${nodeRedPort}`)
      await page.waitForSelector("#red-ui-sidebar-tabs")
      await delay(5 * 1000)
      await page.mouse.click(225, 135, { button: "left" })
      await delay(5 * 1000)
      await browser.close()
    }
    afterEach(function () {
      try {
        execObj.kill()
      } catch (_) {}
      fs.rmSync(testDir, { recursive: true, force: true })
    })
    it("Text file", async function () {
      await downloadFile({ fname: globalExampleFileName })
      const outputFile = path.resolve(testDir, "myfile.txt") // The base name is defined in the flow
      let result = false
      try {
        const data = fs.readFileSync(outputFile, "utf8").toString().trim()
        result = data === "Hello world!"
      } catch (_) {}
      result.should.eql(true, "Text file downloaded")
    })
    it("Binary file", async function () {
      await downloadFile({
        fname: path.resolve(__dirname, "binary_file_test.json"),
        replace: [{ from: "TEST-DIR", to: path.resolve(__dirname) }],
      })
      const refFile = path.resolve(__dirname, "binfile.tar.gz")
      const actFile = path.resolve(testDir, "test_binary_file.tar.gz") // The base name is defined in the flow
      let result = false
      try {
        const ref = fs.readFileSync(refFile)
        const act = fs.readFileSync(actFile)
        result = !Boolean(Buffer.compare(ref, act))
      } catch (error) {
        console.log(error)
      }
      result.should.eql(true, "Binary file downloaded")
    })
  })
})
