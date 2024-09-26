#!/bin/bash

#/ publish.sh
#/ Copyright (c) 2020-present Prescient Devices, Inc. All rights reserved
#/ Usage:
#/   publish.sh [FLAGS] [PACKAGE-DIRECTORY]
#/
#/ FLAGS:
#/   -h    show this screen and exit
#/   -n    Use "@prescient-devices-oss" scope instead of the
#/         default "@prescient-devices"

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

sname=$(basename "$0")
sdir=$(current_dir "${BASH_SOURCE[0]}")

OPTIND=1
scope="@prescient-devices"
while getopts ":hn" opt; do
    case "${opt}" in
    h)
        usage
        exit 0
        ;;
    n)
        scope="@prescient-devices-oss"
        ;;
    \?)
        echo -e "${sname}: invalid option -${OPTARG}\\n" >&2
        usage
        exit 1
        ;;
    :)
        echo -e "${sname}: option -${OPTARG} requires an argument\\n" >&2
        usage
        exit 1
        ;;
    esac
done
shift $((OPTIND - 1))
min_mass_args=1
max_mass_args=1
if [ "$#" -lt ${min_mass_args} ] || [ "$#" -gt ${max_mass_args} ]; then
    echo "${sname}: invalid number of arguments" >&2
    exit 1
fi
unset min_mass_args max_mass_args
dir_basename="$1"
echo "Directory: ${dir_basename}"
echo "Scope: ${scope}"

module_dir="$(readlink -f "${sdir}/../${dir_basename}")"
if [ ! -d "${module_dir}" ]; then
    echo -e "${sname}: directory ${module_dir} does not exist\n" >&2
    exit 1
fi
if ! npm login --scope="${scope}" --registry=https://registry.npmjs.org; then
    echo -e "${sname}: cannot authenticate to npm registry\n" >&2
    exit 1
fi
cd "${module_dir}" && npm publish --access=public --scope="${scope}" --registry=https://registry.npmjs.org
# shellcheck disable=SC2181
if [ "$?" != 0 ]; then
    echo -e "${sname}: cannot publish module ${dir_basename}}\n" >&2
    exit 1
fi
