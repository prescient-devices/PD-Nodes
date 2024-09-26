module.exports = function (RED) {
  function TeSniffer(config) {
    RED.nodes.createNode(this, config)
    const node = this
    let configNodeId
    RED.nodes.eachNode((item) => {
      if (item.type === "te-config") {
        configNodeId = item.id
      }
    })
    if (!configNodeId) {
      return node.error("Could not find configuration node")
    }
    const configNode = RED.nodes.getNode(configNodeId)
    console.log("Config node ID " + configNodeId)
    console.log("<<< SNIFFER NODE")
    console.log("Configuration node?")
    console.log(configNode)
    console.log("API key from node credentials?")
    console.log(configNode?.credentials?.apiKey)
    console.log("API key from node")
    console.log(configNode?.apiKey)
    console.log("API key from client?")
    console.log(configNode?.client?.apiKey)
    console.log("Client show() method")
    configNode.client.show("Sniffer node")
    console.log(">>> SNIFFER NODE")
    node.on("input", function (msg) {
      node.send(msg)
    })
  }
  RED.nodes.registerType("te-sniffer", TeSniffer)
}
