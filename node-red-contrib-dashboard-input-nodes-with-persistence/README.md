# node-red-contrib-dashboard-input-nodes-with-persistence

This module provides drop-in replacement nodes for the standard dashboard
input nodes (version 2.28.2) with one additional feature: the ability to have
their state persist (be preserved) accross node (re)starts, for example,
after a deployment or when there is a runtime (re)start.

Additionally, and optionally these nodes can emit a message with their
current state after a node (re)start.