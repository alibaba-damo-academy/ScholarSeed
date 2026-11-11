// Fixed-input native lease build. Produces an unsigned library and provenance;
// packaging must sign and freeze final bytes before putting them in the closure.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { ensureArtifact, matches } = require('../../../../scripts/shared/artifacts.cjs')
const policy = require('../../native/toolchain.json')
const cache = require('../cd/cache.cjs')
const { ensurePrivateDirectory } = require('./build-state.cjs')
const { LIBRARIES } = require('../../native/libraries.cjs')
const { SUPPORT_UNITS, REPAIR_FLAGS } = require('../../native/shipit/compilation.cjs')

const NATIVE = path.resolve(__dirname, '../../native')
const LIBRARY = 'lease.node'
const BUILD_SCHEMA = 2
const COMPILER_TIMEOUT = 120000
const COMMAND_OUTPUT_LIMIT = 4 * 1024 * 1024
const OUTPUT_LIMIT_ERROR_CODE = 'ENOBUFS'
const DIRECTORY_CLOSE_BOUNDARIES = 6
const NATIVE_BUILD_ROOT = 'scholarseed-native-build'
const CONTRACT_STATUS = Object.freeze({ passed: 'passed', notRequested: 'not-requested' })
// Compiler drivers accept flags from environment variables as well as argv.
// Keep OS/profile/temp inputs and explicit Xcode selection; downloads use a separate environment.
const TOOL_ENVIRONMENT =
  /^(SystemRoot|WINDIR|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LOCALAPPDATA|DEVELOPER_DIR)$/i

function validateDarwinToolchain(compilerVersion, sdk, deploymentTarget) {
  const version = (value) => /^\d+\.\d+(?:\.\d+)?$/.test(value) && value.split('.').map(Number)
  const actual = version(sdk.version)
  const minimum = version(deploymentTarget)
  if (
    !/^Apple clang version \d+\.\d+\.\d+\b/.test(compilerVersion) ||
    !actual ||
    !minimum ||
    !path.isAbsolute(sdk.path)
  ) {
    throw new Error(
      `invalid Apple toolchain: compiler=${compilerVersion}; SDK=${sdk.version}; path=${sdk.path}`
    )
  }
  const compare = Array.from(
    { length: 3 },
    (_, index) => (actual[index] || 0) - (minimum[index] || 0)
  )
  if ((compare.find((part) => part !== 0) || 0) < 0) {
    throw new Error(`macOS SDK ${sdk.version} is older than deployment target ${deploymentTarget}`)
  }
}

function supportsNoDefaultConfig(help) {
  return /--no-default-config\b/.test(help)
}

function digest(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
}

function invoke(executable, args, environment) {
  try {
    return execFileSync(executable, args, {
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: COMPILER_TIMEOUT,
      maxBuffer: COMMAND_OUTPUT_LIMIT,
    }).trim()
  } catch (error) {
    const diagnostics = JSON.stringify({
      executable,
      args,
      exitCode: error.status ?? null,
      signal: error.signal ?? null,
      code: error.code ?? null,
      outputLimitBytes: COMMAND_OUTPUT_LIMIT,
      outputMayBeTruncated: error.code === OUTPUT_LIMIT_ERROR_CODE,
    })
    error.message += `\n[native-command] ${diagnostics}\n--- stdout ---\n${error.stdout ?? ''}\n--- stderr ---\n${error.stderr ?? ''}\n--- end native-command ---`
    throw error
  }
}

function nativeBuildDirectory(environment = process.env) {
  const configured = environment.SCHOLARSEED_NATIVE_BUILD_ROOT
  const temporaryRoot = fs.realpathSync.native(os.tmpdir())
  const root = configured ? path.resolve(configured) : path.join(temporaryRoot, NATIVE_BUILD_ROOT)
  return fs.mkdtempSync(path.join(ensurePrivateDirectory(root), 'run-'))
}

