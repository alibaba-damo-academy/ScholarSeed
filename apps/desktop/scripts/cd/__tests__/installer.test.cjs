const sourceDirectory = require('node:path').dirname(__dirname)
// Execute the production scope gate in NSIS; this is not signed installation acceptance.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync, spawn } = require('node:child_process')
const { once } = require('node:events')
const DIAGNOSTICS = fs.readFileSync(path.join(sourceDirectory, '../../resources/diagnostics.nsh'), 'utf8')

test('native installer diagnostics preserve registers and sticky errors with or without stdout', {
  skip: process.platform !== 'win32' || !process.env.NSISDIR ? 'Requires Windows and NSIS' : false,
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-nsis-diagnostics-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const executable = path.join(directory, 'diagnostics.exe')
  const script = path.join(directory, 'diagnostics.nsi')
  fs.writeFileSync(script, `\uFEFF
Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${executable}"
${DIAGNOSTICS}
Section
  StrCpy $0 "saved-0"
  StrCpy $1 "saved-1"
  StrCpy $2 "saved-2"
  SetErrors
  !insertmacro ssInstallerDiagnostic "phase=diagnostic-check result=failed"
  IfErrors +2
    Goto failed
  ClearErrors
  !insertmacro ssInstallerDiagnostic "phase=diagnostic-check result=passed"
  IfErrors failed
  StrCmp $0 "saved-0" 0 failed
  StrCmp $1 "saved-1" 0 failed
  StrCmp $2 "saved-2" 0 failed
  SetErrorLevel 0
  Quit
  failed:
  SetErrorLevel 9
SectionEnd
`)
  const compiled = spawnSync(path.join(process.env.NSISDIR, 'makensis.exe'), ['/V2', script], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
  })
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr)
  const piped = spawnSync(executable, [], { encoding: 'utf8', timeout: 30000, windowsHide: true })
  assert.equal(piped.status, 0, piped.stderr)
  assert.deepEqual(piped.stdout.trim().split(/\r?\n/), [
    '[nsis] phase=diagnostic-check result=failed', '[nsis] phase=diagnostic-check result=passed',
  ])
  const ignored = spawnSync(executable, [], { stdio: 'ignore', timeout: 30000, windowsHide: true })
  assert.equal(ignored.status, 0)
})

