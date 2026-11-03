#!/usr/bin/env node
// Rebuild the platform-neutral generator with the pinned Emscripten SDK on PATH.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { ensureArtifact } = require('../../../../scripts/shared/artifacts.cjs')

async function build() {
  const desktop = path.resolve(__dirname, '../..')
  const source = path.join(desktop, 'native', 'fontconfig')
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'sources.json')))
  const version = execFileSync('emcc', ['--version'], { encoding: 'utf8' })
  if (!version.split('\n')[0].includes(` ${manifest.emscripten.version} `))
    throw new Error('Use the pinned Emscripten SDK')
  for (const [name, sha256] of Object.entries(manifest.patches)) {
    if (
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(source, 'patches', name)))
        .digest('hex') !== sha256
    )
      throw new Error(`Patch digest mismatch: ${name}`)
  }
  const parent = path.resolve(desktop, '../../tmp/repos/fontconfig-builds')
  fs.mkdirSync(parent, { recursive: true })
  const directory = fs.mkdtempSync(path.join(parent, 'build-'))
  for (const archive of manifest.archives) {
    const filename = path.join(directory, archive.name)
    await ensureArtifact(filename, archive)
    execFileSync('tar', ['xf', filename, '-C', directory], { stdio: 'inherit' })
  }
  execFileSync('bash', [path.join(source, 'build.sh'), source, directory], { stdio: 'inherit' })
  // Build output is reviewable; publishing it into public/ is a separate explicit copy.
  console.log(
    JSON.stringify(
      {
        directory,
        files: ['fontcache.js', 'fontcache.wasm'].map((name) => {
          const bytes = fs.readFileSync(path.join(directory, name))
          return {
            name,
            bytes: bytes.length,
            sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          }
        }),
      },
      null,
      2
    )
  )
}
build().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
