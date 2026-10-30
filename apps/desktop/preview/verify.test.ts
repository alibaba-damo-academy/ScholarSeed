import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { verifyProductionPreviewExclusion } from './verify.ts'

function fixture(run: (root: string, options: { outputRoot: string; sourceEntries: string[]; previewRoot: string }) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'preview-exclusion-'))
  const options = { outputRoot: join(root, 'out'), sourceEntries: [join(root, 'source', 'entry.ts')], previewRoot: join(root, 'preview') }
  try {
    for (const directory of ['main', 'preload', 'renderer']) {
      mkdirSync(join(options.outputRoot, directory, 'nested'), { recursive: true })
      writeFileSync(join(options.outputRoot, directory, 'nested', 'entry.js'), 'const preview = "ordinary document preview";')
    }
    mkdirSync(join(root, 'source'))
    mkdirSync(options.previewRoot)
    writeFileSync(options.sourceEntries[0], 'export const value = 1')
    run(root, options)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('recursive exact-output scan tolerates legitimate preview terminology', () => {
  fixture((_root, options) => {
    const report = verifyProductionPreviewExclusion(options)
    assert.equal(report.artifacts.length, 3)
    assert.equal(report.sourceModules.length, 1)
    assert.deepEqual(report.unresolvedDynamicImports, [])
  })
})

test('each precise preview endpoint, console and service marker is rejected in nested JS/HTML/CSS', () => {
  for (const marker of ['/__preview/state', '/__preview/reset', 'scholarseed-preview-console', 'preview_unimplemented', '/preview/entry.tsx', '/preview/service.ts', '/preview/Console.tsx']) {
    for (const extension of ['js', 'html', 'css']) fixture((_root, options) => {
      writeFileSync(join(options.outputRoot, 'renderer', 'nested', `leak.${extension}`), marker)
      assert.throws(() => verifyProductionPreviewExclusion(options), /Preview marker/)
    })
  }
})

test('missing and empty exact output directories fail instead of skipping', () => {
  fixture((_root, options) => {
    rmSync(join(options.outputRoot, 'preload'), { recursive: true })
    assert.throws(() => verifyProductionPreviewExclusion(options), /Missing production output/)
    mkdirSync(join(options.outputRoot, 'preload'))
    assert.throws(() => verifyProductionPreviewExclusion(options), /No JS\/HTML\/CSS/)
  })
})

test('source closure follows nested static, dynamic, re-export and require imports to preview modules', () => {
  for (const statement of ['import "../preview/hidden.ts"', 'export * from "../preview/hidden.ts"', 'import("../preview/hidden.ts")', 'require("../preview/hidden.ts")']) {
    fixture((root, options) => {
      writeFileSync(options.sourceEntries[0], 'import "./nested"')
      writeFileSync(join(root, 'source', 'nested.ts'), statement)
      writeFileSync(join(options.previewRoot, 'hidden.ts'), 'export const hidden = true')
      assert.throws(() => verifyProductionPreviewExclusion(options), /imports preview module/)
    })
  }
})

test('source closure consumes HTML module entries and explicitly reports unresolved computed imports', () => {
  fixture((root, options) => {
    const html = join(root, 'source', 'index.html')
    writeFileSync(html, '<script type="module" src="/entry.ts"></script>')
    writeFileSync(options.sourceEntries[0], 'const path = getPath(); import(path)')
    const report = verifyProductionPreviewExclusion({ ...options, sourceEntries: [html] })
    assert.equal(report.sourceModules.length, 2)
    assert.equal(report.unresolvedDynamicImports.length, 1)
    assert.throws(() => verifyProductionPreviewExclusion({ ...options, sourceEntries: [join(root, 'missing.ts')] }), /Missing production source entry/)
  })
})
