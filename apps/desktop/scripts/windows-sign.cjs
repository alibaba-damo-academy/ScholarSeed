const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const SIGN_CLIENT_ENV = 'SCHOLARSEED_WINDOWS_SIGN_CLIENT'
const SIGN_SERVER_ENV = 'SCHOLARSEED_WINDOWS_SIGN_SERVER'
const SIGN_USER_ENV = 'SCHOLARSEED_WINDOWS_SIGN_USER'
const SIGN_KEY_ENV = 'SCHOLARSEED_WINDOWS_SIGN_KEY'
const SIGN_DOMAIN_ENV = 'SCHOLARSEED_WINDOWS_SIGN_DOMAIN'
const SIGN_PUBLISHER_ENV = 'SCHOLARSEED_WINDOWS_SIGN_PUBLISHER'
const POWERSHELL = 'powershell.exe'
const SIGNED_NAMES = [
  /^ScholarSeed\.exe$/i,
  /^scholarseed-.*\.exe$/i,
  /^__uninstaller-nsis-scholarseed-desktop\.exe$/i
]

function requiredEnvironment(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`Windows signing requires ${name}`)
  return value
}

function ownedExecutable(filename) {
  const normalized = filename.replaceAll('\\', '/')
  if (normalized.includes('/resources/backend/')) return false
  return SIGNED_NAMES.some(pattern => pattern.test(path.basename(filename)))
}

function signedExecutable(root, name) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = signedExecutable(candidate, name)
      if (nested) return nested
    } else if (entry.isFile() && entry.name === name) {
      return candidate
    }
  }
  return null
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, ...options })
  if (result.error || result.status !== 0) {
    throw new Error(`Windows signing command failed: ${result.error || result.status}`)
  }
  return String(result.stdout || '').trim()
}

function verify(filename, publisher) {
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:SCHOLARSEED_SIGNED_FILE;',
    '[PSCustomObject]@{ Status = [string]$signature.Status;',
    'Subject = [string]$signature.SignerCertificate.Subject } | ConvertTo-Json -Compress'
  ].join(' ')
  const output = run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, SCHOLARSEED_SIGNED_FILE: filename }
  })
  const signature = JSON.parse(output)
  if (signature.Status !== 'Valid' || signature.Subject !== publisher) {
    throw new Error(`Windows signature differs from the configured publisher: ${signature.Status} ${signature.Subject}`)
  }
  return { publisher: signature.Subject, authenticode: 'valid' }
}

async function sign(configuration) {
  const filename = path.resolve(configuration.path)
  if (!ownedExecutable(filename)) return
  const client = requiredEnvironment(SIGN_CLIENT_ENV)
  const clientDirectory = path.dirname(client)
  const server = requiredEnvironment(SIGN_SERVER_ENV)
  const user = requiredEnvironment(SIGN_USER_ENV)
  const key = requiredEnvironment(SIGN_KEY_ENV)
  const domain = requiredEnvironment(SIGN_DOMAIN_ENV)
  const publisher = requiredEnvironment(SIGN_PUBLISHER_ENV)
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-sign-'))
  const original = path.join(temporary, `unsigned-${path.basename(filename)}`)
  const payload = path.join(temporary, 'payload')
  const input = path.join(payload, path.basename(filename))
  try {
    fs.mkdirSync(payload)
    fs.copyFileSync(filename, original)
    fs.copyFileSync(filename, input)
    for (const dependency of ['curl.exe', '7z.exe', '7z.dll']) {
      const source = path.join(clientDirectory, dependency)
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(temporary, dependency))
    }
    const archive = path.join(temporary, 'signed.zip')
    run(client, ['-s', server, '-u', user, '-k', key, '-t', domain,
      '-T', 'sha256s', '-d', path.basename(payload), '-n', path.basename(archive)], { cwd: temporary })
    fs.rmSync(input)
    run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:SCHOLARSEED_SIGN_ARCHIVE -DestinationPath $env:SCHOLARSEED_SIGN_OUTPUT -Force'], {
      env: { ...process.env, SCHOLARSEED_SIGN_ARCHIVE: archive, SCHOLARSEED_SIGN_OUTPUT: temporary }
    })
    const source = signedExecutable(path.join(temporary, 'payload'), path.basename(filename))
    if (!source || source === original) {
      throw new Error('Windows signing service returned no matching executable')
    }
    verify(source, publisher)
    fs.copyFileSync(source, filename)
    verify(filename, publisher)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

module.exports = sign
module.exports.ownedExecutable = ownedExecutable
module.exports.verify = verify
