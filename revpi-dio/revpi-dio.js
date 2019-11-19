/**
 * Copyright JS Foundation and other contributors, http://js.foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

module.exports = function(RED) {
  "use strict";
  var exec = require("child_process").exec;
  var spawn = require("child_process").spawn;
  var fs = require("fs");
  var revpidioCommand = __dirname + "/revpidio";
  var allOK = true;

  //check for errors here

  function RevPiDIOIN(config) {
    RED.nodes.createNode(this, config);
    this.name = config.name;
    this.pinname = config.pinname;
    var node = this;
    if (allOK === true) {
      if (this.pinname !== undefined) {
        node.child = spawn(revpidioCommand, ["in", this.pinname]);
        console.log("Input Pin");
        console.log(this.pinname);
        node.running = true;
        node.status({ fill: "green", shape: "dot", text: "common.status.ok" });
        node.child.stdout.on("data", function(data) {
          node.send({ payload: data.toString() });
        });

        node.child.stderr.on("data", function(data) {
          if (RED.settings.verbose) {
            node.log("err: " + data + " :");
          }
        });

        node.child.on("close", function(code) {
          node.running = false;
          node.child = null;
          if (RED.settings.verbose) {
            node.log(RED._("revpi-dio.status.closed"));
          }
          if (node.done) {
            node.status({
              fill: "grey",
              shape: "ring",
              text: "revpi-dio.status.closed"
            });
            node.done();
          } else {
            node.status({
              fill: "red",
              shape: "ring",
              text: "revpi-dio.status.stopped"
            });
          }
        });

        node.child.on("error", function(err) {
          if (err.errno === "ENOENT") {
            node.error(RED._("revpi-dio.errors.commandnotfound"));
          } else if (err.errno === "EACCES") {
            node.error(RED._("revpi-dio.errors.commandnotexecutable"));
          } else {
            node.error(RED._("revpi-dio.errors.error", { error: err.errno }));
          }
        });
      } else {
        node.warn(RED._("revpi-dio.errors.invalidpin") + ": " + this.pinname);
      }
    }
  }
  RED.nodes.registerType("revpi-dio in", RevPiDIOIN);

  function RevPiDIOOUT(config) {
    RED.nodes.createNode(this, config);
    this.name = config.name;
    this.pinname = config.pinname;
    this.pinvalue = config.pinvalue;
    console.log(config);
    console.log(this);
    console.log(this.pinname);
    var node = this;
    if (allOK === true) {
      if (this.pinname !== undefined) {
        node.child = spawn(revpidioCommand, [
          "out",
          this.pinname,
          this.pinvalue
        ]);
        node.running = true;
        node.status({ fill: "green", shape: "dot", text: "common.status.ok" });

        node.child.stdout.on("data", function(data) {
          node.send({ payload: data.toString() });
          // var d = data.toString().trim().split("\n");
          // for (var i = 0; i < d.length; i++) {
          //     if (d[i] === '') { return; }
          //     if (node.running && node.buttonState !== -1 && !isNaN(Number(d[i])) && node.buttonState !== d[i]) {
          //         node.send({ topic:"pi/"+node.pin, payload:Number(d[i]) });
          //     }
          //     node.buttonState = d[i];
          //     node.status({fill:"green",shape:"dot",text:d[i]});
          //     if (RED.settings.verbose) { node.log("out: "+d[i]+" :"); }
          // }
        });

        node.child.stderr.on("data", function(data) {
          if (RED.settings.verbose) {
            node.log("err: " + data + " :");
          }
        });

        node.child.on("close", function(code) {
          node.running = false;
          node.child = null;
          if (RED.settings.verbose) {
            node.log(RED._("revpi-dio.status.closed"));
          }
          if (node.done) {
            node.status({
              fill: "grey",
              shape: "ring",
              text: "revpi-dio.status.closed"
            });
            node.done();
          } else {
            node.status({
              fill: "red",
              shape: "ring",
              text: "revpi-dio.status.stopped"
            });
          }
        });

        node.child.on("error", function(err) {
          if (err.errno === "ENOENT") {
            node.error(RED._("revpi-dio.errors.commandnotfound"));
          } else if (err.errno === "EACCES") {
            node.error(RED._("revpi-dio.errors.commandnotexecutable"));
          } else {
            node.error(RED._("revpi-dio.errors.error", { error: err.errno }));
          }
        });
      } else {
        node.warn(RED._("revpi-dio.errors.invalidpin") + ": " + this.pinname);
      }
    }
    // this.on("input", function(msg) {
    //   msg.payload = this.pinname;
    //   node.send(msg);
    // });
  }
  RED.nodes.registerType("revpi-dio out", RevPiDIOOUT);
};
