import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import test from 'node:test'

import { hasDirtyReviewEditor } from './api.ts'

import {
  openReviewTab,
  parseReviewTab,
  reviewTab
} from '../workbench/tabs.ts'

const apiSource = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
const featureSource = readFileSync(new URL('./feature.tsx', import.meta.url), 'utf8')
const batchSource = readFileSync(new URL('./ReviewBatch.tsx', import.meta.url), 'utf8')
const cardSource = readFileSync(new URL('./ReviewCard.tsx', import.meta.url), 'utf8')
const barSource = readFileSync(new URL('../workbench/ReviewBar.tsx', import.meta.url), 'utf8')
const diffSource = readFileSync(new URL('../workbench/ReviewDiff.tsx', import.meta.url), 'utf8')
const sharedDiffSource = readFileSync(new URL('../workbench/Diff.tsx', import.meta.url), 'utf8')
const liveSource = readFileSync(new URL('../../live.ts', import.meta.url), 'utf8')
const composerSource = readFileSync(new URL('../../components/business/Composer.tsx', import.meta.url), 'utf8')
const resourcePanelSource = readFileSync(new URL('./ResourcePanel.tsx', import.meta.url), 'utf8')

test('review tab keeps project and batch identities without collisions', () => {
  const tab = reviewTab('project / 甲', 'batch:1', 3)
  assert.deepEqual(parseReviewTab(tab.id), { projectId: 'project / 甲', batchId: 'batch:1' })
  assert.equal(tab.kind, 'review')
  assert.equal(tab.title, '审阅修改 · 3')
  assert.deepEqual(openReviewTab([tab], 'project / 甲', 'batch:1', 3), [tab])
})

test('batch API uses durable review endpoints and idempotent decisions', () => {
  assert.match(apiSource, /\/api\/resource\/review-batches\?/)
  assert.match(apiSource, /\/api\/resource\/review-batches\/\$\{encodeURIComponent\(batchId\)\}/)
  assert.match(apiSource, /\/members\/\$\{encodeURIComponent\(fileId\)\}\/\$\{side\}/)
  assert.match(apiSource, /Idempotency-Key/)
  assert.match(apiSource, /commit/)
  assert.match(apiSource, /decisions: decisions\.map/)
})

