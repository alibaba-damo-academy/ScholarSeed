import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'
import test from 'node:test'

const require = createRequire(import.meta.url)

function runElectronProbe(root: string, entryPoint: string, probe: string): void {
  const bundle = join(root, 'probe.cjs')
  require('esbuild').buildSync({
    entryPoints: [fileURLToPath(new URL(entryPoint, import.meta.url))],
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
    const subject = require(${JSON.stringify(bundle)});
    app.setPath('userData', ${JSON.stringify(join(root, 'user-data'))});
    app.whenReady().then(async () => {
      ${probe}
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
}

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
    runElectronProbe(
      root,
      './update-files.ts',
      `
      if (!fs.statSync(${JSON.stringify(join(stage, 'app.asar'))}).isDirectory()) throw Error('ASAR wrapper not active');
      await subject.removeUpdateArtifact(${JSON.stringify(stage)});
      `
    )
    assert.equal(existsSync(stage), false)
    assert.equal(existsSync(outside), true)
  }
)

test(
  'real macOS Electron measures the ASAR file and verifies its complete bytes in a cached ZIP',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'scholarseed-archive-files-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const source = join(root, 'source')
    const application = join(root, 'ScholarSeed.app')
    const archive = join(root, 'application.zip')
    const asar = join(application, 'app.asar')
    mkdirSync(source)
    mkdirSync(application)
    writeFileSync(join(source, 'index.js'), 'module.exports = 1')
    await require('@electron/asar').createPackage(source, asar)
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--keepParent', application, archive])

    runElectronProbe(
      root,
      './archive.ts',
      `
      const assert = require('node:assert/strict');
      const physical = require('original-fs');
      const application = ${JSON.stringify(application)};
      const archive = ${JSON.stringify(archive)};
      const asar = ${JSON.stringify(asar)};
      const mounted = { path: application, fs: physical.promises };
      assert.equal((await fs.promises.lstat(asar)).isDirectory(), true);
      assert.equal(physical.lstatSync(asar).isFile(), true);
      const expected = physical.statSync(asar).size;
      const results = await Promise.allSettled([
        subject.preflightApplicationArchive(mounted).then(budget => {
          assert.equal(budget.entries, 2);
          assert.equal(budget.expanded, expected);
        }),
        subject.verifyApplicationArchive(archive, undefined, mounted).then(budget => {
          assert.equal(budget.entries, 2);
          assert.equal(budget.expanded, expected);
        })
      ]);
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason));

      const bytes = physical.readFileSync(asar);
      bytes[bytes.length - 1] ^= 1;
      physical.writeFileSync(asar, bytes);
      await assert.rejects(
        subject.verifyApplicationArchive(archive, undefined, mounted),
        subject.UpdateArchiveSourceMismatch
      );
      `
    )
  }
)
