const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { test } = require('node:test')

const macosTest = process.platform === 'darwin' ? test : test.skip

const IMPLEMENTATION = path.resolve(__dirname, '../recovery.cjs')
const EXECUTABLE = 'scholarseed-recovery-probe'
const MANIFEST = 'manifest.json'
const MAINTENANCE_MANIFEST = 'maintenance.json'
const NATIVE_FILES = [
  'lease.c',
  'directory.c',
  'directory.h',
  'security.h',
  'darwin-permissions.h',
  'toolchain.json',
  'libraries.cjs',
]
const NATIVE_LIBRARIES = ['lease.node', 'fonts.node', 'notarization.node']
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const SOURCES = {
  'shipit/preflight.m':
    '#import "preparation.h"\n#import "cleanup.h"\n#import "readiness.h"\n#include "../directory.h"\n',
  'shipit/preparation.m': '#import "preparation.h"\n#import "binding.h"\n',
  'shipit/cleanup.m': '#import "cleanup.h"\n#import "observation.h"\n',
  'shipit/readiness.m': '#import "readiness.h"\n#import "binding.h"\n',
  'shipit/preparation.h': '#import <Foundation/Foundation.h>\n',
  'shipit/cleanup.h': '#import <Foundation/Foundation.h>\n',
  'shipit/readiness.h': '#import <Foundation/Foundation.h>\n',
  'shipit/binding.h': '#import <CommonCrypto/CommonDigest.h>\n',
  'shipit/observation.h': '#import <Foundation/Foundation.h>\n',
  'directory.c': '#include "directory.h"\n#include "security.h"\n#include "darwin-permissions.h"\n',
  'directory.h': '#include <stdbool.h>\n',
  'security.h': '#include <stdint.h>\n',
  'darwin-permissions.h': '#include <sys/stat.h>\n',
}

