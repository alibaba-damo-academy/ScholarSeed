import assert from 'node:assert/strict'
import test from 'node:test'
import { createInstance, type TFunction } from 'i18next'
import zh from '../../localization/locales/zh/assistant.json' with { type: 'json' }
import en from '../../localization/locales/en/assistant.json' with { type: 'json' }
import zhComponents from '../../localization/locales/zh/components.json' with { type: 'json' }
import enComponents from '../../localization/locales/en/components.json' with { type: 'json' }

import { buildSessionOpenRequest, getSessionContinuation } from './api.ts'
import { renderFeedback } from './contracts/feedback.ts'
import { pendingAssistantContextRefs, type AssistantContextRef } from './contracts/assistant.ts'
import {
  buildTurnInput,
  canSubmitComposer,
  canConsumeDraftSubmission,
  composerHasContent,
  composerSubmissionOutcome,
  isComposerSubmissionAccepted,
  composerObscured,
  composerTrigger,
  describeTurnAdmissionFailure,
  isAbsoluteInputPath,
  queuedReferenceLabel,
  queuedReferenceSummary,
  replaceComposerTrigger,
  turnAdmissionFeedback,
} from './input.ts'

test('input paths accept absolute platform paths without rewriting their spelling', () => {
  const paths = [
    '/Users/research/论文/SKILL.md',
    'C:\\研究资料\\skills\\SKILL.md',
    'c:/Research Files/skills/SKILL.md',
    '\\\\?\\C:\\研究资料\\skills\\SKILL.md',
    '\\\\server\\share',
    '\\\\server\\share\\skills\\SKILL.md',
    '\\\\?\\UNC\\server\\share\\skills\\SKILL.md',
    '\\\\?\\unc\\server\\share\\skills\\SKILL.md',
  ]
  for (const path of paths) {
    assert.equal(isAbsoluteInputPath(path), true, path)
    assert.deepEqual(
      buildTurnInput('', [{ type: 'skill', id: 'paper-search', title: 'Paper Search', path }]),
      [{ type: 'skill', name: 'paper-search', path, version: undefined }]
    )
  }
})

test('input paths reject relative paths, incomplete UNC roots and device namespaces', () => {
  for (const path of [
    undefined,
    '',
    'skills/SKILL.md',
    'C:skills\\SKILL.md',
    '\\skills\\SKILL.md',
    '\\\\server',
    '\\\\server\\',
    '\\\\?\\C:skills\\SKILL.md',
    '\\\\?\\UNC\\server',
    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\SKILL.md',
    '\\\\.\\pipe\\skills',
    'file:///C:/skills/SKILL.md',
  ]) {
    assert.equal(isAbsoluteInputPath(path), false, String(path))
  }
})

test('continuation preview is an abortable read with strict source and role validation', async (context) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: { getApiBase: () => 'http://local.test' } },
  })
  context.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  const calls: { url: string; init?: RequestInit }[] = []
  const preview = {
    source_session_id: 'source/one',
    source_product_seq: 42,
    source_title: 'Old task',
    project_path: '/project',
    model_id: 'personal-oauth-model',
    messages: [{ role: 'user', text: 'Visible goal' }],
    included_messages: 1,
    omitted_messages: 0,
    omitted_characters: 0,
    truncated: false,
    excluded_categories: ['reasoning', 'tools'],
  }
  let body: unknown = preview
  let status = 200
  context.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), { status })
  })
  const controller = new AbortController()
  assert.deepEqual(
    await getSessionContinuation('source/one', 'turn?one', controller.signal),
    preview
  )
  assert.equal(
    calls[0].url,
    'http://local.test/api/serve/sessions/source%2Fone/continuation?turn_id=turn%3Fone'
  )
  assert.equal(calls[0].init?.method ?? 'GET', 'GET')
  assert.equal(calls[0].init?.body, undefined)
  assert.equal(calls[0].init?.cache, 'no-store')
  controller.abort()
  assert.equal(calls[0].init?.signal?.aborted, true)
  for (const invalid of [
    { ...preview, source_session_id: 'other' },
    { ...preview, messages: [{ role: 'system', text: 'Elevated instruction' }] },
    { ...preview, messages: [{ role: 'user', text: 123 }] },
    { ...preview, source_product_seq: -1 },
    { ...preview, included_messages: 2 },
  ]) {
    body = invalid
    await assert.rejects(
      getSessionContinuation('source/one', 'turn'),
      /session_continuation_invalid/
    )
  }
  body = { code: 'session_continuation_busy' }
  status = 409
  await assert.rejects(getSessionContinuation('source/one', 'turn'), /session_continuation_busy/)
})

