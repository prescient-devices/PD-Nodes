module.exports = function(RED) {
    const path = require("path")
    var ui = require(path.resolve(path.dirname(require.resolve("node-red-dashboard")), "ui"))(RED);
    const state = require("./state_runtime")(RED);

    function FormNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        var group = RED.nodes.getNode(config.group);
        if (!group) { return; }
        var tab = RED.nodes.getNode(group.config.tab);
        if (!tab) { return; }

        node.on("input", function(msg) {
            node.topi = msg.topic;
        });
        state.validateStore(config, node)
        if (config.storestate) {
            config.passthru = true;
            var initState = state.getState(config, node, config.payload || node.id);
            state.passInitState(config, node, initState);
        }

        var done = ui.add({
            node: node,
            tab: tab,
            group: group,
            forwardInputMessages: false,
            control: {
                type: 'form',
                label: config.label,
                order: config.order,
                value: state.getState(config, node, config.payload || node.id),
                width: config.width || group.config.width || 6,
                height: config.height || config.splitLayout == true ? Math.ceil(config.options.length/2) : config.options.length,
                options: config.options,
                formValue: state.getState(config, node, config.formValue),
                submit: config.submit,
                cancel: config.cancel,
                splitLayout: config.splitLayout || false,
                sy: ui.getSizes().sy,
                cy: ui.getSizes().cy
            },
            beforeSend: function (msg) {
                var t = RED.util.evaluateNodeProperty(config.topic,config.topicType || "str",node,msg) || node.topi;
                if (t) { msg.topic = t; }
                state.saveState(config, node, msg.payload);
            }
        });
        node.on("close", done);
    }
    RED.nodes.registerType("ui_form_persistent", FormNode);
};
