const { timed, timedAsync } = require('../../../../scripts/shared/timing.cjs')
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
  /^__uninstaller-nsis-scholarseed-desktop\.exe$/i,
]

function requiredEnvironment(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`Windows signing requires ${name}`)
  return value
}

function ownedExecutable(filename) {
  const normalized = filename.replaceAll('\\', '/')
  if (normalized.includes('/resources/backend/')) return false
  return SIGNED_NAMES.some((pattern) => pattern.test(path.basename(filename)))
}

function signedExecutables(root, names, found = new Map()) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name)
    if (entry.isDirectory()) {
      signedExecutables(candidate, names, found)
    } else if (names.has(entry.name.toLowerCase())) {
      const name = entry.name.toLowerCase()
      if (!entry.isFile() || found.has(name))
        throw new Error('Windows signing service returned an ambiguous executable')
      found.set(name, candidate)
    }
  }
  return found
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
    'Subject = [string]$signature.SignerCertificate.Subject } | ConvertTo-Json -Compress',
  ].join(' ')
  const output = run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, SCHOLARSEED_SIGNED_FILE: filename },
  })
  const signature = JSON.parse(output)
  if (signature.Status !== 'Valid' || signature.Subject !== publisher) {
    throw new Error(
      `Windows signature differs from the configured publisher: ${signature.Status} ${signature.Subject}`
    )
  }
  return { publisher: signature.Subject, authenticode: 'valid' }
}

async function sign(configuration) {
  const filename = path.resolve(configuration.path)
  if (!ownedExecutable(filename)) return
  return signFile(filename)
}

// The build owner also signs the exact native updater before freezing its final
// hash. Generic electron-builder callbacks still use the ownership filter above.
async function signFile(filename) {
  return signFiles([filename])
}

async function signFiles(filenames) {
  if (!Array.isArray(filenames) || !filenames.length ||
      filenames.some(filename => typeof filename !== 'string' || !filename))
    throw new Error('Windows signing requires a non-empty file list')
  const files = filenames.map((filename, index) => {
    const extension = path.extname(filename)
    if (!/^\.[a-z0-9]+$/i.test(extension))
      throw new Error('Windows signing requires an ASCII executable extension')
    // The remote service decodes filenames through a legacy code page. Keep
    // transport names ASCII and unique; restore caller paths only after verification.
    return { filename: path.resolve(filename), name: `payload-${index}${extension}` }
  })
  const originalNames = new Set(filenames.map(filename => path.basename(filename).toLowerCase()))
  if (originalNames.size !== files.length)
    throw new Error('Windows signing requires unique executable names')
  const names = new Set(files.map(file => file.name.toLowerCase()))
  return timedAsync(files.length === 1 ? `sign.${path.basename(files[0].filename)}` : 'sign.batch',
    () => signFilesMeasured(files, names))
}

async function signFilesMeasured(files, names) {
  const client = requiredEnvironment(SIGN_CLIENT_ENV)
  const clientDirectory = path.dirname(client)
  const server = requiredEnvironment(SIGN_SERVER_ENV)
  const user = requiredEnvironment(SIGN_USER_ENV)
  const key = requiredEnvironment(SIGN_KEY_ENV)
  const domain = requiredEnvironment(SIGN_DOMAIN_ENV)
  const publisher = requiredEnvironment(SIGN_PUBLISHER_ENV)
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-sign-'))
  const payload = path.join(temporary, 'payload')
  const returned = path.join(temporary, 'returned')
  try {
    fs.mkdirSync(payload)
    for (const { filename, name } of files) fs.copyFileSync(filename, path.join(payload, name))
    for (const dependency of ['curl.exe', '7z.exe', '7z.dll']) {
      const source = path.join(clientDirectory, dependency)
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(temporary, dependency))
    }
    const archive = path.join(temporary, 'signed.zip')
    timed('sign.remote', () => run(
      client,
      [
        '-s',
        server,
        '-u',
        user,
        '-k',
        key,
        '-t',
        domain,
        '-T',
        'sha256s',
        '-d',
        path.basename(payload),
        '-n',
        path.basename(archive),
      ],
      { cwd: temporary }
    ))
    fs.rmSync(payload, { recursive: true })
    fs.mkdirSync(returned)
    run(
      POWERSHELL,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Expand-Archive -LiteralPath $env:SCHOLARSEED_SIGN_ARCHIVE -DestinationPath $env:SCHOLARSEED_SIGN_OUTPUT -Force',
      ],
      {
        env: {
          ...process.env,
          SCHOLARSEED_SIGN_ARCHIVE: archive,
          SCHOLARSEED_SIGN_OUTPUT: returned,
        },
      }
    )
    const sources = signedExecutables(returned, names)
    if (sources.size !== files.length) {
      throw new Error('Windows signing service returned no matching executable')
    }
    // Validate the complete batch before replacing any compiler output.
    for (const source of sources.values()) verify(source, publisher)
    for (const { filename, name } of files) {
      fs.copyFileSync(sources.get(name.toLowerCase()), filename)
      verify(filename, publisher)
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

module.exports = sign
module.exports.ownedExecutable = ownedExecutable
module.exports.verify = verify
module.exports.signFile = signFile
module.exports.signFiles = signFiles
