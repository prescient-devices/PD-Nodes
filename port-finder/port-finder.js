/**
 * Copyright 2020 Prescient Devices, Inc.
 **/

module.exports = function(RED) {
  function PortFinder(config) {
      RED.nodes.createNode(this,config);
      var node = this;
      node.on('input', function(msg) {
          msg.url = "localhost:"+RED.settings.uiPort+"/flows";
          node.send(msg);
      });
  }
  RED.nodes.registerType("port-finder",PortFinder);
};
