/**
 * Copyright 2020 Prescient Devices, Inc.
 **/

const fs = require("fs")
const os = require("os")
const path = require("path")
const rimraf = require("rimraf")
const NodeWebcam = require("node-webcam")

module.exports = function (RED) {
  var globalActive = true
  var globalCaptureTimeout = 5000 // In milliseconds
  var globalDebug = false
  var globalFileErrorPrefix = "Error: could not create directory "
  var globalInitialRetryInterval = 1000 // In milliseconds
  var globalMaxRetries = 5
  var globalQueue = []
  var globalState = "IDLE"
  var globalTimer

  const execSync = require("child_process").execSync
  try {
    execSync("fswebcam", { stdio: "ignore", timeout: 2000 })
  } catch (_) {
    globalActive = false
    RED.log.warn("usb-camera: " + RED._("usb-camera.errors.ignorenode"))
  }

  function capture(config, opts) {
    log("Capture function for node " + config.id)
    var Webcam = NodeWebcam.create(opts)
    var filename = path.resolve(
      config.mode === "file"
        ? config.filename
        : path.join(os.tmpdir(), "image_" + config.id + "." + config.format)
    )
    var dirname = path.dirname(filename)
    try {
      fs.mkdirSync(dirname, { recursive: true })
    } catch (_) {
      return Promise.resolve({ err: globalFileErrorPrefix + dirname })
    }
    return promiseTimeout(
      globalCaptureTimeout,
      new Promise(function (resolve) {
        Webcam.capture(filename, function (err, data) {
          log("Camera done for node " + config.id + ", filename " + filename)
          var obj
          if (err) {
            log("Error for node " + config.id + ": " + err)
            obj = { err: err }
          } else {
            log("Successful image capture for node " + config.id)
            if (config.mode === "template") {
              data = data.split(",").slice(1)[0]
              data = `<img width="${config.width}" height="${config.height}" src="data:image/${config.format};base64,${data}">`
            } else if (config.mode === "encode") {
              data = data.split(",").slice(1)[0]
            }
            obj = { data: data }
          }
          Webcam.clear()
          if (config.mode !== "file") {
            try {
              rimraf.sync(filename)
            } catch (error) {
              log("Deleting temporary file error: " + error)
            }
          }
          return resolve(obj)
        })
      })
    )
  }

  function done(desc, node, msg, data) {
    log("Done function with description '" + desc + "'")
    msg.payload = data
    node.send(msg)
    for (var i = 0; i < globalQueue.length; i++) {
      if (globalQueue[i].config.id === globalState) {
        globalQueue.splice(i, 1)
        break
      }
    }
    globalState = "IDLE"
    process(1)
  }

  function log(msg) {
    globalDebug && console.log(msg)
  }

  function process(retry) {
    log("process function with retry " + retry)
    log("Queue state: [" + globalQueue.map((item) => item.config.id).toString() + "]")
    log("Global state: " + globalState)
    clearTimeout(globalTimer)
    if (!globalQueue.length) {
      log("Queue empty")
      return
    }
    if (!(globalState === "IDLE" || retry > 1)) {
      log("Queue busy with node " + globalState)
      return
    }
    var args = globalQueue[0]
    var node = args.node
    var config = args.config
    var opts = args.opts
    var msg = args.msg
    globalState = config.id
    capture(config, opts).then(function (ret) {
      if (ret.err) {
        if (ret.err.startsWith(globalFileErrorPrefix) || retry > globalMaxRetries - 1) {
          node.status({
            fill: "red",
            shape: "dot",
            text: RED._("usb-camera.status.error"),
          })
          done("Error", node, msg, ret.err)
        } else {
          globalTimer = setTimeout(function () {
            clearTimeout(globalTimer)
            retry += 1
            process(retry)
          }, globalInitialRetryInterval * Math.pow(1.1, retry - 1))
        }
      } else {
        node.status({
          fill: "green",
          shape: "dot",
          text: RED._("usb-camera.status.ok"),
        })
        done("Done", node, msg, ret.data)
      }
    })
  }

  function promiseTimeout(ms, promise) {
    var id
    var timeout = new Promise(function (resolve, reject) {
      id = setTimeout(() => {
        clearTimeout(id)
        return resolve({ err: "Error: could not capture image" })
      }, ms)
    })
    return Promise.race([promise, timeout]).then((result) => {
      clearTimeout(id)
      return result
    })
  }

  function UsbCamera(config) {
    RED.nodes.createNode(this, config)
    var node = this
    if (!globalActive) {
      node.status({
        fill: "grey",
        shape: "dot",
        text: "usb-camera.status.not-available",
      })
    } else {
      node.status({ fill: "green", shape: "dot", text: RED._("usb-camera.status.ok") })
      node.on("input", function (msg) {
        return promiseTimeout(
          globalCaptureTimeout,
          new Promise(function (resolve) {
            NodeWebcam.listControls(function (controls) {
              return resolve(controls)
            })
          })
        ).then(function (controls) {
          var perToNum = function (control, per) {
            var obj = controls.find(function (item) {
              return item.name === control
            })
            return !obj ? 0 : obj.min + Math.floor(((obj.max - obj.min) * per) / 100)
          }
          var opts = {
            width: parseInt(config.width),
            height: parseInt(config.height),
            quality: parseInt(config.quality),
            frames: 1,
            delay: parseInt(config.delay),
            saveShots: true,
            output: config.format === "png" ? "png" : "jpeg",
            device: false,
            callbackReturn: {
              template: "base64",
              encode: "base64",
              buffer: "buffer",
              file: "location",
            }[config.mode],
            setValues: {
              Brightness: perToNum("Brightness", config.brightness),
              Contrast: perToNum("Contrast", config.contrast),
              Saturation: perToNum("Saturation", config.saturation),
              Hue: perToNum("Hue", config.hue),
            },
            verbose: globalDebug,
          }
          globalQueue.push({
            node: node,
            config: config,
            opts: opts,
            msg: msg,
          })
          process(1)
        })
      })
    }
  }
  RED.nodes.registerType("usb-camera", UsbCamera)
}
