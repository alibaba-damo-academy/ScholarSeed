// Finalize current installer evidence and serialize Windows product probes.
const path = require('node:path')
const { spawn } = require('node:child_process')
const { AsyncLocalStorage } = require('node:async_hooks')
const { timedAsync } = require('../../../../scripts/shared/timing.cjs')
function finalResult(base, app, installer, velopack, runtime) {
  if (base.stage === 'dmg' && (installer?.installed_check?.status !== 'passed' ||
      installer.installed_check.source !== 'mounted-dmg' || !installer.installed_check.detached ||
      installer.installed_check.sha256 !== installer.sha256 || !installer.signature_valid ||
      !installer.installed_check.package_check?.ok)) throw new Error('Final DMG acceptance is incomplete')
  if (base.stage === 'velopack' && (!velopack || !installer?.installed_check?.ok || !installer.installed_check.retirement?.complete || !app?.package_check?.ok)) throw new Error('Velopack installed acceptance is incomplete')
  if (base.stage === 'velopack' && base.publishable && (!velopack.signed || !installer.signature_valid || !app.signature_valid)) throw new Error('Velopack distribution requires signed artifacts')
  if (base.stage === 'velopack' && (!runtime?.manifest_path || !runtime.components?.length)) throw new Error('Velopack runtime delivery artifacts are incomplete')
  return {...base,status:'passed',artifacts:{app,...(installer?{[base.stage==='dmg'?'dmg':'exe']:installer}:{}),
    ...(velopack?{velopack}:{}), ...(runtime?{runtime}:{})},trust:{...base.trust,...(base.stage === 'dmg' ? installer?.trust : app?.trust)}}
}
const MUTEX_TIMEOUT_MS = 30_000
const VERIFICATION_WAIT_MS = 30 * 60_000
const verificationLease = new AsyncLocalStorage()

// Windows installer probes share account-level installation state. Nested
// installed checks retain the outer lease through application exit and uninstall.
async function withVerificationMutex(action) {
  if (process.platform !== 'win32' || verificationLease.getStore()?.active) return action()
  const release = await timedAsync('verification.lock', () => installationMutex(VERIFICATION_WAIT_MS))
  const lease = { active: true }
  return verificationLease.run(lease, async () => {
    try { return await action() }
    finally { lease.active = false; await release() }
  })
}

async function installationMutex(waitMilliseconds = 0) {
  if(process.platform!=='win32') throw new Error('installation acceptance mutex requires Windows')
  if (!Number.isSafeInteger(waitMilliseconds) || waitMilliseconds < 0 || waitMilliseconds > VERIFICATION_WAIT_MS)
    throw new Error('invalid verification mutex wait')
  const child=spawn(path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),
    ['-NoProfile','-NonInteractive','-File',path.join(__dirname, 'installation-mutex.ps1'),
      '-WaitMilliseconds', String(waitMilliseconds), '-ParentProcessId', String(process.pid)],
    {stdio:['pipe','pipe','pipe'],windowsHide:true})
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error('installation mutex helper timed out'))},MUTEX_TIMEOUT_MS + waitMilliseconds)
    let output=''
    const fail=error=>{clearTimeout(timer);reject(error)}
    child.once('error',fail)
    child.once('exit',code=>fail(new Error(`installation acceptance is busy or mutex unavailable (code=${code}); retry when it finishes`)))
    child.stdout.on('data',data=>{
      output+=data.toString('utf8')
      if(output.trim()==='ready'){clearTimeout(timer);resolve()}
      else if(output.length>1024){child.kill();fail(new Error('invalid installation mutex helper response'))}
    })
    // Consume helper diagnostics; no inherited environment or credentials are printed.
    child.stderr.resume()
  })
  return async()=>{
    const exited=new Promise((resolve,reject)=>{
      if(child.exitCode!==null)return child.exitCode===0?resolve():reject(new Error('installation mutex helper exited unexpectedly'))
      child.once('exit',code=>code===0?resolve():reject(new Error('installation mutex release failed')))
    })
    child.stdin.end('release\n')
    await exited
  }
}
module.exports = { installationMutex, withVerificationMutex, finalResult }
