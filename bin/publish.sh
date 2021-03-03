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

sname=$(basename "$0")
sdir=$(current_dir "${BASH_SOURCE[0]}")

dir_basename="$1"
module_dir="$(readlink -f "${sdir}/../${dir_basename}")"
if [ ! -d "${module_dir}" ]; then
    echo -e "${sname}: directory ${module_dir} does not exist\n" >&2
    exit 1
fi
if ! npm login --scope=@prescient-devices  --registry=https://registry.npmjs.org; then
    echo -e "${sname}: cannot authenticate to GitHub Packages\n" >&2
    exit 1
fi
cd "${module_dir}" && npm publish --access=public --scope=@prescient-devices --registry=https://registry.npmjs.org
if [ "$?" != 0 ]; then
    echo -e "${sname}: cannot publish module ${module_name}\n" >&2
    exit 1
fi
