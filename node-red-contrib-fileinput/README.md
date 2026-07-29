@prescient-devices-oss/node-red-contrib-fileinput
=================================================

A node that, once its button is pressed, prompts the user to select a file from
the browser's file system and then emits its contents as a message or a series of
messages if the streaming option is selected.

A message on the node's input port asks for a file as well. Browsers only open a
file picker while a user gesture is active, so the message cannot open one on its
own: a notification appears in the open editor with a **Choose file** button, and
clicking it opens the picker. The properties of the input message are merged into
every message the node then emits. A request that goes unanswered for ten minutes
expires, and a file chosen after that point no longer carries those properties.

If the connection carrying an upload is severed, the upload fails and has to be
started again from the beginning rather than resuming where it stopped. An upload
that fails before any of the file reaches the node releases it immediately, so the
next attempt is accepted rather than refused as an overlapping upload.

### Installation

Node-RED editor's palette manager may be used to install the node.
Alternatively, the command line may also be used to install the node with the
following commands (assuming the user's Node-RED directory is
`${HOME}/.node-red`):

    $ cd "${HOME}"/.node-red
    $ npm install --production @prescient-devices-oss/node-red-contrib-fileinput
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
