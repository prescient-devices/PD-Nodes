module.exports = function(RED) {
    const path = require("path")
    var ui = require(path.resolve(path.dirname(require.resolve("node-red-dashboard")), "ui"))(RED);
    const state = require("./state_runtime")(RED);

    function TextInputNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        var group = RED.nodes.getNode(config.group);
        if (!group) { return; }
        var tab = RED.nodes.getNode(group.config.tab);
        if (!tab) { return; }

        node.on("input", function(msg) {
            node.topi = msg.topic;
        });
        if (config.storestate) {
            var initState = state.getState(config, node, '');
            state.passInitState(config, node, initState);
        }

        var done = ui.add({
            node: node,
            tab: tab,
            group: group,
            forwardInputMessages: config.passthru,
            control: {
                type: (config.delay <= 0 ? 'text-input-CR' : 'text-input'),
                label: config.label,
                tooltip: config.tooltip,
                mode: config.mode,
                delay: config.delay,
                order: config.order,
                value: state.getState(config, node, ''),
                width: config.width || group.config.width || 6,
                height: config.height || 1
            },
            beforeSend: function (msg) {
                if (config.mode === "time") {
                    if (typeof msg.payload === "string") {
                        msg.payload = Date.parse(msg.payload);
                    }
                }
                // if (config.mode === "week") { msg.payload = Date.parse(msg.payload); }
                // if (config.mode === "month") { msg.payload = Date.parse(msg.payload); }
                var t = RED.util.evaluateNodeProperty(config.topic,config.topicType || "str",node,msg) || node.topi;
                if (t) { msg.topic = t; }
                state.saveState(config, node, msg.payload);
            }
        });
        node.on("close", done);
    }
    RED.nodes.registerType("ui_text_input_persistent", TextInputNode);
};
