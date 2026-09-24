/**
 *
 * downloadfile-browser_spec.js
 *
 * Copyright 2026-present Prescient Devices, Inc.
 *
 * The Stream mode save dialog, driven in a real editor. A real Node-RED runs the
 * flow, a real Chrome opens the editor, and a fake showSaveFilePicker() records
 * what the editor asks of it and what it writes.
 *
 **/

// NodeJS imports
const { spawn } = require("child_process")
const fs = require("fs")
const http = require("http")
const net = require("net")
const os = require("os")
const path = require("path")
// npm imports
const { expect } = require("chai")
const puppeteer = require("puppeteer")

const PACKAGE_ROOT = path.resolve(__dirname, "..")
const NODE_RED_BIN = path.resolve(PACKAGE_ROOT, "node_modules", ".bin", "node-red")
const HOST = "127.0.0.1"
const NODE_ID = "dl1"
const NODE_NAME = "stream saver"
const FLOW_LABEL = "Stream flow"
const FEED_URL = "/feed"
const START_TIMEOUT_MS = 30 * 1000
const STOP_TIMEOUT_MS = 5 * 1000
const WAIT_TIMEOUT_MS = 15 * 1000
// How long a spec watches for a request that must not come. The editor sends the
// claim in the same task as the picker's rejection, so a claim that is coming
// shows within milliseconds.
const QUIET_MS = 500
// How long the fake writable's abort() takes to settle. Long enough that a
// delete started before the abort settles is logged before it.
const ABORT_SETTLE_MS = 200
// How long a spec holds a stream open. Longer than the 5 seconds after which
// RED.notify() closes a notification that is not fixed.
const SLOW_STREAM_MS = 7 * 1000
// Where the faked proxy sends the download request. Never a Node-RED route.
const REDIRECT_PATH = "/proxy-login"
const REDIRECT_BODY = "<html>proxy login</html>"
// A name with a right-to-left override (U+202E) and a zero-width space (U+200B).
const HIDDEN_NAME = "re‮port​.csv"
// First-strong isolate and pop directional isolate, which safeLabel() puts
// around every name shown in a banner.
const FSI = "⁦"
const POP = "⁩"
const CLAIM = "POST /node-red-contrib-downloadfile/claim/<hex>"
const CANCEL = "POST /node-red-contrib-downloadfile/cancel/<hex>"
const DOWNLOAD = "GET /node-red-contrib-downloadfile/download/<hex>"
// What the editor asks of the save dialog for report.csv.
const CSV_PICKER = {
  picker: {
    suggestedName: "report.csv",
    types: [{ accept: { "text/csv": [".csv"] } }],
  },
}

/**
 * @param {string} text - a name as the editor shows it
 * @returns {string} the name inside the isolates safeLabel() adds
 */
function iso(text) {
  return `${FSI}${text}${POP}`
}

/**
 * @param {string} filename - the sanitised file name the runtime sends
 * @returns {{kind: string, text: string}} the banner notification
 */
function bannerNote(filename) {
  return {
    kind: "info",
    text: `File ready to download from "${iso(NODE_NAME)}" in flow "${iso(
      FLOW_LABEL
    )}": ${iso(filename)}`,
  }
}

/**
 * The flow: POST /feed turns a JSON body into one message for the Stream mode
 * node, and answers the POST at once.
 * @returns {Array<object>} the flow
 */
function buildFlow() {
  const func = [
    "const body = msg.payload || {}",
    "msg.payload = body.payload",
    "if (body.filename !== undefined) { msg.filename = body.filename }",
    "if (body.complete === true) { msg.complete = true }",
    "if (body.error !== undefined) { msg.error = body.error }",
    "return msg",
  ].join("\n")
  return [
    { id: "tab1", type: "tab", label: FLOW_LABEL, disabled: false, info: "" },
    {
      id: "in1",
      type: "http in",
      z: "tab1",
      name: "",
      url: FEED_URL,
      method: "post",
      upload: false,
      swaggerDoc: "",
      x: 100,
      y: 100,
      wires: [["fn1"]],
    },
    {
      id: "fn1",
      type: "function",
      z: "tab1",
      name: "",
      func,
      outputs: 1,
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 300,
      y: 100,
      wires: [[NODE_ID, "res1"]],
    },
    {
      id: NODE_ID,
      type: "downloadfile",
      z: "tab1",
      name: NODE_NAME,
      filename: "",
      encoding: "none",
      stream: true,
      errorProperty: "error",
      outputs: 1,
      x: 500,
      y: 100,
      wires: [[]],
    },
    {
      id: "res1",
      type: "http response",
      z: "tab1",
      name: "",
      statusCode: "",
      headers: {},
      x: 500,
      y: 160,
      wires: [],
    },
  ]
}

/**
 * @returns {Promise<number>} a TCP port that was free a moment ago
 */
