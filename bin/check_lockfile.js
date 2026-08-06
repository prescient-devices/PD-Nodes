#!/usr/bin/env node
/**
 * check_lockfile.js
 *
 * Copyright 2026-present Prescient Devices, Inc.
 **/

// VENDORED COPY -- keep byte-identical to the origin below this header.
//   Origin: registries/prescient-devices/bin/check_lockfile.js at 4380477
//   Verify: diff <(tail -n +22 bin/check_lockfile.js) \
//                <(tail -n +7 ../registries/prescient-devices/bin/check_lockfile.js)
//
// Vendored rather than invoked across repos because nothing guarantees that
// registries/prescient-devices is checked out beside PD-Nodes. bin/publish.sh is
// run from a clone of this repo alone, and a publish guard that silently does
// not run is worse than no guard -- it reports success while checking nothing.
// The script needs nothing beyond child_process, fs and path, so a copy costs
// one file and no install step.
//
// Fix bugs in the origin FIRST, then re-copy here, so the three copies (this one,
// PD-Edge, and the registry) never diverge silently.

// ============================================================================
// WHY THIS EXISTS: A NODE_MODULES THAT DISAGREES WITH THE LOCK IS INVISIBLE.
// ============================================================================
// @prescient-devices/mssql-client shipped a total outage this way. Its
// node_modules held @prescient-devices/util 1.18.1 while its OWN package-lock
// already pinned 1.26.5. util 1.20.6 had renamed RetryMngr's `args` to
// `funcArgs` and nested exec()'s payload under `value` -- in a PATCH bump -- so
// every query() rejected Error("Invalid query") with no SQL ever reaching the
// server, on every fresh install, for months. The checked-out tree worked,
// because its vendored util predated the rename. Nobody could see the drift:
// the lockfile was gitignored, so the tree it actually ran against and the tree
// it claimed to run against were never compared by anything.
//
// WHY NOT `npm ci --dry-run`. Because it does not fail. Measured on npm 10.9.8
// against a deliberately-stale tree (lock pins semver 7.8.5, node_modules holds
// 7.5.0, package.json range ^7.5.0 satisfied by both):
//
//   npm ci --dry-run        prints "change semver 7.5.0 => 7.8.5", EXITS 0
//   npm install --dry-run   prints the same change,                EXITS 0
//   npm ls                  prints "semver@7.5.0", no complaint,   EXITS 0
//
// `npm ls` exits non-zero only when the installed version violates the RANGE in
// package.json. Pure lock drift -- the mssql-client case, where the stale
// version still satisfies the declared range -- is silent in every one of them.
// Reading the printed diff instead of the exit status would mean parsing human
// output, over the network, from a command whose job is to mutate the tree.
//
// WHY NOT node_modules/.package-lock.json. npm's own "hidden lockfile" claims to
// record what is installed. It lies: in the probe above it read 7.8.5 while
// node_modules/semver/package.json read 7.5.0, because `npm update
// --package-lock-only` rewrites BOTH lockfiles and touches neither package. So
// the only trustworthy answer to "what is actually installed" is the version
// field of each installed package's own package.json, which is what this reads.
//
// Every disagreement is a loud non-zero exit, never a warning. A guard that
// warns is a guard that is scrolled past.
//
// USAGE
//   node check_lockfile.js [-m DIR] [--require-tracked] [--json] [-h]
//
//   -m DIR             module directory to check (default: cwd)
//   --require-tracked  additionally require that DIR/package-lock.json is
//                      tracked by git. An untracked lock is what made the
//                      mssql-client drift undetectable in the first place.
//   --json             emit machine-readable findings on stdout
//
// Set SKIP_LOCK_CHECK=1 to bypass. Deliberately not advertised in the failure
// output: the message there names the fix (`npm ci`), because a bypass offered
// at the moment of failure is a bypass that becomes the habit.

// NodeJS imports
const { execFileSync } = require("child_process")
const fs = require("fs")
const path = require("path")

/**
 * @typedef {object} Finding
 * @property {string} kind - "MISMATCH", "MISSING", "EXTRA" or "UNTRACKED"
 * @property {string} location - path relative to the module directory
 * @property {string} expected - version the lockfile pins, or "" when not pinned
 * @property {string} actual - version installed on disk, or "" when absent
 *
 * @typedef {object} Options
 * @property {string} moduleDir - absolute path of the module to check
 * @property {boolean} requireTracked - whether to require a git-tracked lockfile
 * @property {boolean} json - whether to emit JSON instead of prose
 */

// Constants
const FAIL = "FAIL"
const PASS = "OK  "

/**
 * Abort loudly with a non-zero exit code
 * @param {string} message - what went wrong
 * @returns {void}
 */
function abort(message) {
  console.error(`${FAIL} check_lockfile: ${message}`)
  process.exit(1)
}