function fixture(context, options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'recovery-contract-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const native = path.join(root, 'apps', 'desktop', 'native')
  fs.mkdirSync(path.join(native, 'shipit'), { recursive: true })
  for (const [name, content] of Object.entries(SOURCES)) {
    fs.writeFileSync(path.join(native, name), content)
  }
  const owner = path.join(root, 'apps', 'desktop', 'scripts', 'cd')
  const pre = path.join(root, 'apps', 'desktop', 'scripts', 'pre')
  fs.mkdirSync(path.join(root, 'apps', 'desktop', 'scripts', 'shared'), { recursive: true })
  fs.mkdirSync(owner, { recursive: true })
  fs.mkdirSync(pre, { recursive: true })
  fs.copyFileSync(IMPLEMENTATION, path.join(owner, 'recovery.cjs'))
  fs.writeFileSync(
    path.join(root, 'apps', 'desktop', 'scripts', 'shared', 'native.cjs'),
    'module.exports = {}\n'
  )
  fs.writeFileSync(path.join(pre, 'security.cjs'), 'module.exports = {}\n')
  const headers = path.join(root, 'headers.tar.gz')
  const license = path.join(root, 'NODE-LICENSE.txt')
  fs.writeFileSync(headers, 'verified header fixture')
  fs.writeFileSync(license, 'verified license fixture')
  const policy = {
    node: process.versions.node,
    electron: '44.3.0',
    napi: 8,
    headers: {
      filename: 'headers.tar.gz',
      bytes: fs.statSync(headers).size,
      sha256: digest(fs.readFileSync(headers)),
    },
    license: {
      filename: 'NODE-LICENSE.txt',
      bytes: fs.statSync(license).size,
      sha256: digest(fs.readFileSync(license)),
    },
    darwin: { deploymentTarget: '13.0' },
  }
  for (const [name, contents] of Object.entries({
    'lease.c': '#include "directory.h"\n',
    'toolchain.json': JSON.stringify(policy),
    'libraries.cjs': 'module.exports = {}\n',
    'shipit/bridge.m': '#define SS_PREFLIGHT_EMBED 1\n#import "preflight.m"\n',
  }))
    fs.writeFileSync(path.join(native, name), contents)
  const calls = []
  const nativeCalls = []
  const compiler = (executable, args, settings) => {
    calls.push({ executable, args, settings })
    const result = options.compile?.({ executable, args, settings, native })
    if (result) return result
    if (executable === '/usr/bin/tar') {
      fs.mkdirSync(
        path.join(args[args.indexOf('-C') + 1], `node-v${policy.node}`, 'include', 'node'),
        { recursive: true }
      )
      return { status: 0, stdout: '', stderr: '' }
    }
    fs.writeFileSync(args[args.indexOf('-o') + 1], 'contract executable', { mode: 0o700 })
    return { status: 0, stdout: '', stderr: '' }
  }
  const fakeProcess = {
    platform: options.platform || 'darwin',
    arch: options.arch || 'arm64',
    getuid: () => process.getuid(),
    versions: { node: process.versions.node },
    env: {
      CFLAGS: '-include /private/attacker.h',
      CPATH: '/private/attacker',
      SDKROOT: '/private/sdk',
      DEVELOPER_DIR: '/private/developer',
      DYLD_INSERT_LIBRARIES: '/private/attacker.dylib',
      SCHOLARSEED_RECOVERY_PROBE: '/private/attacker',
      PATH: '/private/attacker',
    },
  }
  const module = { exports: {} }
  const load = vm.runInNewContext(
    `(function(require, module, exports, __dirname, process, Buffer) {\n${fs.readFileSync(IMPLEMENTATION, 'utf8')}\n})`
  )
  load(
    (name) => {
      if (name === 'node:child_process') return { spawnSync: compiler }
      if (name === 'node:fs' && options.filesystem) return options.filesystem
      if (name === '../../native/libraries.cjs') return { libraries: () => NATIVE_LIBRARIES }
      if (name === '../shared/native.cjs')
        return {
          nativeSourceFiles: () => NATIVE_FILES,
          compileNative: async (settings) => {
            nativeCalls.push(settings)
            fs.mkdirSync(settings.directory, { mode: 0o700 })
            for (const entry of NATIVE_LIBRARIES)
              fs.writeFileSync(path.join(settings.directory, entry), `contract ${entry}`, {
                mode: 0o700,
              })
            fs.copyFileSync(
              settings.artifacts.license,
              path.join(settings.directory, policy.license.filename)
            )
            const value = {
              schema: 2,
              platform: 'darwin',
              arch: options.arch || 'arm64',
              napi: policy.napi,
              electron: policy.electron,
              signed: false,
              directory: settings.directory,
              sources: Object.fromEntries(
                NATIVE_FILES.map((entry) => [
                  entry,
                  digest(fs.readFileSync(path.join(native, entry))),
                ])
              ),
              builder_sha256: digest(
                fs.readFileSync(
                  path.join(root, 'apps', 'desktop', 'scripts', 'shared', 'native.cjs')
                )
              ),
              libraries: NATIVE_LIBRARIES.map((entry) => ({
                path: entry,
                sha256: digest(fs.readFileSync(path.join(settings.directory, entry))),
              })),
              inputs: Object.fromEntries(
                ['headers', 'license'].map((entry) => [
                  entry,
                  { sha256: policy[entry].sha256, bytes: policy[entry].bytes },
                ])
              ),
              licenses: [{ path: policy.license.filename, sha256: policy.license.sha256 }],
              contracts: { directory: 'not-requested' },
            }
            await options.nativeCompile?.({ settings, native, value })
            fs.writeFileSync(path.join(settings.directory, 'build.json'), JSON.stringify(value))
            return value
          },
        }
      return require(name)
    },
    module,
    module.exports,
    owner,
    fakeProcess,
    Buffer
  )
  return {
    ...module.exports,
    root,
    native,
    calls,
    nativeCalls,
    headers,
    license,
    output: path.join(root, 'probe'),
  }
}

test('loading the recovery tool does not compile or create output', (context) => {
  const current = fixture(context)
  assert.equal(typeof current.buildRecoveryProbe, 'function')
  assert.equal(typeof current.resolveRecoveryProbe, 'function')
  assert.equal(current.calls.length, 0)
  assert.equal(fs.existsSync(current.output), false)
})

