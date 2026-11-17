import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

import { PDFDocument, PDFName, PDFString } from 'pdf-lib'
import { createInstance } from 'i18next'
import { expressions } from '../../../../test-helpers/syntax.ts'

import type { PdfRecordSnapshot } from './api.ts'
import { buildAnnotatedPdf } from './pdf/export.ts'
import { evidencePages } from './pdf/evidence.ts'
import { externalPdfLinks, PDF_ANNOTATION_INTENT } from './pdf/links.ts'
import { PDF_HIGHLIGHT_VISUAL_CLASS, pdfMarkVisualClass } from './pdf/records.ts'

const documentExpressions = expressions(
  readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
)

test('selection explanation and translation share the toolbar and can fill the PDF reader', () => {
  const reading = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const viewer = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')

  assert.match(
    reading,
    /selectionResultKind =\s*floating === 'selection_translation' \|\| floating === 'selection_explanation'/
  )
  assert.match(
    reading,
    /selectionResultFillsReader \|\| selectionResultMark \? null : \(\s*selectionResultPanel\s*\)/
  )
  assert.match(
    reading,
    /expandedSelectionResult: selectionResultFillsReader \? selectionResultPanel : null/
  )
  assert.match(viewer, /data-testid="pdf-selection-result-expanded"/)
})

function readingExpression<Result>(
  source: string,
  select: (node: ts.Node) => boolean,
  bindings: Record<string, unknown>
): Result {
  const root = ts.createSourceFile(
    'Reading.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const found: ts.Node[] = []
  const visit = (node: ts.Node): void => {
    if (select(node)) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(root)
  assert.equal(found.length, 1, 'expected one production expression')
  const compiled = ts.transpileModule(`return (${found[0].getText(root)})`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.None,
      jsx: ts.JsxEmit.React,
    },
  }).outputText
  return new Function(...Object.keys(bindings), compiled)(...Object.values(bindings)) as Result
}

test('PDF Escape clears temporary selections and active marking tools', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  for (const scenario of [
    { activeTool: null, selections: [{}], activeMark: null },
    { activeTool: null, selections: [], activeMark: 'saved-mark' },
    { activeTool: 'highlight', selections: [{}], activeMark: null },
    { activeTool: 'underline', selections: [{}], activeMark: null },
  ]) {
    let listener: ((event: unknown) => void) | undefined
    const changes: unknown[] = []
    const effect = readingExpression<() => (() => void) | undefined>(
      source,
      (node) =>
        ts.isArrowFunction(node) &&
        ts.isCallExpression(node.parent) &&
        node.parent.expression.getText() === 'useEffect' &&
        node.getText().includes('const onEscape ='),
      {
        ...scenario,
        active: true,
        analysis: { figure: false },
        controller: { getSnapshot: () => ({ focusedTabId: 'pdf' }) },
        tabId: 'pdf',
        window: {
          addEventListener: (_type: string, callback: typeof listener) => {
            listener = callback
          },
          removeEventListener: () => {
            listener = undefined
          },
        },
        setActiveTool: (value: unknown) => changes.push(['tool', value]),
        setSelectionDragSpan: (value: unknown) => changes.push(['drag', value]),
        clearSelection: () => changes.push('selection'),
        exitFigureSelection: () => changes.push('figure'),
      }
    )
    const cleanup = effect()
    assert.ok(listener, JSON.stringify(scenario))
    listener({ key: 'Escape', defaultPrevented: false, target: null, preventDefault: () => {} })
    assert.deepEqual(changes, [['tool', null], ['drag', null], 'selection'])
    cleanup?.()
    assert.equal(listener, undefined)
  }
})

test('PDF Escape respects focused documents, editable surfaces and consumed events', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  for (const scenario of ['other-tab', 'editable', 'consumed', 'composing', 'other-key']) {
    let listener: ((event: unknown) => void) | undefined
    const changes: unknown[] = []
    const effect = readingExpression<() => (() => void) | undefined>(
      source,
      (node) =>
        ts.isArrowFunction(node) &&
        ts.isCallExpression(node.parent) &&
        node.parent.expression.getText() === 'useEffect' &&
        node.getText().includes('const onEscape ='),
      {
        activeTool: 'highlight',
        selections: [{}],
        activeMark: null,
        active: true,
        analysis: { figure: false },
        tabId: 'pdf',
        controller: {
          getSnapshot: () => ({ focusedTabId: scenario === 'other-tab' ? 'other' : 'pdf' }),
        },
        window: {
          addEventListener: (_type: string, callback: typeof listener) => {
            listener = callback
          },
          removeEventListener: () => {},
        },
        setActiveTool: () => changes.push('tool'),
        setSelectionDragSpan: () => changes.push('drag'),
        clearSelection: () => changes.push('selection'),
        exitFigureSelection: () => changes.push('figure'),
      }
    )
    effect()
    listener?.({
      key: scenario === 'other-key' ? 'Enter' : 'Escape',
      defaultPrevented: scenario === 'consumed',
      isComposing: scenario === 'composing',
      target: scenario === 'editable' ? { closest: () => ({}) } : null,
      preventDefault: () => {},
    })
    assert.deepEqual(changes, [], scenario)
  }
})

test('collapsed PDF viewports retain their last readable geometry', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const host = { clientWidth: 600, clientHeight: 740, offsetWidth: 600 }
  const sizes: unknown[] = []
  let resize: (entries: { contentRect: { width: number; height: number } }[]) => void = () => {}
  const effect = readingExpression<() => (() => void) | undefined>(
    source,
    (node) =>
      ts.isArrowFunction(node) &&
      ts.isCallExpression(node.parent) &&
      node.parent.expression.getText() === 'useLayoutEffect' &&
      node.getText().includes('setSize(') &&
      node.getText().includes('new ResizeObserver('),
    {
      viewportRef: { current: host },
      setSize: (size: unknown) => sizes.push(size),
      ResizeObserver: class {
        constructor(callback: typeof resize) {
          resize = callback
        }
        observe(): void {}
        disconnect(): void {}
      },
    }
  )
  effect()
  resize([{ contentRect: { width: 568, height: 708 } }])
  host.clientWidth = 32
  host.offsetWidth = 32
  resize([{ contentRect: { width: 0, height: 708 } }])
  assert.deepEqual(sizes, [{ width: 600, height: 740, outerWidth: 600 }])
  host.clientWidth = 520
  host.offsetWidth = 520
  resize([{ contentRect: { width: 488, height: 708 } }])
  assert.deepEqual(sizes.at(-1), { width: 520, height: 740, outerWidth: 520 })
})

test('PDF offscreen anchors remain usable only while the reader boundary has space', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  let boundary = { left: 20, right: 580, top: 20, bottom: 720 }
  const viewport = readingExpression<
    (host: unknown, selections: unknown[]) => { visible: boolean; point: { y: number } }
  >(
    source,
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'persistedSelectionViewport',
    {
      pdfSelectionBoundary: () => boundary,
      enclosingRectangle: (rects: unknown[]) => rects[0],
      selectionViewport: (rect: unknown, point: unknown, visible: boolean) => ({
        rect,
        point,
        visible,
      }),
    }
  )
  for (const top of [-1000, 1500]) {
    const host = {
      querySelectorAll: () => [
        {
          dataset: { page: '1' },
          getBoundingClientRect: () => ({ left: 0, top, width: 600, height: 800 }),
        },
      ],
    }
    const selections = [{ page: 1, quads: [[0.1, 0.1, 0.5, 0.2]] }]
    assert.equal(viewport(host, selections).visible, true)
    const readableBoundary = boundary
    boundary = { ...boundary, right: boundary.left }
    assert.equal(viewport(host, selections).visible, false)
    boundary = readableBoundary
  }
})

test('PDF selection visibility follows viewport resize and activation without clearing the selection', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  for (const active of [true, false]) {
    const selection = { status: 'exact', locator: { kind: 'pdf' } }
    const boundary = { left: 20, right: 580, top: 20, bottom: 720 }
    let hostBoundary = boundary
    const presentation = { point: { x: 100, y: 100 }, visible: true, boundary }
    let viewport: typeof presentation | null = presentation
    const published: { selection: unknown; visible: boolean }[] = []
    const synchronize = readingExpression<() => void>(
      source,
      (node) =>
        ts.isArrowFunction(node) &&
        ts.isCallExpression(node.parent) &&
        node.parent.expression.getText() === 'useCallback' &&
        node.getText().includes('persistedSelectionViewport'),
      {
        active,
        viewportRef: { current: {} },
        selections: [{}],
        sessionId: 'session',
        tabId: 'tab',
        persistedSelectionViewport: () => viewport,
        pdfSelectionBoundary: () => hostBoundary,
        controller: {
          getSnapshot: () => ({
            sessions: { session: { selection } },
            selectionPresentations: { tab: presentation },
          }),
          setSelection: (_tabId: string, selected: unknown, next: typeof presentation) =>
            published.push({ selection: selected, visible: next.visible }),
        },
      }
    )
    let resize = (): void => {}
    let windowResize: (() => void) | undefined
    let disconnected = false
    const effect = readingExpression<() => (() => void) | undefined>(
      source,
      (node) =>
        ts.isArrowFunction(node) &&
        ts.isCallExpression(node.parent) &&
        node.parent.expression.getText() === 'useLayoutEffect' &&
        node.getText().includes('new ResizeObserver(syncSelectionViewport)'),
      {
        viewportRef: { current: {} },
        syncSelectionViewport: synchronize,
        window: {
          addEventListener: (_name: string, callback: () => void) => {
            windowResize = callback
          },
          removeEventListener: (_name: string, callback: () => void) => {
            assert.equal(callback, windowResize)
            windowResize = undefined
          },
        },
        ResizeObserver: class {
          constructor(callback: () => void) {
            resize = callback
          }
          observe(): void {}
          disconnect(): void {
            disconnected = true
          }
        },
      }
    )
    const cleanup = effect()
    assert.deepEqual(published.at(-1), { selection, visible: active })
    viewport = { ...presentation, visible: false }
    resize()
    assert.deepEqual(published.at(-1), { selection, visible: active })
    hostBoundary = { ...boundary, right: boundary.left }
    viewport = { ...presentation, boundary: hostBoundary }
    windowResize?.()
    assert.deepEqual(published.at(-1), { selection, visible: false })
    viewport = null
    resize()
    assert.deepEqual(published.at(-1), { selection, visible: false })
    hostBoundary = boundary
    windowResize?.()
    assert.deepEqual(published.at(-1), { selection, visible: active })
    viewport = presentation
    resize()
    assert.deepEqual(published.at(-1), { selection, visible: active })
    cleanup?.()
    assert.equal(disconnected, true)
    assert.equal(windowResize, undefined)
  }
})

test('resizable document panels expand independently of content-owned header actions', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  let expanded: string | null = null
  const toggle = readingExpression<(() => void) | undefined>(
    source,
    (node) =>
      Boolean(node.parent) &&
      ts.isJsxExpression(node.parent) &&
      ts.isJsxAttribute(node.parent.parent) &&
      node.parent.parent.name.getText() === 'onToggleExpanded' &&
      node.getText().includes('activeDocumentPanel'),
    {
      activeDocumentPanel: { id: 'notes', headerActions: 'content', resizable: true },
      setExpandedPanel: (update: (value: string | null) => string | null) => {
        expanded = update(expanded)
      },
      preserveReadingPosition: () => {},
    }
  )
  assert.equal(typeof toggle, 'function')
  toggle?.()
  assert.equal(expanded, 'notes')
  toggle?.()
  assert.equal(expanded, null)
})

