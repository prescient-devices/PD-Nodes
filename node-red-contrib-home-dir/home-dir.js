/**
 * Copyright 2020 Prescient Devices, Inc.
 **/

const path = require("path");

module.exports = function(RED) {
  function HomeDir(config) {
      RED.nodes.createNode(this,config);
      var node = this;
      node.on('input', function(msg) {
          msg.payload = RED.settings.userDir || process.env.NODE_RED_HOME || path.resolve(".");
          node.send(msg);
      });
  }
  RED.nodes.registerType("home-dir",HomeDir);
};
