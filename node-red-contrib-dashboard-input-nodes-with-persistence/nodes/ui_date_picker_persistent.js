module.exports = function(RED) {
    const path = require("path")
    var ui = require(path.resolve(path.dirname(require.resolve("node-red-dashboard")), "ui"))(RED);
    const state = require("./state_runtime")(RED);

    function DatePickerNode(config) {
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
            var initState = state.getState(config, node, new Date().setUTCHours(0,0,0,0));
            state.passInitState(config, node, initState);
        }

        var done = ui.add({
            node: node,
            tab: tab,
            group: group,
            forwardInputMessages: config.passthru,
            control: {
                type: 'date-picker',
                label: config.label,
                order: config.order,
                ddd: state.getState(config, node, new Date().setUTCHours(0,0,0,0)),
                width: config.width || group.config.width || 6,
                height: config.height || 1
            },
            convert: function (p,o,m) {
                var d = new Date(m.payload);
                this.control.ddd = d;
                return m.payload;
            },
            beforeEmit: function (msg, value) {
                if (value === undefined) { return; }
                value = new Date(value);
                return { msg:msg, value:value };
            },
            convertBack: function (value) {
                var d = new Date(value).valueOf();
                return d;
            },
            beforeSend: function (msg) {
                var t = RED.util.evaluateNodeProperty(config.topic,config.topicType || "str",node,msg) || node.topi;
                if (t) { msg.topic = t; }
                state.saveState(config, node, msg.payload);
            }
        });
        node.on("close", done);
    }
    RED.nodes.registerType("ui_date_picker_persistent", DatePickerNode);
};