macosTest(
  'maintenance requires explicit verified headers and license before writing',
  async (context) => {
    const current = fixture(context)
    await assert.rejects(
      async () => current.buildRecoveryMaintenance(current.output, {}),
      /headers|license|input/
    )
    assert.equal(fs.existsSync(current.output), false)
    assert.equal(current.calls.length, 0)
    assert.equal(current.nativeCalls.length, 0)
  }
)

macosTest('maintenance resolution never compiles a missing or probe-only tool', (context) => {
  const current = fixture(context)
  assert.throws(() => current.resolveRecoveryMaintenance(current.output), /ENOENT|missing/)
  current.buildRecoveryProbe(current.output)
  assert.throws(() => current.resolveRecoveryMaintenance(current.output), /ENOENT|missing/)
  assert.equal(current.calls.length, 1)
  assert.equal(current.nativeCalls.length, 0)
})

macosTest(
  'maintenance freezes canonical lease and terminal identities without native overrides',
  async (context) => {
    const current = fixture(context)
    const built = await current.buildRecoveryMaintenance(current.output, {
      headers: current.headers,
      license: current.license,
    })
    assert.equal(built.lease, path.join(current.output, 'native', 'lease.node'))
    assert.equal(built.terminal, path.join(current.output, 'terminal.node'))
    assert.equal(current.nativeCalls.length, 1)
    assert.equal(current.nativeCalls[0].runContract, false)
    assert.equal(current.nativeCalls[0].runDirectoryContract, false)
    assert.equal(current.nativeCalls[0].environment.CFLAGS, undefined)
    assert.equal(current.nativeCalls[0].environment.DEVELOPER_DIR, undefined)
    assert.equal(current.calls.length, 3)
    assert.equal(current.calls[1].executable, '/usr/bin/tar')
    const terminal = current.calls[2]
    assert.equal(terminal.executable, '/usr/bin/xcrun')
    assert.ok(terminal.args.includes('-bundle'))
    assert.ok(terminal.args.includes('-DNAPI_VERSION=8'))
    assert.ok(terminal.args.includes('-DNODE_GYP_MODULE_NAME=terminal'))
    assert.ok(terminal.args.some((argument) => argument.endsWith(`${path.sep}bridge.m`)))
    assert.equal(fs.statSync(built.lease).mode & 0o777, 0o500)
    assert.equal(fs.statSync(built.terminal).mode & 0o777, 0o500)
    const resolved = current.resolveRecoveryMaintenance(current.output)
    assert.equal(resolved.lease, built.lease)
    assert.equal(resolved.terminal, built.terminal)
    assert.equal(resolved.manifestSha256, built.manifestSha256)
    const manifest = JSON.parse(fs.readFileSync(built.manifest, 'utf8'))
    assert.ok(
      manifest.sources.some((source) => source.path === 'apps/desktop/scripts/pre/security.cjs')
    )
    assert.equal(current.calls.length, 3)
  }
)

for (const input of ['headers', 'license']) {
  macosTest(`maintenance refuses mismatched local ${input} without any output`, async (context) => {
    const current = fixture(context)
    fs.appendFileSync(current[input], 'changed')
    await assert.rejects(
      () =>
        current.buildRecoveryMaintenance(current.output, {
          headers: current.headers,
          license: current.license,
        }),
      /input|artifact|verified/
    )
    assert.equal(fs.existsSync(current.output), false)
    assert.equal(current.calls.length, 0)
    assert.equal(current.nativeCalls.length, 0)
  })
}

for (const entry of [
  'terminal.node',
  'native/lease.node',
  'native/build.json',
  MAINTENANCE_MANIFEST,
]) {
  macosTest(`maintenance refuses tampered ${entry} without rebuilding`, async (context) => {
    const current = fixture(context)
    await current.buildRecoveryMaintenance(current.output, {
      headers: current.headers,
      license: current.license,
    })
    const filename = path.join(current.output, entry)
    fs.chmodSync(filename, 0o600)
    fs.writeFileSync(filename, '{}')
    if (entry.endsWith('.node')) fs.chmodSync(filename, 0o500)
    assert.throws(() => current.resolveRecoveryMaintenance(current.output))
    assert.equal(current.nativeCalls.length, 1)
    assert.equal(current.calls.length, 3)
  })
}