test(
  'native running-app check refuses a live process without killing it',
  {
    skip:
      process.platform !== 'win32' || !process.env.NSISDIR ? 'Requires Windows and NSIS' : false,
  },
  async (t) => {
    const source = fs.readFileSync(path.join(sourceDirectory, '../../resources/installer.nsh'), 'utf8')
    const macros = ['ssDetectAppRunning', 'ssLocalizedMessage', 'customCheckAppRunning']
      .map((name) => {
        const match = source.match(new RegExp(String.raw`!macro ${name}[^\r\n]*[\s\S]*?!macroend`))
        assert.ok(match)
        return match[0]
      })
      .join('\n')
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-busy-'))
    let child
    let ended
    t.after(async () => {
      if (child) {
        child.kill()
        await ended
      }
      fs.rmSync(directory, { recursive: true, force: true })
    })
    const application = `SSBusy${process.pid}.exe`
    const image = path.join(directory, application)
    fs.copyFileSync(process.execPath, image)
    const executable = path.join(directory, 'check.exe')
    const script = path.join(directory, 'check.nsi')
    fs.writeFileSync(
      script,
      `\uFEFF
Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${executable}"
!include "LogicLib.nsh"
!define LANG_SIMPCHINESE 2052
!define LANG_TRADCHINESE 1028
!define APP_EXECUTABLE_FILENAME "${application}"
${DIAGNOSTICS}
${macros}
Section
  !insertmacro customCheckAppRunning
  SetErrorLevel 0
SectionEnd
`
    )
    const compiled = spawnSync(path.join(process.env.NSISDIR, 'makensis.exe'), ['/V2', script], {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    })
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr)
    const idle = spawnSync(executable, ['/S'], {
      timeout: 30000,
      windowsHide: true,
      stdio: 'ignore',
    })
    assert.equal(idle.status, 0)
    child = spawn(image, ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    ended = once(child, 'exit')
    await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) })
    const busy = spawnSync(executable, ['/S'], {
      timeout: 30000,
      windowsHide: true,
      stdio: 'ignore',
    })
    assert.equal(busy.status, 2)
    assert.doesNotThrow(() => process.kill(child.pid, 0), 'installer killed the running owner')

    // The earlier legacy .onInit gate must also explain its silent timeout.
    // Shorten only the polling budget; execute the production function unchanged.
    const legacy = source.match(/    Function ssEnforceAppClosed[\s\S]*?    FunctionEnd/)
    assert.ok(legacy)
    fs.writeFileSync(script, `\uFEFF
Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${executable}"
!include "LogicLib.nsh"
!define LANG_SIMPCHINESE 2052
!define LANG_TRADCHINESE 1028
!define APP_EXECUTABLE_FILENAME "${application}"
!define SS_OLDPROC_WAIT_ROUNDS 2
!define SS_HANDSHAKE_SLEEP_MS 1
Var ssLogPhase
Var ssLogEventName
Var ssLogResult
${DIAGNOSTICS}
${macros}
Function ssLogEvent
FunctionEnd
${legacy[0]}
Function .onInit
  Call ssEnforceAppClosed
FunctionEnd
Section
  SetErrorLevel 0
SectionEnd
`)
    const legacyCompiled = spawnSync(path.join(process.env.NSISDIR, 'makensis.exe'), ['/V2', script], {
      encoding: 'utf8', timeout: 30000, windowsHide: true,
    })
    assert.equal(legacyCompiled.status, 0, legacyCompiled.stdout + legacyCompiled.stderr)
    const waiting = spawnSync(executable, ['/S'], { encoding: 'utf8', timeout: 30000, windowsHide: true })
    assert.equal(waiting.status, 2, waiting.stdout + waiting.stderr)
    assert.match(waiting.stdout, /phase=app-close result=timeout/)
    assert.doesNotThrow(() => process.kill(child.pid, 0), 'legacy gate killed the running owner')
    child.kill()
    await ended
    child = null
    const closed = spawnSync(executable, ['/S'], { encoding: 'utf8', timeout: 30000, windowsHide: true })
    assert.equal(closed.status, 0, closed.stdout + closed.stderr)
    assert.match(closed.stdout, /phase=app-close result=closed/)
  }
)

