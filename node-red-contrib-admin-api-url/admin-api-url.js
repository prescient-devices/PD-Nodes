/**
 * Copyright 2020 Prescient Devices, Inc.
 **/

module.exports = function(RED) {
  function AdminApiUrl(config) {
      RED.nodes.createNode(this,config);
      var node = this;
      node.on('input', function(msg) {
          msg.url = "localhost:"+RED.settings.uiPort;
          node.send(msg);
      });
  }
  RED.nodes.registerType("admin-api-url",AdminApiUrl);
};
