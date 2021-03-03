module.exports = function(RED) {
    const path = require("path")
    var ui = require(path.resolve(path.dirname(require.resolve("node-red-dashboard")), "ui"))(RED);
    var tc = require(path.resolve(path.dirname(require.resolve("node-red-dashboard")), "dist", "js", "tinycolor-min"));
    const state = require("./state_runtime")(RED);

    function ColourPickerNode(config) {
        RED.nodes.createNode(this, config);
        this.format = config.format;
        this.outformat = config.outformat;
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
            var initState = state.getState(config, node, "");
            state.passInitState(config, node, initState);
        }

        var done = ui.add({
            node: node,
            tab: tab,
            group: group,
            forwardInputMessages: config.passthru,
            control: {
                type: 'colour-picker',
                label: config.label,
                format: config.format,
                showPicker: config.showPicker,
                showSwatch: config.showSwatch,
                showValue: config.showValue,
                showHue: config.showHue,
                showAlpha: config.showAlpha,
                showLightness: config.showLightness,
                square: (config.square == 'true') || false,
                dynOutput: config.dynOutput,
                allowEmpty: true,
                order: config.order,
                value: state.getState(config, node, ''),
                width: config.width || group.config.width || 6,
                height: config.height || 1
            },
            beforeSend: function (msg) {
                if (node.outformat === 'object') {
                    var pay = tc(msg.payload);
                    if (node.format === 'rgb') { msg.payload = pay.toRgb(); }
                    if (node.format === 'hsl') { msg.payload = pay.toHsl(); }
                    if (node.format === 'hsv') { msg.payload = pay.toHsv(); }
                }
                var t = RED.util.evaluateNodeProperty(config.topic,config.topicType || "str",node,msg) || node.topi;
                if (t) { msg.topic = t; }
                state.saveState(config, node, msg.payload);
            },
            convert: function(p,o,m) {
                if (m.payload === undefined || m.payload === null) { return; }
                var colour = tc(m.payload);
                return colour.toString(config.format);
            }
        });
        node.on("close", done);
    }
    RED.nodes.registerType("ui_colour_picker_persistent", ColourPickerNode);
};