test(
  'native NSIS uninstall retires with no stdout and preserves the store during update',
  {
    skip:
      process.platform !== 'win32' ||
      !process.env.NSISDIR ||
      !process.env.SCHOLARSEED_RETIREMENT_LAUNCHER
        ? 'Requires Windows, NSIS and a native launcher with a contract-only baseline'
        : false,
  },
  (t) => {
    const launcher = path.resolve(process.env.SCHOLARSEED_RETIREMENT_LAUNCHER)
    const native = (args) =>
      spawnSync(launcher, args, {
        encoding: 'utf8',
        timeout: 30000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    const previous = native(['--retire-update-store'])
    assert.equal(previous.status, 0, previous.stderr)
    // A resumed cleanup reports its quarantine. Repeat after completion to get
    // the absent installation namespace, and verify that retirement is idempotent.
    const empty = native(['--retire-update-store'])
    assert.equal(empty.status, 0, empty.stderr)
    const namespace = JSON.parse(empty.stdout).namespace
    assert.ok(path.isAbsolute(namespace))
    assert.equal(fs.existsSync(namespace), false)
    t.after(() => {
      const cleanup = native(['--retire-update-store'])
      assert.equal(cleanup.status, 0, cleanup.stderr)
    })
    // Exercise ordinary startup through the compiled policy, with intentionally
    // absent fixture bootstrap archives. It must create authority, then fail.
    const started = native([])
    assert.notEqual(started.status, 0)
    assert.equal(fs.existsSync(namespace), true)
    const source = fs.readFileSync(path.join(sourceDirectory, '../../resources/installer.nsh'), 'utf8')
    const macros = ['ssLocalizedMessage', 'customUnInstall']
      .map((name) => {
        const match = source.match(
          new RegExp(String.raw`\n!macro ${name}[^\r\n]*[\s\S]*?!macroend`)
        )
        assert.ok(match)
        return match[0]
      })
      .join('\n')
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-retire-nsis-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    for (const updated of [true, false]) {
      const output = path.join(directory, `${updated}.exe`)
      const reached = path.join(directory, `${updated}.reached`)
      const script = path.join(directory, `${updated}.nsi`)
      fs.writeFileSync(
        script,
        `\uFEFF
Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${output}"
!include "LogicLib.nsh"
!define LANG_SIMPCHINESE 2052
!define LANG_TRADCHINESE 1028
!define SS_NATIVE_CARRIER
!define APP_EXECUTABLE_FILENAME "${path.basename(launcher)}"
!define isUpdated '$R8 == "1"'
${DIAGNOSTICS}
${macros}
Function .onInit
  StrCpy $INSTDIR "${path.dirname(launcher)}"
  StrCpy $R8 "${updated ? '1' : '0'}"
FunctionEnd
Section
  !insertmacro customUnInstall
  FileOpen $0 "${reached}" w
  FileWrite $0 "safe to remove installed files"
  FileClose $0
  SetErrorLevel 0
SectionEnd
`
      )
      const compiled = spawnSync(path.join(process.env.NSISDIR, 'makensis.exe'), ['/V2', script], {
        encoding: 'utf8',
        timeout: 30000,
        windowsHide: true,
      })
      assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr)
      const run = spawnSync(output, ['/S'], { timeout: 30000, windowsHide: true, stdio: 'ignore' })
      assert.equal(run.error, undefined)
      assert.equal(run.status, 0, `GUI NSIS uninstall failed (updated=${updated})`)
      assert.equal(fs.existsSync(reached), true)
      assert.equal(fs.existsSync(namespace), updated)
    }
  }
)

test(
  'native carrier refuses machine scope before the silent install section',
  {
    skip:
      process.platform !== 'win32' || !process.env.NSISDIR
        ? 'Requires Windows and the packaging NSIS toolchain'
        : false,
  },
  async (t) => {
    const source = fs.readFileSync(path.join(sourceDirectory, '../../resources/installer.nsh'), 'utf8')
    const macros = ['ssLocalizedMessage', 'ssRequireNativeUserScope']
      .map((name) => {
        const match = source.match(new RegExp(`!macro ${name}[^\\r\\n]*[\\s\\S]*?!macroend`))
        assert.ok(match, `missing production macro ${name}`)
        return match[0]
      })
      .join('\n')
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-scope-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    for (const [name, mode, machine, folder, allUsers, expected] of [
      ['new-user', 'CurrentUser', '0', '', '0', 0],
      ['existing-user', 'CurrentUser', '0', '', '0', 0],
      ['inferred-machine', 'all', '1', 'C:\\Program Files\\ScholarSeed', '0', 2],
      ['both-scopes', 'CurrentUser', '1', 'C:\\Program Files\\ScholarSeed', '0', 2],
      ['explicit-user-with-machine', 'CurrentUser', '0', 'C:\\Program Files\\ScholarSeed', '0', 2],
      ['explicit-all-users', 'CurrentUser', '0', '', '1', 2],
      ['unknown-mode', '', '0', '', '0', 2],
    ]) {
      await t.test(name, () => {
        const executable = path.join(directory, `${name}.exe`)
        const reached = path.join(directory, `${name}.reached`)
        const script = path.join(directory, `${name}.nsi`)
        fs.writeFileSync(
          script,
          `\uFEFF
Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${executable}"
!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "WinVer.nsh"
!define LANG_SIMPCHINESE 2052
!define LANG_TRADCHINESE 1028
!define isForAllUsers '$R8 == "1"'
Var installMode
Var hasPerMachineInstallation
Var perMachineInstallationFolder
${DIAGNOSTICS}
${macros}
Function .onInit
  StrCpy $installMode "${mode}"
  StrCpy $hasPerMachineInstallation "${machine}"
  StrCpy $perMachineInstallationFolder "${folder}"
  StrCpy $R8 "${allUsers}"
  !insertmacro ssRequireNativeUserScope
FunctionEnd
Section
  FileOpen $0 "${reached}" w
  FileWrite $0 "install section reached"
  FileClose $0
  SetErrorLevel 0
SectionEnd
`
        )
        const compiled = spawnSync(
          path.join(process.env.NSISDIR, 'makensis.exe'),
          ['/V2', script],
          {
            encoding: 'utf8',
            timeout: 30000,
            windowsHide: true,
          }
        )
        assert.equal(compiled.error, undefined)
        assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr)
        const run = spawnSync(executable, ['/S'], { timeout: 30000, windowsHide: true })
        assert.equal(run.error, undefined)
        assert.equal(run.status, expected)
        assert.equal(fs.existsSync(reached), expected === 0)
      })
    }
  }
)