for (const entry of ['shipit/bridge.m', 'lease.c', 'toolchain.json']) {
  macosTest(`maintenance refuses changed source ${entry}`, async (context) => {
    const current = fixture(context)
    await current.buildRecoveryMaintenance(current.output, {
      headers: current.headers,
      license: current.license,
    })
    fs.appendFileSync(path.join(current.native, entry), '\nchanged\n')
    assert.throws(
      () => current.resolveRecoveryMaintenance(current.output),
      /source|fingerprint|JSON/
    )
    assert.equal(current.nativeCalls.length, 1)
  })
}

macosTest(
  'maintenance source changes during canonical compilation cannot publish authority',
  async (context) => {
    const current = fixture(context, {
      nativeCompile: ({ native }) => fs.appendFileSync(path.join(native, 'lease.c'), '\nchanged\n'),
    })
    await assert.rejects(
      () =>
        current.buildRecoveryMaintenance(current.output, {
          headers: current.headers,
          license: current.license,
        }),
      /source|fingerprint/
    )
    assert.equal(fs.existsSync(path.join(current.output, MAINTENANCE_MANIFEST)), false)
    assert.throws(() => current.resolveRecoveryMaintenance(current.output))
  }
)

for (const [platform, arch] of [
  ['win32', 'x64'],
  ['linux', 'arm64'],
  ['darwin', 'ia32'],
]) {
  test(`recovery rejects ${platform}/${arch} before writing`, (context) => {
    const current = fixture(context, { platform, arch })
    for (const operation of [current.buildRecoveryProbe, current.resolveRecoveryProbe]) {
      assert.throws(() => operation(current.output), /native macOS/)
    }
    assert.equal(fs.existsSync(current.output), false)
    assert.equal(current.calls.length, 0)
  })
  test(`maintenance rejects ${platform}/${arch} before writing`, async (context) => {
    const current = fixture(context, { platform, arch })
    await assert.rejects(
      () =>
        current.buildRecoveryMaintenance(current.output, {
          headers: current.headers,
          license: current.license,
        }),
      /native macOS/
    )
    assert.throws(() => current.resolveRecoveryMaintenance(current.output), /native macOS/)
    assert.equal(fs.existsSync(current.output), false)
    assert.equal(current.calls.length, 0)
    assert.equal(current.nativeCalls.length, 0)
  })
}

macosTest(
  'canonical receipt failures and partial builds never become a maintenance tool',
  async (context) => {
    const current = fixture(context, {
      nativeCompile: ({ value }) => {
        value.signed = true
      },
    })
    await assert.rejects(
      () =>
        current.buildRecoveryMaintenance(current.output, {
          headers: current.headers,
          license: current.license,
        }),
      /receipt/
    )
    assert.equal(fs.existsSync(path.join(current.output, MAINTENANCE_MANIFEST)), false)
    assert.ok(current.resolveRecoveryProbe(current.output).executable)
    assert.throws(() => current.resolveRecoveryMaintenance(current.output))
  }
)

macosTest(
  'changed canonical builder source invalidates maintenance resolution',
  async (context) => {
    const current = fixture(context)
    await current.buildRecoveryMaintenance(current.output, {
      headers: current.headers,
      license: current.license,
    })
    fs.appendFileSync(
      path.join(current.root, 'apps', 'desktop', 'scripts', 'shared', 'native.cjs'),
      '\nchanged\n'
    )
    assert.throws(() => current.resolveRecoveryMaintenance(current.output), /source|fingerprint/)
    assert.equal(current.nativeCalls.length, 1)
  }
)

for (const mutation of ['hardlink', 'symlink', 'permissions']) {
  macosTest(`maintenance refuses terminal addon ${mutation}`, async (context) => {
    const current = fixture(context)
    const built = await current.buildRecoveryMaintenance(current.output, {
      headers: current.headers,
      license: current.license,
    })
    if (mutation === 'hardlink') fs.linkSync(built.terminal, path.join(current.root, 'extra-link'))
    if (mutation === 'symlink') {
      const replacement = path.join(current.root, 'replacement')
      fs.renameSync(built.terminal, replacement)
      fs.symlinkSync(replacement, built.terminal)
    }
    if (mutation === 'permissions') fs.chmodSync(built.terminal, 0o700)
    assert.throws(() => current.resolveRecoveryMaintenance(current.output))
    assert.equal(current.nativeCalls.length, 1)
  })
}