function freePort() {
  return new Promise(function (resolve, reject) {
    const server = net.createServer()
    server.on("error", reject)
    server.listen(0, HOST, function () {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

/**
 * Start Node-RED on a fresh user directory that links this package in.
 * @returns {Promise<{child: object, port: number, userDir: string, output: Array<string>}>}
 *   the running Node-RED
 */
async function startNodeRed() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "dlf-browser-"))
  const scopeDir = path.join(userDir, "node_modules", "@prescient-devices-oss")
  fs.mkdirSync(scopeDir, { recursive: true })
  fs.symlinkSync(
    PACKAGE_ROOT,
    path.join(scopeDir, "node-red-contrib-downloadfile"),
    "dir"
  )
  fs.writeFileSync(
    path.join(userDir, "flows.json"),
    JSON.stringify(buildFlow(), null, 2)
  )
  const settings = {
    uiHost: HOST,
    flowFile: "flows.json",
    credentialSecret: false,
    editorTheme: { tours: false },
  }
  fs.writeFileSync(
    path.join(userDir, "settings.js"),
    `module.exports = ${JSON.stringify(settings, null, 2)}\n`
  )
  const port = await freePort()
  const output = []
  const child = spawn(
    process.execPath,
    [NODE_RED_BIN, `--userDir=${userDir}`, `--port=${port}`],
    { stdio: ["ignore", "pipe", "pipe"] }
  )
  const instance = { child, port, userDir, output }
  await new Promise(function (resolve, reject) {
    const timer = setTimeout(function () {
      reject(
        new Error(`Node-RED did not start in time:\n${output.join("").slice(-2000)}`)
      )
    }, START_TIMEOUT_MS)
    function onData(data) {
      output.push(data.toString())
      if (output.join("").includes("Started flows")) {
        clearTimeout(timer)
        resolve()
      }
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", (data) => output.push(data.toString()))
    child.on("exit", function (code) {
      clearTimeout(timer)
      reject(
        new Error(`Node-RED exited with ${code}:\n${output.join("").slice(-2000)}`)
      )
    })
  }).catch(async function (error) {
    await stopNodeRed(instance)
    throw error
  })
  return instance
}

/**
 * Stop Node-RED and delete its user directory. Safe to call twice.
 * @param {object | null} instance - what startNodeRed() returned
 * @returns {Promise<void>}
 */
async function stopNodeRed(instance) {
  if (!instance) {
    return
  }
  const { child, userDir } = instance
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve))
    child.kill("SIGTERM")
    const timer = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS)
    await exited
    clearTimeout(timer)
  }
  fs.rmSync(userDir, { recursive: true, force: true })
}

/**
 * Send one message into the flow.
 * @param {number} port - the Node-RED port
 * @param {object} body - payload, and filename, complete and error when set
 * @returns {Promise<number>} the HTTP status
 */
function feed(port, body) {
  return new Promise(function (resolve, reject) {
    const data = JSON.stringify(body)
    const req = http.request(
      {
        host: HOST,
        port,
        method: "POST",
        path: FEED_URL,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: WAIT_TIMEOUT_MS,
      },
      function (res) {
        res.resume()
        res.on("end", () => resolve(res.statusCode))
      }
    )
    req.on("timeout", () => req.destroy(new Error("POST /feed timed out")))
    req.on("error", reject)
    req.end(data)
  })
}

/**
 * Call a Node-RED route from outside the browser, as another editor would.
 * @param {string} method - the HTTP method
 * @param {string} url - the full URL
 * @returns {Promise<{status: number, body: string}>} the answer
 */
function directCall(method, url) {
  return new Promise(function (resolve, reject) {
    const req = http.request(
      url,
      { method, headers: { Accept: "application/json" }, timeout: WAIT_TIMEOUT_MS },
      function (res) {
        const chunks = []
        res.on("data", (chunk) => chunks.push(chunk))
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        )
      }
    )
    req.on("timeout", () => req.destroy(new Error(`${method} ${url} timed out`)))
    req.on("error", reject)
    req.end()
  })
}

/**
 * @param {object} request - a puppeteer request
 * @returns {string} the method and path, with every 32 hex id as `<hex>`
 */
function requestLabel(request) {
  const url = new URL(request.url())
  return `${request.method()} ${url.pathname.replace(/[0-9a-f]{32}/g, "<hex>")}`
}

/**
 * Runs in the page before the editor's own scripts. Installs the fake save
 * dialog and records, in window.__dlf, what the editor does with it.
 * `window.__dlf.mode` picks how the fake dialog answers. `removeMode` picks how
 * the chosen file's remove() answers: "ok" resolves, "reject" rejects with a
 * NoModificationAllowedError, and "missing" leaves the handle without remove().
 * `renameTo`, when set, replaces the file name in the runtime's next banner
 * event, as something other than the runtime could.
 * @param {number} abortSettleMs - how long the writable's abort() takes
 */
