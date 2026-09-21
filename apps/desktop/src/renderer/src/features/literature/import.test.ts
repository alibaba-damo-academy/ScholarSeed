import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { importLiteratureAttachment, previewAttachmentImport } from './api.ts'
import { claimSubmission } from './submission.ts'

const importSource = readFileSync(new URL('./Import.tsx', import.meta.url), 'utf8')

test('generic attachments import without exposing PDF record controls', () => {
  assert.match(importSource, /const supportsRecords = attachment\.media_type === PDF_MEDIA_TYPE/)
  assert.match(importSource, /copy_records: supportsRecords && copyRecords/)
  assert.match(importSource, /recordControls = supportsRecords \? <div><Checkbox data-testid="literature-copy-records"/)
  assert.match(importSource, /fileSuffix\(node\.name\) === sourceSuffix\s*&&/)
  assert.match(importSource, /const AttachmentIcon = fileIconForName\(attachment\.name\)/)
  assert.match(importSource, /<AttachmentIcon[\s\S]*?\{attachment\.name\}/)
  assert.doesNotMatch(importSource, /t\('import\.pdf'\)/)
  // 附件导入只有拷贝这一种取向: 链接会让项目资源指着文献库里的路径, 文献一删就悬空。
  assert.doesNotMatch(importSource, /MODE\.link|link_records|linkRecords/)
})

test('attachment submission gate accepts one request and rejects concurrent retries', () => {
  const gate = { current: false }
  assert.equal(claimSubmission(gate), true)
  assert.equal(claimSubmission(gate), false)
  assert.equal(gate.current, true)
})

test('attachment execution freezes destination, revisions and retry identity from preflight', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  const observed: RequestInit[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { href: 'http://desktop.test/' }, scholarseed: { getApiBase: () => 'http://service.test' }
  } })
  const preview = { status: 'preview' as const, path: 'resources/papers/target.pdf', token: 'frozen', conflict: true,
    can_replace: true, source_record_revision: 'source-revision', target_record_revision: 'target-revision' }
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /literatures\/paper%201\/attachments\/attachment%201\/import-to-project$/)
    observed.push(init ?? {})
    return Response.json(observed.length === 1 ? preview : { status: 'completed', path: preview.path })
  }
  try {
    const options = { project: 'project', parent: 'resources/papers', name: 'source.pdf',
      replace_path: preview.path, copy_records: false, replace_records: false }
    const planned = await previewAttachmentImport('paper 1', 'attachment 1', options)
    await importLiteratureAttachment('paper 1', 'attachment 1', options, planned, 'retry-key')
    await importLiteratureAttachment('paper 1', 'attachment 1', options, planned, 'retry-key')
    assert.deepEqual(JSON.parse(String(observed[0].body)), { ...options, preview: true })
    assert.deepEqual(JSON.parse(String(observed[1].body)), { ...options, preview: false, token: 'frozen',
      source_record_revision: 'source-revision', target_record_revision: 'target-revision' })
    assert.equal(new Headers(observed[1].headers).get('Idempotency-Key'), 'retry-key')
    assert.deepEqual(observed[1], observed[2])
  } finally {
    globalThis.fetch = previousFetch
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})