function cleanupNativeBuild(directory, failure) {
  try {
    fs.rmSync(directory, { recursive: true, force: true })
  } catch (error) {
    if (!failure) throw error
    failure.message += `\n[native-cleanup] ${error.message}`
    failure.cleanupError = error
  }
}

function nativeSourceFiles(platform) {
  return [
    'lease.c',
    'fonts.c',
    ...(platform === 'win32' ? ['notification.c', 'notification.h', 'notification.test.c'] : []),
    'libraries.cjs',
    'directory.c',
    'directory.h',
    'security.h',
    'security.json',
    'security.outputs.json',
    ...(platform === 'darwin'
      ? ['darwin-permissions.h', 'notarization.c', 'notarization.test.cjs', 'notarization.fixture.json']
      : []),
    ...(platform === 'darwin' ? [
      'shipit/bridge.m', 'shipit/preflight.m', 'shipit/preparation.m', 'shipit/preparation.h',
      'shipit/cleanup.m', 'shipit/cleanup.h', 'shipit/readiness.m', 'shipit/readiness.h',
      'shipit/binding.h', 'shipit/observation.h', 'shipit/succession.h',
      'shipit/parking.h',
      'shipit/compilation.cjs',
      'shipit/repair.test.cjs',
    ] : []),
    'startup.h',
    'family.h',
    ...(platform === 'win32' ? ['installation.h', 'installation.test.c'] : []),
    'directory.test.c',
    ...(platform === 'win32' ? ['hook.c', 'VELOPACK-LICENSE.txt'] : []),
    'toolchain.json',
  ]
}

