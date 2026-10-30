import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { preserveTextSelectionForContextMenu } from './focus.ts'
import { whitespaceSelection } from './mapping.ts'
import { captureSelectionSnapshot } from './api.ts'

test('large spreadsheet snapshot captures full material before adding its reference', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  let requestBody: Record<string, unknown> | undefined
  let requestUrl: unknown
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: { getApiBase: () => 'http://127.0.0.1:9999' } },
  })
  globalThis.fetch = async (input, options) => {
    requestUrl = input
    assert.equal(options?.method, 'POST')
    requestBody = JSON.parse(String(options?.body))
    return Response.json({
      snapshot_text: 'first cell\nlast cell',
      source_revision: 'sha256:frozen',
    })
  }
  try {
    const snapshot = await captureSelectionSnapshot(
      { kind: 'project', project: 'project-a', path: 'resources/data.xlsx' },
      'sha256:source',
      {
        document_id: 'document',
        document_session_id: 'viewer',
        revision: 'sha256:source',
        status: 'exact',
        text: 'data.xlsx · Evidence!A1:A151',
        locator: { kind: 'calc', sheet: 'Evidence', range: 'A1:A151', content_mode: 'reference' },
      }
    )
    assert.equal(snapshot.snapshot_text, 'first cell\nlast cell')
    assert.equal(requestUrl, 'http://127.0.0.1:9999/api/workbench/selection/snapshot')
    assert.equal(requestBody?.project_id, 'project-a')
    assert.equal(requestBody?.source_id, 'resources/data.xlsx')
    assert.match(String(requestBody?.selected_text_hash), /^sha256:[0-9a-f]{64}$/)
    await captureSelectionSnapshot(
      {
        kind: 'literature',
        literatureId: 'paper-a',
        attachmentId: 'attachment-a',
        path: 'data.xlsx',
        recordTarget: {
          owner: 'literature_attachment',
          scope_id: 'paper-a',
          subject_id: 'attachment-a',
        },
      },
      'sha256:source',
      {
        document_id: 'document-a',
        document_session_id: 'viewer',
        revision: 'sha256:source',
        status: 'exact',
        text: 'data.xlsx · Evidence!A1:A151',
        locator: { kind: 'calc', sheet: 'Evidence', range: 'A1:A151', content_mode: 'reference' },
      }
    )
    assert.equal(requestBody?.source_revision, 'sha256:source')
    assert.equal(requestBody?.sheet, 'Evidence')
    assert.equal(requestBody?.range, 'A1:A151')
    assert.equal(
      requestUrl,
      'http://127.0.0.1:9999/api/v1/literatures/paper-a/attachments/attachment-a/selection-snapshot'
    )
    assert.equal(snapshot.source_revision, 'sha256:frozen')
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('secondary pointer inside selected AI text preserves the complete selection', () => {
  let prevented = false
  const selection = {
    isCollapsed: false,
    rangeCount: 1,
    toString: () => '完整的 AI 结果选区',
    getRangeAt: () => ({
      getClientRects: () => [{ bottom: 80, left: 20, right: 220, top: 40 }],
    }),
  } as unknown as Selection
  const event = {
    button: 2,
    clientX: 120,
    clientY: 60,
    preventDefault: () => {
      prevented = true
    },
  } as unknown as PointerEvent

  assert.equal(preserveTextSelectionForContextMenu(event, selection), true)
  assert.equal(prevented, true)

  prevented = false
  const outsideEvent = {
    ...event,
    clientX: 260,
    preventDefault: () => {
      prevented = true
    },
  }
  assert.equal(preserveTextSelectionForContextMenu(outsideEvent, selection), false)
  assert.equal(prevented, false)
})

test('resource AI has selection actions but no whole-file toolbar entry', () => {
  const feature = readFileSync(new URL('../resources/feature.tsx', import.meta.url), 'utf8')
  const host = readFileSync(new URL('./Selection.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(feature, /ResourceFileExplanation|resource-ai-explain/)
  assertLocalized(host, 'workbench', 'selection.explain', ['AI 解释', 'AI explanation'])
  assertLocalized(host, 'workbench', 'selection.polish', ['AI 润色', 'AI polish'])
})

test('selection toolbar centers its measured intrinsic width and clamps it to the viewport', async () => {
  const placement = await import('./placement.ts').catch(() => null)
  assert.ok(placement, 'selection placement module must exist')
  assert.deepEqual(
    placement.selectionActionPosition({ x: 400, y: 100 }, false, 460, { width: 800, height: 600 }),
    { left: 170, top: 108, width: 460 }
  )
  assert.deepEqual(
    placement.selectionActionPosition({ x: 20, y: 580 }, false, 460, { width: 800, height: 600 }),
    { left: 12, top: 524, width: 460 }
  )
})

test('resource actions use independent transport while context addition retains AssistantIngress', () => {
  const host = readFileSync(new URL('./Selection.tsx', import.meta.url), 'utf8')
  const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')

  assert.match(host, /useAssistantIngress/)
  assert.match(host, /ingress\.addContext/)
  assert.match(host, /ResourceSuggestion/)
  const resourceApi = readFileSync(new URL('../resources/ai.ts', import.meta.url), 'utf8')
  assert.match(resourceApi, /\/api\/resource\/ai/)
  assert.doesNotMatch(resourceApi, /\/api\/workbench\/selection|\/api\/literature/)
  assert.doesNotMatch(host, /executeSelectionAction/)
  assert.doesNotMatch(api, /\/api\/workbench\/selection\/actions/)
})

test('dirty project selections commit before Assistant context captures the source revision', () => {
  const host = readFileSync(new URL('./Selection.tsx', import.meta.url), 'utf8')

  assert.match(host, /session\.dirty[\s\S]*controller\.save\(session\.id\)/)
  assert.match(host, /controller\.getSnapshot\(\)\.sessions\[session\.id\]/)
  assert.match(host, /source_revision: sourceRevision/)
})

test('literature PDF selections expose add-to-conversation through AssistantIngress', () => {
  const host = readFileSync(new URL('./Selection.tsx', import.meta.url), 'utf8')

  assert.match(host, /source\.kind === ['"]literature['"]/)
  assert.match(host, /source\.literatureId/)
  assert.match(host, /document_id: source\.attachmentId/)
  assert.match(host, /w\(['"]selection\.add['"]\)/)
  assert.match(host, /kind: literature \? ['"]literature['"] : ['"]selection['"]/)
})

test('all add-to-conversation selections freeze the complete text for the next turn', () => {
  const host = readFileSync(new URL('./Selection.tsx', import.meta.url), 'utf8')

  assert.match(host, /let snapshotText = selection\.text/)
  assert.match(host, /snapshot_text: snapshotText/)
  assert.doesNotMatch(host, /selection\.locator\.kind === ['"]pdf['"] \? \{ snapshot_text:/)
  assert.match(host, /preview_text: selection\.text/)
})

test('PDF selection actions share one compact order across resource and literature sources', () => {
  const host = readFileSync(new URL('./Selection.tsx', import.meta.url), 'utf8')
  const document = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const reader = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const icons = readFileSync(new URL('../../icons.tsx', import.meta.url), 'utf8')

  assert.match(host, /DEFAULT_SELECTION_ACTION_ORDER = 5/)
  assert.match(host, /ADD_CONTEXT_ACTION_ORDER = 50/)
  assert.match(host, /\.sort\(\(left, right\) => left\.order - right\.order/)
  assert.match(host, /replacesDefaults/)
  assert.match(host, /selection\.locator\.kind !== ['"]pdf['"]/)
  assert.match(host, /w\(['"]selection\.add['"]\)/)
  assert.doesNotMatch(host, /selectionActions\.quote/)
  assert.match(host, /size=['"]sm['"]/)
  assert.match(document, /id: ['"]pdf-records['"],\s*order: 1/)
  assert.match(document, /id: ['"]pdf-copy['"],\s*order: 100/)
  assert.match(reader, /useTranslation\(['"]workbench['"]\)/)
  assert.match(reader, /id: ['"]pdf-ai['"],\s*order: 5/)
  assert.match(reader, /selection\.explain/)
  assert.match(reader, /selection\.translate/)
  assert.match(reader, /size=['"]sm['"]/)
  assert.match(icons, /strikethrough:[\s\S]*M16 4H9/)
})

test('Workbench selection actions reuse the public design-system primitives', () => {
  const host = readFileSync(new URL('./Selection.tsx', import.meta.url), 'utf8')
  const suggestion = readFileSync(new URL('../resources/Suggestion.tsx', import.meta.url), 'utf8')

  assert.match(host, /from ['"]\.\.\/\.\.\/components\/ui['"]/)
  assert.match(host, /<FloatingToolbar/)
  assert.match(host, /<Badge/)
  assert.match(suggestion, /<IconButton/)
  assert.match(suggestion, /className="vds-selection-action-result(?:\s+[^"]*)?"/)
  assert.match(suggestion, /<Textarea\s+autoFocus/)
  assert.match(suggestion, /<ScrollArea/)
  assert.match(suggestion, /isComposing/)
  assert.match(suggestion, /<FloatingToolbar/)
  assert.doesNotMatch(host, /shadow\s+viewportClassName="vds-selection-action-output/)
  assert.doesNotMatch(host, /components\/ui\//)
  assert.doesNotMatch(host, /<details|<summary/)
})

test('Calc selection actions display the active worksheet and cell range', () => {
  const host = readFileSync(new URL('./Selection.tsx', import.meta.url), 'utf8')

  assert.match(host, /locator\.kind === ['"]calc['"]/)
  assert.match(host, /locator\.sheet/)
  assert.match(host, /locator\.range/)
})

test('Workbench selection host composes tab-scoped viewer actions without viewer branches', () => {
  const host = readFileSync(new URL('./Selection.tsx', import.meta.url), 'utf8')

  assert.match(host, /useSelectionActions\(current\?\.tab\.id \?\? (?:''|"")\)/)
  assert.match(host, /registry\.dismiss\(tab\.id\)/)
  assert.match(host, /useSelectionActionRegistry/)
  assert.match(host, /useWorkspaceController/)
  assert.match(host, /contributions\.map/)
  assert.doesNotMatch(host, /session\.viewer === ['"](?:pdf|markdown)['"]/)
})

test('Workbench selection toolbar measures intrinsic content instead of forcing a page-wide width', () => {
  const host = readFileSync(new URL('./Selection.tsx', import.meta.url), 'utf8')

  assert.match(host, /ref=\{toolbarRef\}/)
  assert.match(host, /ResizeObserver/)
  assert.match(host, /w-max/)
  assert.doesNotMatch(host, /MENU_WIDTH/)
})

test('selection AI results remain suggestions until an editable viewer replaces the guarded selection', () => {
  const host = readFileSync(new URL('./Selection.tsx', import.meta.url), 'utf8')

  assertLocalized(host, 'workbench', 'selection.polish', ['AI 润色', 'AI polish'])
  const suggestion = readFileSync(new URL('../resources/Suggestion.tsx', import.meta.url), 'utf8')
  assertLocalized(suggestion, 'resources', 'suggestion.replace', ['替换原文', 'Replace original'])
  assert.match(suggestion, /action === 'polish'/)
  assert.match(suggestion, /disabled=\{!complete/)
  assert.match(host, /selectionReplacementFor/)
  assert.match(host, /expectedChangeVersion/)
  assert.match(host, /expectedFingerprint/)
  assert.doesNotMatch(host, /documentWorkspace\.save/)
  assert.match(suggestion, /item\.key === selectedModel && !item\.disabled/)
  assert.match(suggestion, /z-\[var\(--vds-z-popover\)\]/)
})

test('resource AI freezes selected PDF text in the click-time request snapshot', () => {
  const host = readFileSync(new URL('./Selection.tsx', import.meta.url), 'utf8')
  const resourceApi = readFileSync(new URL('../resources/ai.ts', import.meta.url), 'utf8')

  assert.match(resourceApi, /selected_text: string/)
  assert.match(host, /selected_text: selection\.text/)
  assert.match(host, /snapshot=/)
  assert.doesNotMatch(host, /prepare=/)
})

test('resource AI results pin only the popup lifecycle and remain draggable', () => {
  const host = readFileSync(new URL('./Selection.tsx', import.meta.url), 'utf8')
  const suggestion = readFileSync(new URL('../resources/Suggestion.tsx', import.meta.url), 'utf8')

  assert.match(host, /pinned/)
  assert.match(host, /currentIdentity/)
  assert.match(host, /active\.tabId !== focusedTabId/)
  assert.match(host, /onPinnedChange/)
  assert.match(host, /retainsDocumentSelection\(null, event\.target\)/)
  assert.match(host, /addEventListener\(["']pointerdown["'], dismissOutsidePointer, true\)/)
  assert.match(suggestion, /aria-pressed=\{pinned\}/)
  assert.match(
    suggestion,
    /submitted && \(action === 'explain' \|\| action === 'translate'\) \? \(\s*<IconButton\s+aria-pressed=\{pinned\}/
  )
  assert.match(suggestion, /onPointerDown=\{startDrag\}/)
  assert.match(suggestion, /onPointerMove=\{moveDrag\}/)
  assert.match(suggestion, /onPointerUp=\{stopDrag\}/)
  assertLocalized(suggestion, 'ui', 'floatingWindow.pin', ['固定浮窗', 'Pin floating window'])
  assertLocalized(suggestion, 'ui', 'floatingWindow.unpin', [
    '取消固定浮窗',
    'Unpin floating window',
  ])
})

test('resource AI input keeps the selection toolbar visible and marks the active action', () => {
  const host = readFileSync(new URL('./Selection.tsx', import.meta.url), 'utf8')
  const suggestion = readFileSync(new URL('../resources/Suggestion.tsx', import.meta.url), 'utf8')

  assert.match(host, /activeAttachedToSelection/)
  assert.match(host, /aria-pressed=\{activeAction === ["']explain["']\}/)
  assert.match(host, /toolbarActions=\{toolbarActions\}/)
  assert.match(host, /anchorWidth=\{position\?\.width\}/)
  assert.match(host, /ref=\{toolbarRef\}/)
  assert.match(host, /getBoundingClientRect\(\)\.width/)
  assert.doesNotMatch(host, /useLayoutEffect\(\(\) => \{[\s\S]*if \(!toolbarRef\.current\) return;/)
  assert.equal(host.match(/<ResourceSuggestion\b/g)?.length, 1)
  assert.match(suggestion, /toolbarActions\?: ReactNode/)
  assert.match(suggestion, /toolbarActions && !submitted/)
  assert.match(suggestion, /actions=\{suggestionActions\}/)
  assert.doesNotMatch(host, /!active \|\| active\.identity !== currentIdentity/)
})

test('selection AI actions share the same pressed toolbar button treatment', () => {
  const host = readFileSync(new URL('./Selection.tsx', import.meta.url), 'utf8')

  assert.match(host, /aria-pressed=\{activeAction === ["']polish["']\}/)
  assert.doesNotMatch(host, /<Toggle/)
})

test('resource AI exposes PDF annotation only through the active viewer contribution', () => {
  const host = readFileSync(new URL('./Selection.tsx', import.meta.url), 'utf8')
  const actions = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8')
  const suggestion = readFileSync(new URL('../resources/Suggestion.tsx', import.meta.url), 'utf8')

  assert.match(actions, /annotateResult\?: SelectionAnnotation/)
  assert.match(host, /selectionAnnotationFor/)
  assert.match(host, /selection: captured\.selection/)
  assert.match(suggestion, /onAnnotate/)
  assert.match(suggestion, /suggestion\.addToAnnotation/)
  assert.match(suggestion, /disabled=\{!complete \|\| busy \|\| annotating \|\| annotated\}/)
})

test('resource AI generated content remains text-selectable without changing whole-result copy', () => {
  const suggestion = readFileSync(new URL('../resources/Suggestion.tsx', import.meta.url), 'utf8')

  assert.match(suggestion, /className=\{`[^`]*\bcursor-text\s+select-text\b[^`]*`\}/)
  assert.match(
    suggestion,
    /action === 'polish' && onApply \? \(\s*<Button[\s\S]*: \(\s*<CopyButton/
  )
  assert.match(suggestion, /<CopyButton[^>]*value=\{output\}/)
})
test('visual soft-wrap mapping preserves source coordinates and refuses ambiguous matches', () => {
  const source = '前文\n温度升高\n效率下降\n后文'
  const result = whitespaceSelection(source, '温度升高效率下降')
  assert.ok(result)
  assert.equal(source.slice(result.start, result.end), '温度升高\n效率下降')
  assert.equal(whitespaceSelection('a b a b', 'ab'), null)
  assert.equal(whitespaceSelection(source, 'missing'), null)
})

function assertLocalized(source: string, namespace: string, key: string, expected: string[]): void {
  assert.ok(source.includes(`'${key}'`), `source binds ${namespace}:${key}`)
  const labels = ['zh', 'en'].map((language) => {
    const resource = JSON.parse(
      readFileSync(
        new URL(`../../../../localization/locales/${language}/${namespace}.json`, import.meta.url),
        'utf8'
      )
    )
    return key.split('.').reduce((value, part) => value[part], resource)
  })
  assert.deepEqual(labels, expected)
}
