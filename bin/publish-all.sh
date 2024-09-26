#!/bin/bash

current_dir() {
    local sdir="$1"
    local udir=""
    # Resolve ${sdir} until the file is no longer a symlink
    while [ -h "${sdir}" ]; do
        udir="$(cd -P "$(dirname "${sdir}")" && pwd)"
        sdir="$(readlink "${sdir}")"
        # If ${sdir} was a relative symlink, we need to resolve it
        # relative to the path where the symlink file was located
        [[ "${sdir}" != /* ]] && sdir="${udir}/${sdir}"
    done
    udir="$(cd -P "$(dirname "${sdir}")" && pwd)"
    echo "${udir}"
}
usage() { grep '^#/' "$0" | cut -c4-; }

sdir=$(current_dir "${BASH_SOURCE[0]}")
modules=(
    @prescient-devices-oss/node-red-contrib-admin-api-url
    @prescient-devices-oss/node-red-contrib-downloadfile
    @prescient-devices-oss/node-red-contrib-fan-in-out
    @prescient-devices-oss/node-red-contrib-fileinput
    @prescient-devices-oss/node-red-contrib-home-dir
    @prescient-devices-oss/node-red-contrib-promptinput
    @prescient-devices-oss/node-red-contrib-revpi-dio
    @prescient-devices-oss/node-red-contrib-usb-camera
)
for module in "${modules[@]}"; do
    "${sdir}"/publish.sh -n "${module}"
done