/**
 * Collect every installed package by walking node_modules on disk
 *
 * Walks nested node_modules so a dependency npm could not hoist is compared
 * too, and keys every entry by the same "node_modules/..." path the lockfile
 * uses, so the two sides are directly comparable.
 * @param {string} moduleDir - absolute path of the module directory
 * @param {string} relDir - node_modules path relative to moduleDir
 * @param {Map<string, string>} acc - accumulator of location to version
 * @returns {Map<string, string>} installed packages keyed by lockfile-style path
 */
function collectInstalled(moduleDir, relDir, acc) {
  const absDir = path.join(moduleDir, relDir)
  let entries
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const entry of entries) {
    // .bin, .package-lock.json and .cache are npm bookkeeping, not packages
    if (entry.name.startsWith(".")) continue
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    // A scope directory holds packages; it is not one itself
    if (entry.name.startsWith("@")) {
      for (const scoped of fs.readdirSync(path.join(absDir, entry.name), {
        withFileTypes: true,
      })) {
        if (scoped.name.startsWith(".")) continue
        recordInstalled(moduleDir, path.join(relDir, entry.name, scoped.name), acc)
      }
      continue
    }
    recordInstalled(moduleDir, path.join(relDir, entry.name), acc)
  }
  return acc
}

/**
 * Report whether a path is a symlink
 * @param {string} absPath - absolute path to test
 * @returns {boolean} true when the path is a symbolic link
 */
function isSymlink(absPath) {
  try {
    return fs.lstatSync(absPath).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Read one installed package's version and recurse into its own node_modules
 * @param {string} moduleDir - absolute path of the module directory
 * @param {string} location - package path relative to moduleDir
 * @param {Map<string, string>} acc - accumulator of location to version
 * @returns {void}
 */
function recordInstalled(moduleDir, location, acc) {
  const absPath = path.join(moduleDir, location)
  const version = readVersion(path.join(absPath, "package.json"))
  // A directory with no readable package.json is not a package -- npm leaves
  // such leftovers behind, and reporting them would be noise, not drift
  if (version === null) return
  acc.set(location, version)
  // Do NOT walk into a symlinked package. A `file:` sibling dependency --
  // node-red-contrib-opcua links ../opcua-client, node-red-contrib-precision-
  // snowflake links ../snowflake-client -- resolves to another module in this
  // repo, whose node_modules is governed by ITS OWN lockfile and is checked
  // when that module is checked. Following the link reported every one of the
  // sibling's 345 dependencies as EXTRA, which is noise, and noise is how a
  // guard gets turned off.
  if (isSymlink(absPath)) return
  collectInstalled(moduleDir, path.join(location, "node_modules"), acc)
}

/**
 * Compare the lockfile against what is installed on disk
 * @param {string} moduleDir - absolute path of the module directory
 * @returns {Finding[]} every disagreement found, empty when the tree is in sync
 */
function compare(moduleDir) {
  const lockPath = path.join(moduleDir, "package-lock.json")
  let lock
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, "utf8"))
  } catch (error) {
    abort(`cannot read ${lockPath}: ${error.message}`)
  }
  if (!lock.packages) {
    abort(
      `${lockPath} has lockfileVersion ${lock.lockfileVersion} and no "packages" map. ` +
        `Regenerate it with npm 7 or later ('npm install --package-lock-only').`
    )
  }
  const installed = collectInstalled(moduleDir, "node_modules", new Map())
  const findings = []
  const pinned = new Set()
  for (const [location, entry] of Object.entries(lock.packages)) {
    // "" is the module itself; publish.sh already checks its version
    if (location === "") continue
    // An entry outside node_modules is the TARGET of a `file:` link -- npm
    // records "../opcua-client" and its whole dependency subtree in the
    // dependent's lock. That subtree lives in a sibling module governed by its
    // own lockfile, so comparing it here reports the sibling's install state
    // as this module's drift.
    if (!location.startsWith("node_modules/")) continue
    // Register before the link test, so a link entry that IS materialised on
    // disk is not then reported EXTRA for being absent from the pinned set
    pinned.add(location)
    // The link itself has no version to compare; its target is checked above
    if (entry.link === true) continue
    const actual = installed.get(location)
    if (actual === undefined) {
      // An optional dependency npm declined to install is not drift. So is one
      // whose os/cpu constraints exclude this machine.
      if (entry.optional === true || !platformMatches(entry)) continue
      findings.push({
        kind: "MISSING",
        location,
        expected: entry.version || "",
        actual: "",
      })
      continue
    }
    if (entry.version && entry.version !== actual) {
      findings.push({ kind: "MISMATCH", location, expected: entry.version, actual })
    }
  }
  for (const [location, version] of installed) {
    if (pinned.has(location)) continue
    findings.push({ kind: "EXTRA", location, expected: "", actual: version })
  }
  return findings
}

/**
 * Report whether a lockfile entry's platform constraints match this machine
 * @param {object} entry - a package-lock.json packages[] entry
 * @returns {boolean} true when the entry could be installed here
 */
