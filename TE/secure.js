
class SecureClient {
  #apiKey = null
  constructor(credentials) {
    this.hostname = credentials.hostname
    this.#apiKey = credentials.apiKey
  }
  show() {
    console.log(`Hostname: ${this.hostname}, API key: ${this.#apiKey}`)
  }
}

function getSecureClient(node) {
  // Create copy of credentials so that object property can be deleted later
  const { hostname, apiKey } = node.credentials
  node.client = new getSecureClient(hostname, apiKey)
}

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