macosTest('resolution never creates, compiles, signs or repairs a missing probe', (context) => {
  const current = fixture(context)
  assert.throws(() => current.resolveRecoveryProbe(current.output), /ENOENT|missing/)
  assert.equal(fs.existsSync(current.output), false)
  assert.equal(current.calls.length, 0)
  assert.throws(() => current.buildRecoveryProbe('relative-output'), /absolute/)
  assert.equal(current.calls.length, 0)
})

for (const arch of ['arm64', 'x64']) {
  macosTest(
    `explicit ${arch} build freezes the full native include closure and private artifacts`,
    (context) => {
      const current = fixture(context, { arch })
      const built = current.buildRecoveryProbe(current.output)
      assert.equal(built.executable, path.join(current.output, EXECUTABLE))
      assert.equal(built.manifest, path.join(current.output, MANIFEST))
      const manifest = JSON.parse(fs.readFileSync(built.manifest, 'utf8'))
      assert.deepEqual(
        manifest.sources.map((source) => source.path).sort(),
        Object.keys(SOURCES).sort()
      )
      assert.equal(manifest.arch, arch)
      assert.equal(fs.statSync(current.output).mode & 0o777, 0o700)
      assert.equal(fs.statSync(built.manifest).mode & 0o777, 0o600)
      assert.equal(fs.statSync(built.executable).mode & 0o777, 0o500)
      assert.equal(fs.statSync(built.manifest).uid, process.getuid())
      assert.equal(fs.statSync(built.executable).uid, process.getuid())
      assert.equal(fs.statSync(built.manifest).nlink, 1)
      assert.equal(fs.statSync(built.executable).nlink, 1)
      assert.match(built.manifestSha256, /^[a-f0-9]{64}$/)
      assert.equal(current.calls.length, 1)
      const call = current.calls[0]
      assert.equal(call.executable, '/usr/bin/xcrun')
      assert.equal(call.args.includes('clang'), true)
      assert.equal(call.args.includes('Foundation'), true)
      assert.equal(call.args.includes('AppKit'), true)
      assert.equal(call.args[call.args.indexOf('-arch') + 1], arch === 'x64' ? 'x86_64' : arch)
      assert.equal(call.settings.shell, false)
      assert.deepEqual(Object.keys(call.settings.env).sort(), ['PATH', 'TMPDIR'])
      assert.equal(call.settings.env.PATH, '/usr/bin:/bin')
      for (const unit of [
        'preflight.m',
        'preparation.m',
        'cleanup.m',
        'readiness.m',
        'directory.c',
      ]) {
        const selected = call.args.find((argument) => argument.endsWith(path.sep + unit))
        assert.ok(selected?.startsWith(current.output + path.sep))
        assert.equal(selected.startsWith(current.native + path.sep), false)
      }
      const resolved = current.resolveRecoveryProbe(current.output)
      assert.equal(resolved.executable, built.executable)
      assert.equal(resolved.manifestSha256, built.manifestSha256)
      assert.equal(current.calls.length, 1)
      assert.deepEqual(fs.readdirSync(current.output).sort(), [MANIFEST, EXECUTABLE].sort())
    }
  )
}

for (const source of Object.keys(SOURCES)) {
  macosTest(`resolution rejects stale source ${source} without changing artifacts`, (context) => {
    const current = fixture(context)
    const built = current.buildRecoveryProbe(current.output)
    const receipt = fs.readFileSync(built.manifest)
    fs.appendFileSync(path.join(current.native, source), '\nchanged\n')
    assert.throws(() => current.resolveRecoveryProbe(current.output), /source|fingerprint/)
    assert.deepEqual(fs.readFileSync(built.manifest), receipt)
    assert.equal(current.calls.length, 1)
  })
}