test('PDF split layout includes opted-in document panels without changing fixed panels', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const value = <Result>(name: string, bindings: Record<string, unknown>): Result =>
    readingExpression<Result>(
      source,
      (node) =>
        Boolean(node.parent) &&
        ts.isVariableDeclaration(node.parent) &&
        node.parent.initializer === node &&
        node.parent.name.getText() === name,
      bindings
    )
  for (const scenario of [
    { resizable: true, panel: null, expandedPanel: null, open: true, expanded: false },
    { resizable: true, panel: null, expandedPanel: 'notes', open: true, expanded: true },
    { resizable: false, panel: null, expandedPanel: null, open: false, expanded: false },
    { resizable: true, panel: 'interpretation', expandedPanel: null, open: true, expanded: false },
    {
      resizable: true,
      panel: 'document_translation',
      expandedPanel: null,
      open: false,
      expanded: false,
    },
  ]) {
    const bindings = {
      activeDocumentPanel: { id: 'notes', resizable: scenario.resizable },
      analysis: { panel: scenario.panel, panelExpanded: false, expandedSelectionResult: null },
      expandedPanel: scenario.expandedPanel,
    }
    const resizableDocumentPanel = value<boolean>('resizableDocumentPanel', bindings)
    assert.equal(
      value<boolean>('readingPanelOpen', { ...bindings, resizableDocumentPanel }),
      scenario.open
    )
    assert.equal(
      value<boolean>('readingPanelExpanded', { ...bindings, resizableDocumentPanel }),
      scenario.expanded
    )
  }
  const feature = readFileSync(new URL('../literature/feature.tsx', import.meta.url), 'utf8')
  const resizable = readingExpression<boolean>(
    feature,
    (node) =>
      Boolean(node.parent) &&
      ts.isPropertyAssignment(node.parent) &&
      node.parent.name.getText() === 'resizable' &&
      node.parent.initializer === node &&
      node.parent.parent.getText().includes('id: LITERATURE_NOTES_PANEL_ID'),
    {}
  )
  assert.equal(resizable, true)
})

test('a new PDF selection closes selection results without closing figure results', () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  for (const previous of [
    'selection_translation',
    'selection_explanation',
    'figure_explanation',
    null,
  ]) {
    let floating = previous
    const effect = readingExpression<() => void>(
      source,
      (node) =>
        ts.isArrowFunction(node) &&
        ts.isCallExpression(node.parent) &&
        node.parent.expression.getText() === 'useEffect' &&
        node.getText().includes('setSelectionExplanationSnapshot([])') &&
        node.parent.getText().endsWith('[selectionIdentity])'),
      {
        selection: [{ page: 1, text: 'new selection' }],
        setSelectionResultMark: () => {},
        SELECTION_ACTIONS: new Set(['selection_translation', 'selection_explanation']),
        setFloating: (update: (current: typeof floating) => typeof floating) => {
          floating = update(floating)
        },
        setSelectionExplanationOpen: () => {},
        setSelectionExplanationDraft: () => {},
        setSelectionExplanationSnapshot: () => {},
        setResults: () => {},
      }
    )
    effect()
    assert.equal(floating, previous === 'figure_explanation' ? previous : null)
  }
})

test('comment editor persistence replaces only the requested annotation comments and preserves record identities', async () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const records = {
    schema_version: 3,
    marks: [
      { id: 'selected', style: 'highlight' },
      { id: 'other', style: 'comment' },
    ],
    comments: [
      { id: 'first', mark_id: 'selected', body: 'original', created_at: 11 },
      { id: 'second', mark_id: 'selected', body: 'another', created_at: 12 },
      { id: 'unrelated', mark_id: 'other', body: 'keep', created_at: 13 },
    ],
    notes: [{ id: 'note', body: 'keep note' }],
  }
  const writes: Array<{ records: typeof records; focus: unknown }> = []
  let succeeds = true
  const update = readingExpression<
    (markId: string, drafts: Array<{ id: string; body: string }>) => Promise<boolean>
  >(
    source,
    (node) =>
      Boolean(node.parent) &&
      ts.isVariableDeclaration(node.parent) &&
      node.parent.name.getText() === 'updateMarkComments' &&
      node.parent.initializer === node,
    {
      sidecar: { records },
      persistRecords: async (next: typeof records, { focus }: { focus: unknown }) => {
        writes.push({ records: next, focus })
        return succeeds
      },
    }
  )
  assert.equal(await update('selected', [{ id: 'first', body: ' edited ' }]), true)
  assert.deepEqual(writes[0].records.comments, [
    { id: 'first', mark_id: 'selected', body: 'edited', created_at: 11 },
    records.comments[1],
    records.comments[2],
  ])
  assert.equal(writes[0].records.comments[1], records.comments[1])
  assert.equal(writes[0].records.comments[2], records.comments[2])
  assert.equal(writes[0].records.marks, records.marks)
  assert.equal(writes[0].records.notes, records.notes)
  assert.equal(writes[0].records.schema_version, records.schema_version)
  assert.equal(writes[0].focus, records.marks[0])
  assert.equal(records.comments[0].body, 'original')
  for (const [markId, drafts] of [
    ['selected', [{ id: 'unrelated', body: 'wrong owner' }]],
    ['selected', [{ id: 'missing', body: 'deleted comment' }]],
    ['missing', [{ id: 'first', body: 'missing annotation' }]],
    ['selected', [{ id: 'first', body: '  ' }]],
    ['selected', []],
  ] as const) {
    assert.equal(await update(markId, [...drafts]), false)
  }
  assert.equal(writes.length, 1)
  succeeds = false
  assert.equal(await update('selected', [{ id: 'first', body: 'not saved' }]), false)
  assert.equal(records.comments[0].body, 'original')
})

test('reader merge preserves target translation without task-specific display extensions', () => {
  const reading = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const document = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(
    reading,
    /literatureTranslationPreferences|setLiteratureTranslationChoice|readTranslationTypography|translationRefreshPending|TranslationLayout|translationControlsOpen/
  )
  assert.doesNotMatch(
    document,
    /automaticTranslationSelection|handleTextLayer|translationColumnMinimum/
  )
  assert.match(reading, /run\(\s*'document_translation'/)
  assert.match(reading, /translationDirty\(value, appliedTranslations\[kind\]\)/)
  assert.match(reading, /pdfSelectionRefreshPending/)
  assert.match(document, /onCommentRail=\{handleCommentRail\}/)
  assert.match(document, /const consumedAnnotationFocus/)
})

test('PDF toolbar uses the target preference owner when available and local fallback otherwise', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const evaluate = <Result>(name: string, bindings: Record<string, unknown>): Result =>
    readingExpression<Result>(
      source,
      (node) =>
        Boolean(node.parent) &&
        ts.isVariableDeclaration(node.parent) &&
        node.parent.name.getText() === name &&
        node.parent.initializer === node,
      bindings
    )
  for (const backendAvailable of [false, true]) {
    for (const toolbar of [false, true]) {
      for (const fallback of [false, true]) {
        const updates: unknown[] = []
        const localUpdates: boolean[] = []
        const bindings = {
          translationBackend: backendAvailable
            ? { update: (patch: unknown) => updates.push(patch) }
            : null,
          translationSettings: backendAvailable ? { toolbar, preferencesReady: true } : null,
          appState: { pdfSelectionToolbarEnabled: fallback },
          appActions: {
            setPdfSelectionToolbarEnabled: (value: boolean) => localUpdates.push(value),
          },
        }
        assert.equal(
          evaluate('selectionToolbarEnabled', bindings),
          backendAvailable ? toolbar : fallback
        )
        const selectionToolbarDisabled = evaluate<boolean>('selectionToolbarDisabled', bindings)
        assert.equal(selectionToolbarDisabled, false)
        const update = evaluate<(value: boolean) => void>('setSelectionToolbarEnabled', {
          ...bindings,
          selectionToolbarDisabled,
          useCallback: (callback: unknown) => callback,
        })
        update(false)
        assert.deepEqual(updates, backendAvailable ? [{ toolbar: false }] : [])
        assert.deepEqual(localUpdates, backendAvailable ? [] : [false])
      }
    }
  }
  for (const settings of [
    { preferencesReady: false },
    { preferencesReady: true, preferencesSaving: true },
  ]) {
    const updates: unknown[] = []
    const bindings = {
      translationBackend: { update: (patch: unknown) => updates.push(patch) },
      translationSettings: settings,
      appActions: { setPdfSelectionToolbarEnabled: () => assert.fail('wrong owner') },
    }
    const selectionToolbarDisabled = evaluate<boolean>('selectionToolbarDisabled', bindings)
    assert.equal(selectionToolbarDisabled, true)
    const update = evaluate<(value: boolean) => void>('setSelectionToolbarEnabled', {
      ...bindings,
      selectionToolbarDisabled,
      useCallback: (callback: unknown) => callback,
    })
    update(true)
    assert.deepEqual(updates, [])
  }
})

test('PDF evidence navigation groups duplicate pages without losing supporting quotes', () => {
  const anchors = [
    { page: 2, quote: 'B' },
    { page: 1, quote: 'A' },
    { page: 1, quote: 'A2' },
    { page: 1, quote: 'A' },
  ]
  assert.deepEqual(evidencePages(anchors), [
    { page: 1, quote: 'A\n\nA2' },
    { page: 2, quote: 'B' },
  ])
  assert.equal(anchors.length, 4)
  assert.deepEqual(evidencePages(), [])
})

test('note source annotation focus requires a current exact mark and preserves right panels', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const focus = source.slice(
    source.indexOf('const consumedAnnotationFocus'),
    source.indexOf('if (query.trim())')
  )
  assert.match(source, /reading\?\.\[ANNOTATION_VIEW_STATE_KEY\]/)
  assert.match(focus, /annotationFocus\.revision !== session\?\.revision/)
  assert.match(focus, /sidecar\?\.source_revision !== session\.revision/)
  assert.match(focus, /candidate\.id === annotationFocus\.markId/)
  assert.match(focus, /candidate\.page === annotationFocus\.page/)
  assert.match(focus, /candidate\.anchor_state === 'anchored'/)
  assert.match(focus, /setActiveMark\(mark.id\)/)
  assert.match(focus, /requestFocus\(\{ kind: 'annotation', page: mark\.page, id: mark\.id \}\)/)
  assert.doesNotMatch(focus, /closeDocumentPanel|setPanel|setSelection/)
})

test('figure explanation omits page navigation while other reading outputs retain it', () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  assert.match(source, /<Markdown text=\{floatingResult\?\.text \?\? figureText\}/)
  assert.match(source, /output\(floatingResult, true\)/)
  assert.match(source, /showEvidence &&\s*evidencePages\(content.evidence\)/)
})

test('PDF owns its toolbar so the Dock does not reserve an empty row', () => {
  const feature = readFileSync(new URL('./feature.tsx', import.meta.url), 'utf8')
  assert.match(feature, /kind: 'pdf',[\s\S]*toolbar: 'viewer'/)
})

