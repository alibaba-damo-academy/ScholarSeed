const fs = require('node:fs')
const path = require('node:path')
const { ensureArtifact } = require('./artifacts.cjs')

const MANIFEST = path.join('scripts', 'vendor', 'ripgrep', 'manifest.json')
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const ARCH_ALIASES = { x86_64: 'x64' }

function ripgrepRelease(repo, platform = process.platform, arch = process.arch) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, MANIFEST), 'utf8'))
  const key = `${platform}-${ARCH_ALIASES[arch] || arch}`
  const selected = manifest.targets?.[key]
  if (!VERSION_PATTERN.test(manifest.version) || !selected ||
      !SHA256_PATTERN.test(selected.sha256) || typeof selected.url !== 'string' ||
      !Number.isSafeInteger(selected.bytes) || selected.bytes <= 0) {
    throw new Error(`no reviewed ripgrep distribution for ${key}`)
  }
  return {
    ...selected,
    key,
    version: manifest.version,
    executable: path.join(repo, 'scripts', 'vendor', 'ripgrep', selected.triple, selected.file),
    mode: platform === 'win32' ? 0o600 : 0o755
  }
}

async function ensureRipgrep(repo, platform = process.platform, arch = process.arch) {
  const selected = ripgrepRelease(repo, platform, arch)
  await ensureArtifact(selected.executable, selected)
  return selected
}

module.exports = { ensureRipgrep, ripgrepRelease }