function platformMatches(entry) {
  const matches = (list, actual) => {
    if (!Array.isArray(list) || list.length === 0) return true
    // npm expresses exclusions as "!darwin"
    const negated = list.filter((v) => v.startsWith("!"))
    if (negated.length > 0) return !negated.some((v) => v.slice(1) === actual)
    return list.includes(actual)
  }
  return matches(entry.os, process.platform) && matches(entry.cpu, process.arch)
}

/**
 * Read a package.json version field
 * @param {string} pkgPath - absolute path of a package.json
 * @returns {string | null} the version, or null when unreadable
 */
function readVersion(pkgPath) {
  try {
    const version = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version
    return typeof version === "string" ? version : ""
  } catch {
    return null
  }
}

/**
 * Report whether git tracks a path
 * @param {string} moduleDir - absolute path of the module directory
 * @param {string} fname - absolute path of the file to test
 * @returns {boolean} true when the file is tracked
 */
function isTracked(moduleDir, fname) {
  try {
    const out = execFileSync(
      "git",
      ["-C", moduleDir, "ls-files", "--error-unmatch", fname],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    )
    return out.trim().length > 0
  } catch {
    return false
  }
}

/**
 * Parse argv
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {Options} parsed options
 */
function parseArgs(argv) {
  const options = { moduleDir: process.cwd(), requireTracked: false, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "-h" || arg === "--help") {
      console.log("Usage: check_lockfile.js [-m DIR] [--require-tracked] [--json]")
      console.log("Set SKIP_LOCK_CHECK=1 to bypass.")
      process.exit(0)
    } else if (arg === "-m") {
      i += 1
      if (i >= argv.length) abort("-m requires a directory argument")
      options.moduleDir = path.resolve(argv[i])
    } else if (arg === "--require-tracked") {
      options.requireTracked = true
    } else if (arg === "--json") {
      options.json = true
    } else {
      abort(`unknown argument ${arg}`)
    }
  }
  return options
}

/**
 * Entry point
 * @returns {void}
 */
function main() {
  if (process.env.SKIP_LOCK_CHECK === "1") {
    console.log(`${PASS} check_lockfile: skipped (SKIP_LOCK_CHECK=1)`)
    return
  }
  const options = parseArgs(process.argv.slice(2))
  const { moduleDir } = options
  const lockPath = path.join(moduleDir, "package-lock.json")
  const modulesPath = path.join(moduleDir, "node_modules")
  const hasLock = fs.existsSync(lockPath)
  const hasModules = fs.existsSync(modulesPath)
  if (!hasLock && !hasModules) {
    console.log(
      `${PASS} check_lockfile: ${path.basename(moduleDir)} has no lockfile and no node_modules`
    )
    return
  }
  if (!hasLock) {
    abort(
      `${path.basename(moduleDir)} has node_modules but no package-lock.json, so what it ` +
        `runs against cannot be compared to anything. Run 'npm install' to generate one.`
    )
  }
  if (!hasModules) {
    abort(
      `${path.basename(moduleDir)} has a package-lock.json but no node_modules. Run 'npm ci'.`
    )
  }
  const findings = compare(moduleDir)
  if (options.requireTracked && !isTracked(moduleDir, lockPath)) {
    findings.push({
      kind: "UNTRACKED",
      location: "package-lock.json",
      expected: "tracked",
      actual: "untracked",
    })
  }
  if (options.json) {
    console.log(JSON.stringify({ moduleDir, findings }, null, 2))
  }
  if (findings.length === 0) {
    if (!options.json) {
      console.log(
        `${PASS} check_lockfile: ${path.basename(moduleDir)} node_modules matches package-lock.json`
      )
    }
    return
  }
  console.error(
    `${FAIL} check_lockfile: ${path.basename(moduleDir)} node_modules disagrees with package-lock.json\n`
  )
  for (const finding of findings.slice(0, 40)) {
    if (finding.kind === "MISMATCH") {
      console.error(
        `  MISMATCH  ${finding.location}: lock pins ${finding.expected}, installed ${finding.actual}`
      )
    } else if (finding.kind === "MISSING") {
      console.error(
        `  MISSING   ${finding.location}: lock pins ${finding.expected}, not installed`
      )
    } else if (finding.kind === "EXTRA") {
      console.error(
        `  EXTRA     ${finding.location}@${finding.actual}: installed, absent from the lockfile`
      )
    } else {
      console.error(
        `  UNTRACKED package-lock.json is not tracked by git, so this drift is invisible to review`
      )
    }
  }
  if (findings.length > 40) console.error(`  ... and ${findings.length - 40} more`)
  console.error(
    `\nThe tree being tested is NOT the tree the lockfile describes, so a green bench` +
      `\nsays nothing about what a fresh install will run. Run 'npm ci' in ${path.basename(moduleDir)}.`
  )
  process.exit(1)
}

main()