function instrumentPage(abortSettleMs) {
  const rec = {
    log: [],
    bytes: [],
    notes: [],
    mode: "save",
    removeMode: "ok",
    renameTo: null,
    renamed: 0,
    release: null,
    wsOpen: false,
  }
  window.__dlf = rec
  function isOurs(url) {
    return String(url).includes("node-red-contrib-downloadfile/")
  }
  function norm(url) {
    return new URL(String(url), location.href).pathname.replace(
      /[0-9a-f]{32}/g,
      "<hex>"
    )
  }
  function makeHandle(name) {
    const handle = {
      name,
      createWritable: function () {
        rec.log.push("createWritable")
        const stream = new WritableStream({
          write: function (chunk) {
            for (const byte of new Uint8Array(chunk)) {
              rec.bytes.push(byte)
            }
          },
          close: function () {
            rec.log.push("close")
          },
          abort: function () {
            rec.log.push("abort")
          },
        })
        // The editor's own abort() call. pipeTo() aborts through the stream's
        // internals, which the sink's "abort" above records. This one settles
        // late, like a real abort that deletes the browser's temporary copy.
        stream.abort = function (reason) {
          rec.log.push("writable.abort()")
          return WritableStream.prototype.abort
            .call(this, reason)
            .then(() => new Promise((resolve) => setTimeout(resolve, abortSettleMs)))
            .then(() => {
              rec.log.push("writable.abort() settled")
            })
        }
        return Promise.resolve(stream)
      },
    }
    if (rec.removeMode !== "missing") {
      handle.remove = function () {
        rec.log.push("remove")
        if (rec.removeMode === "reject") {
          return Promise.reject(
            new DOMException("The file is in use.", "NoModificationAllowedError")
          )
        }
        return Promise.resolve()
      }
    }
    return handle
  }
  function fakePicker(options) {
    rec.log.push({ picker: JSON.parse(JSON.stringify(options)) })
    if (rec.mode === "cancel") {
      return Promise.reject(new DOMException("The user aborted.", "AbortError"))
    }
    if (rec.mode === "security") {
      return Promise.reject(new DOMException("Not allowed.", "SecurityError"))
    }
    if (rec.mode === "hold") {
      return new Promise(function (resolve) {
        rec.release = () => resolve(makeHandle(options.suggestedName))
      })
    }
    return Promise.resolve(makeHandle(options.suggestedName))
  }
  fakePicker.isFake = true
  window.showSaveFilePicker = fakePicker
  const realOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (method, url) {
    if (isOurs(url)) {
      rec.log.push({ xhr: `${String(method).toUpperCase()} ${norm(url)}` })
    }
    return realOpen.apply(this, arguments)
  }
  const realFetch = window.fetch
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input && input.url
    if (isOurs(url)) {
      const method = String((init && init.method) || "GET").toUpperCase()
      rec.log.push({ fetch: `${method} ${norm(url)}` })
    }
    return realFetch.apply(this, arguments)
  }
  // Replace the file name of a banner event when `renameTo` is set. Returns the
  // event unchanged otherwise.
  function rename(event) {
    if (typeof rec.renameTo !== "string") {
      return event
    }
    let message
    try {
      message = JSON.parse(event.data)
    } catch (_) {
      return event
    }
    if (!Array.isArray(message)) {
      return event
    }
    let changed = false
    for (const item of message) {
      const data = item && item.data
      if (
        String(item && item.topic).startsWith("notification/STREAM-DOWNLOAD-FILE-") &&
        data &&
        typeof data.filename === "string" &&
        !data.claimed &&
        !data.expired
      ) {
        data.filename = rec.renameTo
        changed = true
      }
    }
    if (!changed) {
      return event
    }
    rec.renameTo = null
    rec.renamed += 1
    return new MessageEvent("message", { data: JSON.stringify(message) })
  }
  const RealWebSocket = window.WebSocket
  const onMessage = Object.getOwnPropertyDescriptor(
    RealWebSocket.prototype,
    "onmessage"
  )
  window.WebSocket = function (url, protocols) {
    const socket = new RealWebSocket(url, protocols)
    socket.addEventListener("open", () => (rec.wsOpen = true))
    // The editor's comms assign ws.onmessage.
    Object.defineProperty(socket, "onmessage", {
      configurable: true,
      get: () => onMessage.get.call(socket),
      set: function (handler) {
        const wrapped =
          typeof handler === "function"
            ? function (event) {
                return handler.call(this, rename(event))
              }
            : handler
        onMessage.set.call(socket, wrapped)
      },
    })
    return socket
  }
  window.WebSocket.prototype = RealWebSocket.prototype
  Object.assign(window.WebSocket, {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  })
  new MutationObserver(function (records) {
    for (const record of records) {
      for (const added of record.addedNodes) {
        if (added.nodeType !== 1 || !added.classList.contains("red-ui-notification")) {
          continue
        }
        const kind =
          ["error", "success", "warning"].find((k) =>
            added.classList.contains(`red-ui-notification-${k}`)
          ) || "info"
        const para = added.querySelector("p")
        rec.notes.push({ kind, text: para ? para.textContent : added.textContent })
      }
    }
  }).observe(document, { childList: true, subtree: true })
}

/**
 * @param {object} page - a puppeteer page
 * @param {string} label - what is awaited, for the error message
 * @param {Function} predicate - runs in the page
 * @param {...any} args - passed to the predicate
 * @returns {Promise<void>}
 */
async function waitInPage(page, label, predicate, ...args) {
  try {
    await page.waitForFunction(
      predicate,
      { timeout: WAIT_TIMEOUT_MS, polling: 50 },
      ...args
    )
  } catch (error) {
    const state = await page
      .evaluate(() =>
        JSON.stringify({
          log: window.__dlf.log,
          notes: window.__dlf.notes,
          bytes: window.__dlf.bytes.length,
        })
      )
      .catch(() => "unreadable")
    throw new Error(`Timed out waiting for ${label}; page state ${state}`)
  }
}

/**
 * @param {object} page - a puppeteer page
 * @returns {Promise<object>} a copy of window.__dlf without its functions
 */
function record(page) {
  return page.evaluate(() => ({
    log: window.__dlf.log,
    notes: window.__dlf.notes,
    text: new TextDecoder().decode(new Uint8Array(window.__dlf.bytes)),
  }))
}

/**
 * @param {object} page - a puppeteer page
 * @returns {Promise<number>} how many open banners show a Download button
 */
function openBanners(page) {
  return page.evaluate(
    () =>
      Array.from(document.querySelectorAll(".red-ui-notification")).filter(
        (note) =>
          !note.closed &&
          Array.from(note.querySelectorAll("button")).some(
            (button) => button.textContent === "Download"
          )
      ).length
  )
}

