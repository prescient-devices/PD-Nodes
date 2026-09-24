@prescient-devices-oss/node-red-contrib-downloadfile
====================================================

A node to download a message's payload to the browser's local file system

### Installation

Node-RED editor's palette manager may be used to install the node.
Alternatively, the command line may also be used to install the node with the
following commands (assuming the user's Node-RED directory is
`${HOME}/.node-red`):

    $ cd "${HOME}"/.node-red
    $ npm install --production @prescient-devices-oss/node-red-contrib-downloadfile
    [...]

### Node

- downloadfile

The node has two modes, set by the **Stream** checkbox in the edit dialog.

### Stream off

Each message becomes its own file. The node sends the message to every open
editor, and each editor saves `msg.payload` as a file. A Buffer payload is saved
as binary data. Any other payload that is not a string is converted with
`JSON.stringify`. The file name comes from `msg.filename`, then from the node
configuration, and the default is `data.txt`.

### Stream on

A whole stream of messages becomes one file. A stream is every message from the
first one up to the one with `msg.complete` set to `true`. The node writes the
payloads in order and does not hold the whole file in memory, so the file can be
many gigabytes. A string is written as UTF-8 text, a Buffer as it is, and any other
payload as JSON followed by a new line.

When the first message arrives, every open editor shows a banner with a
**Download** button. Somebody must click **Download** within 10 minutes, or the
download expires. **Dismiss** cancels it. The file goes to the download folder of
the browser where somebody clicked. Stream mode needs somebody to open the Node-RED
editor and click **Download**, because the file goes through the editor's admin HTTP
server. With the editor turned off (`httpAdminRoot: false` or `disableEditor: true`),
nobody can click, so the download expires after 10 minutes.

In Stream mode the node has one output. It sends each input message on only after
its payload is written to the browser, with the download state in `msg.download`.
Connect this output to the node that tells your source to send its next message,
and the source moves only as fast as the browser saves the file. Without flow
control, the node holds at most 16 MiB of payload or 10,000 messages, and then
stops the download with an error.

A node works on one stream at a time, and tells streams apart by `msg._streamID`.
Put the same `_streamID` on every message of a stream, the final message included.
The node refuses a second stream while a download is open, and passes its messages
on without writing them.

The **Error property** (default `msg.error`) lets a source fail the file. When the
final message carries a truthy value at this property, the node stops the download
with state `error`, and the browser marks the file as failed. So a source that fails
part way through never leaves a short file that looks complete.

The node help in the editor has the full details.

### Running Tests

The development dependencies need to be installed before running the test-bench.
This can be accomplished with the following commands (assuming
`${HOME}/node-red-contrib-downloadfile` is the node's development directory
where the node's `package.json` is):

    $ cd "${HOME}"/node-red-contrib-downloadfile
    $ npm install
    [...]

Then to run the tests:

    $ cd "${HOME}"/node-red-contrib-downloadfile
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