async function compileNative({
  directory,
  arch = process.arch,
  artifacts = {},
  environment = process.env,
  runContract = true,
  runDirectoryContract = false,
}) {
  if (typeof runDirectoryContract !== 'boolean') throw new TypeError('runDirectoryContract must be boolean')
  invoke(process.execPath, [path.resolve(__dirname, '../pre/security.cjs'), '--check'], environment)
  const platform = process.platform
  if (!(
    (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) ||
    (platform === 'win32' && arch === 'x64' && process.arch === 'x64')
  )) {
    throw new Error(`unsupported native lease target: ${platform}/${arch}`)
  }
  if (!directory || !path.isAbsolute(directory))
    throw new Error('native output requires a new absolute directory')
  fs.mkdirSync(directory, { mode: 0o700 })
  const temporary = nativeBuildDirectory(environment)
  const selected = Object.fromEntries(
    Object.entries(environment).filter(([name]) => TOOL_ENVIRONMENT.test(name))
  )
  const windows = selected.SystemRoot || selected.SYSTEMROOT || 'C:\\Windows'
  selected.PATH = platform === 'win32' ? path.join(windows, 'System32') : '/usr/bin:/bin'
  const tar = platform === 'win32' ? path.join(windows, 'System32', 'tar.exe') : '/usr/bin/tar'
  const sourceFiles = nativeSourceFiles(platform)
  const sources = Object.fromEntries(
    sourceFiles.map((name) => [name, digest(path.join(NATIVE, name))])
  )
  const builderSha = digest(__filename)
  const downloaded = {}
  const input = async (name, expected) => {
    const filename = path.join(temporary, expected.filename)
    if (artifacts[name]) {
      fs.copyFileSync(path.resolve(artifacts[name]), filename, fs.constants.COPYFILE_EXCL)
      if (!(await matches(filename, expected)))
        throw new Error(`native ${name} artifact differs from policy`)
    } else {
      await ensureArtifact(filename, expected, { environment })
    }
    downloaded[name] = { sha256: expected.sha256, bytes: expected.bytes }
    return filename
  }
  let failure
  try {
    const headers = await input('headers', policy.headers)
    const headersDirectory = platform === 'win32'
      ? cache.expanded(headers, policy.headers, environment, directory => invoke(tar, ['-xf', headers, '-C', directory], selected))
      : (invoke(tar, ['-xf', headers, '-C', temporary], selected), temporary)
    const headerRoot = path.join(headersDirectory, `node-v${policy.node}`)
    const output = path.join(directory, LIBRARY)
    let compiler,
      compilerVersion,
      sdk = null
    let defaultConfigDisabled = true
    const arguments_ = [
      '--no-default-config',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-std=c11',
      '-O2',
      `-DNAPI_VERSION=${policy.napi}`,
      '-I',
      path.join(headerRoot, 'include', 'node'),
    ]
    const contractArguments = [...arguments_]
    const licenses = { 'NODE-LICENSE.txt': await input('license', policy.license) }
    if (platform === 'win32') {
      const archive = await input('compiler', policy.windows.compiler)
      const library = await input('library', policy.windows.library)
      const expanded = cache.expanded(archive, policy.windows.compiler, environment,
        directory => invoke(tar, ['-xf', archive, '-C', directory], selected))
      const compilerRoot = path.join(expanded, policy.windows.directory)
      compiler = path.join(compilerRoot, 'bin', 'clang.exe')
      compilerVersion = invoke(compiler, ['--version'], selected).split(/\r?\n/, 1)[0]
      contractArguments.push(
        `-D_WIN32_WINNT=${policy.windows.apiTarget}`,
        `-DWINVER=${policy.windows.apiTarget}`,
        `--config=${path.join(compilerRoot, 'bin', 'x86_64-w64-windows-gnu.cfg')}`,
        '-ladvapi32',
        '-lntdll'
      )
      arguments_.push(
        `-D_WIN32_WINNT=${policy.windows.apiTarget}`,
        `-DWINVER=${policy.windows.apiTarget}`,
        `--config=${path.join(compilerRoot, 'bin', 'x86_64-w64-windows-gnu.cfg')}`,
        '-shared',
        path.join(NATIVE, 'lease.c'),
        path.join(NATIVE, 'directory.c'),
        path.join(NATIVE, 'hook.c'),
        library,
        '-Wl,--delayload=node.exe',
        '-Wl,--no-insert-timestamp',
        '-ldelayimp',
        '-ladvapi32',
        '-lntdll',
        '-o',
        output
      )
      licenses['LLVM-LICENSE.txt'] = path.join(compilerRoot, 'LICENSE.TXT')
      for (const name of [
        'COPYING',
        'COPYING.MinGW-w64-runtime.txt',
        'COPYING.MinGW-w64.txt',
        'COPYING.winpthreads.txt',
      ]) {
        licenses[`MINGW-${name}`] = path.join(
          compilerRoot,
          'x86_64-w64-mingw32',
          'share',
          'mingw32',
          name
        )
      }
    } else {
      compiler = invoke('/usr/bin/xcrun', ['--sdk', 'macosx', '--find', 'clang'], selected)
      compilerVersion = invoke(compiler, ['--version'], selected).split(/\r?\n/, 1)[0]
      sdk = {
        path: invoke('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], selected),
        version: invoke('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-version'], selected),
      }
      validateDarwinToolchain(compilerVersion, sdk, policy.darwin.deploymentTarget)
      defaultConfigDisabled = supportsNoDefaultConfig(invoke(compiler, ['--help'], selected))
      if (!defaultConfigDisabled) {
        arguments_.shift()
        contractArguments.shift()
      }
      console.log(
        `[native] ${compilerVersion}; SDK=${sdk.version}; no-default-config=${defaultConfigDisabled}`
      )
      contractArguments.push(
        '-arch',
        process.arch === 'x64' ? 'x86_64' : process.arch,
        '-isysroot',
        sdk.path,
        `-mmacosx-version-min=${policy.darwin.deploymentTarget}`
      )
      arguments_.push(
        '-bundle',
        '-undefined',
        'dynamic_lookup',
        '-arch',
        arch === 'x64' ? 'x86_64' : arch,
        '-isysroot',
        sdk.path,
        `-mmacosx-version-min=${policy.darwin.deploymentTarget}`,
        path.join(NATIVE, 'lease.c'),
        path.join(NATIVE, 'directory.c'),
        '-o',
        output
      )
    }
    if (platform === 'win32') {
      const installationContract = path.join(temporary, 'installation-test.exe')
      invoke(
        compiler,
        [
          ...contractArguments,
          path.join(NATIVE, 'installation.test.c'),
          '-o',
          installationContract,
        ],
        selected
      )
      invoke(installationContract, [], selected)
    }
    if (runDirectoryContract) {
      const contract = path.join(
        temporary,
        platform === 'win32' ? 'directory-test.exe' : 'directory-test'
      )
      invoke(
        compiler,
        [...contractArguments, path.join(NATIVE, 'directory.test.c'), '-o', contract],
        selected
      )
      if (platform === 'darwin') {
        invoke('/usr/bin/codesign', ['--force', '--sign', '-', contract], selected)
        invoke('/usr/bin/codesign', ['--verify', '--strict', contract], selected)
      }
      for (let failedClose = 0; failedClose <= DIRECTORY_CLOSE_BOUNDARIES; failedClose++) {
        invoke(contract, [String(failedClose)], selected)
      }
    }
    if (runContract && platform === 'win32') {
      const notificationContract = path.join(temporary, 'notification-test.exe')
      invoke(
        compiler,
        [...contractArguments, path.join(NATIVE, 'notification.test.c'), '-o', notificationContract],
        selected
      )
      invoke(notificationContract, [], selected)
    }
    invoke(compiler, arguments_, selected)
    const fontArguments = arguments_.filter(argument => ![
      path.join(NATIVE, 'directory.c'), '-ladvapi32', '-lntdll',
    ].includes(argument)).map(argument => argument === path.join(NATIVE, 'lease.c')
      ? path.join(NATIVE, 'fonts.c') : argument === output ? path.join(directory, 'fonts.node') : argument)
    fontArguments.push(...(platform === 'darwin' ? ['-framework', 'CoreText', '-framework', 'CoreFoundation'] : ['-ldwrite']))
    invoke(compiler, fontArguments, selected)
    if (platform === 'win32') {
      const notificationArguments = arguments_.filter(argument => ![
        path.join(NATIVE, 'directory.c'), '-ladvapi32', '-lntdll',
      ].includes(argument)).map(argument => argument === path.join(NATIVE, 'lease.c')
        ? path.join(NATIVE, 'notification.c') : argument === output ? path.join(directory, 'notification.node') : argument)
      notificationArguments.push('-lruntimeobject', '-lole32', '-lshell32', '-luuid', '-lpropsys')
      invoke(compiler, notificationArguments, selected)
    }
    if (platform === 'darwin') {
      const ticketLibrary = path.join(directory, 'notarization.node')
      const ticketArguments = arguments_
        .filter((argument) => argument !== path.join(NATIVE, 'directory.c'))
        .map((argument) =>
          argument === path.join(NATIVE, 'lease.c')
            ? path.join(NATIVE, 'notarization.c')
            : argument === output
              ? ticketLibrary
              : argument
        )
      ticketArguments.push('-framework', 'Security', '-framework', 'CoreFoundation')
      invoke(compiler, ticketArguments, selected)
      const repairArguments = arguments_
        .map(argument => argument === path.join(NATIVE, 'lease.c')
          ? path.join(NATIVE, 'shipit/bridge.m') : argument === output ? path.join(directory, 'repair.node') : argument)
      repairArguments.push(...REPAIR_FLAGS,
        ...SUPPORT_UNITS.map(name => path.join(NATIVE, 'shipit', name)))
      invoke(compiler, repairArguments, selected)
      if (runContract) {
        invoke(process.execPath, ['--test', path.join(NATIVE, 'shipit/repair.test.cjs')], {
          ...selected,
          SCHOLARSEED_REPAIR_LIBRARY: path.join(directory, 'repair.node'),
        })
        invoke(process.execPath, ['--test', path.join(NATIVE, 'notarization.test.cjs')], {
          ...selected,
          SCHOLARSEED_NOTARIZATION_LIBRARY: ticketLibrary,
        })
      }
    }
    if (platform === 'win32') {
      licenses['VELOPACK-LICENSE.txt'] = path.join(NATIVE, 'VELOPACK-LICENSE.txt')
      const sdkRoot = path.resolve(__dirname, '../../node_modules/velopack')
      const sdk = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json'), 'utf8'))
      if (sdk.version !== '1.2.161') throw new Error('native Velopack SDK must be 1.2.161')
      const sdkFile = path.join(sdkRoot, 'lib/native/velopack_nodeffi_win_x64_msvc.node')
      const expected = digest(sdkFile)
      downloaded.velopack = { version: sdk.version, sha256: expected, bytes: fs.statSync(sdkFile).size }
      fs.copyFileSync(sdkFile, path.join(directory, 'velopack.node'), fs.constants.COPYFILE_EXCL)
      if (digest(path.join(directory, 'velopack.node')) !== expected) throw new Error('Velopack SDK changed during copy')
    }
    if (digest(__filename) !== builderSha)
      throw new Error('native builder changed during compilation')
    for (const [name, sha] of Object.entries(sources)) {
      if (digest(path.join(NATIVE, name)) !== sha)
        throw new Error('native source changed during compilation')
    }
    const licenseFiles = []
    for (const [name, filename] of Object.entries(licenses)) {
      fs.copyFileSync(filename, path.join(directory, name), fs.constants.COPYFILE_EXCL)
      licenseFiles.push({ path: name, sha256: digest(filename) })
    }
    const result = {
      schema: BUILD_SCHEMA,
      platform,
      arch,
      napi: policy.napi,
      electron: policy.electron,
      directory,
      libraries: LIBRARIES.map(name => ({ path: name, sha256: digest(path.join(directory, name)) })),
      sources,
      builder_sha256: builderSha,
      contracts: { directory: runDirectoryContract ? CONTRACT_STATUS.passed : CONTRACT_STATUS.notRequested },
      inputs: downloaded,
      compiler: {
        version: compilerVersion,
        sha256: digest(compiler),
        default_config_disabled: defaultConfigDisabled,
        ...(sdk ? { sdk } : {}),
      },
      licenses: licenseFiles,
      signed: false,
    }
    fs.writeFileSync(path.join(directory, 'build.json'), JSON.stringify(result, null, 2) + '\n', {
      flag: 'wx',
    })
    return result
  } catch (error) {
    failure = error
    throw error
  } finally {
    cleanupNativeBuild(temporary, failure)
  }
}

module.exports = { compileNative, nativeSourceFiles, nativeBuildDirectory, cleanupNativeBuild, validateDarwinToolchain, supportsNoDefaultConfig, invoke }

if (require.main === module) {
  const args = process.argv.slice(2)
  const options = {}
  const allowed = new Set([
    '--output',
    '--arch',
    '--headers',
    '--compiler',
    '--library',
    '--license',
  ])
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options[args[i]]) {
      throw new Error(
        'usage: native.cjs --output <new directory> [--arch arm64|x64] [--headers <archive>] [--compiler <archive>] [--library <Electron node.lib>] [--license <Node LICENSE>]'
      )
    }
    options[args[i]] = args[i + 1]
  }
  compileNative({
    directory: options['--output'] && path.resolve(options['--output']),
    arch: options['--arch'] || process.arch,
    artifacts: {
      headers: options['--headers'],
      compiler: options['--compiler'],
      library: options['--library'],
      license: options['--license'],
    },
  })
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
