#!/bin/bash

#/ publish-all.sh
#/ Copyright (c) 2020-present Prescient Devices, Inc. All rights reserved
#/ Usage:
#/   publish-all.sh [FLAGS]
#/
#/ Publishes every publishable package in this repository, routing each one
#/ through bin/publish.sh so the lockfile-drift guard publish.sh runs stays on
#/ the path. Never call "npm publish" from here.
#/
#/ FLAGS:
#/   -h    show this screen and exit
#/   -d    dry run: print what would be published, publish nothing
#/   -f    force: publish even when the registry already holds the source
#/         version (npm answers 403 for a duplicate, so this normally only
#/         makes noise)
#/
#/ Exit status is 0 only when every package either published or was already up
#/ to date. Any refusal -- including a lockfile-drift refusal from publish.sh --
#/ is a non-zero exit and a named entry in the closing summary.

# ============================================================================
# WHY THE PACKAGE LIST IS COMPUTED, NOT WRITTEN DOWN
# ============================================================================
# Until 2026-08-06 this script carried a hand-written array of eight module
# names, and it had never published anything. Two separate defects:
#
#   1. It passed SCOPED PACKAGE NAMES where publish.sh takes a DIRECTORY.
#      publish.sh resolves its argument as "${sdir}/../${arg}", so
#      "@prescient-devices-oss/node-red-contrib-home-dir" resolved to
#      PD-Nodes/@prescient-devices-oss/node-red-contrib-home-dir -- a path that
#      has never existed. Every package failed at the directory check, on the
#      first one, before npm login. Confirmed by running it.
#
#   2. The array named 8 of the 13 scoped packages here. All five packages in
#      the default "@prescient-devices" scope were absent, because the array
#      had quietly become a list of the "-n" (oss) packages only.
#
#   3. The loop checked no exit status, so the script ended on whatever the last
#      package returned. Had defect 1 been fixed alone, a package refused in the
#      middle of the run would still have gone unnoticed.
#
# The first two are the same failure: a list maintained by hand beside a
# repository that keeps changing. So the list is now derived from
# "git ls-files '*package.json'"
# -- an invariant computed from the repo has nothing to be omitted from, and a
# package added tomorrow is included the day it is committed.
#
# The two filters are OPT-OUT, deliberately, so that the default for a new
# package is "publishes":
#
#   * "private": true  -- npm's own signal, and npm publish refuses it too.
#   * a name outside the @prescient-devices* scopes -- TE and TE-Sniffer are
#     named "te" and "te-sniffer", which belong to somebody else on npmjs.
#
# An OPT-IN signal is what task #31 found wrong in registries/prescient-devices,
# where keying off "files"/"release" missed 51 packages. Opt-in fails silent;
# opt-out fails loud.

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
root="$(cd -P "${sdir}/.." && pwd)"

# Same registry publish.sh names on its "npm publish" line. Kept identical on
# purpose: the up-to-date check has to ask the registry publish.sh writes to, or
# it would skip a package that is not actually there.
#
# That agreement was only NOMINAL until 2026-08-06, and in opposite directions.
# registry_version() below passes the SCOPED flag "--@scope:registry=", which
# does win, so this check has always queried npmjs.org correctly. publish.sh
# passed only "--registry=", which does NOT win for a scoped name, so the
# publish itself was aimed at whatever "@prescient-devices:registry" said in
# ~/.npmrc and reached npmjs.org solely via the side effect of "npm login".
# See the block above publish.sh's login/publish lines. The two now agree for a
# real reason: every publishable manifest pins its own registry in
# publishConfig, which outranks both the ~/.npmrc scoped line and "--registry".
registry="https://registry.npmjs.org"

OPTIND=1
dry_run=0
force=0
while getopts ":hdf" opt; do
    case "${opt}" in
    h)
        usage
        exit 0
        ;;
    d)
        dry_run=1
        ;;
    f)
        force=1
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
if [ "$#" -ne 0 ]; then
    echo -e "${sname}: takes no positional arguments\\n" >&2
    usage
    exit 1
fi

for tool in git node npm; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
        echo "${sname}: ${tool} is required and is not on PATH" >&2
        exit 1
    fi
done
if [ ! -x "${sdir}/publish.sh" ]; then
    echo "${sname}: ${sdir}/publish.sh is missing or not executable" >&2
    exit 1
fi

# Read name, version and the private flag out of one package.json. Prints three
# tab-separated fields. A malformed package.json is a hard failure, not a skip:
# a package that cannot be parsed is exactly the one that must not be passed
# over in silence.
read_manifest() {
    node -e '
const fs = require("fs")
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
process.stdout.write(
  [manifest.name || "", manifest.version || "", manifest.private === true ? "1" : "0"].join("\t")
)
' "$1"
}