macosTest('changed sources during compilation cannot publish a manifest', (context) => {
  const current = fixture(context, {
    compile: ({ args, native }) => {
      const staged = args.find((argument) => argument.endsWith(path.sep + 'preflight.m'))
      assert.equal(fs.readFileSync(staged, 'utf8'), SOURCES['shipit/preflight.m'])
      fs.appendFileSync(path.join(native, 'shipit', 'binding.h'), '\nchanged\n')
    },
  })
  assert.throws(() => current.buildRecoveryProbe(current.output), /source|fingerprint/)
  assert.equal(fs.existsSync(path.join(current.output, MANIFEST)), false)
  assert.equal(fs.existsSync(path.join(current.output, EXECUTABLE)), false)
})

macosTest(
  'compiler failures retain diagnostics and publish no executable or manifest',
  (context) => {
    const current = fixture(context, {
      compile: () => ({ status: 1, stdout: '', stderr: 'precise compiler failure' }),
    })
    assert.throws(() => current.buildRecoveryProbe(current.output), /precise compiler failure/)
    assert.equal(fs.existsSync(path.join(current.output, MANIFEST)), false)
    assert.equal(fs.existsSync(path.join(current.output, EXECUTABLE)), false)
  }
)

macosTest(
  'successful compiler status without a regular output cannot publish a manifest',
  (context) => {
    const current = fixture(context, {
      compile: () => ({ status: 0, stdout: '', stderr: '' }),
    })
    assert.throws(() => current.buildRecoveryProbe(current.output), /ENOENT|regular/)
    assert.equal(fs.existsSync(path.join(current.output, MANIFEST)), false)
    assert.equal(fs.existsSync(path.join(current.output, EXECUTABLE)), false)
  }
)

macosTest(
  'missing includes fail before output creation instead of building a partial fingerprint',
  (context) => {
    const current = fixture(context)
    fs.unlinkSync(path.join(current.native, 'shipit', 'observation.h'))
    assert.throws(() => current.buildRecoveryProbe(current.output), /ENOENT/)
    assert.equal(fs.existsSync(current.output), false)
    assert.equal(current.calls.length, 0)
  }
)

macosTest('nested local includes are part of the frozen source closure', (context) => {
  const current = fixture(context)
  fs.appendFileSync(path.join(current.native, 'shipit', 'binding.h'), '#include "nested.h"\n')
  fs.writeFileSync(path.join(current.native, 'shipit', 'nested.h'), '#include <stdbool.h>\n')
  const built = current.buildRecoveryProbe(current.output)
  const manifest = JSON.parse(fs.readFileSync(built.manifest, 'utf8'))
  assert.equal(
    manifest.sources.some((source) => source.path === 'shipit/nested.h'),
    true
  )
  fs.appendFileSync(path.join(current.native, 'shipit', 'nested.h'), '\nchanged\n')
  assert.throws(() => current.resolveRecoveryProbe(current.output), /fingerprint/)
  assert.equal(current.calls.length, 1)
})

macosTest(
  'source symlinks and local includes escaping the native owner are refused before output creation',
  (context) => {
    const current = fixture(context)
    const source = path.join(current.native, 'shipit', 'binding.h')
    fs.unlinkSync(source)
    fs.symlinkSync(path.join(current.native, 'shipit', 'readiness.h'), source)
    assert.throws(() => current.buildRecoveryProbe(current.output), /regular|link/)
    assert.equal(fs.existsSync(current.output), false)
    fs.unlinkSync(source)
    fs.writeFileSync(source, '#include "../../outside.h"\n')
    assert.throws(() => current.buildRecoveryProbe(current.output), /owner|escape/)
    assert.equal(fs.existsSync(current.output), false)
    assert.equal(current.calls.length, 0)
  }
)

macosTest(
  'build refuses nonempty, public and linked output directories without changing them',
  (context) => {
    const current = fixture(context)
    fs.mkdirSync(current.output, { mode: 0o700 })
    fs.writeFileSync(path.join(current.output, 'keep'), 'unrelated')
    assert.throws(() => current.buildRecoveryProbe(current.output), /empty/)
    assert.equal(fs.readFileSync(path.join(current.output, 'keep'), 'utf8'), 'unrelated')
    fs.unlinkSync(path.join(current.output, 'keep'))
    fs.chmodSync(current.output, 0o755)
    assert.throws(() => current.buildRecoveryProbe(current.output), /private|permission/)
    assert.equal(fs.statSync(current.output).mode & 0o777, 0o755)
    fs.rmdirSync(current.output)
    fs.symlinkSync(current.native, current.output)
    assert.throws(() => current.buildRecoveryProbe(current.output), /link|directory/)
    assert.equal(current.calls.length, 0)
  }
)

