#!/bin/bash
current_dir() {
    local sdir udir os rbin
    sdir="$1"
    udir=""
    os="$(detect_os)"
    if [ "${os}" == "linux" ]; then
        rbin="readlink"
    else
        rbin="greadlink"
    fi
    # Resolve ${sdir} until the file is no longer a symlink
    while [ -h "${sdir}" ]; do
        udir="$(cd -P "$(dirname "${sdir}")" && pwd)"
        sdir="$("${rbin}" "${sdir}")"
        [[ "${sdir}" != /* ]] && sdir="${udir}/${sdir}"
    done
    udir="$(cd -P "$(dirname "${sdir}")" && pwd)"
    echo "${udir}"
}

detect_os() {
    local desc
    desc="${OSTYPE,,}"
    if [[ "${desc}" == darwin* ]]; then
        echo "darwin"
        return 0
    fi
    desc="$(uname)"
    desc="${desc,,}"
    if [[ "${desc}" == darwin* ]]; then
        echo "darwin"
        return 0
    fi
    echo "linux"
    return 0
}

sdir=$(current_dir "${BASH_SOURCE[0]}")

tar --owner=0 --group=0 --mode='og-w' -czf "${sdir}"/binfile.tar.gz "${sdir}"/readme.txt
