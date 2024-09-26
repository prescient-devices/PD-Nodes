class LeakyClient {
  constructor(credentials) {
    // NO! If credentials object is deleted later, change will propagate here
    this.credentials = credentials
    this.hostname = this.credentials.hostname
    this.apiKey = this.credentials.apiKey
  }
  show(desc) {
    console.log(`${desc} -> hostname: ${this.hostname}, API key: ${this.apiKey}`)
  }
}

function getLeakyClient(node) {
  node.client = new LeakyClient(node.credentials)
}

module.exports = function (RED) {
  function TeConfig(config) {
    RED.nodes.createNode(this, config)
    const node = this
    // node.apiKey = node.credentials.apiKey // <<< Do not store keys in configuration node
    getLeakyClient(node)
    delete node.credentials // Use credentials and then delete it from config node
    node.client.show("Configuration node")
  }
  RED.nodes.registerType("te-config", TeConfig, {
    credentials: { hostname: { type: "text" }, apiKey: { type: "password" } },
  })

  function TeConnector(config) {
    RED.nodes.createNode(this, config)
    const node = this
    const configNode = RED.nodes.getNode(config.secrets)
    configNode.client.show("Connector node")
    node.on("input", function (msg) {
      node.send(msg)
    })
  }
  RED.nodes.registerType("te-connector", TeConnector)
}
