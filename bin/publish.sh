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

# Test the uncanonicalised path, and report THAT on failure. "readlink -f"
# fails outright when an intermediate component is missing, leaving module_dir
# empty -- so the old message read "directory  does not exist", naming nothing.
# That is how publish-all.sh passing a package NAME here stayed unexplained:
# the one line that could have said which path was wrong printed a blank.
raw_dir="${sdir}/../${dir_basename}"
if [ ! -d "${raw_dir}" ]; then
    echo -e "${sname}: directory ${raw_dir} does not exist\n" >&2
    case "${dir_basename}" in
    @*) echo -e "${sname}: argument is a DIRECTORY, not a package name; the scope comes from -n\n" >&2 ;;
    esac
    exit 1
fi
module_dir="$(readlink -f "${raw_dir}")"
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
# here whether it was run by hand or by publish-all.sh -- and publish-all.sh
# routes every package back through this script, rather than calling npm itself,
# so there is no path to the registry that skips this check.
#
# --require-tracked additionally rejects a lockfile that git does not track. An
# untracked lock is what made the @prescient-devices/mssql-client drift
# undetectable for months; see the header of bin/check_lockfile.js.
if ! node "${sdir}"/check_lockfile.js -m "${module_dir}" --require-tracked; then
    echo -e "${sname}: refusing to publish ${dir_basename}\n" >&2
    exit 1
fi
# THE "--registry" FLAGS BELOW DO NOT CHOOSE THE REGISTRY. Measured, npm 10.9.8.
#
# For a SCOPED package name npm resolves the publish target with
# npm-registry-fetch's pickRegistry(), which consults "@scope:registry" FIRST and
# only falls back to "registry" when no scoped key is set. A developer ~/.npmrc
# carrying
#     @prescient-devices:registry=https://npm.pkg.github.com/prescient-devices/
# therefore beats "--registry" outright, and "--scope" does not change that:
#     npm view @prescient-devices/node-red-node-mqtt-in-json version \
#       --registry=https://registry.npmjs.org   ->  1.6.2  (the GITHUB version)
# The public registry holds 1.2.3.
#
# Until 2026-08-06 these packages reached npmjs.org only BY ACCIDENT: the
# "npm login --scope=... --registry=..." on the next line REWRITES the
# "@prescient-devices:registry" line in ~/.npmrc as a side effect, and that
# rewrite -- not the flag -- is what redirected the publish. While rewritten,
# the ~96 private @prescient-devices packages resolve to npmjs.org too.
#
# The destination is now pinned where it cannot be lost: each publishable
# manifest here carries
#     "publishConfig": { "@prescient-devices:registry": "https://registry.npmjs.org/" }
# which is the ONE form that wins, because @npmcli/config's flatten() passes
# "@scope:registry" keys straight through into the options pickRegistry reads.
# Plain "publishConfig.registry" does NOT win -- it only sets the fallback that
# the scoped ~/.npmrc line outranks; it is kept beside the scoped key for
# non-npm publishers (yarn) and for the case where the scoped line is absent.
#
# The flags are left in place because they are inert for these scoped names
# ("npm publish --dry-run" reports the same target with and without them) and
# because dropping "--registry" would hand the @prescient-devices-oss packages
# -- which have no scoped pin -- to whatever global default the operator's
# ~/.npmrc happens to hold. Do not add a third escaper for the registry here:
# pin it in the manifest.
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
