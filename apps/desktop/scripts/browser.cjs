// Prepare and verify the single Node executable shared by the installed browser drivers.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const semver = require('semver')
const { sha256, executableDigest } = require('./digest.cjs')
const { BROWSER_NODE_RELATIVE, BUNDLED_PYTHON_RELATIVE, browserEnvironment } = require('../runtime/browser.cjs')

const PROBE_TIMEOUT_MS = 30_000
const NODE_TARGETS = { arm64: 'arm64', x86_64: 'x64' }
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
const PRIMARY_NODE_SOURCE = 'playwright/driver/node'
const NODE_PROBE = 'console.log(JSON.stringify({version:process.version,platform:process.platform,arch:process.arch}))'
const DRIVER_PROBE = `
import asyncio
import json
import os
import sys
import sysconfig
from importlib import metadata
from pathlib import Path

import patchright
import playwright
from packaging.requirements import Requirement
from patchright._impl._driver import compute_driver_executable as patchright_driver
from patchright.async_api import async_playwright as patchright_api
from playwright._impl._driver import compute_driver_executable as playwright_driver
from playwright.async_api import async_playwright as playwright_api

CONSUMERS = (
    ("playwright", playwright, playwright_driver, playwright_api),
    ("patchright", patchright, patchright_driver, patchright_api),
)
OPTIONAL_SDK = "claude-agent-sdk"
EXPECTED_BROWSER = "chromium"
resources = Path(sys.argv[1]).resolve()
shared = Path(os.environ["PLAYWRIGHT_NODEJS_PATH"]).resolve()
site_packages = Path(sysconfig.get_path("purelib")).resolve()
if not site_packages.is_relative_to(resources):
    raise RuntimeError("browser distributions resolve outside product resources")
installed = {item.metadata["Name"].lower().replace("_", "-") for item in metadata.distributions()}
if OPTIONAL_SDK in installed or (site_packages / "claude_agent_sdk").exists():
    raise RuntimeError("optional Claude SDK is present in the default Desktop backend")
requirements = [Requirement(value) for value in metadata.requires("scholarseed") or []]
sdk = [item for item in requirements if item.name.lower().replace("_", "-") == OPTIONAL_SDK]
if not sdk or any(item.marker is None or item.marker.evaluate({"extra": "serve"}) for item in sdk):
    raise RuntimeError("default Serve metadata includes the optional Claude SDK")
if not all(any(item.marker.evaluate({"extra": extra}) for item in sdk) for extra in ("claude-sdk", "all")):
    raise RuntimeError("explicit Claude SDK extras are missing")

async def probe():
    result = []
    for name, module, driver, api in CONSUMERS:
        root = Path(module.__file__).resolve().parent / "driver"
        if not root.is_relative_to(site_packages):
            raise RuntimeError(f"driver resolves outside product site-packages: {name}")
        executable, cli = driver()
        if Path(executable).resolve() != shared or Path(cli).resolve() != root / "package" / "cli.js":
            raise RuntimeError(f"driver does not select the shared product Node: {name}")
        package = json.loads((root / "package" / "package.json").read_text())
        async with api() as browser:
            if browser.chromium.name != EXPECTED_BROWSER:
                raise RuntimeError(f"driver protocol did not initialize: {name}")
        result.append({"distribution": name, "version": metadata.version(name),
                       "source": (root / "node").relative_to(resources).as_posix(),
                       "node_engine": package["engines"]["node"], "transport": "passed"})
    print(json.dumps(result))

asyncio.run(probe())
`.trim()

function cleanEnvironment() {
  return { PATH: SYSTEM_PATH, LANG: 'en_US.UTF-8', PYTHONDONTWRITEBYTECODE: '1' }
}

function command(executable, args, env = cleanEnvironment()) {
  return execFileSync(executable, args, { encoding: 'utf8', env, timeout: PROBE_TIMEOUT_MS }).trim()
}

