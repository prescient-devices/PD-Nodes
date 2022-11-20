module.exports = function (RED) {
    function GetFlow(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        node.on("input", function (msg) {
            var currentPath = process.cwd();
            var fs = require("fs");
            fs.readFile(currentPath + "/.node-red/flows_edge.json", function (err, data) {
                if (err) {
                    node.send(err);
                }
                else {
                    msg.payload = data.toString();
                    node.send(msg);
                }
            });
        });
    }
    RED.nodes.registerType("get-flow", GetFlow);
}