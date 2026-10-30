import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const require = createRequire(import.meta.url)

test(
  'real Electron removes candidate ASAR files without following symlinks or disabling ASAR globally',
  {
    skip: process.platform === 'linux' && !process.env.DISPLAY,
  },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'scholarseed-update-files-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const source = join(root, 'source')
    const stage = join(root, 'ScholarSeed.app')
    const outside = join(root, 'retained')
    mkdirSync(source)
    mkdirSync(stage)
    writeFileSync(join(source, 'index.js'), 'module.exports = 1')
    writeFileSync(outside, 'retain')
    await require('@electron/asar').createPackage(source, join(stage, 'app.asar'))
    if (process.platform !== 'win32') symlinkSync(outside, join(stage, 'linked-file'))
    const bundle = join(root, 'cleanup.cjs')
    require('esbuild').buildSync({
      entryPoints: [fileURLToPath(new URL('./update-files.ts', import.meta.url))],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['original-fs'],
    })
    const script = join(root, 'run.cjs')
    writeFileSync(
      script,
      `
    const { app } = require('electron');
    const fs = require('node:fs');
    const { removeUpdateArtifact } = require(${JSON.stringify(bundle)});
    app.whenReady().then(async () => {
      if (!fs.statSync(${JSON.stringify(join(stage, 'app.asar'))}).isDirectory()) throw Error('ASAR wrapper not active');
      await removeUpdateArtifact(${JSON.stringify(stage)});
      if (process.noAsar) throw Error('global ASAR support disabled');
      app.quit();
    }).catch(error => { console.error(error); app.exit(1); });
  `
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawnSync(require('electron'), [script], {
      env,
      encoding: 'utf8',
      timeout: 30_000,
    })
    assert.equal(child.status, 0, child.stderr || String(child.error))
    assert.equal(existsSync(stage), false)
    assert.equal(existsSync(outside), true)
  }
)
