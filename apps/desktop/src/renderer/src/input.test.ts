import assert from 'node:assert/strict'
import test from 'node:test'
import { createInstance, type TFunction } from 'i18next'
import zh from '../../localization/locales/zh/assistant.json' with { type: 'json' }
import en from '../../localization/locales/en/assistant.json' with { type: 'json' }

import { buildSessionOpenRequest } from './api.ts'
import {
  buildTurnInput,
  canSubmitComposer,
  composerSubmissionOutcome,
  isComposerSubmissionAccepted,
  composerObscured,
  composerTrigger,
  describeTurnAdmissionFailure,
  queuedReferenceLabel,
  queuedReferenceSummary,
  replaceComposerTrigger,
  turnAdmissionFeedback
} from './input.ts'

const translate = ((key: string, values?: { name?: string }) => (
  values?.name ? `${key}:${values.name}` : key
)) as TFunction<'components'>

test('at and slash shortcuts share candidate queries without matching emails or paths', () => {
  for (const [text, query] of [
    ['@', ''], ['@文献', '文献'], ['@skill:pdf', 'skill:pdf'],
    ['/', 'skill:'], ['/pdf', 'skill:pdf'], ['请使用 /pdf', 'skill:pdf'],
    ['引用 @file:papers/method.md', 'file:papers/method.md']
  ]) assert.equal(composerTrigger(text)?.query, query)
  for (const text of ['a@example.com', 'https://example.com/', '/tmp/papers/', 'a/b', '/pdf ']) {
    assert.equal(composerTrigger(text), null, text)
  }
})

test('selecting a shortcut removes only the trigger and preserves the draft', () => {
  assert.equal(replaceComposerTrigger('请分析 /pdf', ''), '请分析 ')
  assert.equal(replaceComposerTrigger('/', ''), '')
  assert.equal(replaceComposerTrigger('引用 @', '@file:'), '引用 @file:')
  assert.equal(replaceComposerTrigger('@file:papers/', '@file:papers/sub/'), '@file:papers/sub/')
  assert.equal(replaceComposerTrigger('普通文本', ''), '普通文本')
})

test('workbench overlays hide only the background conversation picker, never the adjacent assistant', () => {
  for (const capabilities of [false, true]) {
    for (const files of [false, true]) {
      for (const documents of [false, true]) {
        const overlays = { capabilities, files, documents }
        assert.equal(composerObscured('assistant', overlays), false)
        assert.equal(composerObscured('workbench', overlays), false)
        assert.equal(composerObscured('conversation', overlays), capabilities || files || documents)
      }
    }
  }
})

test('admits running submissions into the queue while preserving launch and interrupt barriers', () => {
  const idle = {
    runtimeReady: true,
    creditsAvailable: true,
    modelAvailable: true,
    launching: false,
    running: false,
    interrupting: false,
    hasContent: true
  }
  assert.equal(canSubmitComposer(idle), true)
  assert.equal(canSubmitComposer({ ...idle, running: true }), true)
  assert.equal(canSubmitComposer({ ...idle, interrupting: true }), false)
  assert.equal(canSubmitComposer({ ...idle, launching: true }), false)
  assert.equal(canSubmitComposer({ ...idle, runtimeReady: false }), false)
  assert.equal(canSubmitComposer({ ...idle, creditsAvailable: false }), false)
  assert.equal(canSubmitComposer({ ...idle, modelAvailable: false }), false)
  assert.equal(canSubmitComposer({ ...idle, hasContent: false }), false)
})

test('accepts a queue-intended submission that the server starts immediately', () => {
  assert.equal(isComposerSubmissionAccepted({ ok: true, turn_id: 'started-turn' }), true)
  assert.equal(isComposerSubmissionAccepted({ ok: true, queued: true, queued_message_id: 'queued' }), true)
  assert.equal(isComposerSubmissionAccepted(null), false)
  assert.equal(isComposerSubmissionAccepted({ ok: true }), false)
  assert.equal(isComposerSubmissionAccepted({ ok: true, queued: true }), false)
  assert.equal(isComposerSubmissionAccepted({ ok: false, error: 'failed', turn_id: 'stale' }), false)
})

