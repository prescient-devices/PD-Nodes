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

browsers=(Firefox Chromium)
versions=(2.1.3)
# browsers=(Firefox)
# versions=(3.1.9 3.0.2 2.1.3)
#browsers=(Firefox WebKit Chromium)
#versions=(3.1.9 3.0.2 2.2.2 2.1.3)
os="$(detect_os)"
if [ "${os}" == "linux" ]; then
    rbin="readlink"
else
    rbin="greadlink"
fi
test_dir="$("${rbin}" -f "${sdir}"/../test)"
echo "Test directory: ${test_dir}"
rm -rf \
    "${test_dir}"/Firefox_* \
    "${test_dir}"/WebKit_* \
    "${test_dir}"/Chromium_* \
    "${test_dir}"/node-red-* \
    "${test_dir}"/.node-red-*
for browser in "${browsers[@]}"; do
    for version in "${versions[@]}"; do
        fname="${test_dir}/${browser}_${version}_spec.js"
        echo "Creating test bench ${fname}"
        echo -e "const path = require(\"path\")\nconst { testSuite } = require(path.resolve(__dirname, \"util.js\"))\ntestSuite(\"${browser}\", \"${version}\")" > "${fname}"
    done
done
