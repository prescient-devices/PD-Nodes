module.exports = function(RED) {
    const path = require("path")
    var ui = require(path.resolve(path.dirname(require.resolve("node-red-dashboard")), "ui"))(RED);
    const state = require("./state_runtime")(RED);

    function SliderNode(config) {
        RED.nodes.createNode(this, config);
        this.pt = config.passthru;
        this.state = [" "," "];
        var node = this;
        node.status({});

        var group = RED.nodes.getNode(config.group);
        if (!group) { return; }
        var tab = RED.nodes.getNode(group.config.tab);
        if (!tab) { return; }

        node.on("input", function(msg) {
            node.topi = msg.topic;
        });
        if (config.storestate) {
            var initState = state.getState(config, node, config.min);
            node.status({shape:"dot",fill:"grey",text:initState});
            state.passInitState(config, node, initState);
        }

        var done = ui.add({
            node: node,
            tab: tab,
            group: group,
            forwardInputMessages: config.passthru,
            control: {
                type: 'slider',
                label: config.label,
                tooltip: config.tooltip,
                order: config.order,
                value: state.getState(config, node, config.min),
                min: Math.min(config.min, config.max),
                max: Math.max(config.max, config.min),
                invert: (parseFloat(config.min) > parseFloat(config.max)) ? true : undefined,
                step: Math.abs(config.step) || 1,
                outs: config.outs || "all",
                width: config.width || group.config.width || 6,
                height: config.height || 1
            },
            beforeSend: function (msg) {
                var t = RED.util.evaluateNodeProperty(config.topic,config.topicType || "str",node,msg) || node.topi;
                if (t) { msg.topic = t; }
                state.saveState(config, node, msg.payload);
                if (node.pt) {
                    node.status({shape:"dot",fill:"grey",text:msg.payload});
                }
                else {
                    node.state[1] = msg.payload;
                    node.status({shape:"dot",fill:"grey",text:node.state[1] + " | " + node.state[1]});
                }
            },
            convert: ui.toFloat.bind(this, config)
        });
        if (!node.pt) {
            node.on("input", function(msg) {
                node.state[0] = msg.payload;
                node.status({shape:"dot",fill:"grey",text:node.state[0] + " | " + node.state[1]});
            });
        }
        else if (node._wireCount === 0) {
            node.on("input", function(msg) {
                node.status({shape:"dot",fill:"grey",text:msg.payload});
            });
        }
        node.on("close", done);
    }
    RED.nodes.registerType("ui_slider_persistent", SliderNode);
};
