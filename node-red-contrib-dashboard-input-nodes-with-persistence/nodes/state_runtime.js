var globalRED
var globalStateContextVariableName = "state"

module.exports = function (RED) {
  globalRED = RED
  return {
    addTopic: addTopic,
    getState: getState,
    passInitState: passInitState,
    saveState: saveState,
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
  var state = node.context().get(globalStateContextVariableName, config.store)
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
  node.context().set(globalStateContextVariableName, state, config.store, callback)
}