test('distinguishes a server rejection from an unconfirmed transport outcome', () => {
  assert.equal(composerSubmissionOutcome({ ok: true, turn_id: 'started-turn' }), 'accepted')
  assert.equal(composerSubmissionOutcome({ ok: false, submissionOutcome: 'rejected' }), 'rejected')
  assert.equal(composerSubmissionOutcome({ ok: false, submissionOutcome: 'unknown' }), 'unknown')
  assert.equal(composerSubmissionOutcome(null), 'unknown')
})

test('maps structured Assistant context failures to actionable localized messages', () => {
  assert.equal(describeTurnAdmissionFailure(translate, {
    error: 'assistant_context_unavailable',
    issues: [{
      ref_id: 'selection-1',
      kind: 'selection',
      label: 'evidence.md · 划词',
      state: 'stale',
      reason: 'selection_text_changed'
    }]
  }), 'composer.selectionContextChanged:evidence.md · 划词')
  assert.equal(describeTurnAdmissionFailure(translate, {
    code: 'assistant_context_unavailable',
    message: 'assistant_context_unavailable',
    issues: [{
      ref_id: 'file-1',
      kind: 'file',
      label: 'evidence.md',
      state: 'stale',
      reason: 'source_revision_changed'
    }]
  }), 'composer.sourceContextChanged:evidence.md')
  assert.deepEqual(
    turnAdmissionFeedback({ code: 'resource_review_required' }),
    { ns: 'conversation', key: 'request.resourceReviewRequired', values: undefined }
  )
})

test('summarizes frozen queue references without exposing paths', async () => {
  const locale = createInstance()
  await locale.init({ lng: 'zh', fallbackLng: false, resources: { zh: { assistant: zh }, en: { assistant: en } } })
  const t = locale.getFixedT(null, 'assistant')
  const summary = queuedReferenceSummary([
    { type: 'text', text: '分析' },
    { type: 'skill', name: 'paper-search', path: '/secret/skill' },
    { type: 'file', path: '/secret/report.pdf', name: 'report.pdf' },
    { type: 'local_image', reference_id: 'private-id' }
  ], [
    { title: '项目资料' },
    { label: '选区 A' }
  ], t)
  assert.equal(summary, 'paper-search、report.pdf、图片、项目资料、选区 A')
  assert.equal(summary.includes('/secret'), false)
  assert.equal(summary.includes('private-id'), false)
  assert.equal(queuedReferenceSummary([{ type: 'text', text: '纯文本' }], [], t), '')
})

test('keeps skill identity typed without polluting natural-language text', () => {
  assert.deepEqual(buildTurnInput('检索论文', [{
    type: 'skill',
    id: 'paper-search',
    title: 'Paper Search',
    path: '/opt/scholarseed/skills/paper-search',
    version: '2.1.0'
  }]), [
    { type: 'text', text: '检索论文' },
    { type: 'skill', name: 'paper-search', path: '/opt/scholarseed/skills/paper-search', version: '2.1.0' }
  ])
})

test('does not synthesize a text marker for a skill-only turn', () => {
  assert.deepEqual(buildTurnInput('', [{
    type: 'skill',
    id: 'paper-search',
    title: 'Paper Search',
    path: '/opt/scholarseed/skills/paper-search',
    version: '2.1.0'
  }]), [
    { type: 'skill', name: 'paper-search', path: '/opt/scholarseed/skills/paper-search', version: '2.1.0' }
  ])
})

test('projects a session attachment into local_image without rewriting its canonical path', () => {
  assert.deepEqual(buildTurnInput('', [{
    type: 'file',
    id: 'figure.png',
    title: 'figure.png',
    path: '/tmp/session-1/attachments/figure.png',
    mediaType: 'image/png',
    sha256: 'abc123'
  }]), [{
    type: 'local_image',
    path: '/tmp/session-1/attachments/figure.png',
    name: 'figure.png',
    media_type: 'image/png',
    sha256: 'abc123'
  }])
})