/**
 * Click a button of the one open banner, once it has stopped moving.
 * @param {object} page - a puppeteer page
 * @param {string} text - the button text
 * @returns {Promise<void>}
 */
async function clickBannerButton(page, text) {
  const find = (label) => {
    const notes = Array.from(document.querySelectorAll(".red-ui-notification"))
    for (const note of notes) {
      if (note.closed || $(note).is(":animated") || note.offsetHeight === 0) {
        continue
      }
      for (const button of note.querySelectorAll("button")) {
        if (button.textContent === label) {
          return button
        }
      }
    }
    return null
  }
  await waitInPage(page, `the banner button ${text}`, find, text)
  const handle = await page.evaluateHandle(find, text)
  await handle.click()
  await handle.dispose()
}

/**
 * Wait for `ms` without holding the process open past a failed spec.
 * @param {number} ms - milliseconds
 * @returns {Promise<void>}
 */
function quiet(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("Downloadfile editor - Stream mode save dialog", function () {
  this.timeout(60 * 1000)
  let nodeRed = null
  let browser = null
  let page = null
  let pageRequests = []
  let downloads = []
  let downloadDir = ""
  // Errors thrown by an `intercept` handler. Every spec that intercepts expects
  // none.
  let interceptErrors = []

  /**
   * Wait for the browser's download manager to finish a download.
   * @returns {Promise<Array<{request: string, text: string}>>} every download,
   *   with the text of the file it wrote
   */
  async function linkDownloads() {
    const deadline = Date.now() + WAIT_TIMEOUT_MS
    while (
      !(
        downloads.length > 0 && downloads.every((item) => item.state !== "inProgress")
      ) &&
      Date.now() < deadline
    ) {
      await quiet(50)
    }
    return downloads.map((item) => ({
      request: item.request,
      state: item.state,
      text:
        item.state === "completed"
          ? fs.readFileSync(path.join(downloadDir, item.guid), "utf8")
          : "",
    }))
  }

  /**
   * Start Node-RED and Chrome, open the editor, and wait until it can show a
   * banner.
   * @param {{picker: boolean, intercept: Function | null}} options - `picker`
   *   `false` deletes showSaveFilePicker. `intercept(request, label)` sees every
   *   request of the page and returns `true` when it answered the request
   *   itself; any other request goes on to the network.
   * @returns {Promise<void>}
   */
  async function openEditor({ picker = true, intercept = null } = {}) {
    nodeRed = await startNodeRed()
    browser = await puppeteer.launch({ headless: "new" })
    page = await browser.newPage()
    // The link path's download goes into the Node-RED user directory, which
    // stopNodeRed() deletes. Each file is named by its download GUID.
    downloadDir = path.join(nodeRed.userDir, "downloads")
    fs.mkdirSync(downloadDir)
    downloads = []
    const session = await browser.target().createCDPSession()
    session.on("Browser.downloadWillBegin", function (event) {
      const url = new URL(event.url)
      downloads.push({
        guid: event.guid,
        request: `GET ${url.pathname.replace(/[0-9a-f]{32}/g, "<hex>")}`,
        state: "inProgress",
      })
    })
    session.on("Browser.downloadProgress", function (event) {
      const item = downloads.find((entry) => entry.guid === event.guid)
      if (item) {
        item.state = event.state
      }
    })
    await session.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: downloadDir,
      eventsEnabled: true,
    })
    pageRequests = []
    page.on("request", function (request) {
      const url = new URL(request.url())
      if (url.pathname.includes("node-red-contrib-downloadfile/")) {
        pageRequests.push(
          `${request.method()} ${url.pathname.replace(/[0-9a-f]{32}/g, "<hex>")}`
        )
      }
    })
    interceptErrors = []
    if (intercept) {
      await page.setRequestInterception(true)
      page.on("request", function (request) {
        Promise.resolve()
          .then(() => intercept(request, requestLabel(request)))
          .then((handled) => (handled ? null : request.continue()))
          .catch((error) => interceptErrors.push(String(error)))
      })
    }
    await page.evaluateOnNewDocument(instrumentPage, ABORT_SETTLE_MS)
    if (!picker) {
      await page.evaluateOnNewDocument(() => delete window.showSaveFilePicker)
    }
    await page.goto(`http://${HOST}:${nodeRed.port}`)
    await waitInPage(
      page,
      "the editor to load the node and connect",
      (id) =>
        window.__dlf.wsOpen &&
        window.RED &&
        RED.nodes &&
        RED.nodes.node(id) &&
        $("#red-ui-workspace-chart .red-ui-flow-node").length > 0,
      NODE_ID
    )
    // The fake is installed, in a secure context, or deleted when asked.
    const installed = await page.evaluate(() => ({
      secure: window.isSecureContext,
      picker:
        typeof window.showSaveFilePicker === "undefined"
          ? "absent"
          : window.showSaveFilePicker.isFake === true
            ? "fake"
            : "real",
    }))
    expect(installed).to.deep.equal({
      secure: true,
      picker: picker ? "fake" : "absent",
    })
  }

  /**
   * @param {object} body - the message fields
   * @returns {Promise<void>}
   */
  async function send(body) {
    expect(await feed(nodeRed.port, body)).to.equal(200)
  }

  /**
   * @param {string} mode - how the fake dialog answers
   * @returns {Promise<void>}
   */
  function setMode(mode) {
    return page.evaluate((value) => (window.__dlf.mode = value), mode)
  }

  /**
   * @param {string} mode - how the chosen file's remove() answers
   * @returns {Promise<void>}
   */
  function setRemoveMode(mode) {
    return page.evaluate((value) => (window.__dlf.removeMode = value), mode)
  }

  /**
   * @returns {Promise<number>} how many "Saving" notifications are open
   */
  function savingNotes() {
    return page.evaluate(
      () =>
        Array.from(document.querySelectorAll(".red-ui-notification")).filter(
          (note) => !note.closed && note.textContent.startsWith("Saving ")
        ).length
    )
  }

  /**
   * @param {number} count - how many notifications to wait for
   * @returns {Function} a check for until(): `count` notifications recorded
   */
  function notesAtLeast(count) {
    return (state) => state.notes.length >= count
  }

  /**
   * @returns {Promise<void>} resolves when the banner is on screen
   */
  function waitForBanner() {
    return waitInPage(page, "the banner", () =>
      Array.from(document.querySelectorAll(".red-ui-notification button")).some(
        (button) => button.textContent === "Download"
      )
    )
  }

  /**
   * @returns {Promise<object>} what the page recorded, the open banners, and the
   *   downloads of the browser's download manager
   */
  async function snapshot() {
    const state = await record(page)
    state.banners = await openBanners(page)
    state.downloads = downloads.map((item) => Object.assign({}, item))
    return state
  }

  /**
   * Wait until `check` holds for a snapshot. A timeout does not throw: the
   * deep.equal after the wait then shows what the editor did instead, so a
   * wrong behaviour fails on its assertion, not on the clock.
   * @param {Function} check - takes a snapshot, returns a boolean
   * @returns {Promise<boolean>} whether `check` held in time
   */
  async function until(check) {
    const deadline = Date.now() + WAIT_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (check(await snapshot())) {
        return true
      }
      await quiet(50)
    }
    return false
  }

  /**
   * @param {object} state - a snapshot
   * @returns {boolean} whether the save has ended, in any of the ways it can
   */
  function finished(state) {
    return (
      state.notes.some(
        (note) =>
          note.kind === "success" ||
          note.kind === "error" ||
          note.text.startsWith("This download is no longer available")
      ) || state.downloads.some((item) => item.state !== "inProgress")
    )
  }

  /**
   * Click a banner button when a banner is still open. A banner that a wrong
   * behaviour closed is left to the assertion to report.
   * @param {string} text - the button text
   * @returns {Promise<void>}
   */
  async function clickIfOpen(text) {
    if ((await openBanners(page)) > 0) {
      await clickBannerButton(page, text)
    }
  }

  afterEach(async function () {
    const closing = browser
    browser = null
    page = null
    if (closing) {
      await closing.close().catch(() => {})
    }
    const stopping = nodeRed
    nodeRed = null
    await stopNodeRed(stopping)
  })

  it("Should save into the chosen file with the sanitised name and a csv type", async function () {
    await openEditor()
    await send({ payload: "a,b\n", filename: "rep:ort*.csv" })
    await send({ payload: "1,2\n" })
    await waitForBanner()
    await clickBannerButton(page, "Download")
    await send({ payload: "3,4\n", complete: true })
    await until(finished)
    const expected = {
      log: [
        {
          picker: {
            suggestedName: "report.csv",
            types: [{ accept: { "text/csv": [".csv"] } }],
          },
        },
        { xhr: CLAIM },
        { fetch: DOWNLOAD },
        "createWritable",
        "close",
      ],
      notes: [
        bannerNote("report.csv"),
        { kind: "info", text: `Saving ${iso("report.csv")}` },
        { kind: "success", text: `Saved as ${iso("report.csv")}` },
      ],
      text: "a,b\n1,2\n3,4\n",
    }
    expect(await record(page)).to.deep.equal(expected)
  })

  it("Should give the dialog no file type for an extension outside csv, json, log and txt", async function () {
    await openEditor()
    await send({ payload: "x\n", filename: "export.dat", complete: true })
    await waitForBanner()
    await clickBannerButton(page, "Download")
    await until(finished)
    const expected = {
      log: [
        { picker: { suggestedName: "export.dat" } },
        { xhr: CLAIM },
        { fetch: DOWNLOAD },
        "createWritable",
        "close",
      ],
      notes: [
        bannerNote("export.dat"),
        { kind: "info", text: `Saving ${iso("export.dat")}` },
        { kind: "success", text: `Saved as ${iso("export.dat")}` },
      ],
      text: "x\n",
    }
    expect(await record(page)).to.deep.equal(expected)
  })

  it("Should claim nothing and keep the banner when the dialog is cancelled", async function () {
    await openEditor()
    await send({ payload: "x\n", filename: "report.csv", complete: true })
    await waitForBanner()
    await setMode("cancel")
    await clickBannerButton(page, "Download")
    await until((state) => state.log.length >= 1)
    await quiet(QUIET_MS)
    const bannersAfterCancel = await openBanners(page)
    await clickIfOpen("Download")
    await until((state) => state.log.length >= 2)
    await quiet(QUIET_MS)
    const picker = {
      picker: {
        suggestedName: "report.csv",
        types: [{ accept: { "text/csv": [".csv"] } }],
      },
    }
    const { log, notes } = await record(page)
    const expected = {
      log: [picker, picker],
      notes: [bannerNote("report.csv")],
      bannersAfterCancel: 1,
      bannersAtEnd: 1,
      pageRequests: [],
    }
    expect({
      log,
      notes,
      bannersAfterCancel,
      bannersAtEnd: await openBanners(page),
      pageRequests,
    }).to.deep.equal(expected)
  })

  it("Should fall back to the claim and link download when the dialog throws a SecurityError", async function () {
    await openEditor()
    await send({ payload: "x\n", filename: "report.csv", complete: true })
    await waitForBanner()
    await setMode("security")
    await clickBannerButton(page, "Download")
    await until(finished)
    const linked = await linkDownloads()
    const { log, notes, text } = await record(page)
    const expected = {
      log: [
        {
          picker: {
            suggestedName: "report.csv",
            types: [{ accept: { "text/csv": [".csv"] } }],
          },
        },
        { xhr: CLAIM },
      ],
      notes: [bannerNote("report.csv")],
      text: "",
      pageRequests: [CLAIM],
      linked: [{ request: DOWNLOAD, state: "completed", text: "x\n" }],
      bannersAtEnd: 0,
    }
    expect({
      log,
      notes,
      text,
      pageRequests,
      linked,
      bannersAtEnd: await openBanners(page),
    }).to.deep.equal(expected)
  })

  /**
   * Save two messages into the chosen file, then end the stream with an error.
   * @returns {Promise<object>} what the page recorded
   */
  async function failStreamAfterTwoMessages() {
    await send({ payload: "a,b\n", filename: "report.csv" })
    await send({ payload: "1,2\n" })
    await waitForBanner()
    await clickBannerButton(page, "Download")
    // The first two messages on disk, or the save already gone another way.
    await until(
      (state) =>
        state.text === "a,b\n1,2\n" || state.downloads.length > 0 || finished(state)
    )
    await send({ payload: "not data", complete: true, error: "query failed" })
    await until(finished)
    await quiet(QUIET_MS)
    return record(page)
  }

  it("Should abort the chosen file, then delete it, and report it not saved when the stream fails", async function () {
    await openEditor()
    const expected = {
      log: [
        CSV_PICKER,
        { xhr: CLAIM },
        { fetch: DOWNLOAD },
        "createWritable",
        "abort",
        "writable.abort()",
        "writable.abort() settled",
        "remove",
      ],
      notes: [
        bannerNote("report.csv"),
        { kind: "info", text: `Saving ${iso("report.csv")}` },
        {
          kind: "error",
          text: `The download failed. ${iso("report.csv")} was not saved.`,
        },
      ],
      text: "a,b\n1,2\n",
    }
    expect(await failStreamAfterTwoMessages()).to.deep.equal(expected)
  })

  it("Should say the chosen file may be left empty when remove() rejects", async function () {
    await openEditor()
    await setRemoveMode("reject")
    const expected = {
      log: [
        CSV_PICKER,
        { xhr: CLAIM },
        { fetch: DOWNLOAD },
        "createWritable",
        "abort",
        "writable.abort()",
        "writable.abort() settled",
        "remove",
      ],
      notes: [
        bannerNote("report.csv"),
        { kind: "info", text: `Saving ${iso("report.csv")}` },
        {
          kind: "error",
          text: `The download failed. ${iso("report.csv")} was not saved. ${iso(
            "report.csv"
          )} may be left empty.`,
        },
      ],
      text: "a,b\n1,2\n",
    }
    expect(await failStreamAfterTwoMessages()).to.deep.equal(expected)
  })

  it("Should use the claim and link download when the browser has no save dialog", async function () {
    await openEditor({ picker: false })
    await send({ payload: "x\n", filename: "report.csv", complete: true })
    await waitForBanner()
    await clickBannerButton(page, "Download")
    await until(finished)
    const linked = await linkDownloads()
    const { log, notes, text } = await record(page)
    const expected = {
      log: [{ xhr: CLAIM }],
      notes: [bannerNote("report.csv")],
      text: "",
      pageRequests: [CLAIM],
      linked: [{ request: DOWNLOAD, state: "completed", text: "x\n" }],
      bannersAtEnd: 0,
    }
    expect({
      log,
      notes,
      text,
      pageRequests,
      linked,
      bannersAtEnd: await openBanners(page),
    }).to.deep.equal(expected)
  })

  /**
   * Open the dialog, dismiss the banner while the dialog is open, then choose a
   * file in it.
   * @returns {Promise<object>} what the page recorded, and the page requests
   */
  async function dismissWhileDialogOpen() {
    await send({ payload: "x\n", filename: "report.csv", complete: true })
    await waitForBanner()
    await setMode("hold")
    await clickBannerButton(page, "Download")
    await until((state) => state.log.length >= 1)
    await clickIfOpen("Dismiss")
    await until((state) => state.log.some((entry) => entry.xhr))
    // Choose a file in the dialog that is still open.
    await page.evaluate(() => window.__dlf.release && window.__dlf.release())
    await until(finished)
    await quiet(QUIET_MS)
    const { log, notes, text } = await record(page)
    return { log, notes, text, pageRequests }
  }

  it("Should claim nothing, delete the chosen file and say the download is gone when the banner closes while the dialog is open", async function () {
    await openEditor()
    const expected = {
      log: [CSV_PICKER, { xhr: CANCEL }, "remove"],
      notes: [
        bannerNote("report.csv"),
        { kind: "info", text: "This download is no longer available" },
      ],
      text: "",
      pageRequests: [CANCEL],
    }
    expect(await dismissWhileDialogOpen()).to.deep.equal(expected)
  })

  it("Should end the sentence and say the chosen file may be left empty when the handle has no remove()", async function () {
    await openEditor()
    await setRemoveMode("missing")
    const expected = {
      log: [CSV_PICKER, { xhr: CANCEL }],
      notes: [
        bannerNote("report.csv"),
        {
          kind: "info",
          text: `This download is no longer available. ${iso(
            "report.csv"
          )} may be left empty.`,
        },
      ],
      text: "",
      pageRequests: [CANCEL],
    }
    expect(await dismissWhileDialogOpen()).to.deep.equal(expected)
  })

  it("Should delete the chosen file and say somebody else has it when another editor claims first", async function () {
    const direct = []
    await openEditor({
      intercept: async function (request, label) {
        if (label !== CLAIM || direct.length > 0) {
          return false
        }
        // Another editor claims while this editor's claim is on its way.
        direct.push(await directCall("POST", request.url()))
        return false
      },
    })
    await send({ payload: "x\n", filename: "report.csv", complete: true })
    await waitForBanner()
    await clickBannerButton(page, "Download")
    await until(notesAtLeast(2))
    await quiet(QUIET_MS)
    const { log, notes, text } = await record(page)
    const expected = {
      direct: [200],
      log: [CSV_PICKER, { xhr: CLAIM }, "remove"],
      notes: [
        bannerNote("report.csv"),
        { kind: "info", text: "Somebody else has already downloaded this file" },
      ],
      text: "",
      pageRequests: [CLAIM],
      bannersAtEnd: 0,
      interceptErrors: [],
    }
    expect({
      direct: direct.map((answer) => answer.status),
      log,
      notes,
      text,
      pageRequests,
      bannersAtEnd: await openBanners(page),
      interceptErrors,
    }).to.deep.equal(expected)
  })

  it("Should delete the chosen file and say the download expired when the claim answers 404", async function () {
    const direct = []
    await openEditor({
      intercept: async function (request, label) {
        if (label !== CLAIM || direct.length > 0) {
          return false
        }
        // The runtime drops the download before this editor's claim arrives.
        const url = request.url().replace("/claim/", "/cancel/")
        direct.push(await directCall("POST", url))
        return false
      },
    })
    await send({ payload: "x\n", filename: "report.csv", complete: true })
    await waitForBanner()
    await clickBannerButton(page, "Download")
    await until(notesAtLeast(2))
    await quiet(QUIET_MS)
    const { log, notes, text } = await record(page)
    const expected = {
      direct: [200],
      log: [CSV_PICKER, { xhr: CLAIM }, "remove"],
      notes: [
        bannerNote("report.csv"),
        {
          kind: "info",
          text: "This download request has expired and the file is gone",
        },
      ],
      text: "",
      pageRequests: [CLAIM],
      bannersAtEnd: 0,
      interceptErrors: [],
    }
    expect({
      direct: direct.map((answer) => answer.status),
      log,
      notes,
      text,
      pageRequests,
      bannersAtEnd: await openBanners(page),
      interceptErrors,
    }).to.deep.equal(expected)
  })

  it("Should delete the chosen file, keep the banner, and open the dialog again after another claim error", async function () {
    let refused = 0
    await openEditor({
      intercept: async function (request, label) {
        if (label !== CLAIM || refused > 0) {
          return false
        }
        refused += 1
        await request.respond({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "too many downloads", code: "busy" }),
        })
        return true
      },
    })
    await send({ payload: "x\n", filename: "report.csv", complete: true })
    await waitForBanner()
    await clickBannerButton(page, "Download")
    await until(notesAtLeast(2))
    await quiet(QUIET_MS)
    const afterError = await snapshot()
    await clickIfOpen("Download")
    // finished() already holds for the first error, so wait for the fourth note:
    // banner, error, Saving, and the result of the second try.
    await until(notesAtLeast(4))
    const { log, notes, text } = await record(page)
    const failed = {
      kind: "error",
      text: "Could not start the download, please try again",
    }
    const expected = {
      afterError: {
        log: [CSV_PICKER, { xhr: CLAIM }, "remove"],
        notes: [bannerNote("report.csv"), failed],
        banners: 1,
      },
      log: [
        CSV_PICKER,
        { xhr: CLAIM },
        "remove",
        CSV_PICKER,
        { xhr: CLAIM },
        { fetch: DOWNLOAD },
        "createWritable",
        "close",
      ],
      notes: [
        bannerNote("report.csv"),
        failed,
        { kind: "info", text: `Saving ${iso("report.csv")}` },
        { kind: "success", text: `Saved as ${iso("report.csv")}` },
      ],
      text: "x\n",
      pageRequests: [CLAIM, CLAIM, DOWNLOAD],
      interceptErrors: [],
    }
    expect({
      afterError: {
        log: afterError.log,
        notes: afterError.notes,
        banners: afterError.banners,
      },
      log,
      notes,
      text,
      pageRequests,
      interceptErrors,
    }).to.deep.equal(expected)
  })

  it("Should delete the chosen file and keep the banner when the claim answers a malformed ticket", async function () {
    await openEditor({
      intercept: async function (request, label) {
        if (label !== CLAIM) {
          return false
        }
        await request.respond({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ticket: "not-a-ticket" }),
        })
        return true
      },
    })
    await send({ payload: "x\n", filename: "report.csv", complete: true })
    await waitForBanner()
    await clickBannerButton(page, "Download")
    await until(notesAtLeast(2))
    await quiet(QUIET_MS)
    const { log, notes, text } = await record(page)
    const expected = {
      log: [CSV_PICKER, { xhr: CLAIM }, "remove"],
      notes: [
        bannerNote("report.csv"),
        { kind: "error", text: "Could not start the download, please try again" },
      ],
      text: "",
      pageRequests: [CLAIM],
      bannersAtEnd: 1,
      interceptErrors: [],
    }
    expect({
      log,
      notes,
      text,
      pageRequests,
      bannersAtEnd: await openBanners(page),
      interceptErrors,
    }).to.deep.equal(expected)
  })

  it("Should delete the chosen file and report it not saved when the download answers 404", async function () {
    const direct = []
    await openEditor({
      intercept: async function (request, label) {
        if (label !== DOWNLOAD || direct.length > 0) {
          return false
        }
        // Somebody else spends the ticket first.
        direct.push(await directCall("GET", request.url()))
        return false
      },
    })
    await send({ payload: "x\n", filename: "report.csv", complete: true })
    await waitForBanner()
    await clickBannerButton(page, "Download")
    await until(finished)
    await quiet(QUIET_MS)
    const { log, notes, text } = await record(page)
    const expected = {
      direct: [{ status: 200, body: "x\n" }],
      log: [CSV_PICKER, { xhr: CLAIM }, { fetch: DOWNLOAD }, "remove"],
      notes: [
        bannerNote("report.csv"),
        { kind: "info", text: `Saving ${iso("report.csv")}` },
        {
          kind: "error",
          text: `The download failed. ${iso("report.csv")} was not saved.`,
        },
      ],
      text: "",
      pageRequests: [CLAIM, DOWNLOAD],
      interceptErrors: [],
    }
    expect({ direct, log, notes, text, pageRequests, interceptErrors }).to.deep.equal(
      expected
    )
  })

  it("Should not follow a redirect of the download, and delete the chosen file", async function () {
    const redirected = []
    await openEditor({
      intercept: async function (request, label) {
        const url = new URL(request.url())
        if (url.pathname === REDIRECT_PATH) {
          // A proxy login page, which must never reach the file.
          redirected.push(label)
          await request.respond({
            status: 200,
            contentType: "text/html",
            body: REDIRECT_BODY,
          })
          return true
        }
        if (label !== DOWNLOAD) {
          return false
        }
        await request.respond({
          status: 302,
          headers: { Location: `${url.origin}${REDIRECT_PATH}` },
          body: "",
        })
        return true
      },
    })
    await send({ payload: "x\n", filename: "report.csv", complete: true })
    await waitForBanner()
    await clickBannerButton(page, "Download")
    await until(finished)
    await quiet(QUIET_MS)
    const { log, notes, text } = await record(page)
    const expected = {
      redirected: [],
      log: [CSV_PICKER, { xhr: CLAIM }, { fetch: DOWNLOAD }, "remove"],
      notes: [
        bannerNote("report.csv"),
        { kind: "info", text: `Saving ${iso("report.csv")}` },
        {
          kind: "error",
          text: `The download failed. ${iso("report.csv")} was not saved.`,
        },
      ],
      text: "",
      pageRequests: [CLAIM, DOWNLOAD],
      interceptErrors: [],
    }
    expect({
      redirected,
      log,
      notes,
      text,
      pageRequests,
      interceptErrors,
    }).to.deep.equal(expected)
  })

  it("Should keep the Saving note on screen while a slow stream runs, and close it after the result", async function () {
    await openEditor()
    await send({ payload: "a,b\n", filename: "report.csv" })
    await waitForBanner()
    await clickBannerButton(page, "Download")
    await until((state) => state.text === "a,b\n" || finished(state))
    // Past the 5 seconds after which a notification that is not fixed closes.
    await quiet(SLOW_STREAM_MS)
    const savingDuring = await savingNotes()
    await send({ payload: "1,2\n", complete: true })
    await until(finished)
    const deadline = Date.now() + WAIT_TIMEOUT_MS
    while ((await savingNotes()) > 0 && Date.now() < deadline) {
      await quiet(50)
    }
    const savingAfter = await savingNotes()
    const { log, notes, text } = await record(page)
    const expected = {
      savingDuring: 1,
      savingAfter: 0,
      log: [CSV_PICKER, { xhr: CLAIM }, { fetch: DOWNLOAD }, "createWritable", "close"],
      notes: [
        bannerNote("report.csv"),
        { kind: "info", text: `Saving ${iso("report.csv")}` },
        { kind: "success", text: `Saved as ${iso("report.csv")}` },
      ],
      text: "a,b\n1,2\n",
    }
    expect({ savingDuring, savingAfter, log, notes, text }).to.deep.equal(expected)
  })

  it("Should delete hidden and direction characters from the name offered in the dialog", async function () {
    await openEditor()
    // The runtime deletes these characters itself, so the event is changed in
    // the page, as a sender other than the runtime could send it.
    await page.evaluate((name) => (window.__dlf.renameTo = name), HIDDEN_NAME)
    await send({ payload: "x\n", filename: "report.csv", complete: true })
    await waitForBanner()
    await clickBannerButton(page, "Download")
    await until(finished)
    const renamed = await page.evaluate(() => window.__dlf.renamed)
    const expected = {
      renamed: 1,
      log: [CSV_PICKER, { xhr: CLAIM }, { fetch: DOWNLOAD }, "createWritable", "close"],
      notes: [
        bannerNote("report.csv"),
        { kind: "info", text: `Saving ${iso("report.csv")}` },
        { kind: "success", text: `Saved as ${iso("report.csv")}` },
      ],
      text: "x\n",
    }
    expect(Object.assign({ renamed }, await record(page))).to.deep.equal(expected)
  })
})