for (const target of [MANIFEST, EXECUTABLE]) {
  for (const mutation of ['bytes', 'permissions', 'hardlink', 'symlink']) {
    macosTest(`resolution refuses ${target} ${mutation} without rebuilding`, (context) => {
      const current = fixture(context)
      current.buildRecoveryProbe(current.output)
      const filename = path.join(current.output, target)
      if (mutation === 'bytes') {
        fs.chmodSync(filename, 0o600)
        fs.writeFileSync(filename, target === MANIFEST ? '{}' : 'changed')
        if (target === EXECUTABLE) fs.chmodSync(filename, 0o500)
      } else if (mutation === 'permissions') {
        fs.chmodSync(filename, 0o777)
      } else if (mutation === 'hardlink') {
        fs.linkSync(filename, path.join(current.root, 'extra-link'))
      } else {
        const replacement = path.join(current.root, 'replacement')
        fs.copyFileSync(filename, replacement)
        fs.unlinkSync(filename)
        fs.symlinkSync(replacement, filename)
      }
      assert.throws(() => current.resolveRecoveryProbe(current.output))
      assert.equal(current.calls.length, 1)
    })
  }
}

macosTest(
  'executable digest rejects same-size tampering even when inode and mode stay unchanged',
  (context) => {
    const current = fixture(context)
    const built = current.buildRecoveryProbe(current.output)
    const previous = fs.statSync(built.executable)
    fs.chmodSync(built.executable, 0o700)
    fs.writeFileSync(built.executable, 'CONTRACT EXECUTABLE')
    fs.chmodSync(built.executable, 0o500)
    assert.equal(fs.statSync(built.executable).ino, previous.ino)
    assert.equal(fs.statSync(built.executable).size, previous.size)
    assert.throws(() => current.resolveRecoveryProbe(current.output), /digest/)
    assert.equal(current.calls.length, 1)
  }
)

for (const field of ['uid', 'nlink', 'mode', 'inode', 'device', 'bytes', 'sha256']) {
  macosTest(`manifest cannot substitute executable ${field}`, (context) => {
    const current = fixture(context)
    const built = current.buildRecoveryProbe(current.output)
    const manifest = JSON.parse(fs.readFileSync(built.manifest, 'utf8'))
    manifest.executable[field] =
      field === 'sha256' ? '0'.repeat(64) : manifest.executable[field] + 1
    fs.writeFileSync(built.manifest, JSON.stringify(manifest))
    assert.throws(() => current.resolveRecoveryProbe(current.output), /identity|digest/)
    assert.equal(current.calls.length, 1)
  })
}

macosTest('a copied probe directory cannot impersonate the original output identity', (context) => {
  const current = fixture(context)
  current.buildRecoveryProbe(current.output)
  const copy = path.join(current.root, 'copied-output')
  fs.cpSync(current.output, copy, { recursive: true })
  fs.chmodSync(copy, 0o700)
  assert.throws(() => current.resolveRecoveryProbe(copy), /manifest/)
  assert.equal(current.calls.length, 1)
})

macosTest(
  'source and artifact reads use bounded descriptor reads instead of readFileSync',
  (context) => {
    const requests = []
    const filesystem = {
      ...fs,
      readFileSync(filename, ...args) {
        assert.notEqual(typeof filename, 'number', 'descriptor reads must have a hard byte bound')
        return fs.readFileSync(filename, ...args)
      },
      readSync(descriptor, buffer, offset, length, position) {
        requests.push({ capacity: buffer.length, length })
        return fs.readSync(descriptor, buffer, offset, length, position)
      },
    }
    const current = fixture(context, { filesystem })
    current.buildRecoveryProbe(current.output)
    current.resolveRecoveryProbe(current.output)
    assert.ok(requests.length > 0)
    assert.equal(
      requests.every((request) => request.length <= request.capacity),
      true
    )
    assert.equal(
      requests.every((request) => request.capacity <= 32 * 1024 * 1024 + 1),
      true
    )
  }
)

