node-red-contrib-fileinput
==========================

A node that once its buttons is pressed, prompts user to select a file from the
browser's file system and then emits its contents as a message or a series of
messages if the streaming option is selected.

### Installation

Node-RED editor's palette manager may be used to install the node.
Alternatively, the command line may also be used to install the node with the
following commands (assuming the user's Node-RED directory is
`${HOME}/.node-red`):

    $ cd "${HOME}"/.node-red
    $ npm install --production node-red-contrib-fileinput
    [...]

### Node

 - fileinput

### Running Tests

The development dependencies need to be installed before running the test-bench.
This can be accomplished with the following commands (assuming
`${HOME}/node-red-contrib-fileinput` is the node's development directory where
the node's `package.json` is):

    $ cd "${HOME}"/node-red-contrib-fileinput
    $ npm install
    [...]

Then to run the tests:

    $ cd "${HOME}"/node-red-contrib-fileinput
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
