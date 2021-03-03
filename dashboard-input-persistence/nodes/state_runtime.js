var globalRED

module.exports = function (RED) {
  globalRED = RED
  return {
    addTopic: addTopic,
    getState: getState,
    passInitState: passInitState,
    saveState: saveState,
    validateStore: validateStore,
  }
}

function addTopic(config, node, msg) {
  var t =
    globalRED.util.evaluateNodeProperty(
      config.topic,
      config.topicType || "str",
      node,
      msg
    ) || node.topi
  if (t) {
    msg.topic = t
  }
}

function getState(config, node, defaultValue) {
  if (!config.storestate) {
    return defaultValue
  }
  var obj = globalRED.util.parseContextStore(config.store)
  var context = {
    flow: node.context().flow,
    global: node.context().global,
  }
  var state = context[config.storeType].get(obj.key, obj.store)
  return state !== undefined ? state : defaultValue
}

function passInitState(config, node, initState) {
  if (config.storestate && config.passthru) {
    initState = initState || getState(config, node)
    var initMsg = function () {
      globalRED.events.removeListener("nodes-started", initMsg)
      var msg = { payload: initState }
      addTopic(config, node, msg)
      var timer = setTimeout(() => {
        clearTimeout(timer)
        node.send(msg)
      }, 300)
    }
    globalRED.events.on("nodes-started", initMsg)
  }
}

function saveState(config, node, state) {
  if (!config.storestate) {
    return
  }
  var callback = function (error) {
    if (error) {
      node.warn("state could not be saved: " + error.message)
    }
  }
  var obj = globalRED.util.parseContextStore(config.store)
  var context = {
    flow: node.context().flow,
    global: node.context().global,
  }
  context[config.storeType].set(obj.key, state, obj.store, callback)
}

function validateStore(config, node) {
  if (config.storeType === "flow" || config.storeType === "global") {
    try {
      parts = globalRED.util.normalisePropertyExpression(config.store)
      if (parts.length === 0) {
        throw new Error()
      }
    } catch (err) {
      node.warn("Invalid persistent location expression - disabling")
      config.storestate = false
    }
  }
}