macosTest(
  'a source growing during its bounded read is rejected without publishing output',
  (context) => {
    let growingDescriptor
    let changed = false
    const filesystem = {
      ...fs,
      openSync(filename, ...args) {
        const descriptor = fs.openSync(filename, ...args)
        if (typeof filename === 'string' && filename.endsWith(`${path.sep}binding.h`)) {
          growingDescriptor = descriptor
        }
        return descriptor
      },
      readFileSync(filename, ...args) {
        assert.notEqual(typeof filename, 'number', 'descriptor reads must have a hard byte bound')
        return fs.readFileSync(filename, ...args)
      },
      readSync(descriptor, buffer, offset, length, position) {
        if (descriptor === growingDescriptor && !changed) {
          changed = true
          fs.appendFileSync(
            path.join(current.native, 'shipit', 'binding.h'),
            'changed while reading'
          )
        }
        return fs.readSync(descriptor, buffer, offset, length, position)
      },
    }
    const current = fixture(context, { filesystem })
    assert.throws(() => current.buildRecoveryProbe(current.output), /changed while reading/)
    assert.equal(changed, true)
    assert.equal(fs.existsSync(current.output), false)
    assert.equal(current.calls.length, 0)
  }
)

for (const [target, limit] of [
  ['source', 8 * 1024 * 1024],
  [MANIFEST, 1024 * 1024],
  [EXECUTABLE, 32 * 1024 * 1024],
]) {
  macosTest(`oversized ${target} is rejected before reading its contents`, (context) => {
    const current = fixture(context)
    if (target === 'source') {
      fs.truncateSync(path.join(current.native, 'shipit', 'binding.h'), limit + 1)
      assert.throws(() => current.buildRecoveryProbe(current.output), /bounded/)
      assert.equal(fs.existsSync(current.output), false)
      assert.equal(current.calls.length, 0)
    } else {
      current.buildRecoveryProbe(current.output)
      const filename = path.join(current.output, target)
      fs.chmodSync(filename, 0o600)
      fs.truncateSync(filename, limit + 1)
      fs.chmodSync(filename, target === MANIFEST ? 0o600 : 0o500)
      assert.throws(() => current.resolveRecoveryProbe(current.output), /bounded/)
      assert.equal(current.calls.length, 1)
    }
  })
}

for (const target of ['source', MANIFEST, EXECUTABLE]) {
  macosTest(`FIFO ${target} is refused without blocking an isolated process`, (context) => {
    const current = fixture(context)
    if (target !== 'source') current.buildRecoveryProbe(current.output)
    const filename =
      target === 'source'
        ? path.join(current.native, 'shipit', 'binding.h')
        : path.join(current.output, target)
    fs.unlinkSync(filename)
    const created = spawnSync('/usr/bin/mkfifo', [filename], { encoding: 'utf8', timeout: 2000 })
    assert.equal(created.error, undefined)
    assert.equal(created.status, 0, created.stderr)
    const child = `
      const fs = require('node:fs')
      const vm = require('node:vm')
      const module = { exports: {} }
      const load = vm.runInNewContext('(function(require, module, exports, __dirname, process, Buffer) {\\n' + fs.readFileSync(process.argv[1], 'utf8') + '\\n})')
      load(require('node:module').createRequire(process.argv[1]), module, module.exports, process.argv[2], { platform: 'darwin', arch: 'arm64', getuid: () => process.getuid() }, Buffer)
      try {
        module.exports[process.argv[3]](process.argv[4])
        process.exitCode = 2
      } catch (error) {
        process.stderr.write(error.message)
        process.exitCode = /regular|permission|bounded/.test(error.message) ? 0 : 3
      }
    `
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        child,
        IMPLEMENTATION,
        path.join(current.root, 'apps', 'desktop', 'scripts', 'cd'),
        target === 'source' ? 'buildRecoveryProbe' : 'resolveRecoveryProbe',
        current.output,
      ],
      { encoding: 'utf8', timeout: 2000 }
    )
    assert.equal(result.error, undefined, result.error?.message)
    assert.equal(result.status, 0, result.stderr)
  })
}