# Version currently on the registry, or "" when the package is not published or
# the query fails. A failed query never causes a skip -- it falls through to the
# publish attempt, and npm stays the authority on whether that is allowed.
registry_version() {
    local name="$1" scope="$2" out=""
    out="$(npm view "${name}" version \
        "--${scope}:registry=${registry}" \
        --registry="${registry}" 2>/dev/null | tail -1)"
    if [[ "${out}" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
        echo "${out}"
    else
        echo ""
    fi
}

# Read into an array with a while loop rather than "mapfile": /bin/bash on macOS
# is 3.2, which has no mapfile, and process substitution keeps the appends out
# of a subshell the way a pipeline would not.
manifests=()
while IFS= read -r line; do
    manifests+=("${line}")
done < <(git -C "${root}" ls-files -- '*package.json' ':(exclude)*node_modules/*' | LC_ALL=C sort)
if [ "${#manifests[@]}" -eq 0 ]; then
    echo "${sname}: found no package.json under ${root} -- derivation is broken" >&2
    exit 1
fi

targets=()
printf '%-38s %-64s %-10s %-10s %s\n' DIRECTORY PACKAGE SOURCE REGISTRY ACTION
for manifest in "${manifests[@]}"; do
    dir="$(dirname "${manifest}")"
    if ! fields="$(read_manifest "${root}/${manifest}")"; then
        echo "${sname}: cannot parse ${manifest}" >&2
        exit 1
    fi
    IFS=$'\t' read -r name version private <<<"${fields}"
    if [ -z "${name}" ] || [ -z "${version}" ]; then
        echo "${sname}: ${manifest} has no name or no version" >&2
        exit 1
    fi

    if [ "${private}" = "1" ]; then
        printf '%-38s %-64s %-10s %-10s %s\n' "${dir}" "${name}" "${version}" - "skip (private)"
        continue
    fi

    flag=""
    case "${name}" in
    @prescient-devices/*)
        scope="@prescient-devices"
        ;;
    @prescient-devices-oss/*)
        scope="@prescient-devices-oss"
        flag="-n"
        ;;
    @prescient-devices*/*)
        # publish.sh offers exactly two scopes. A third would be published to
        # whichever of them happened to be the default, so refuse instead.
        echo "${sname}: ${manifest} declares scope of ${name}, which publish.sh cannot publish" >&2
        exit 1
        ;;
    *)
        printf '%-38s %-64s %-10s %-10s %s\n' "${dir}" "${name}" "${version}" - "skip (not our scope)"
        continue
        ;;
    esac

    published="$(registry_version "${name}" "${scope}")"
    if [ "${force}" -eq 0 ] && [ -n "${published}" ] && [ "${published}" = "${version}" ]; then
        printf '%-38s %-64s %-10s %-10s %s\n' \
            "${dir}" "${name}" "${version}" "${published}" "skip (up to date)"
        continue
    fi
    printf '%-38s %-64s %-10s %-10s %s\n' \
        "${dir}" "${name}" "${version}" "${published:--}" "PUBLISH"
    targets+=("${dir}|${flag}")
done

if [ "${#targets[@]}" -eq 0 ]; then
    echo -e "\n${sname}: nothing to publish"
    exit 0
fi
if [ "${dry_run}" -eq 1 ]; then
    echo -e "\n${sname}: dry run, published nothing"
    exit 0
fi

published_ok=()
failed=()
for target in "${targets[@]}"; do
    dir="${target%%|*}"
    flag="${target#*|}"
    echo -e "\n=== ${sname}: publishing ${dir} ==="
    if [ -n "${flag}" ]; then
        "${sdir}"/publish.sh "${flag}" "${dir}"
    else
        "${sdir}"/publish.sh "${dir}"
    fi
    # publish.sh exits non-zero on a lockfile-drift refusal, a login failure and
    # a publish failure alike. The old loop checked none of them, so the script
    # ended on whatever the LAST package returned and every earlier failure was
    # invisible -- measured, not assumed: a two-iteration loop that fails first
    # and succeeds last exits 0.
    # shellcheck disable=SC2181
    if [ "$?" -ne 0 ]; then
        failed+=("${dir}")
    else
        published_ok+=("${dir}")
    fi
done

echo -e "\n=== ${sname}: summary ==="
echo "published: ${#published_ok[@]}"
for dir in "${published_ok[@]}"; do echo "  ${dir}"; done
echo "failed:    ${#failed[@]}"
for dir in "${failed[@]}"; do echo "  ${dir}"; done
if [ "${#failed[@]}" -ne 0 ]; then
    exit 1
fi