test('PDF rail actions are icon-only and side panels can fill the PDF area', () => {
  const document = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const reading = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const panel = readFileSync(new URL('./pdf/Panel.tsx', import.meta.url), 'utf8')
  const floatingWindow = readFileSync(
    new URL('../../components/primitive/FloatingWindow.tsx', import.meta.url),
    'utf8'
  )
  assert.doesNotMatch(document, /data-testid="pdf-annotation-toggle"/)
  assert.match(document, /data-testid="pdf-annotations-tab"/)
  assert.match(document, /<nav\s+aria-label=\{t\('pdfToolbar\.toolbar'\)\}[^>]*items-center/)
  assert.match(document, /const label = panel\.label\(i18n\)/)
  assert.ok(
    document.indexOf("{documentPanelActions('start')}") < document.indexOf('{analysis.railActions}')
  )
  assert.ok(
    document.indexOf('{analysis.railActions}') < document.indexOf("{documentPanelActions('end')}")
  )
  assert.match(document, /icon=\{panel\.icon \?\? <NotepadText/)
  assert.doesNotMatch(document, /literature-information/)
  assert.match(
    document,
    /<Tooltip key=\{panel\.id\} portalled content=\{label\} side="left">[\s\S]*data-testid=\{`document-panel-toggle-\$\{panel\.id\}`\}[\s\S]*label=\{label\}[\s\S]*title=\{undefined\}/
  )
  assert.doesNotMatch(
    document,
    /<Tooltip portalled content=\{t\('pdfAnnotation\.records'\)\} side="left">/
  )
  assert.match(
    reading,
    /<Tooltip portalled content=\{LABELS\.document_translation\} side="left">[\s\S]*data-testid="pdf-document-translation"[^>]*title=\{undefined\}/
  )
  assert.match(
    reading,
    /<Tooltip portalled content=\{LABELS\.interpretation\} side="left">[\s\S]*data-testid="pdf-interpretation"[^>]*title=\{undefined\}/
  )
  assert.match(reading, /<PdfPanel[\s\S]*testId="pdf-reading-panel"/)
  assert.match(
    document,
    /<PdfPanel[\s\S]*testId=\{`document-panel-\$\{activeDocumentPanel\.id\}`\}/
  )
  assert.match(
    panel,
    /className=\{`flex min-h-\[var\(--vds-workbench-header-height\)\] items-center justify-between gap-\[var\(--vds-space-2\)\][^\n]*headerSeparator \? 'px-\[var\(--vds-space-3\)\]' : 'px-\[var\(--vds-space-4\)\]'[^\n]*py-\[var\(--vds-space-2\)\]/
  )
  assert.match(panel, /icon=\{<Icon name="close" size=\{14\} \/>\}/)
  assert.match(floatingWindow, /data-testid="floating-window-toggle-size"/)
})

test('figure explanation keeps a stable toolbar button and replaces in-flight streams', () => {
  const reading = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const viewer = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const zh = JSON.parse(
    readFileSync(new URL('../../../../localization/locales/zh/pdf.json', import.meta.url), 'utf8')
  )
  const en = JSON.parse(
    readFileSync(new URL('../../../../localization/locales/en/pdf.json', import.meta.url), 'utf8')
  )

  assert.match(reading, /data-testid="pdf-figure-explanation"/)
  assert.match(reading, /const figureModelSupportsImageInput = Boolean/)
  assert.match(reading, /if \(!figureModelSupportsImageInput\)/)
  assert.match(reading, /code: 'pdf_ai_image_input_unsupported'/)
  assert.match(reading, /lastFigureRegion\.current = region/)
  assert.match(
    reading,
    /kind === 'figure_explanation' && lastFigureRegion\.current\)\s*startFigure\(lastFigureRegion\.current\)/
  )
  assert.match(reading, /data-testid="pdf-figure-explanation"[^>]*disabled/)
  assert.match(reading, /<HoverCardContent\s+side="bottom"/)
  assert.doesNotMatch(reading, /reading\.figureScope/)
  assert.match(reading, /figureAbort\.current\?\.abort\(\)/)
  assert.match(reading, /invokeFigure\(request, figureController\.signal/)
  assert.doesNotMatch(reading, /figureQueue|figureQueued/)
  assert.doesNotMatch(reading, /figureHistory|setFigureHistory/)
  assert.match(
    reading,
    /floatingResult \|\|\s*busy \|\|\s*cropPreview \|\|\s*jobs\.figure_explanation\?\.error \|\|\s*jobs\.figure_explanation\?\.failed \? \(\s*<Card/
  )
  assert.doesNotMatch(reading, /figureResult', \{ index:/)
  assert.doesNotMatch(reading, /figureResultPending', \{ index:/)
  assert.equal(zh.reading.figureResult, '选区 · 第 {{page}} 页')
  assert.equal(zh.reading.figureResultPending, '选区 · 正在解释…')
  assert.equal(en.reading.figureResult, 'Selection · Page {{page}}')
  assert.equal(en.reading.figureResultPending, 'Selection · Explaining…')
  assert.match(zh.reading.figureUnavailable, /当前模型.*图片输入/)
  assert.match(en.reading.figureUnavailable, /current model.*image input/i)
  assert.match(
    reading,
    /action !== 'figure_explanation' &&\s*action !== 'document_translation' &&\s*action !== 'selection_translation' &&\s*action !== 'selection_explanation' &&\s*action !== 'formula_latex' &&\s*jobBusy\(job\)/
  )
  assert.match(reading, /selectionResultKind \? \(\s*<section/)
  assert.match(reading, /<FigureGuide t=\{t\}/)
  assert.match(reading, /const FIGURE_GUIDE_SCALE = 4 \/ 7/)
  assert.match(
    reading,
    /width: `min\(\$\{FIGURE_GUIDE_WIDTH_PX\}px, calc\(100vw - \$\{FIGURE_GUIDE_VIEWPORT_GUTTER_PX\}px\)\)`/
  )
  assert.match(reading, /zoom: FIGURE_GUIDE_SCALE/)
  assert.match(reading, /gridTemplateColumns: '220px minmax\(0, 1fr\)'/)
  assert.match(
    reading,
    /<IconButton\s+data-testid="pdf-figure-explanation"[\s\S]*?aria-pressed=\{figure\}[\s\S]*?variant="ghostIcon"/
  )
  assert.match(reading, /<Button\s+data-testid="pdf-figure-explanation"/)
  assert.match(reading, /\{t\('reading.figure'\)\}\s*<\/Button>/)
  expressions(reading)(
    "() => { setFloating(null); void cancel('figure_explanation'); exitFigureSelection() }"
  )
  assert.match(reading, /figurePromptGuide/)
  assert.match(reading, /<HoverCardTrigger\s+asChild\s+onClick=/)
  expressions(reading)(
    '() => { if (figure) exitFigureSelection(); else { onExclusiveSurfaceOpen(); setFigure(true); setFigureGuideOpen(false) } selectPanel(null) }'
  )
  assert.match(reading, /<rect x="160" y="36" width="24" height="96"/)
  assert.match(reading, /M178 168L190 224L202 207L220 223L230 212L212 196L230 184/)
  assert.match(reading, /border-l border-\[var\(--vds-border-default\)\]/)
  assert.match(reading, /strokeDasharray="7 7"/)
  assert.doesNotMatch(reading, /border-r border-\[var\(--vds-border-default\)\]/)
  assert.doesNotMatch(reading, /selectFigure: \([^)]*\) => \{ setFigure\(false\)/)
  assert.match(viewer, /event\.key !== 'Escape'/)
  assert.match(viewer, /cropBox\.width >= MIN_FIGURE_SELECTION_PX/)
  assert.match(viewer, /analysis\.setFigureGuideOpen\(false\)/)
})

test('PDF visual regions expose automatic explain and copy without blocking text selection', () => {
  const viewer = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const page = readFileSync(new URL('./pdf/Page.tsx', import.meta.url), 'utf8')
  const analysis = readFileSync(new URL('./pdf/analysis.ts', import.meta.url), 'utf8')
  const reading = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const zh = JSON.parse(
    readFileSync(new URL('../../../../localization/locales/zh/pdf.json', import.meta.url), 'utf8')
  )
  const en = JSON.parse(
    readFileSync(new URL('../../../../localization/locales/en/pdf.json', import.meta.url), 'utf8')
  )

  assert.match(analysis, /export type PdfVisualRegionKind = 'formula' \| 'figure' \| 'table'/)
  assert.match(analysis, /region_id: string/)
  assert.match(analysis, /formula_latex/)
  assert.doesNotMatch(viewer, /loadPdfVisualRegions/)
  assert.match(page, /groupPdfRegions/)
  assert.match(page, /paintedGraphics/)
  assert.match(reading, /rect: visualRegionRect\(region\)/)
  assert.match(analysis, /query\.append\('quad', String\(coordinate\)\)/)
  assert.match(viewer, /writeClipboardImage/)
  assert.match(viewer, /analysis\.explainRegion/)
  assert.match(viewer, /analysis\.copyFormula/)
  assert.match(page, /data-pdf-visual-region=/)
  assert.match(page, /pointer-events-none[\s\S]*pointer-events-auto/)
  assert.match(page, /onVisualRegionExplain/)
  assert.match(page, /onVisualRegionCopy/)
  assert.match(page, /copyingVisualRegionId/)
  assert.match(page, /focusedRegion === region\.region_id \|\| copying/)
  assert.match(page, /loading=\{copying\}/)
  assert.match(page, /event\.key === 'Escape'/)
  assert.match(reading, /const explainRegion/)
  assert.match(reading, /const copyFormula/)
  assert.match(reading, /IMAGE_INPUT_ACTIONS/)
  assert.match(reading, /const figureModelSupportsImageInput = Boolean/)
  assert.match(reading, /visualRegionImageInputAvailable: figureModelSupportsImageInput/)
  assert.match(
    viewer,
    /visualRegionImageInputAvailable=\{analysis\.visualRegionImageInputAvailable\}/
  )
  assert.match(
    page,
    /disabled=\{!visualRegionImageInputAvailable\}[\s\S]*onClick=\{\(\) => onVisualRegionExplain\?\.\(region\)\}/
  )
  assert.match(
    page,
    /disabled=\{region\.kind === 'formula' && !visualRegionImageInputAvailable\}[\s\S]*onClick=\{\(\) => onVisualRegionCopy\?\.\(region\)\}/
  )
  assert.match(
    page,
    /visualRegionImageInputAvailable \? \(\s*explainButton\s*\) : \(\s*<Tooltip portalled content=\{t\('reading\.figureUnavailable'\)\} side="bottom">/
  )
  assert.match(
    page,
    /formulaCopyUnavailable \? \(\s*<Tooltip portalled content=\{t\('reading\.figureUnavailable'\)\} side="bottom">/
  )
  assert.match(reading, /copyingFormulaRegionId: isBusy\('formula_latex'\)/)
  assert.match(reading, /action !== 'formula_latex'/)
  assert.match(
    reading,
    /toast\(\{ title: t\('visualRegions\.formulaCopied'\), tone: 'success' \}\)/
  )
  assert.match(reading, /pdfAiFailureText\(formulaFailure, t\)/)
  assert.match(viewer, /copyingVisualRegionId=\{analysis\.copyingFormulaRegionId\}/)
  assert.equal(zh.visualRegions.copyFormula, '复制 LaTeX')
  assert.equal(zh.visualRegions.copyImage, '复制图片')
  assert.equal(en.visualRegions.explain, 'Explain')
  assert.equal(zh.reading.figureUnavailable, '当前模型未声明支持图片输入，请切换支持图片的模型。')
})

test('PDF surfaces exit figure selection through one transition', () => {
  const reading = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const viewer = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')

  assert.match(
    reading,
    /const exitFigureSelection = useCallback\(\(\): void => \{\s*setFigure\(false\)\s*setFigureGuideOpen\(false\)\s*\}, \[\]\)/
  )
  assert.match(
    reading,
    /toggleInterpretation[\s\S]*exitFigureSelection\(\)[\s\S]*onExclusiveSurfaceOpen\(\)/
  )
  assert.match(
    reading,
    /changeTranslationMenu[\s\S]*exitFigureSelection\(\)[\s\S]*onExclusiveSurfaceOpen\(\)/
  )
  assert.match(
    viewer,
    /const clearFigureSelection = useCallback\(\(\): void => \{\s*cropStart\.current = undefined\s*setCropBox\(null\)/
  )
  assert.match(
    viewer,
    /const exitFigureSelection = useCallback\(\(\): void => \{\s*clearFigureSelection\(\)\s*analysis\.exitFigureSelection\(\)/
  )
  assert.match(
    viewer,
    /data-testid=\{`document-panel-toggle-\$\{panel\.id\}`\}[\s\S]*exitFigureSelection\(\)[\s\S]*documentPanels\.toggle\(panel\.id\)/
  )
  assert.match(viewer, /<TabsContent value="annotations"[\s\S]*<PdfAnnotations/)
})

test('literature AI actions expose independent persisted model selectors', () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const shared = readFileSync(
    new URL('../../components/business/Reading.tsx', import.meta.url),
    'utf8'
  )
  assert.match(
    source,
    /import \{ ModelMenu \} from '\.\.\/\.\.\/\.\.\/components\/business\/ModelMenu'/
  )
  assert.match(source, /t\('reading\.currentModel'\)/)
  assert.match(source, /state\.literatureAiModels/)
  assert.match(source, /actions\.setLiteratureAiModel\(kind, model\.key\)/)
  assert.match(source, /modelControl\('figure_explanation', true\)/)
  assert.match(source, /modelControl\('document_translation', false, 'engine'\)/)
  assert.match(shared, /act\.setLiteratureAiModel\('interpretation', model\.key\)/)
  assert.match(shared, /testIdPrefix="pdf-interpretation-model"/)
  assert.match(
    source,
    /floating === 'selection_translation' \|\| floating === 'selection_explanation'/
  )
  assert.match(source, /modelControl\(selectionResultKind\)/)
  assert.match(source, /new Set<PdfAction>\(LITERATURE_AI_MODEL_ACTIONS\)/)
  assert.match(source, /data-testid=\{`pdf-\$\{floating\}-regenerate`\}/)
  assert.match(
    source,
    /run\(\s*floating,\s*request.module,\s*undefined,\s*request,\s*directions\[floating\] \?\? request.target_language\s*\)/
  )
  assert.match(source, /modelFilter=\{multimodal \? MULTIMODAL_MODEL_FILTER : undefined\}/)
  assert.match(source, /kind === 'formula_latex' \? 'figure_explanation' : kind/)
  const modelKey = (choice: { engine: string } | null): string =>
    readingExpression<string>(
      source,
      (node) =>
        ts.isConditionalExpression(node) &&
        ts.isVariableDeclaration(node.parent) &&
        node.parent.name.getText() === 'modelKey',
      {
        choice,
        AI_ENGINE_PREFIX: 'ai:',
        kind: 'selection_explanation',
        state: { catalog: { models: [{ key: 'available', disabled: false }] } },
        actionModelKey: (kind: string) => `action:${kind}`,
        translationModelKey: (value: { engine: string }, available: string[]) => {
          assert.deepEqual(available, ['available'])
          return value.engine
        },
      }
    )
  assert.equal(modelKey(null), 'action:selection_explanation')
  assert.equal(modelKey({ engine: 'ai:' }), 'action:selection_explanation')
  assert.equal(modelKey({ engine: 'ai:chosen' }), 'ai:chosen')
  assert.match(source, /model_key: modelKey,\s*kind/)
  assert.match(source, /literature_id: literatureId,\s*attachment_id: attachmentId/)
  documentExpressions(
    "excerptSource?.literatureId === literatureId ? excerptSource.title : ''",
    'analysis'
  )
})

test('PDF explanation requests follow the committed interface language', () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const analysis = readFileSync(new URL('./pdf/analysis.ts', import.meta.url), 'utf8')

  assert.match(source, /pdfResponseLanguage\(i18n\.resolvedLanguage \|\| i18n\.language\)/)
  assert.match(source, /response_language: responseLanguage/)
  const shared = readFileSync(
    new URL('../../components/business/Reading.tsx', import.meta.url),
    'utf8'
  )
  assert.match(shared, /startsWith\('en'\) \? 'en' : 'zh'/)
  assert.match(analysis, /startsWith\('en'\) \? 'en' : 'zh'/)
})

test('figure explanation keeps a synchronous capability failure visible', () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  assert.match(
    source,
    /jobs\.figure_explanation\?\.error \|\|\s*jobs\.figure_explanation\?\.failed \? \(\s*<Card/
  )
  assert.match(source, /feedback\('figure_explanation'\)/)
})

const BROKEN_CONTENTS_PDF = new URL(
  '../../../../../e2e/fixtures/preview_pdf_1MB.pdf',
  import.meta.url
)

test('selection actions hide previous results while generating explanation or translation', () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  assert.match(source, /selectionRefreshPending/)
  expressions(source)('(model) => actions.setLiteratureAiModel(kind, model.key)', {
    attribute: 'onModelSelect',
  })
  assert.match(source, /REPLACEABLE_ACTIONS\.has\(kind\)/)
  assert.match(source, /const \{ \[kind\]: _stale, \.\.\.remaining \} = previous/)
  for (const floating of ['selection_explanation', 'selection_translation']) {
    for (const busy of [false, true]) {
      const previous = { text: 'previous result' }
      const result = readingExpression(
        source,
        (node) =>
          ts.isConditionalExpression(node) &&
          ts.isVariableDeclaration(node.parent) &&
          node.parent.name.getText() === 'floatingResult',
        { floating, busy, results: { [floating]: previous } }
      )
      assert.equal(result, !busy ? previous : undefined)
    }
  }
  assert.doesNotMatch(source, /reading\.previousSource/)
  assert.doesNotMatch(source, /previousTranslation/)
})

test('PDF actions isolate requests and allow a new selection to replace busy work', () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  assert.match(source, /requests.current\[kind\] = request/)
  assert.doesNotMatch(source, /disabled=\{isBusy\('selection_explanation'\)\}/)
  assert.doesNotMatch(source, /disabled=\{isBusy\('selection_translation'\)\}/)
  assert.match(source, /REPLACEABLE_ACTIONS\.has\(kind\)/)
  assert.match(source, /<PaperReading\s/)
  assert.match(source, /feedback\(selectionResultKind\)/)
  assert.match(source, /cancel\(kind\)/)
  assert.doesNotMatch(source, /if \(busy\) return/)
})

test('hidden remembered document panels do not reserve PDF track width', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  for (const panel of [null, 'document_translation', 'interpretation']) {
    const activeDocumentPanelId = 'reader-notes'
    const analysis = { panel, sidePanel: panel === 'interpretation' ? {} : null }
    const open = readingExpression<boolean>(
      source,
      (node) =>
        Boolean(node.parent) &&
        ts.isVariableDeclaration(node.parent) &&
        node.parent.name.getText() === 'rightPanelOpen' &&
        node.parent.initializer === node,
      { analysis, activeDocumentPanelId }
    )
    assert.equal(open, panel !== 'document_translation')
    assert.equal(activeDocumentPanelId, 'reader-notes')
  }
})

test('document translation pairs every PDF page with a same-scale translation page in one scroll flow', () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const documentSource = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const panelSource = readFileSync(new URL('./pdf/Panel.tsx', import.meta.url), 'utf8')

  assert.match(source, /data-testid="pdf-document-translation"/)
  assert.match(
    source,
    /className="box-border flex flex-col overflow-hidden rounded-none! !\[border:0\] bg-\[var\(--vds-bg-white-default\)\] !\[box-shadow:none\]"/
  )
  assert.doesNotMatch(
    source,
    /page === sourcePage \? ' ring-1 ring-\[var\(--vds-border-strong\)\]'/
  )
  assert.match(
    source,
    /<CardHeader className="relative mb-0 flex! flex-wrap items-center justify-between border-b/
  )
  const translationPage = source.slice(
    source.indexOf('const translationPage ='),
    source.indexOf('function modelControl')
  )
  const pageHeader = translationPage.slice(0, translationPage.indexOf('</CardHeader>'))
  assert.match(pageHeader, /\{sourcePage\}\/\{pageCount\}/)
  assert.match(pageHeader, /reading\.retranslatePage/)
  assert.match(pageHeader, /reading\.copyTranslationPage/)
  assert.match(pageHeader, /reading\.hideTranslationPage/)
  assert.doesNotMatch(pageHeader, /<Switch|modelControl\(/)
  assert.match(translationPage, /waiting \|\| pageBusy/)
  assert.match(translationPage, /setTranslationPageClosed\(sourcePage, false\)/)
  assert.match(translationPage, /reading\.openTranslationPage/)
  assert.match(translationPage, /onClick=\{\(\) => runTranslationPage\(sourcePage\)\}/)
  assert.match(source, /<Translation\s+sentences=\{content\.blocks\}[\s\S]*?compact\s+sections/)
  const translation = readFileSync(new URL('./pdf/Translation.tsx', import.meta.url), 'utf8')
  assert.match(
    translation,
    /compact \? 'text-\[length:var\(--vds-pdf-translation-body-font-size\)\] font-\[var\(--vds-fw-regular\)\] leading-\[var\(--vds-pdf-translation-line-height\)\]' : 'text-sm leading-\[var\(--vds-pdf-reading-content-line-height\)\]'/
  )
  assert.match(translation, /sentence\.heading \? 'font-\[var\(--vds-fw-semibold\)\]' : ''/)
  assert.match(translation, /data-translation-paragraph=\{node\.id\}/)
  const menu = source.slice(source.indexOf('<Popover open={translationMenuOpen}'))
  assert.match(menu, /aria-pressed=\{panel === 'document_translation'\}/)
  assert.match(menu, /onCheckedChange=\{changeDocumentTranslation\}/)
  assert.match(menu, /checked=\{automaticTranslation\}/)
  assert.match(
    menu,
    /localStorage\.setItem\(\s*PDF_AUTOMATIC_TRANSLATION_PREFERENCE,\s*checked \? 'on' : 'off'\s*\)/
  )
  assert.match(menu, /modelControl\('document_translation', false, 'languages'\)/)
  const automaticToggle = source.slice(
    source.indexOf('const changeAutomaticTranslation'),
    source.indexOf('useEffect(() => {', source.indexOf('const changeAutomaticTranslation'))
  )
  assert.match(automaticToggle, /if \(!checked\) \{\s+setAutomaticTranslation\(false\)/)
  assert.match(automaticToggle, /automaticTranslationRequest\.current && isBusy/)
  assert.match(automaticToggle, /reading\.automaticTranslationPaused/)
  assert.doesNotMatch(automaticToggle, /setPanel\(null\)/)
  const openMenu = source.slice(
    source.indexOf('const changeTranslationMenu'),
    source.indexOf('const selectPanel')
  )
  assert.match(openMenu, /setPanel\('document_translation'\)/)
  assert.match(openMenu, /localStorage\.getItem\(PDF_AUTOMATIC_TRANSLATION_PREFERENCE\) !== 'off'/)
  assert.match(source, /translationOpen: panel === 'document_translation'/)
  assert.match(source, /translationPage,/)
  assert.match(
    source,
    /style=\{\{ width: pageSize\.width, height: pageSize\.height, zoom: pageScale \}\}/
  )
  assert.match(source, /<CardContent className="min-h-0 flex-1 overflow-y-auto overscroll-contain /)
  assert.match(source, /data-testid=\{`pdf-translation-page-\$\{sourcePage\}`\}/)
  assert.match(documentSource, /data-testid=\{`pdf-page-pair-\$\{number\}`\}/)
  assert.match(
    documentSource,
    /shadow-\[var\(--vds-shadow-2-center\)\][\s\S]*\[&>\.vds-pdf-page-frame\]:m-0 \[&_\.vds-pdf-page\]:!\[box-shadow:none\]/
  )
  assert.match(
    documentSource,
    /before:left-\[var\(--pdf-source-page-width\)\][\s\S]*before:bg-\[var\(--vds-border-default\)\]/
  )
  assert.match(
    documentSource,
    /'--pdf-source-page-width': `\$\{translationSourceWidth \* scale\}px`/
  )
  assert.match(documentSource, /hideCommentPins=\{analysis\.translationOpen\}/)
  assert.match(documentSource, /bg-transparent! before:invisible hover:before:visible/)
  assert.match(
    documentSource,
    /translationWidthRatio\(reading\?\.\[PDF_TRANSLATION_WIDTH_STATE_KEY\]\)/
  )
  assert.match(documentSource, /translationSpreadSize\(translationSourceSize, translationRatio\)/)
  assert.match(documentSource, /size\.outerWidth > PDF_WIDE_TRANSLATION_MIN_WIDTH/)
  assert.match(documentSource, /size\.outerWidth - PDF_WIDE_TRANSLATION_GUTTER/)
  assert.match(documentSource, /data-testid=\{`pdf-translation-resize-\$\{number\}`\}/)
  documentExpressions(
    '(open: boolean): void => { setTranslationLayoutOpen(open); if (open) set({ modulePanelOpen: false }) }',
    'handleDocumentTranslationChange'
  )
  assert.match(documentSource, /onDocumentTranslationChange: handleDocumentTranslationChange/)
  documentExpressions(
    'analysis.translationPage(number, { width: translationSourceWidth * scale * translationRatio, height: loadedPage?.getViewport({ scale }).height ?? estimatedPageSize.height * scale }, 1)'
  )
  assert.match(
    documentSource,
    /gridTemplateColumns: `var\(--pdf-source-page-width\) \$\{translationSourceWidth \* scale \* translationRatio\}px`/
  )
  assert.doesNotMatch(documentSource, /items-start gap-\[var\(--vds-space-4\)\]/)
  assert.match(
    documentSource,
    /const rightPanelOpen = Boolean\(analysis\.sidePanel \|\| \(activeDocumentPanelId && !analysis\.panel\)\)/
  )
  assert.doesNotMatch(source, /translationPanelRef|pdf-translation-panel|translationCard\(page\)/)
  assert.doesNotMatch(panelSource, /layout\?: 'overlay' \| 'split'|vds-pdf-panel--split/)
  assert.doesNotMatch(source, /reading\.translateAll/)
})

test('AI interpretation opens saved state and generates only on explicit action', () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const shared = readFileSync(
    new URL('../../components/business/Reading.tsx', import.meta.url),
    'utf8'
  )
  const toggle = source.slice(
    source.indexOf('const toggleInterpretation'),
    source.indexOf('const changeTranslationMenu')
  )
  assert.match(source, /data-testid="pdf-interpretation"/)
  assert.doesNotMatch(source, /reading\.documentScope/)
  assert.match(source, /<FloatingWindow[\s\S]*footer=\{/)
  assert.doesNotMatch(toggle, /run\('interpretation'\)|generateReading/)
  assert.match(source, /<PaperReading\s/)
  assert.match(shared, /void readReading\(/)
  assert.match(shared, /data-testid="pdf-generate-summary"[\s\S]*onClick=\{\(\) => void run\(\)\}/)
  assert.match(shared, /return generateReading\(/)
})

test('the Electron PDF adapter uses the legacy-compatible PDF.js entry and matching worker', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  assert.match(source, /pdfjs-dist\/legacy\/build\/pdf\.mjs/)
  assert.match(source, /pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs\?url/)
})

test('PDF pages expose URI annotations through the default-browser bridge', () => {
  const source = readFileSync(new URL('./pdf/Page.tsx', import.meta.url), 'utf8')
  assert.match(source, /page\s*\.getAnnotations\(\{ intent: PDF_ANNOTATION_INTENT \}\)/)
  assert.match(source, /externalPdfLinks\(annotations, view\)/)
  assert.match(source, /data-testid=\{`pdf-external-link-\$\{page\.pageNumber\}-\$\{index\}`\}/)
  assert.match(source, /window\.scholarseed\.openExternal\(link\.url\)/)
})

test('PDF toolbar uses 32px icon controls with visible and ghost group spacing', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const tools = readFileSync(new URL('./pdf/Tools.tsx', import.meta.url), 'utf8')

  assert.ok(source.includes('[&_.vds-icon-button]:!size-[var(--vds-control-height-md)]'))
  assert.ok(source.includes('[&_button[role=tab]]:!size-[var(--vds-control-height-md)]'))

  assert.match(
    source,
    /vds-pdf-tools[^"\n]*min-h-\[var\(--vds-library-toolbar-height\)\][^"\n]*flex-wrap/u
  )
  assert.match(
    source,
    /flex min-w-0 flex-1 flex-wrap items-center justify-center gap-\[var\(--vds-toolbar-icon-gap\)\]/u
  )
  assert.match(source, /!absolute left-\[var\(--vds-space-3\)\] top-\[var\(--vds-space-2\)\]/u)
  assert.match(source, /size="sm"[^>]*data-testid="pdf-sidebar-toggle"/u)
  assert.doesNotMatch(source, /data-testid="pdf-search-open"/u)
  assert.match(tools, /gap-\[var\(--vds-toolbar-icon-gap\)\][^>]*data-pdf-annotation-tools/u)
})

test('PDF sidebar toggle uses primary text when active and secondary text on inactive hover', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  assert.match(
    source,
    /data-testid="pdf-sidebar-toggle"\s+className="hover:!text-\[var\(--vds-text-secondary\)\] aria-pressed:!text-\[var\(--vds-text-primary\)\] hover:\[&_svg\]:!text-\[var\(--vds-text-secondary\)\] aria-pressed:\[&_svg\]:!text-\[var\(--vds-text-primary\)\] aria-pressed:hover:!text-\[var\(--vds-text-primary\)\] aria-pressed:hover:\[&_svg\]:!text-\[var\(--vds-text-primary\)\]"\s+aria-pressed=\{sidebar\}/u
  )
})

test('PDF mark-only tools do not render a trailing divider', () => {
  const source = readFileSync(new URL('./pdf/Tools.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /compact && section !== 'comment' && \(\s*<Divider/u)
  assert.equal((source.match(/compact && section === 'all' && \(\s*<Divider/gu) ?? []).length, 2)
  const document = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  assert.match(
    document,
    /actions: \(\s*<>\s*<PdfTools\s+section="marks"[\s\S]*?\/>\s*<Divider\s+orientation="vertical"/u
  )
})

test('PDF page number uses a plain numeric text input without stepper controls', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')

  assert.match(source, /data-testid="pdf-page-input"[^>]*type="text"[^>]*inputMode="numeric"/u)
  assert.doesNotMatch(source, /data-testid="pdf-page-input"[^>]*type="number"/u)
  assert.match(
    source,
    /<span className="[^"]*text-\[length:var\(--vds-font-body-lv1\)\][^"]*\[font-weight:var\(--vds-fw-regular\)\][^"]*text-\[var\(--vds-text-tertiary\)\][^"]*">\s*\/ \{pageCount/u
  )
})

test('PDF selection is tab-scoped and clears the shared selection when the DOM selection is empty', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const feature = readFileSync(new URL('./feature.tsx', import.meta.url), 'utf8')
  const page = readFileSync(new URL('./pdf/Page.tsx', import.meta.url), 'utf8')
  assert.match(feature, /<PdfDocumentHost[^>]*sessionId=\{documentSessionId\}[^>]*tabId=\{tabId\}/)
  assert.match(source, /controller\.setSelection\(tabId, null\)/)
  assert.match(source, /persistedSelectionViewport\(/)
  assert.match(page, /data-pdf-selection-highlight/)
})

test('PDF selection pins its full drag span and releases the native range before virtualization', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const page = readFileSync(new URL('./pdf/Page.tsx', import.meta.url), 'utf8')

  assert.match(source, /setSelectionDragSpan\(page \? \{ anchor: page, focus: page \} : null\)/)
  documentExpressions(
    'pageInSelectionSpan(number, selectionDragSpan.anchor, selectionDragSpan.focus)'
  )
  assert.match(
    source,
    /if \(selections\.length && selectionDragSpan === null\) window\.getSelection\(\)\?\.removeAllRanges\(\)/
  )
  assert.match(page, /const renderable = near \|\| keepRendered/)
  assert.match(page, /\{renderable && \(\s*<canvas/)
  assert.match(page, /releaseCanvas\(target\)/)
  assert.match(page, /releaseCanvas\(stagingCanvas\.current\)/)
})

test('PDF annotation rendering and hit testing share the newest-first overlap projection', () => {
  const page = readFileSync(new URL('./pdf/Page.tsx', import.meta.url), 'utf8')

  assert.match(
    page,
    /const visibleAnnotations = useMemo\(\(\) => projectVisibleMarks\(annotations\), \[annotations\]\)/
  )
  assert.match(page, /visibleAnnotations\.find\(\(annotation\) =>\s*annotation\.quads\.some/)
  assert.match(
    page,
    /visibleAnnotations\.flatMap\(\(\{ mark: annotation, quads \}\) =>\s*quads\.map/
  )
  assert.doesNotMatch(page, /\[\.\.\.annotations\]\.reverse\(\)\.find/)
})

test('PDF highlight compositing preserves text while line annotations stay unblended', () => {
  assert.match(PDF_HIGHLIGHT_VISUAL_CLASS, /bg-\[var\(--pdf-mark-color\)\]/)
  assert.equal(pdfMarkVisualClass('highlight'), '')
  assert.doesNotMatch(pdfMarkVisualClass('underline'), /mix-blend-/)
  assert.doesNotMatch(pdfMarkVisualClass('strikethrough'), /mix-blend-/)
})

test('PDF body and annotation sidecar both reload after a restored revision', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  assert.match(source, /\[active, lifecycle, session\?\.revision, sessionId\]/)
  assert.match(source, /\[active, session\?\.documentId, session\?\.revision\]/)
})

test('PDFs without a record owner stay readable without an unsupported annotation banner', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  assert.match(source, /if \(!recordTargetFor\(session\.source\)\) return/)
  assert.doesNotMatch(source, /annotationsUnsupported/)
})

test('PDF records use explicit marks, comments and notes and export underlines', () => {
  const contract = readFileSync(new URL('../../contracts/workbench.ts', import.meta.url), 'utf8')
  const exporter = readFileSync(new URL('./pdf/export.ts', import.meta.url), 'utf8')

  assert.match(contract, /type PdfMarkRecord = PdfTextMarkRecord \| PdfPointMarkRecord/)
  assert.match(contract, /type PdfTextMarkStyle = 'highlight' \| 'underline' \| 'strikethrough'/)
  assert.match(
    contract,
    /interface PdfPointMarkRecord[\s\S]*style: 'comment'[\s\S]*point: \[number, number\][\s\S]*quads: \[\][\s\S]*text: ''/
  )
  assert.match(contract, /interface PdfCommentRecord/)
  assert.match(contract, /interface PdfNoteRecord/)
  assert.match(contract, /interface PdfRecordSnapshot/)
  assert.doesNotMatch(contract, /interface PdfAnnotation/)
  assert.match(exporter, /page\.drawLine/)
  assert.match(exporter, /schema_version: PDF_RECORD_SCHEMA_VERSION/)
  assert.match(exporter, /new TextEncoder\(\)\.encode/)
  assert.match(exporter, /normalizePageContents/)
})

test('PDF export stays available without marks, exposes only a localized failure and prevents duplicate clicks while busy', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  assert.match(source, /PDF_EXPORT_ERROR_CODE/)
  assert.match(source, /disabled=\{!canExport \|\| exporting\}/)
  assert.match(source, /!recordTargetFor\(session.source\) \|\| sidecar/)
  assert.match(source, /exportingRef\.current/)
  assert.match(source, /\[pdf-export\]/)
  assert.doesNotMatch(
    source,
    /data-testid="pdf-export" disabled=\{!sidecar\?\.records\.marks\.length/
  )
  assert.doesNotMatch(source, /setStatus\(error instanceof Error \? error\.message/)
})

test('PDF preserves selection mark actions and owns a literature-only annotation panel', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const annotations = readFileSync(new URL('./pdf/Annotations.tsx', import.meta.url), 'utf8')
  const page = readFileSync(new URL('./pdf/Page.tsx', import.meta.url), 'utf8')
  const annotation = readFileSync(new URL('./pdf/Annotation.tsx', import.meta.url), 'utf8')

  assert.match(source, /useSelectionActionContribution\(tabId, selectionContribution\)/)
  assert.match(source, /session\?\.source\.kind === 'literature'/)
  const tools = readFileSync(new URL('./pdf/Tools.tsx', import.meta.url), 'utf8')
  assert.match(tools, /PDF_MARK_PALETTE\.map/)
  assert.match(tools, /pdfAnnotation\.addStrikethrough/)
  assert.match(tools, /onApply\(tool\.style, colors\[tool\.style\]\)/)
  assert.match(source, /id: 'pdf-records'/)
  assert.match(
    source,
    /className="vds-selection-action-result !border-t-0 !gap-\[var\(--vds-space-3\)\] !p-\[var\(--vds-space-3\)\]"/
  )
  assert.match(source, /<CopyButton/)
  assert.match(source, /<PdfAnnotations/)
  assert.doesNotMatch(source, /写入笔记|添加到笔记/)
  assert.match(annotations, /'data-testid': 'pdf-annotation-list'/)
  assert.match(
    source,
    /<TabsTrigger\s+value="outline"[\s\S]*<TabsTrigger\s+value="pages"[\s\S]*<TabsTrigger\s+value="annotations"[\s\S]*<TabsTrigger\s+value="search"/
  )
  assert.match(source, /update\(\{ records: false, sidebar: true, sidebarTab: 'annotations' \}\)/)
  assert.match(
    source,
    /activeDocumentPanel &&\s*!analysis\.panel &&\s*!analysis\.expandedSelectionResult &&\s*documentPanels/
  )
  assert.doesNotMatch(source, /recordsOpen|PDF_RECORDS_PANEL_ID/)
  assert.match(annotations, /filterMarks/)
  assert.match(annotations, /<Tabs value=\{filter\}/)
  assert.match(annotations, /<TabsTrigger\s+key=\{category\}\s+value=\{category\}/)
  assert.match(annotations, /groupMarksByPage/)
  assert.match(page, /<Popover/)
  assert.match(page, /renderAnnotation/)
  assert.match(annotation, /<PdfTools/)
  assert.match(annotation, /comments\.length \? onUpdateComments/)
  assert.match(annotation, /<PdfCommentEditor/)
  assert.match(annotation, /<PdfSelectionActions>/)
  for (const key of ['comment', 'copy', 'delete']) {
    assert.match(annotation, new RegExp(`pdfAnnotation\\.${key}`))
  }
  assert.doesNotMatch(source, /data-testid="pdf-highlight"/)
  assert.doesNotMatch(source, /data-testid="pdf-note"/)
})

test('PDF annotation feedback keeps failures and deletion success without routine success or undo toasts', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')

  assert.match(source, /statusCode\?: PdfResultCode/)
  assert.match(source, /if \(options\.statusCode\) notifyResult\(options\.statusCode\)/)
  assert.match(source, /notifyResult\('conflict'\)/)
  assert.match(source, /notifyResult\('saveFailed'\)/)
  assert.match(source, /deleteMark[\s\S]*statusCode: 'deleted'/)
  assert.doesNotMatch(
    source,
    /status\.(underlineSaved|highlightSaved|markSaved|strikethroughSaved|updated|commentSaved)/
  )
  assert.doesNotMatch(source, /pdfAnnotation\.undo/)
  assert.doesNotMatch(source, /const \{ dismiss, toast \} = useToast\(\)/)
})

test('PDF annotation inspector groups controls and silently persists direct edits', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const annotation = readFileSync(new URL('./pdf/Annotation.tsx', import.meta.url), 'utf8')
  const updateMark = source.slice(
    source.indexOf('const updateMark'),
    source.indexOf('const applyMark')
  )

  assert.match(
    annotation,
    /data-testid="pdf-annotation-actions"[\s\S]*<PdfSelectionActions>[\s\S]*<PdfTools[\s\S]*data-testid="pdf-annotation-delete"/
  )
  assert.match(annotation, /data-testid="pdf-annotation-actions"[^>]*flex flex-nowrap items-center/)
  assert.match(
    annotation,
    /pdfAnnotation\.explain[\s\S]*pdfAnnotation\.translate[\s\S]*pdfAnnotation\.copy[\s\S]*pdfAnnotation\.comment[\s\S]*pdfAnnotation\.delete/
  )
  assert.doesNotMatch(annotation, /grid-cols-2|col-start-|col-span-|row-start-/)
  assert.match(source, /statusCode\?: PdfResultCode/)
  assert.match(source, /if \(options\.statusCode\) notifyResult\(options\.statusCode\)/)
  assert.doesNotMatch(updateMark, /statusCode/)
})

test('saved PDF annotation AI actions keep their own immutable selection snapshot', () => {
  const documentSource = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const annotation = readFileSync(new URL('./pdf/Annotation.tsx', import.meta.url), 'utf8')
  const reading = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')

  assert.match(annotation, /<section[^>]*onMouseUp=\{\(event\) => event\.stopPropagation\(\)\}/)
  assert.match(documentSource, /renderAnnotation=\{renderAnnotation\}/)
  assert.match(documentSource, /const renderAnnotation = \(\s*mark: PdfMark,\s*close: \(\) => void/)
  documentExpressions(
    "(instruction) => { if (mark.style === 'comment') return\n analysis.explainSelection({ page: mark.page, text: mark.text, quads: mark.quads }, instruction, mark.id) }",
    { attribute: 'onExplain' }
  )
  documentExpressions(
    "() => { if (mark.style === 'comment') return\n analysis.translateSelection({ page: mark.page, text: mark.text, quads: mark.quads }, mark.id) }",
    { attribute: 'onTranslate' }
  )
  assert.match(reading, /const run = async \(/)
  assert.match(
    reading,
    /page: requestedPage \?\? region\?\.page \?\? selected\[0\]\?\.page \?\? page,\s*text: selected\.map/
  )
  assert.match(reading, /quads: selected\s*\.filter/)
  assert.match(
    reading,
    /const canAnalyzeSelection = Boolean\(literatureId \|\| \(projectId && path\)\)/
  )
  assert.match(reading, /annotationResult:\s*selectionResultMark && selectionResultKind/)
  expressions(reading)(
    "(target?: PdfSelection, requirement = '', markId?: string) => { setSelectionResultMark(markId ?? null); void run('selection_explanation', 'summary', undefined, undefined, undefined, undefined, target ? [target] : selection, selectionInstruction(state.selectionPrompts, 'explain', requirement)) }"
  )
  const snapshot: Readonly<{ page: number; text: string; quads: readonly (readonly number[])[] }> =
    Object.freeze({
      page: 4,
      text: 'saved annotation',
      quads: Object.freeze([Object.freeze([0, 0, 0.4, 0.2])]),
    })
  const selection = [
    { page: 9, text: 'unrelated current selection', quads: [[0.1, 0.1, 0.3, 0.3]] },
  ]
  const calls: unknown[][] = []
  const invoke = readingExpression<(target?: typeof snapshot) => void>(
    reading,
    (node) =>
      ts.isArrowFunction(node) &&
      ts.isPropertyAssignment(node.parent) &&
      node.parent.name.getText() === 'translateSelection',
    {
      selection,
      setSelectionResultMark: () => {},
      run: (...args: unknown[]) => calls.push(args),
    }
  )
  invoke(snapshot)
  assert.equal(calls[0][0], 'selection_translation')
  assert.deepEqual(calls[0][6], [snapshot])
  assert.equal((calls[0][6] as unknown[])[0], snapshot)
  assert.equal(calls[0][4], undefined)
  invoke()
  assert.equal(calls[1][6], selection)
  assert.doesNotMatch(
    reading,
    /if \(selection\.length \|\| !selectionResult\) return[\s\S]*setFloating\(null\)/
  )
})

test('PDF explanations accept optional instructions and link to prompt settings', () => {
  const annotation = readFileSync(new URL('./pdf/Annotation.tsx', import.meta.url), 'utf8')
  const reading = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const explanation = readFileSync(new URL('./pdf/Explanation.tsx', import.meta.url), 'utf8')
  const guide = readFileSync(
    new URL('../../components/business/PromptSettingsGuide.tsx', import.meta.url),
    'utf8'
  )

  assert.match(annotation, /<PdfExplanation/)
  assert.match(explanation, /<Textarea[^>]*autoFocus[^>]*reading\.explanationPrompt/)
  assert.match(annotation, /onExplain\?\.\(explanationDraft\.trim\(\)\)/)
  assert.doesNotMatch(annotation, /if \(!explanationDraft\.trim\(\)\) return/)
  assert.doesNotMatch(annotation, /disabled=\{!explanationDraft\.trim\(\) \|\| analyzing\}/)
  assert.match(annotation, /onOpenSettings=\{\(\) => onOpenSettings\?\.\(\)\}/)
  assert.match(reading, /selectionExplanationOpen/)
  assert.match(reading, /selectionExplanationSnapshot/)
  assert.match(reading, /<PdfExplanation/)
  assert.match(explanation, /labelClassName="sr-only"/)
  assert.match(explanation, /reading\.selectionPromptSettings/)
  assert.match(
    reading,
    /disabled=\{!selectionExplanationSnapshot\.length\}\s+onSubmit=\{submitSelectionExplanation\}/
  )
  assert.match(
    reading,
    /selectionInstruction\(state\.selectionPrompts, 'explain', selectionExplanationDraft\)/
  )
  assert.doesNotMatch(
    reading,
    /if \(!requirement \|\| !selectionExplanationSnapshot\.length\) return/
  )
  assert.doesNotMatch(reading, /disabled=\{!selectionExplanationDraft\.trim\(\)\}/)
  assert.match(reading, /onOpenSettings=\{\(\) => actions\.openSettings\('prompts'\)\}/)
  assert.match(reading, /floating === 'selection_translation'[\s\S]*PromptSettingsGuide/)
  assert.match(reading, /expanded:\s*selectionExplanationOpen/)
  assert.match(guide, /linkPrefix\?: ReactNode/)
  assert.match(guide, /whitespace-nowrap/)
})

test('PDF side panels share a fixed-width drawer without a resizer', () => {
  const annotations = readFileSync(new URL('./pdf/Annotations.tsx', import.meta.url), 'utf8')
  const document = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const reading = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const panel = readFileSync(new URL('./pdf/Panel.tsx', import.meta.url), 'utf8')

  assert.doesNotMatch(panel, /ResizablePanel|panelWidth|setPanelWidth/)
  assert.match(panel, /w-\[var\(--vds-layout-pdf-panel-width\)\]/)
  assert.match(panel, /max-w-\[calc\(100%-var\(--vds-layout-pdf-rail-width\)\)\]/)
  assert.match(panel, /expanded \? ' left-0 max-w-none'/)
  assert.match(panel, /onClick=\{onToggleExpanded\}/)
  assert.doesNotMatch(annotations, /<PdfPanel/)
  assert.match(annotations, /<section[\s\S]*data-testid="pdf-annotations"/)
  assert.match(document, /<PdfPanel[\s\S]*testId=\{`document-panel-/)
  assert.match(reading, /<PdfPanel[\s\S]*testId="pdf-reading-panel"/)
})

test('PDF annotation list copies source text and each comment independently', () => {
  const annotations = readFileSync(new URL('./pdf/Annotations.tsx', import.meta.url), 'utf8')

  assert.match(
    annotations,
    /onSelect=\{\(\) => void writeClipboard\(mark\.text\)\}[\s\S]*pdfAnnotation\.copySource/
  )
  assert.match(
    annotations,
    /markComments\.map\(\(comment\) =>[\s\S]*data-testid="pdf-annotation-comment-caption"[\s\S]*<CopyButton[\s\S]*value=\{comment\.body\}[\s\S]*pdfAnnotation\.copyComment/
  )
  assert.doesNotMatch(annotations, /markComments[\s\S]*\.join\(/)
})

test('PDF annotation cards separate source text and independently expandable comments', () => {
  const annotations = readFileSync(new URL('./pdf/Annotations.tsx', import.meta.url), 'utf8')

  assert.match(annotations, /\{mark\.style !== 'comment' \? \(/)
  assert.match(annotations, /\{mark\.style !== 'comment' && expandable \? \(/)
  assert.match(annotations, /markComments\.map\(\(comment\) =>/)
  assert.match(annotations, /const commentExpanded = expandedComments\.has\(comment\.id\)/)
})

test('PDF AI results no longer expose an add-to-note action', () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /添加到笔记|onNote|saveNote/)
  assert.match(source, /explainSelection/)
  assert.match(source, /translateSelection/)
})

test('PDF selection AI result windows survive selection dismissal and keep explicit controls', () => {
  const reading = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const floatingWindow = readFileSync(
    new URL('../../components/primitive/FloatingWindow.tsx', import.meta.url),
    'utf8'
  )

  assert.doesNotMatch(reading, /[Ff]loatingPinned/)
  assert.doesNotMatch(reading, /onPinnedChange=/)
  assert.match(reading, /documentSelectionInteractionProps/)
  const autoSelectionIdentity = { current: 'selected' }
  const clearSelection = readingExpression<() => void>(
    reading,
    (node) =>
      ts.isArrowFunction(node) &&
      ts.isCallExpression(node.parent) &&
      node.parent.expression.getText() === 'useEffect' &&
      node.getText().includes("autoSelectionIdentity.current = ''"),
    {
      selection: [],
      autoSelectionIdentity,
      setFloating: () => assert.fail('clearing selection must not close its result'),
    }
  )
  clearSelection()
  assert.equal(autoSelectionIdentity.current, '')
  assert.match(reading, /floating === 'figure_explanation' \? \(\s*<FloatingWindow/)
  assert.match(reading, /initialHorizontalCenterRef=\{viewportRef\}/)
  assert.match(floatingWindow, /aria-pressed=\{pinned\}/)
  assert.match(reading, /ghostIconHeader\s+plainFooter/)
  assert.match(reading, /stableLabelWidth=\{false\}\s*icon=\{<Copy \/>\}/)
  assert.match(floatingWindow, /const headerIconVariant = ghostIconHeader \? 'ghostIcon' : 'ghost'/)
  assert.match(floatingWindow, /plainFooter \? '' : ' bg-\[var\(--vds-surface-muted\)\]'/)
  assert.match(floatingWindow, /floating-window-toggle-size[\s\S]*?variant=\{headerIconVariant\}/)
  assert.match(floatingWindow, /floatingWindow\.close[\s\S]*?variant=\{headerIconVariant\}/)
  assert.match(floatingWindow, /cursor-move/)
  assert.match(floatingWindow, /onPointerMove=\{move\}/)
  assert.match(floatingWindow, /floatingWindow\.close/)
})

test('figure preview zoom uses square icon buttons', () => {
  const crop = readFileSync(new URL('./pdf/Crop.tsx', import.meta.url), 'utf8')

  assert.match(
    crop,
    /<IconButton size="sm" variant="outline" label=\{t\('crop.zoomOut'\)\} icon=\{<Minus \/>\}/
  )
  assert.match(
    crop,
    /<IconButton size="sm" variant="outline" label=\{t\('crop.zoomIn'\)\} icon=\{<Plus \/>\}/
  )
})

test('PDF AI generated bodies remain text-selectable across markdown, summary, and translation', () => {
  const reading = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const markdown = readFileSync(
    new URL('../../components/primitive/Markdown.tsx', import.meta.url),
    'utf8'
  )
  const summary = readFileSync(
    new URL('../../components/business/Summary.tsx', import.meta.url),
    'utf8'
  )
  const translation = readFileSync(new URL('./pdf/Translation.tsx', import.meta.url), 'utf8')

  assert.match(reading, /cursor-text select-text/)
  assert.match(markdown, /cursor-text select-text/)
  assert.match(summary, /cursor-text select-text/)
  assert.match(translation, /cursor-text select-text/)
})

test('PDF AI annotation reuses the captured selection text and quads', () => {
  const documentSource = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const reading = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')

  assert.match(documentSource, /const addAiComment/)
  assert.match(documentSource, /page: selection\.page/)
  assert.match(documentSource, /text: selection\.text/)
  assert.match(documentSource, /quads: selection\.quads/)
  assert.match(documentSource, /annotateResult:/)
  assert.match(reading, /onAddComment/)
  assert.match(reading, /reading\.addToAnnotation/)
})

test('PDF selection results share copy, expansion and conversation actions', () => {
  const reading = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')

  assert.match(reading, /<CopyButton\s+iconOnly[\s\S]*?value=\{resultText\}/)
  assert.match(reading, /icon=\{selectionResultFillsReader \? <Minimize2[^>]*> : <Maximize2/)
  assert.match(
    reading,
    /variant="primary"\s*icon=\{resultAnnotated \? <Check[^>]*> : <MessageSquareText/
  )
  assert.match(reading, /data-testid="pdf-selection-translation-settings"/)
  const resultActions = reading.slice(
    reading.indexOf('const selectionResultActions ='),
    reading.indexOf('const submitSelectionExplanation =')
  )
  assert.doesNotMatch(resultActions, /reading\.cancel|cancel\(floating\)/)
  assert.match(reading, /max-w-full px-\[var\(--vds-space-3\)\] \[overflow-wrap:anywhere\]/)
})

test('completed PDF translations and explanations add their original and result to a draft', async () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  interface ActionNode {
    type: string
    props: Record<string, unknown>
    children: unknown[]
  }
  const buttons = (node: unknown): ActionNode[] => {
    if (!node || typeof node !== 'object' || !('children' in node)) return []
    const element = node as ActionNode
    return [...(element.type === 'Button' ? [element] : []), ...element.children.flatMap(buttons)]
  }
  for (const language of ['zh', 'en']) {
    const locale = createInstance()
    await locale.init({
      lng: language,
      fallbackLng: false,
      interpolation: { escapeValue: false },
      resources: {
        [language]: {
          pdf: JSON.parse(
            readFileSync(
              new URL(`../../../../localization/locales/${language}/pdf.json`, import.meta.url),
              'utf8'
            )
          ),
        },
      },
    })
    const translate = locale.getFixedT(language, 'pdf')
    for (const floating of ['selection_translation', 'selection_explanation']) {
      for (const state of ['ready', 'busy', 'empty', 'missing']) {
        const floatingResult =
          state === 'missing'
            ? null
            : {
                kind: floating,
                page: 3,
                revision: 'revision-1',
                selected_text: 'Original text <source> & {{untouched}}',
                text: state === 'empty' ? '' : '结果与译文 <result> & {{source}}',
              }
        const drafts: unknown[][] = []
        const quote = readingExpression<() => void>(
          source,
          (node) =>
            ts.isArrowFunction(node) &&
            ts.isVariableDeclaration(node.parent) &&
            node.parent.name.getText() === 'quote',
          {
            floatingResult,
            assistantTitle: 'Test paper',
            t: translate,
            openDocumentChat: (...args: unknown[]) => drafts.push(args),
          }
        )
        const resultReady = readingExpression<boolean>(
          source,
          (node) =>
            ts.isCallExpression(node) &&
            ts.isVariableDeclaration(node.parent) &&
            node.parent.name.getText() === 'resultReady',
          { Boolean, floatingResult, busy: state === 'busy' }
        )
        const footer = readingExpression<unknown>(
          source,
          (node) =>
            ts.isBinaryExpression(node) &&
            ts.isJsxExpression(node.parent) &&
            node.left.getText() === 'resultReady' &&
            node.getText().includes('onClick={quote}'),
          {
            React: {
              createElement: (
                type: string,
                props: Record<string, unknown>,
                ...children: unknown[]
              ) => ({ type, props, children }),
            },
            Button: 'Button',
            MessageCirclePlus: 'MessageCirclePlus',
            Check: 'Check',
            MessageSquareText: 'MessageSquareText',
            floating,
            floatingResult,
            resultReady,
            selectionResultName:
              floating === 'selection_translation' ? 'translation' : 'explanation',
            quote,
            t: translate,
            resultAnnotated: false,
            annotating: false,
            busy: state === 'busy',
            canAnnotate: true,
          }
        )
        const conversation = buttons(footer).filter((button) => button.props.onClick === quote)
        assert.equal(
          conversation.length,
          state === 'ready' ? 1 : 0,
          `${language}/${floating}/${state}`
        )
        if (state !== 'ready' || !floatingResult) continue
        assert.equal(conversation[0].props.disabled, false)
        assert.equal(
          conversation[0].props['data-testid'],
          `pdf-selection-${floating === 'selection_translation' ? 'translation' : 'explanation'}-conversation`
        )
        assert.deepEqual(conversation[0].children, [translate('selectionAddConversation')])
        ;(conversation[0].props.onClick as () => void)()
        assert.equal(drafts.length, 1)
        assert.deepEqual(drafts[0], [
          translate('reading.selectionDraft', {
            literatureId: 'Test paper',
            page: 3,
            revision: 'revision-1',
            source: floatingResult.selected_text,
            result: floatingResult.text,
          }),
          false,
        ])
        assert.ok(String(drafts[0][0]).includes(floatingResult.selected_text))
        assert.ok(String(drafts[0][0]).endsWith(floatingResult.text))
      }
    }
  }
})

test('literature follow-ups attach the current document before entering chat', () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const zh = JSON.parse(
    readFileSync(new URL('../../../../localization/locales/zh/pdf.json', import.meta.url), 'utf8')
  )
  const en = JSON.parse(
    readFileSync(new URL('../../../../localization/locales/en/pdf.json', import.meta.url), 'utf8')
  )

  assert.match(
    source,
    /const openDocumentChat = async \(text: string, focus = true\): Promise<void> =>/
  )
  assert.match(source, /const context = await actions\.addContext\(\{/)
  assert.match(source, /kind: 'literature'/)
  assert.match(source, /source_id: literatureId/)
  assert.match(source, /label: assistantTitle/)
  assert.match(source, /retention: 'next_turn'/)
  assert.match(source, /origin: 'explicit'/)
  assert.doesNotMatch(source, /origin: 'current_document'/)
  assert.match(source, /if \(!context\.accepted_ref_ids\.length\) return/)
  assert.match(source, /void openDocumentChat\(\s*t\('reading\.selectionDraft'/)
  assert.match(source, /literatureId: assistantTitle/)
  assert.match(source, /source: floatingResult\.selected_text/)
  assert.match(source, /result: floatingResult\.text/)
  assert.match(source, /<Button[\s\S]*?disabled=\{!floatingResult\}\s*onClick=\{quote\}/)
  assert.match(
    source,
    /onChat=\{\(text\) => \{[\s\S]*void openDocumentChat\(\s*t\('reading\.summaryDraft', \{ literatureId: assistantTitle, summary: text \}\)/
  )
  assert.match(source, /focusComposer\(\)/)
  for (const draft of [zh.reading.selectionDraft, en.reading.selectionDraft]) {
    assert.match(draft, /\{\{source\}\}/)
    assert.match(draft, /\{\{result\}\}/)
  }
})

test('literature chat uses the metadata title belonging to the opened literature', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')

  assert.match(
    source,
    /literatureTitle: excerptSource\?\.literatureId === literatureId \? excerptSource\.title : ''/
  )
})

test('PDF navigation and annotation inspector reuse compact design-system controls', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const scale = readFileSync(new URL('./pdf/Scale.tsx', import.meta.url), 'utf8')
  const outline = readFileSync(new URL('./pdf/Outline.tsx', import.meta.url), 'utf8')
  const annotations = readFileSync(new URL('./pdf/Annotations.tsx', import.meta.url), 'utf8')
  const reading = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const panel = readFileSync(new URL('./pdf/Panel.tsx', import.meta.url), 'utf8')
  const layout = readFileSync(new URL('../../design/layout.css', import.meta.url), 'utf8')
  const icons = readFileSync(new URL('../../icons.tsx', import.meta.url), 'utf8')

  for (const value of ['outline', 'pages', 'search']) {
    assert.match(source, new RegExp(`<TabsTrigger\\s+value="${value}"`))
  }
  assert.doesNotMatch(source, /role="search" aria-label="搜索 PDF"/)
  assert.match(readFileSync(new URL('./pdf/Tools.tsx', import.meta.url), 'utf8'), /<Popover/)
  assert.doesNotMatch(source, /selectionPanel/)
  assert.match(source, /<PdfScale/)
  assert.match(scale, /onDoubleClick/)
  assert.match(scale, /CLICK_DISAMBIGUATION_MS/)
  assert.match(scale, /event\.key === 'Escape'/)
  assert.match(scale, /percentScale/)
  assert.doesNotMatch(source, /data-testid="pdf-fit-page"/)
  assert.doesNotMatch(source, /data-testid="pdf-fit-width"/)
  assert.match(source, /focusedTabId !== tabId/)
  assert.match(source, /searchInputRef\.current\?\.select\(\)/)
  assert.match(source, /<PdfOutline items=\{outline\}/)
  assert.match(source, /<Textarea[^>]*data-testid="pdf-search"/)
  assert.doesNotMatch(source, /<Input[^>]*data-testid="pdf-search"/)
  assert.match(layout, /--vds-layout-pdf-rail-width:/)
  assert.match(source, /PDF_NAVIGATION_DEFAULT_WIDTH_PX = 260/)
  assert.match(source, /PDF_NAVIGATION_MIN_WIDTH_PX = 190/)
  assert.match(source, /PDF_NAVIGATION_MAX_WIDTH_PX = 360/)
  assert.match(source, /<ResizablePanel/)
  assert.match(source, /data-testid="pdf-navigation-resizable"/)
  assert.doesNotMatch(source, /className="vds-pdf-sidebar[^"]*\bborder-r\b/u)
  assert.match(source, /leftWidth=\{`\$\{navigationWidth\}px`\}/)
  documentExpressions('(width) => update({ navigationWidth: Number.parseFloat(width) })', {
    attribute: 'onWidthChange',
  })
  assert.match(
    source,
    /style=\{\{ marginLeft: sidebar \? `\$\{navigationWidth\}px` : undefined \}\}/
  )
  // The reading split measures the PDF viewport itself; navigation is outside it.
  documentExpressions('size.width - activeCommentRail - PAGE_GUTTER')
  assert.match(source, /observer\.observe\(host\)/)
  documentExpressions('fittedScale(mode, fittedPageSize, fitViewport)')
  assert.match(
    source,
    /const rightPanelOpen = Boolean\(analysis\.sidePanel \|\| \(activeDocumentPanelId && !analysis\.panel\)\)/
  )
  assert.match(source, /data-testid="pdf-pages-track"/)
  assert.match(
    source,
    /rightPanelOpen && !readingPanelOpen \? ' min-w-\[calc\(100%\+var\(--vds-layout-pdf-panel-width\)\)\] pr-\[var\(--vds-layout-pdf-panel-width\)\]'/
  )
  assert.match(source, /overflow-x-hidden/)
  assert.match(source, /bg-\[var\(--vds-bg-gray-light-default\)\]!/)
  assert.match(panel, /absolute inset-y-0 right-\[var\(--vds-layout-pdf-rail-width\)\]/)
  assert.match(panel, /expanded \? ' left-0 max-w-none'/)
  assert.doesNotMatch(annotations, /<PdfPanel/)
  assert.match(reading, /<PdfPanel/)
  for (const panelSource of [source, panel]) {
    assert.match(panelSource, /bg-\[var\(--vds-bg-white-default\)\]/)
    assert.doesNotMatch(panelSource, /backdrop-opacity|bg-opacity|opacity-\d/)
  }
  assert.match(
    source,
    /className="w-full min-w-0 justify-start text-left whitespace-normal! \[overflow-wrap:anywhere\]"/
  )
  assert.match(
    source,
    /<mark\s+className="rounded-\[var\(--vds-radius-2\)\] bg-\[var\(--vds-brand-bg-light\)\] px-\[var\(--vds-space-half\)\] text-inherit"/
  )
  assert.doesNotMatch(outline, /<Collapsible[^>]*defaultOpen/)
  assert.match(outline, /<CollapsibleTrigger asChild>/)
  assert.match(outline, /data-testid=\{`pdf-outline-toggle-/)
  assert.match(outline, /data-testid=\{`pdf-outline-row-/)
  assert.match(outline, /size="content"/)
  assert.match(outline, /<EllipsisText[^>]*tooltip=\{item\.title\}/)
  assert.match(outline, /aria-disabled=\{item\.page === null\}/)
  assert.doesNotMatch(outline, /\n\s+disabled=\{item\.page === null\}/)
  assert.doesNotMatch(outline, /title=\{item\.title\}/)
  assert.match(outline, /tooltipPortalled/)
  assert.match(outline, /tooltipSide="right"/)
  assert.doesNotMatch(outline, /whitespace-normal! \[overflow-wrap:anywhere\]/)
  assert.match(outline, /<OutlineBranch\s+items=\{item\.children\}\s+depth=\{depth \+ 1\}/)
  assert.match(outline, /data-outline-depth=\{depth\}/)
  for (const name of ['highlighter', 'underline', 'annotation', 'strikethrough']) {
    assert.match(icons, new RegExp(`\\| '${name}'`))
  }
  assert.match(
    readFileSync(new URL('./pdf/Tools.tsx', import.meta.url), 'utf8'),
    /icon: 'highlighter'/
  )
  assert.match(
    readFileSync(new URL('./pdf/Tools.tsx', import.meta.url), 'utf8'),
    /icon: 'underline'/
  )
  assert.match(
    readFileSync(new URL('./pdf/Tools.tsx', import.meta.url), 'utf8'),
    /MessageSquareText/
  )
})

test('literature PDF tabs expose the reusable multi-selection resource import component', () => {
  const pdf = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const feature = readFileSync(new URL('./feature.tsx', import.meta.url), 'utf8')
  const store = readFileSync(new URL('../../store.tsx', import.meta.url), 'utf8')
  const component = readFileSync(
    new URL('../../components/business/Excerpts.tsx', import.meta.url),
    'utf8'
  )
  assert.match(store, /LITERATURE_EXCERPT_VIEW_STATE_KEY/)
  assert.match(store, /activeTab: OVERVIEW_TAB\.id/)
  assert.match(pdf, /<LiteratureExcerptImport/)
  assert.match(pdf, /documentRevision=\{session\.revision\}/)
  assert.match(pdf, /selections=\{excerptSelections\}/)
  assert.match(feature, /onResourceImported=\{async \(\) => \{\s+await act\.reloadResourceTree\(\)/)
  assert.match(component, /useTranslation\('literature'\)/)
  assert.match(
    component,
    /<DialogDescription>\s*\{t\('excerpts\.description'\)\}\s*<\/DialogDescription>/
  )
  const descriptions = ['zh', 'en'].map(
    (language) =>
      JSON.parse(
        readFileSync(
          new URL(`../../../../localization/locales/${language}/literature.json`, import.meta.url),
          'utf8'
        )
      ).excerpts.description
  )
  assert.deepEqual(descriptions, [
    '同一篇文献的多个选段会聚合到一份 Markdown 资料；已保存的相同页码和文本会自动跳过。',
    'Selections from the same paper are combined into one Markdown resource; duplicate pages and text are skipped.',
  ])
})

test('literature PDF opening preserves attachment identity and record ownership', () => {
  const store = readFileSync(new URL('../../store.tsx', import.meta.url), 'utf8')
  const detail = readFileSync(
    new URL('../literature/LiteratureDetail.tsx', import.meta.url),
    'utf8'
  )

  assert.match(
    store,
    /openLiteratureAttachment: \(\s*id: string,\s*attachmentId\?: string,\s*page\?: number,\s*options\?: \{\s*projectId\?: string \| null;?\s*citation\?: Omit<CitationFocus, 'sequence'>;?\s*annotation\?: Omit<AnnotationFocus, 'sequence'>;?\s*selection\?: SelectionReveal\s*\}\s*\) => Promise<boolean>/
  )
  assert.match(
    store,
    /detail\.attachments\.find\(\(candidate\) => candidate\.id === attachmentId\)/
  )
  assert.match(store, /attachmentId: attachment\.id/)
  assert.match(store, /recordTarget: attachment\.record_target/)
  assert.match(store, /\.\.\.\(page \? \{ page \} : \{\}\)/)
  assert.match(detail, /act\.openLiteratureAttachment\(item\.id, attachment\.id\)/)
  assert.match(detail, /act\.openLiteratureAttachment\(currentItem\.id, attachment\.id\)/)
  assert.match(detail, /<AttachmentMarks\s+source=\{attachmentSource\}/)
})

test('the selected PDF.js runtime parses a real generated PDF without TypedArray.toHex', async () => {
  assert.equal(typeof Reflect.get(Uint8Array.prototype, 'toHex'), 'undefined')
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const source = await PDFDocument.create()
  source.addPage([320, 240])
  const bytes = await source.save()

  const task = getDocument({ data: bytes })
  const document = await task.promise
  assert.equal(document.numPages, 1)
  await task.destroy()
})

test('PDF URI annotations become safe external-browser hit regions', async () => {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const source = await PDFDocument.create()
  const page = source.addPage([320, 240])
  const annotation = source.context.register(
    source.context.obj({
      Type: PDFName.of('Annot'),
      Subtype: PDFName.of('Link'),
      Rect: [20, 30, 120, 50],
      Border: [0, 0, 0],
      A: {
        S: PDFName.of('URI'),
        URI: PDFString.of('https://example.com/paper'),
      },
    })
  )
  page.node.set(PDFName.of('Annots'), source.context.obj([annotation]))

  const task = getDocument({ data: await source.save() })
  try {
    const parsedPage = await (await task.promise).getPage(1)
    const viewport = parsedPage.getViewport({ scale: 1 })
    assert.deepEqual(
      externalPdfLinks(
        await parsedPage.getAnnotations({ intent: PDF_ANNOTATION_INTENT }),
        viewport
      ),
      [
        {
          url: 'https://example.com/paper',
          left: 20,
          top: 190,
          width: 100,
          height: 20,
        },
      ]
    )
    assert.deepEqual(
      externalPdfLinks(
        [
          { subtype: 'Link', url: 'javascript:alert(1)', rect: [20, 30, 120, 50] },
          { subtype: 'Link', unsafeUrl: 'file:///tmp/private', rect: [20, 30, 120, 50] },
        ],
        viewport
      ),
      []
    )
  } finally {
    await task.destroy()
  }
})

test('annotated export accepts the real PDF whose Contents entry is not an array', async () => {
  const records: PdfRecordSnapshot = {
    record_target: { owner: 'project_asset', scope_id: 'fixture', subject_id: 'fixture-asset' },
    record_revision: 'fixture-record',
    source_revision: 'fixture-source',
    source_state: 'available',
    source_path: 'fixture.pdf',
    records: {
      schema_version: 1,
      marks: [
        {
          id: 'highlight-1',
          style: 'highlight',
          color: 'yellow',
          page: 1,
          quads: [[0.1, 0.1, 0.4, 0.15]],
          text: 'PDF Preview Test',
          anchor_state: 'anchored',
          created_at: 1,
          updated_at: 1,
        },
      ],
      comments: [],
      notes: [],
    },
  }
  const exported = await buildAnnotatedPdf(
    readFileSync(BROKEN_CONTENTS_PDF),
    records,
    'ScholarSeed PDF annotations'
  )
  const reopened = await PDFDocument.load(exported)
  assert.equal(reopened.getPageCount(), 1)
  assert.deepEqual(reopened.getPage(0).getSize(), { width: 612, height: 792 })
})

test('PDF selection annotation save action aligns to the right below the draft', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  assert.match(
    source,
    /<PdfCommentInput[\s\S]*?rows=\{3\}[\s\S]*?value=\{commentDraft\}[\s\S]*?<Button\s+className="justify-self-end"[\s\S]*?\{t\('pdfAnnotation.kind.comment'\)\}/
  )
  assert.match(source, /vds-selection-action-result !border-t-0/)
  assert.doesNotMatch(source, /label=\{t\('writeComment'\)\}/)
})

test('PDF selection controls update their locale without replacing document or draft state', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  documentExpressions(
    '[selectionToolbarEnabled, activeMark, addAiComment, commentDraft, commentFormOpen, toggleSelectionComment, highlightOpen, markColors, selectionColor, saving, selections, session?.capabilities.can_annotate, session?.revision, sessionId, sidecar, t]',
    'selectionContribution'
  )
  assert.match(source, /id: 'pdf-copy'/)
  assert.doesNotMatch(source, /quoteBefore/)
  assert.match(source, /value=\{commentDraft\}/)
  assert.match(source, /useSelectionActionContribution\(tabId, selectionContribution\)/)
  assert.match(source, /useSelectionActionContribution\(tabId, copyContribution\)/)
})

test('reading and table draft templates preserve interpolated source bytes in both languages', async () => {
  const resources = Object.fromEntries(
    ['zh', 'en'].map((language) => [
      language,
      Object.fromEntries(
        ['pdf', 'workbench'].map((namespace) => [
          namespace,
          JSON.parse(
            readFileSync(
              new URL(
                `../../../../localization/locales/${language}/${namespace}.json`,
                import.meta.url
              ),
              'utf8'
            )
          ),
        ])
      ),
    ])
  )
  const locale = createInstance()
  await locale.init({
    lng: 'zh',
    fallbackLng: false,
    interpolation: { escapeValue: false },
    resources,
  })
  const source = '  原文 <tag> & {{untouched}}\n$&  '
  const result = 'AI output\n  <b>原样</b> & {{source}}  '
  const summary = '  Summary\n原文 & {{literatureId}}  '
  const path = '目录/原始 <file> & {{path}}.csv'
  for (const language of ['zh', 'en']) {
    await locale.changeLanguage(language)
    const selection = locale.t('reading.selectionDraft', {
      ns: 'pdf',
      literatureId: '标题/原文',
      page: 3,
      revision: 'r&1',
      source,
      result,
    })
    assert.ok(selection.includes(source))
    assert.ok(selection.endsWith(result))
    assert.ok(selection.includes('标题/原文'))
    assert.ok(selection.includes('r&1'))
    assert.ok(
      locale
        .t('reading.summaryDraft', { ns: 'pdf', literatureId: '标题/原文', summary })
        .endsWith(summary)
    )
    const table = locale.t('table.analysisDraft', { ns: 'workbench', path })
    assert.ok(table.includes(path))
    assert.ok(table.endsWith('\n\n'))
    assert.match(selection, language === 'zh' ? /^请基于/ : /^Continue the analysis/)
    assert.match(table, language === 'zh' ? /^分析这份表格/ : /^Analyze trends/)
    assert.equal(
      locale.t('reading.evidencePage', { ns: 'pdf', page: 3 }),
      resources[language].pdf.reading.evidencePage.replace('{{page}}', '3')
    )
  }
})