test('projects a desktop-selected local file through its session-scoped reference id', () => {
  assert.deepEqual(buildTurnInput('概括这个文件', [{
    type: 'file',
    id: 'local-reference',
    referenceId: 'local-reference',
    title: 'paper.md',
    path: '/Users/research/paper.md',
    mediaType: 'text/markdown'
  }]), [
    { type: 'text', text: '概括这个文件' },
    {
      type: 'file',
      reference_id: 'local-reference',
      name: 'paper.md',
      media_type: 'text/markdown',
      sha256: undefined
    }
  ])
})

test('projects a selected directory as one typed reference without expanding its contents', () => {
  assert.deepEqual(buildTurnInput('整理资料', [{
    type: 'directory',
    id: 'folder-reference',
    referenceId: 'folder-reference',
    title: 'papers',
    path: '/Users/research/papers'
  }]), [
    { type: 'text', text: '整理资料' },
    { type: 'directory', reference_id: 'folder-reference', name: 'papers' }
  ])
  assert.throws(() => buildTurnInput('', [{
    type: 'directory',
    id: 'unregistered-folder',
    title: 'papers',
    path: '/Users/research/papers'
  }]), /canonical absolute path/)
})

test('fails closed instead of treating a skill name or relative file as a path', () => {
  assert.throws(() => buildTurnInput('run', [{
    type: 'skill',
    id: 'paper-search',
    title: 'Paper Search',
    path: 'paper-search'
  }]), /canonical absolute path/)
  assert.throws(() => buildTurnInput('run', [{
    type: 'file',
    id: 'data.csv',
    title: 'data.csv',
    path: 'data\/data.csv'
  }]), /canonical absolute path/)
})

test('session open projects only fields owned by the frozen product contract', () => {
  assert.deepEqual(
    buildSessionOpenRequest({
      projectPath: '/tmp/research',
      modelId: 'gpt-5.6-sol',
      permissionMode: 'ask',
      requiredCapabilities: ['web_search']
    }),
    {
      project_path: '/tmp/research',
      model_id: 'gpt-5.6-sol',
      permission_mode: 'ask',
      required_capabilities: ['web_search']
    }
  )
  assert.deepEqual(
    buildSessionOpenRequest({ resumeSessionId: 'product-session' }),
    { resume_session_id: 'product-session' }
  )
})


test('queue display follows language changes without mutating frozen input or protocol values', async () => {
  const locale = createInstance()
  await locale.init({ lng: 'zh', fallbackLng: false, resources: { zh: { assistant: zh }, en: { assistant: en } } })
  const t = locale.getFixedT(null, 'assistant')
  const input = [
    { type: 'file' as const, name: '我的文件', reference_id: 'source-id' },
    { type: 'local_image' as const, path: '/private/image.png' }
  ]
  const refs = [
    { kind: 'session', state: 'stale' },
    { label: '用户原文', kind: 'file', state: 'missing' },
    { kind: 'future-kind', state: 'future-state' },
    {}
  ]
  const original = JSON.stringify({ input, refs })
  assert.equal(queuedReferenceSummary(input, refs, t), '我的文件、图片、对话、用户原文、future-kind、上下文')
  assert.equal(queuedReferenceLabel(refs[0], t), '对话（已过期）')
  await locale.changeLanguage('en')
  assert.equal(queuedReferenceSummary(input, refs, t), '我的文件, Image, Conversation, 用户原文, future-kind, Context')
  assert.equal(queuedReferenceLabel(refs[0], t), 'Conversation (Outdated)')
  assert.equal(queuedReferenceLabel(refs[1], t), '用户原文 (Source missing)')
  assert.equal(queuedReferenceLabel(refs[2], t), 'future-kind (future-state)')
  assert.equal(queuedReferenceLabel({ title: 'Chosen title', label: 'other', state: 'ready' }, t), 'Chosen title')
  assert.equal(queuedReferenceLabel({ label: 'raw', state: 'toString' }, t), 'raw (toString)')
  assert.equal(JSON.stringify({ input, refs }), original)
})
