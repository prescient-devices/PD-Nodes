@prescient-devices/node-red-contrib-fan-in-out
============================================

> [!CAUTION]
> This package has been deprecated, for new installations please use
> [@prescient-devices-oss/node-red-contrib-fan-in-out](https://flows.nodered.org/node/@prescient-devices/node-red-contrib-fan-in-out)

A pair of nodes that makes it easier and faster to have a subflow with multiple
(virtual inputs).

### Installation

Node-RED editor's palette manager may be used to install the node.
Alternatively, the command line may also be used to install the node with the
following commands (assuming the user's Node-RED directory is
`${HOME}/.node-red`):

    $ cd "${HOME}"/.node-red
    $ npm install --production node-red-contrib-faninout
    [...]

### Nodes

 - fanin
 - fanout

### Running Tests

The development dependencies need to be installed before running the test-bench.
This can be accomplished with the following commands (assuming
`${HOME}/node-red-contrib-faninout` is the node's development directory where
the node's `package.json` is):

    $ cd "${HOME}"/node-red-contrib-faninout
    $ npm install
    [...]

Then to run the tests:

    $ cd "${HOME}"/node-red-contrib-faninout
    $ npm test
    [...]

### Contributing / Fixes

An issue may be raised for typos and single-line fixes. A pull request may be
opened in the node's GitHub
[repository](https://github.com/prescient-devices/PD-Nodes) for more complex
fixes and/or contributions.

### Copyright and license

Copyright Prescient Devices, Inc. under the MIT license, which is in the LICENSE
file.
