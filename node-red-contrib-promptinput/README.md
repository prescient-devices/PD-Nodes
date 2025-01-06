@prescient-devices-oss/node-red-contrib-promptinput
===================================================

A node that once its button is pressed or it receives a message, prompts the
user for input and emits a message with that input converted to a desired data
type. An optional JSONata expression can be used to validate the input and emit
a message only when the validation succeeds.

### Installation

Node-RED editor's palette manager may be used to install the node.
Alternatively, the command line may also be used to install the node with the
following commands (assuming the user's Node-RED directory is
`${HOME}/.node-red`):

    $ cd "${HOME}"/.node-red
    $ npm install --production node-red-contrib-promptinput
    [...]

### Node

 - promptinput

### Running Tests

The development dependencies need to be installed before running the test-bench.
This can be accomplished with the following commands (assuming
`${HOME}/node-red-contrib-promptinput` is the node's development directory where
the node's `package.json` is):

    $ cd "${HOME}"/node-red-contrib-promptinput
    $ npm install
    [...]

The tests are run using some or all of these browsers: Chromium and Mozilla
Firefox. To set up the tests:

    $ cd "${HOME}"/node-red-contrib-promptinput
    $ npm run make-test-suite
    Test directory: [...]
    [...]

Then issue the command `npm run test-firefox` or `npm run test-chromium` to run
the tests with Mozilla Firefox or Chromium, respectively. For example, to run
tests with Mozilla Firefox:

    $ npm run test-firefox
    > @prescient-devices-oss/node-red-contrib-promptinput@1.2.5 test-firefox
    > mocha --bail --full-warning --full-trace --timeout $((60*1000)) "test/Firefox_*_spec.js"
    [...]

### Contributing / Fixes

An issue may be raised for typos and single-line fixes. A pull request may be
opened in the node's GitHub
[repository](https://github.com/prescient-devices/PD-Nodes) for more complex
fixes and/or contributions.

### Copyright and license

Copyright Prescient Devices, Inc. under the MIT license, which is in the LICENSE
file.