test('draft auto-send belongs to the ready project composer and is consumed once', () => {
  const ready = {
    surface: 'assistant' as const,
    view: 'resource' as const,
    ready: true,
    consumed: false,
    obscured: false,
  }
  assert.equal(canConsumeDraftSubmission(ready), true)
  assert.equal(canConsumeDraftSubmission({ ...ready, surface: 'conversation' }), false)
  assert.equal(canConsumeDraftSubmission({ ...ready, view: 'skills' }), false)
  assert.equal(canConsumeDraftSubmission({ ...ready, ready: false }), false)
  assert.equal(canConsumeDraftSubmission({ ...ready, consumed: true }), false)
  assert.equal(canConsumeDraftSubmission({ ...ready, obscured: true }), false)
})

const translate = ((key: string, values?: { name?: string }) =>
  values?.name ? `${key}:${values.name}` : key) as TFunction<'components'>

test('context revision conflicts retain actionable feedback for code and legacy error responses', () => {
  for (const failure of [
    { code: 'assistant_context_revision_conflict' },
    { error: 'assistant_context_revision_conflict' },
  ]) {
    assert.deepEqual(turnAdmissionFeedback(failure), {
      ns: 'components',
      key: 'composer.contextChanged',
      values: undefined,
    })
  }
})

test('composer admits reference-only drafts without counting consumed references', () => {
  for (const kind of ['file', 'session', 'selection', 'note'] as const) {
    const reference: AssistantContextRef = {
      ref_id: 'reference',
      kind,
      source_id: 'source',
      label: 'Reference',
      retention: 'next_turn',
      origin: 'explicit',
    }
    const refs = pendingAssistantContextRefs([reference], [])
    assert.equal(composerHasContent('', [], refs), true)
    assert.equal(composerHasContent('  \n', [], refs), true)
    assert.equal(
      composerHasContent('', [], pendingAssistantContextRefs([reference], ['reference'])),
      false
    )
    assert.deepEqual(refs, [reference])
    assert.equal(composerHasContent('', [], [{ ...reference, origin: 'current_document' }]), false)
    assert.equal(
      composerHasContent('', [], [{ ...reference, origin: 'implicit_retrieval' }]),
      false
    )
  }
  assert.equal(composerHasContent('text', [], []), true)
  assert.equal(composerHasContent(' \n', [], []), false)
  assert.equal(
    composerHasContent('', [{ type: 'file', id: 'file', title: 'file', path: '/file' }], []),
    true
  )
})