function containedFile(resources, relative) {
  if (path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('browser runtime path escapes resources')
  const filename = path.resolve(resources, relative)
  if (!filename.startsWith(path.resolve(resources) + path.sep)
    || !fs.lstatSync(filename).isFile()
    || !fs.realpathSync(filename).startsWith(fs.realpathSync(resources) + path.sep)) {
    throw new Error('browser runtime is not a regular contained file')
  }
  fs.accessSync(filename, fs.constants.X_OK)
  return filename
}

function prepareDirectory(resources, relative) {
  if (path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('browser directory escapes resources')
  let directory = path.resolve(resources)
  for (const segment of relative.split('/')) {
    directory = path.join(directory, segment)
    let stat
    try { stat = fs.lstatSync(directory) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      fs.mkdirSync(directory)
      stat = fs.lstatSync(directory)
    }
    if (!stat.isDirectory() || !fs.realpathSync(directory).startsWith(fs.realpathSync(resources) + path.sep)) {
      throw new Error('browser destination ancestor is not a contained directory')
    }
  }
}

function assertAbsent(filename) {
  try { fs.lstatSync(filename) } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  throw new Error('duplicate browser Node remains in artifact')
}

function nodeIdentity(filename, arch) {
  const identity = JSON.parse(command(filename, ['-e', NODE_PROBE]))
  if (identity.platform !== 'darwin' || identity.arch !== NODE_TARGETS[arch]) throw new Error('browser Node target mismatch')
  if (command('lipo', ['-archs', filename]) !== arch) throw new Error('browser Node Mach-O architecture mismatch')
  return identity
}

function probeDrivers(resources) {
  const python = path.join(resources, BUNDLED_PYTHON_RELATIVE)
  const env = browserEnvironment(cleanEnvironment(), resources, python)
  return JSON.parse(command(python, ['-I', '-B', '-c', DRIVER_PROBE, resources], env))
}

function assertMatchingNodes(rows) {
  const first = rows[0]
  if (!first || rows.length < 2 || rows.some(row => row.sha256 !== first.sha256
    || JSON.stringify(row.identity) !== JSON.stringify(first.identity))) {
    throw new Error('browser drivers bundle different Node executables; align their dependencies before sharing')
  }
  for (const row of rows) {
    if (!semver.satisfies(row.identity.version, row.node_engine)) throw new Error(`browser Node violates driver engine: ${row.distribution}`)
  }
}

async function prepareBrowser(resources, arch) {
  // Discover from the actual product Python, never from the development venv.
  const python = path.join(resources, BUNDLED_PYTHON_RELATIVE)
  const site = command(python, ['-I', '-B', '-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'])
  const firstSource = path.relative(resources, path.join(site, PRIMARY_NODE_SOURCE))
  const source = containedFile(resources, firstSource)
  const shared = path.join(resources, BROWSER_NODE_RELATIVE)
  prepareDirectory(resources, path.posix.dirname(BROWSER_NODE_RELATIVE))
  fs.copyFileSync(source, shared, fs.constants.COPYFILE_EXCL)
  const consumers = probeDrivers(resources)
  const rows = []
  for (const consumer of consumers) {
    const filename = containedFile(resources, consumer.source)
    rows.push({ ...consumer, sha256: await sha256(filename), bytes: fs.statSync(filename).size,
      identity: nodeIdentity(filename, arch) })
  }
  assertMatchingNodes(rows)
  if (await sha256(shared) !== rows[0].sha256) throw new Error('shared browser Node copy differs from source')
  const frozen = { path: BROWSER_NODE_RELATIVE, sha256: rows[0].sha256,
    executable_sha256: await executableDigest(shared), identity: rows[0].identity,
    consumers: rows, saved_bytes: rows.reduce((sum, row) => sum + row.bytes, 0) - fs.statSync(shared).size }
  // Only exact, validated staging duplicates are removed, before any signing.
  for (const row of rows) fs.unlinkSync(containedFile(resources, row.source))
  await verifyBrowser(resources, arch, frozen)
  return frozen
}

async function verifyBrowser(resources, arch, frozen, signed = false) {
  if (!frozen || frozen.path !== BROWSER_NODE_RELATIVE) throw new Error('frozen browser Node inventory is missing')
  const shared = containedFile(resources, frozen.path)
  if (await executableDigest(shared) !== frozen.executable_sha256) throw new Error('browser Node executable differs from frozen input')
  if (!signed && await sha256(shared) !== frozen.sha256) throw new Error('unsigned browser Node bytes differ from frozen input')
  if (signed) command('codesign', ['--verify', '--strict', shared])
  if (JSON.stringify(nodeIdentity(shared, arch)) !== JSON.stringify(frozen.identity)) throw new Error('browser Node identity differs from frozen input')
  const consumers = probeDrivers(resources)
  const expected = frozen.consumers.map(({ distribution, version, source, node_engine, transport }) =>
    ({ distribution, version, source, node_engine, transport }))
  if (JSON.stringify(consumers) !== JSON.stringify(expected)) throw new Error('browser driver inventory differs from frozen input')
  for (const consumer of consumers) {
    assertAbsent(path.join(resources, consumer.source))
  }
  return { identity: frozen.identity, consumers, saved_bytes: frozen.saved_bytes, executable_sha256: frozen.executable_sha256 }
}

module.exports = { prepareBrowser, verifyBrowser, assertMatchingNodes, containedFile, prepareDirectory, assertAbsent, DRIVER_PROBE }
