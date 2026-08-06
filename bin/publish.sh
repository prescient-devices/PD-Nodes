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
# Refuse to publish a tree that disagrees with its own lockfile.
#
# This runs BEFORE "npm login" on purpose, so the failure arrives without first
# prompting for credentials, and so a login failure can never be what stops the
# check from running.
#
# Wired here rather than into a "prepublishOnly" hook in each of the 15
# package.json files, for the same reason the .gitignore rule is a single root
# rule rather than 15 negations: a per-package hook has to be remembered for
# every package, and the package that gets forgotten is exactly the one that
# ships wrong. publish.sh takes any directory, so every publish passes through
# here whether or not the package is listed in publish-all.sh -- which matters,
# because publish-all.sh names only 8 of the 13 scoped packages in this repo.
#
# --require-tracked additionally rejects a lockfile that git does not track. An
# untracked lock is what made the @prescient-devices/mssql-client drift
# undetectable for months; see the header of bin/check_lockfile.js.
if ! node "${sdir}"/check_lockfile.js -m "${module_dir}" --require-tracked; then
    echo -e "${sname}: refusing to publish ${dir_basename}\n" >&2
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