test('at and slash shortcuts share candidate queries without matching emails or paths', () => {
  for (const [text, query] of [
    ['@', ''],
    ['@文献', '文献'],
    ['@skill:pdf', 'skill:pdf'],
    ['/', 'skill:'],
    ['/pdf', 'skill:pdf'],
    ['请使用 /pdf', 'skill:pdf'],
    ['引用 @file:papers/method.md', 'file:papers/method.md'],
  ])
    assert.equal(composerTrigger(text)?.query, query)
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

test('shortcuts follow the caret before existing text and across multiple lines', () => {
  for (const [text, caret, query, start] of [
    ['/已有正文\n第二行', 1, 'skill:', 0],
    ['@已有正文\n第二行', 1, '', 0],
    ['前文 /pdf后文', 7, 'skill:pdf', 3],
    ['第一行\n@file:后文', 10, 'file:', 4],
  ] as const) {
    assert.deepEqual(composerTrigger(text, caret), { query, start })
  }
  assert.equal(composerTrigger('/pdf 正文', 0), null)
  assert.equal(composerTrigger('/pdf 正文', 5), null)
  assert.equal(composerTrigger('name@example.com', 5), null)
  assert.equal(composerTrigger('path/to/file', 5), null)
  assert.equal(composerTrigger('https://example.com', 7), null)
})

test('shortcut replacement preserves both sides including trailing whitespace', () => {
  assert.equal(replaceComposerTrigger('/已有正文\n第二行  ', '', 1), '已有正文\n第二行  ')
  assert.equal(replaceComposerTrigger('前文 /pdf后文', '', 7), '前文 后文')
  assert.equal(replaceComposerTrigger('@已有正文', '@file:', 1), '@file:已有正文')
  assert.equal(
    replaceComposerTrigger('前文 @file:后文\n', '@file:papers/', 9),
    '前文 @file:papers/后文\n'
  )
  assert.equal(replaceComposerTrigger('普通文本', '', 2), '普通文本')
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
    hasContent: true,
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
  assert.equal(
    isComposerSubmissionAccepted({ ok: true, accepted: true, turn_id: 'started-turn' }),
    true
  )
  assert.equal(
    isComposerSubmissionAccepted({
      ok: true,
      accepted: true,
      disposition: 'queued',
      queued_message_id: 'queued',
    }),
    true
  )
  assert.equal(isComposerSubmissionAccepted(null), false)
  assert.equal(isComposerSubmissionAccepted({ ok: true, accepted: true }), false)
  assert.equal(isComposerSubmissionAccepted({ ok: true, queued_message_id: 'queued' }), false)
  assert.equal(
    isComposerSubmissionAccepted({ ok: false, accepted: true, error: 'failed', turn_id: 'stale' }),
    false
  )
})

test('distinguishes a server rejection from an unconfirmed transport outcome', () => {
  assert.equal(
    composerSubmissionOutcome({ ok: true, accepted: true, turn_id: 'started-turn' }),
    'accepted'
  )
  assert.equal(composerSubmissionOutcome({ ok: true, turn_id: 'legacy-turn' }), 'unknown')
  assert.equal(composerSubmissionOutcome({ ok: false, submissionOutcome: 'rejected' }), 'rejected')
  assert.equal(composerSubmissionOutcome({ ok: false, submissionOutcome: 'unknown' }), 'unknown')
  assert.equal(composerSubmissionOutcome(null), 'unknown')
})

test('maps structured Assistant context failures to actionable localized messages', () => {
  assert.equal(
    describeTurnAdmissionFailure(translate, {
      error: 'assistant_context_unavailable',
      issues: [
        {
          ref_id: 'legacy-selection',
          kind: 'selection',
          label: 'evidence.docx',
          state: 'unavailable',
          reason: 'selection_snapshot_required',
        },
      ],
    }),
    'composer.selectionSnapshotRequired:evidence.docx'
  )
  assert.equal(
    describeTurnAdmissionFailure(translate, {
      error: 'assistant_context_unavailable',
      issues: [
        {
          ref_id: 'selection-1',
          kind: 'selection',
          label: 'evidence.md · 划词',
          state: 'stale',
          reason: 'selection_text_changed',
        },
      ],
    }),
    'composer.selectionContextChanged:evidence.md · 划词'
  )
  assert.equal(
    describeTurnAdmissionFailure(translate, {
      code: 'assistant_context_unavailable',
      message: 'assistant_context_unavailable',
      issues: [
        {
          ref_id: 'file-1',
          kind: 'file',
          label: 'evidence.md',
          state: 'stale',
          reason: 'source_revision_changed',
        },
      ],
    }),
    'composer.sourceContextChanged:evidence.md'
  )
  assert.deepEqual(turnAdmissionFeedback({ code: 'resource_review_required' }), {
    ns: 'conversation',
    key: 'request.resourceReviewRequired',
    values: undefined,
  })
  assert.deepEqual(turnAdmissionFeedback({ code: 'previous_turn_pending_hil' }), {
    ns: 'components',
    key: 'composer.previousTurnPendingHil',
    values: undefined,
  })
  assert.deepEqual(turnAdmissionFeedback({ code: 'previous_turn_background_active' }), {
    ns: 'components',
    key: 'composer.previousTurnBackgroundActive',
    values: undefined,
  })
})

test('continuation preparation refusals use preparation feedback instead of activity feedback', () => {
  for (const error of [
    'runtime_preparation_default_failed',
    'runtime_resource_wait_timeout',
    'runtime_host_busy',
  ]) {
    assert.deepEqual(turnAdmissionFeedback({ error, preparation_error: true }), {
      ns: 'components',
      key: 'runtimePreparation.failed',
      values: undefined,
    })
  }
})

test('localizes pending settlement reasons and never exposes raw admission errors', async () => {
  const locale = createInstance()
  await locale.init({
    lng: 'zh',
    fallbackLng: false,
    resources: { zh: { components: zhComponents }, en: { components: enComponents } },
  })
  const cases = [
    ['assistant_context_revision_conflict', 'composer.contextChanged'],
    ['turn_outcome_unconfirmed', 'composer.turnOutcomeUnconfirmed'],
    ['previous_turn_settling', 'composer.previousTurnSettling'],
    ['previous_turn_background_active', 'composer.previousTurnBackgroundActive'],
    ['previous_turn_pending_hil', 'composer.previousTurnPendingHil'],
    ['previous_turn_activity_unavailable', 'composer.previousTurnActivityUnavailable'],
  ] as const
  for (const language of ['zh', 'en']) {
    await locale.changeLanguage(language)
    for (const [code, key] of cases) {
      const descriptor = turnAdmissionFeedback({ code, error: code, message: code })
      assert.deepEqual(descriptor, { ns: 'components', key, values: undefined })
      const rendered = renderFeedback(locale, descriptor)
      assert.notEqual(rendered, key)
      assert.notEqual(rendered, code)
      assert.equal(
        describeTurnAdmissionFailure(locale.getFixedT(null, 'components'), { error: code }),
        rendered
      )
    }
    for (const failure of [
      { error: 'unregistered_internal_code' },
      { message: 'private backend detail' },
      { code: 'constructor', error: 'constructor' },
      {},
    ]) {
      assert.deepEqual(turnAdmissionFeedback(failure), {
        ns: 'components',
        key: 'composer.messageFailed',
        values: undefined,
      })
    }
  }
})

test('summarizes frozen queue references without exposing paths', async () => {
  const locale = createInstance()
  await locale.init({
    lng: 'zh',
    fallbackLng: false,
    resources: { zh: { assistant: zh }, en: { assistant: en } },
  })
  const t = locale.getFixedT(null, 'assistant')
  const summary = queuedReferenceSummary(
    [
      { type: 'text', text: '分析' },
      { type: 'skill', name: 'paper-search', path: '/secret/skill' },
      { type: 'file', path: '/secret/report.pdf', name: 'report.pdf' },
      { type: 'local_image', reference_id: 'private-id' },
    ],
    [{ title: '项目资料' }, { label: '选区 A' }],
    t
  )
  assert.equal(summary, 'paper-search、report.pdf、图片、项目资料、选区 A')
  assert.equal(summary.includes('/secret'), false)
  assert.equal(summary.includes('private-id'), false)
  assert.equal(queuedReferenceSummary([{ type: 'text', text: '纯文本' }], [], t), '')
})

test('keeps skill identity typed without polluting natural-language text', () => {
  assert.deepEqual(
    buildTurnInput('检索论文', [
      {
        type: 'skill',
        id: 'paper-search',
        title: 'Paper Search',
        path: '/opt/scholarseed/skills/paper-search',
        version: '2.1.0',
      },
    ]),
    [
      { type: 'text', text: '检索论文' },
      {
        type: 'skill',
        name: 'paper-search',
        path: '/opt/scholarseed/skills/paper-search',
        version: '2.1.0',
      },
    ]
  )
})

test('does not synthesize a text marker for a skill-only turn', () => {
  assert.deepEqual(
    buildTurnInput('', [
      {
        type: 'skill',
        id: 'paper-search',
        title: 'Paper Search',
        path: '/opt/scholarseed/skills/paper-search',
        version: '2.1.0',
      },
    ]),
    [
      {
        type: 'skill',
        name: 'paper-search',
        path: '/opt/scholarseed/skills/paper-search',
        version: '2.1.0',
      },
    ]
  )
})

test('projects a session attachment into local_image without rewriting its canonical path', () => {
  assert.deepEqual(
    buildTurnInput('', [
      {
        type: 'file',
        id: 'figure.png',
        title: 'figure.png',
        path: '/tmp/session-1/attachments/figure.png',
        mediaType: 'image/png',
        sha256: 'abc123',
      },
    ]),
    [
      {
        type: 'local_image',
        path: '/tmp/session-1/attachments/figure.png',
        name: 'figure.png',
        media_type: 'image/png',
        sha256: 'abc123',
      },
    ]
  )
})

test('projects a desktop-selected local file through its session-scoped reference id', () => {
  assert.deepEqual(
    buildTurnInput('概括这个文件', [
      {
        type: 'file',
        id: 'local-reference',
        referenceId: 'local-reference',
        title: 'paper.md',
        path: '/Users/research/paper.md',
        mediaType: 'text/markdown',
      },
    ]),
    [
      { type: 'text', text: '概括这个文件' },
      {
        type: 'file',
        reference_id: 'local-reference',
        name: 'paper.md',
        media_type: 'text/markdown',
        sha256: undefined,
      },
    ]
  )
})

test('projects a selected directory as one typed reference without expanding its contents', () => {
  assert.deepEqual(
    buildTurnInput('整理资料', [
      {
        type: 'directory',
        id: 'folder-reference',
        referenceId: 'folder-reference',
        title: 'papers',
        path: '/Users/research/papers',
      },
    ]),
    [
      { type: 'text', text: '整理资料' },
      { type: 'directory', reference_id: 'folder-reference', name: 'papers' },
    ]
  )
  assert.throws(
    () =>
      buildTurnInput('', [
        {
          type: 'directory',
          id: 'unregistered-folder',
          title: 'papers',
          path: '/Users/research/papers',
        },
      ]),
    /canonical absolute path/
  )
})

test('fails closed instead of treating a skill name or relative file as a path', () => {
  assert.throws(
    () =>
      buildTurnInput('run', [
        {
          type: 'skill',
          id: 'paper-search',
          title: 'Paper Search',
          path: 'paper-search',
        },
      ]),
    /canonical absolute path/
  )
  assert.throws(
    () =>
      buildTurnInput('run', [
        {
          type: 'file',
          id: 'data.csv',
          title: 'data.csv',
          path: 'data/data.csv',
        },
      ]),
    /canonical absolute path/
  )
})

test('session open projects only fields owned by the frozen product contract', () => {
  assert.deepEqual(
    buildSessionOpenRequest({
      projectPath: '/tmp/research',
      modelId: 'gpt-5.6-sol',
      permissionMode: 'ask',
      requiredCapabilities: ['web_search'],
    }),
    {
      project_path: '/tmp/research',
      model_id: 'gpt-5.6-sol',
      permission_mode: 'ask',
      required_capabilities: ['web_search'],
    }
  )
  assert.deepEqual(buildSessionOpenRequest({ forkSessionId: 'source', forkTurnId: 'turn-two' }), {
    fork_session_id: 'source',
    fork_turn_id: 'turn-two',
  })
  assert.deepEqual(buildSessionOpenRequest({ resumeSessionId: 'product-session' }), {
    resume_session_id: 'product-session',
  })
})

test('queue display follows language changes without mutating frozen input or protocol values', async () => {
  const locale = createInstance()
  await locale.init({
    lng: 'zh',
    fallbackLng: false,
    resources: { zh: { assistant: zh }, en: { assistant: en } },
  })
  const t = locale.getFixedT(null, 'assistant')
  const input = [
    { type: 'file' as const, name: '我的文件', reference_id: 'source-id' },
    { type: 'local_image' as const, path: '/private/image.png' },
  ]
  const refs = [
    { kind: 'session', state: 'stale' },
    { label: '用户原文', kind: 'file', state: 'missing' },
    { kind: 'future-kind', state: 'future-state' },
    {},
  ]
  const original = JSON.stringify({ input, refs })
  assert.equal(
    queuedReferenceSummary(input, refs, t),
    '我的文件、图片、任务、用户原文、future-kind、上下文'
  )
  assert.equal(queuedReferenceLabel(refs[0], t), '任务（已过期）')
  await locale.changeLanguage('en')
  assert.equal(
    queuedReferenceSummary(input, refs, t),
    '我的文件, Image, Task, 用户原文, future-kind, Context'
  )
  assert.equal(queuedReferenceLabel(refs[0], t), 'Task (Outdated)')
  assert.equal(queuedReferenceLabel(refs[1], t), '用户原文 (Source missing)')
  assert.equal(queuedReferenceLabel(refs[2], t), 'future-kind (future-state)')
  assert.equal(
    queuedReferenceLabel({ title: 'Chosen title', label: 'other', state: 'ready' }, t),
    'Chosen title'
  )
  assert.equal(queuedReferenceLabel({ label: 'raw', state: 'toString' }, t), 'raw (toString)')
  assert.equal(JSON.stringify({ input, refs }), original)
})