test('turn admission probes unfinished members from open and failed batches', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://test' }
  } as Window & typeof globalThis
  const requestedStates: string[] = []
  const requestedProjects: string[] = []
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    const state = url.searchParams.get('state') ?? ''
    requestedStates.push(state)
    requestedProjects.push(url.searchParams.get('project') ?? '')
    return Response.json({
      items: state === 'failed'
        ? [{
            id: 'batch-1',
            members: [{ file_id: 'file-1', path: 'notes.txt', state: 'failed' }]
          }]
        : [],
      next_cursor: null
    })
  }
  try {
    const dirty = await hasDirtyReviewEditor(
      'project-id',
      '/project/path',
      (project, fileId, paths) => (
        project === '/project/path' && fileId === 'file-1' && paths[0] === 'notes.txt'
      )
    )
    assert.equal(dirty, true)
    assert.deepEqual(requestedStates.sort(), ['applying', 'failed', 'open'])
    assert.deepEqual(requestedProjects, ['project-id', 'project-id', 'project-id'])
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('resources contributes the review viewer and uses the shared review surface', () => {
  assert.match(featureSource, /kind: 'review'/)
  assert.match(featureSource, /<ReviewBatch/)
  assert.match(batchSource, /<ReviewBar/)
  assert.match(batchSource, /<ReviewDiff/)
  assert.match(batchSource, /<OfficeDocument/)
  assert.match(batchSource, /setBatch\(null\)/)
  assert.match(batchSource, /selected\?\.review_id/)
  assert.match(batchSource, /act\.invalidateResources\(\)/)
  assert.match(batchSource, /act\.completeResourceReview\(tabId, \{/)
  assert.match(batchSource, /path: selected\?\.path \?\? batch\.members\[0\]\.path/)
  assert.match(batchSource, /documentTabId/)
  assert.match(liveSource, /case 'review_ready':/)
  assert.match(liveSource, /projectReviewReadyEvent\(thread\.conversation, event\)/)
})

test('root resource drop keeps the tree readable while showing an explicit target', () => {
  assert.match(
    resourcePanelSource,
    /dropTarget === RESOURCE_ROOT_DIRECTORY[\s\S]{0,300}after:ring-2/
  )
  assert.match(
    resourcePanelSource,
    /dropTarget === RESOURCE_ROOT_DIRECTORY[\s\S]{0,300}after:ring-inset/
  )
  assert.match(
    resourcePanelSource,
    /dropTarget === RESOURCE_ROOT_DIRECTORY[\s\S]{0,300}after:z-\[var\(--vds-z-content\)\]/
  )
  assert.doesNotMatch(
    resourcePanelSource,
    /dropTarget === RESOURCE_ROOT_DIRECTORY[\s\S]{0,300}bg-\[/
  )
})

test('resource file rows resolve drag drops to their parent folder', () => {
  assert.match(resourcePanelSource, /resourceDropDirectory\(/)
  assert.match(resourcePanelSource, /void act\.moveResourceNode\(source, targetDir\)/)
  assert.doesNotMatch(resourcePanelSource, /if \(node\.kind !== 'dir'\) return/)
})

test('resource drop highlights stay inside the scrollable tree bounds', () => {
  assert.match(
    resourcePanelSource,
    /!bg-\[var\(--vds-accent-light-bg-default\)\] ring-2 ring-inset ring-\[var\(--vds-accent-light-border\)\]/
  )
  assert.doesNotMatch(
    resourcePanelSource,
    /outline-2 outline-offset-1 outline-\[var\(--vds-accent-light-border\)\]/
  )
})

test('review surfaces identify agent and external changes', () => {
  assert.match(apiSource, /origin: 'agent' \| 'external'/)
  assertLocalized(cardSource, "resources", "reviewOrigin.agent", ["Agent 改动", "Agent changes"])
  assertLocalized(cardSource, "resources", "reviewOrigin.external", ["外部改动", "External changes"])
  assertLocalized(batchSource, "resources", "reviewBatch.agent", ["Agent 改动", "Agent changes"])
  assertLocalized(batchSource, "resources", "reviewBatch.external", ["外部改动", "External changes"])
})

test('review card refreshes from the durable batch and replaces pending controls at completion', () => {
  assert.match(cardSource, /state\.resourceRevision/)
  assert.match(cardSource, /batch\.state === 'completed'/)
  assert.match(cardSource, /reviewOutcome\(batch\)/)
  assert.match(cardSource, /reviewCard\.outcome/)
  assert.match(cardSource, /!completed\s*\? <CardFooter/)
  assert.match(composerSource, /act\.invalidateResources\(\)/)
})

test('review UI stages editable decisions and commits only after all files are decided', () => {
  assert.match(sharedDiffSource, /createDiffEditor/)
  assert.match(sharedDiffSource, /originalEditable: false/)
  assert.match(diffSource, /readOnly=\{false\}/)
  assert.match(diffSource, /workspace\.updateText/)
  assert.match(barSource, /AlertDialog/)
  assertLocalized(barSource, "workbench", "review.undoAll", ["撤销全部", "Undo all"])
  assertLocalized(barSource, "workbench", "review.acceptAll", ["接受全部", "Accept all"])
  assertLocalized(barSource, "workbench", "review.rejectAll", ["拒绝全部", "Reject all"])
  assertLocalized(barSource, "workbench", "review.submit", ["提交", "Submit"])
  assert.match(barSource, /review\.outcomeProgress/)
  assert.match(batchSource, /reviewProgress\(/)
  assert.doesNotMatch(barSource, /拒绝本批次剩余修改/)
  assert.match(batchSource, /reviewDraftStore/)
  assert.match(batchSource, /decidedCount/)
  assert.match(batchSource, /fetchReviewMemberCurrent/)
  assertLocalized(batchSource, "resources", "reviewBatch.changed", ["文件在 Agent 完成后又发生了变化", "Files changed after the Agent finished"])
  assert.match(batchSource, /loadedCurrentFileId === selected\.file_id/)
  assert.match(barSource, /data-testid="review-batch-actions"/)
  assert.match(barSource, /data-testid="review-file-actions"/)
  assert.doesNotMatch(resourcePanelSource, /PendingResources|待保存与审阅/)
  assert.doesNotMatch(`${batchSource}\n${barSource}\n${diffSource}`, /<(?:button|input|select|textarea|table)\b/)
})

test('a new turn accepts unfinished review batches without interrupting the user', () => {
  assert.match(composerSource, /unfinishedReviewBatches/)
  assert.match(composerSource, /acceptReviewBatches/)
  assert.match(composerSource, /fetchReviewMemberCurrent/)
  assert.match(composerSource, /member\.action \?\? 'accept'/)
  assert.match(composerSource, /: 'accept'/)
  assert.doesNotMatch(composerSource, /ReviewAdmission/)
  assert.doesNotMatch(composerSource, /acceptOpen|accept_open/)
})


function assertLocalized(source: string, namespace: string, key: string, expected: string[]): void {
  assert.ok(source.includes(`'${key}'`), `source binds ${namespace}:${key}`)
  const labels = ['zh', 'en'].map(language => {
    const resource = JSON.parse(readFileSync(new URL(`../../../../localization/locales/${language}/${namespace}.json`, import.meta.url), 'utf8'))
    return key.split('.').reduce((value, part) => value[part], resource)
  })
  assert.deepEqual(labels, expected)
}


test('completed file decisions are disabled while unfinished batch can still submit', async () => {
  const desktop = new URL('../../../../../', import.meta.url).pathname
  const directory = mkdtempSync(join(desktop, 'node_modules/.review-bar-'))
  try {
    const output = join(directory, 'contract.mjs')
    await build({
      stdin: { contents: `
        import React from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { I18nextProvider } from 'react-i18next';
        import { createLocalization } from './src/localization/engine';
        import { resources } from './src/localization/resources';
        import { ReviewBar } from './src/renderer/src/features/workbench/ReviewBar';
        export function render(selectedEnabled, decisionsEnabled) {
          const engine = createLocalization('en', resources);
          return renderToStaticMarkup(React.createElement(I18nextProvider, {i18n: engine},
            React.createElement(ReviewBar, {busy: false, decided: 1, total: 1, hasEdits: false,
              selectedAction: 'reject', reviseEnabled: true, selectedEnabled, decisionsEnabled,
              onChoose() {}, onUndoAll() {}, onBulk() {}, onSubmit() {}})));
        }
      `, resolveDir: desktop, loader: 'ts' },
      outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.png': 'dataurl' },
      plugins: [{ name: 'styles', setup(builder) {
        builder.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: 'styles' }))
        builder.onLoad({ filter: /.*/, namespace: 'styles' }, () => ({ contents: '', loader: 'js' }))
      } }]
    })
    const { render } = await import(pathToFileURL(output).href)
    const buttons = (html: string): Map<string, boolean> => new Map(
      [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(match => [
        match[2].replace(/<[^>]*>/g, ''), /\bdisabled(?:=|\s|$)/.test(match[1])
      ])
    )
    const completed = buttons(render(false, false))
    for (const label of ['Accept', 'Reject', 'Revise', 'Accept all', 'Reject all', 'Undo all']) {
      assert.equal(completed.get(label), true, `${label} is disabled for completed members`)
    }
    assert.equal(completed.get('Submit'), false, 'batch recovery can still submit')
    const pending = buttons(render(true, true))
    for (const label of ['Accept', 'Reject', 'Revise', 'Accept all', 'Reject all', 'Undo all']) {
      assert.equal(pending.get(label), false, `${label} remains available for unfinished members`)
    }
    const mixed = buttons(render(false, true))
    assert.equal(mixed.get('Accept'), true)
    assert.equal(mixed.get('Accept all'), false)
    assert.match(batchSource, /selectedEnabled=\{Boolean\(selected && selected.state !== 'completed'\)\}/)
    assert.match(batchSource, /decisionsEnabled=\{batch.members.some\(\(member\) => member.state !== 'completed'\)\}/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
