import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { codeLanguageLabel, normalizeMathDelimiters } from './mathematics.ts'
import { createMarkdownImageResolver, ImageOperationError } from './api.ts'
import { markdownFragmentTarget } from './anchors.ts'

const markdownSource = readFileSync(new URL('./MarkdownDocument.tsx', import.meta.url), 'utf8')
const monacoSource = readFileSync(new URL('./MonacoDocument.tsx', import.meta.url), 'utf8')
const storeSource = readFileSync(new URL('../../store.tsx', import.meta.url), 'utf8')
const editorStyles = readFileSync(new URL('./editor.css', import.meta.url), 'utf8')
const diffSource = readFileSync(new URL('./Diff.tsx', import.meta.url), 'utf8')
const frameSource = readFileSync(new URL('./monaco/host.tsx', import.meta.url), 'utf8')
const frameBootstrapSource = readFileSync(new URL('./monaco/frame.ts', import.meta.url), 'utf8')
const featureSource = readFileSync(new URL('./feature.tsx', import.meta.url), 'utf8')

test('generated Markdown fragments resolve only through explicit anchors', () => {
  const source = [
    '正文引用 [[1]](#ref-paper).',
    '',
    '## 参考文献',
    '',
    '<a id="ref-paper"></a>',
    '[1] **Author**. Paper title. _Journal, 2026._',
    ''
  ].join('\n')
  assert.deepEqual(markdownFragmentTarget(source, '#ref-paper'), {
    fragment: 'ref-paper',
    text: '[1] Author. Paper title. Journal, 2026.'
  })
  assert.equal(markdownFragmentTarget(source, '#ref-missing'), null)
  assert.equal(markdownFragmentTarget('正文只有 [1]，没有链接或锚点。', '#ref-1'), null)
})

test('Markdown header uses one toolbar with icon history/save actions', () => {
  assert.doesNotMatch(markdownSource, /t\('markdown\.hint'\)/u)
  assert.doesNotMatch(markdownSource, /markdown\.(?:toolbar|formatToolbar)/u)
  assert.doesNotMatch(markdownSource, /<Switch/u)
  assert.match(markdownSource, /data-testid="markdown-open-source"/u)
  assert.match(markdownSource, /data-testid="markdown-open-editor"/u)
  assert.match(markdownSource, /data-testid="markdown-save"/u)
  assert.doesNotMatch(markdownSource, /<SegmentedControl/u)
  assert.doesNotMatch(markdownSource, /markdown-page-width-/u)
  assert.match(markdownSource, /<Tooltip[^>]*content=\{t\('markdown\.save'\)\}/u)
  assert.match(markdownSource, /<Save/u)
  assert.match(markdownSource, /<BadgeDot/u)
  assert.match(markdownSource, /data-external-change=\{externalPending \? 'true'/u)
  assert.match(markdownSource, /sealResourceSnapshot\([\s\S]*'external_confirmed'/u)
  assert.match(markdownSource, /data-testid="markdown-editor-actions"/u)
  assert.match(markdownSource, /toolbarHost\.append\(topBar\)/u)
  assert.doesNotMatch(markdownSource, /markdown\.more|>⋮</u)
})

test('Markdown paper always uses the full available width', () => {
  assert.match(markdownSource, /const MARKDOWN_PAPER_CLASS = '[^']*max-w-none/u)
  assert.doesNotMatch(markdownSource, /MarkdownPageWidth|MARKDOWN_PAGE_WIDTH_CLASS|pageWidth/u)
  assert.match(markdownSource, /paper\.className = MARKDOWN_PAPER_CLASS/u)
})

test('visual Markdown uses one body font with distinct heading and body weights', () => {
  assert.ok(markdownSource.includes('[--crepe-font-default:var(--vds-font-main)]'))
  assert.ok(markdownSource.includes('[--crepe-font-title:var(--vds-font-main)]'))
  assert.ok(markdownSource.includes('[&>.ProseMirror]:![font-family:var(--vds-font-main)]'))
  assert.match(styles, /\.vds-markdown-crepe \.katex \.cjk_fallback\s*\{[^}]*font-family: var\(--vds-font-main\)/su)
  assert.ok(markdownSource.includes('[&>.ProseMirror]:![font-weight:var(--vds-fw-regular)]'))
  assert.ok(markdownSource.includes('[&>.ProseMirror_:is(h1,h2,h3,h4,h5,h6)]:![font-weight:var(--vds-fw-semibold)]'))
})

test('visual Markdown formulas follow body font size and inline line height', () => {
  assert.match(styles, /\.vds-markdown-crepe \.ProseMirror \.katex\s*\{[^}]*font-size: 1em/su)
  assert.match(styles, /\.vds-markdown-crepe \.ProseMirror span\[data-type='math_inline'\]\s*\{[^}]*vertical-align: baseline[^}]*line-height: inherit/su)
})

test('visual Markdown shows only document content while source mode uses an IDE surface', () => {
  assert.doesNotMatch(markdownSource, /markdown-filename-title|MarkdownFilenameTitle|MARKDOWN_EXTENSION/u)
  assert.match(markdownSource, /paper\.dataset\.testid = 'markdown-paper'/u)
  assert.match(markdownSource, /paper\.append\(view\.dom\)/u)
  assert.ok(markdownSource.includes('[&>.ProseMirror>:nth-child(1_of_:not(.ProseMirror-widget,.prosemirror-virtual-cursor))]:!mt-0'))
  assert.match(markdownSource, /latestText !== initialText/u)
  assert.match(markdownSource, /data-testid="markdown-source-editor"[\s\S]*<MonacoDocument/u)
  for (const icon of ['Undo2', 'Redo2', 'Search', 'Replace']) {
    assert.match(monacoSource, new RegExp(`<${icon}`))
  }
  for (const testId of ['markdown-undo', 'markdown-redo', 'markdown-find', 'markdown-replace']) {
    assert.match(monacoSource, new RegExp(`data-testid="${testId}"`))
  }
  assert.match(monacoSource, /markdown-undo[\s\S]*createPortal\(sourceActions, toolbarHost\)/u)
  assert.match(monacoSource, /data-testid="source-document-toolbar"/u)
  assert.match(monacoSource, /vds-code-document is-actions-external/u)
  assert.match(featureSource, /kind: 'code',[\s\S]*toolbar: 'viewer'[\s\S]*toolbarActions=\{toolbarActions\}/u)
  assert.match(editorStyles, /\.vds-code-document\.is-actions-external\s*\{[^}]*grid-template-rows: minmax\(0, 1fr\)/su)
  assert.match(monacoSource, /<Tooltip[^>]*content=\{t\('code\.undo'\)\}/u)
  assert.doesNotMatch(monacoSource, /<Button[^>]*>\{t\('code\.(?:find|replace)'\)\}<\/Button>/u)
})

test('Monaco source editor uses one global wrapping icon preference', () => {
  assert.match(monacoSource, /icon=\{<TextWrap \/>\}/u)
  assert.match(monacoSource, /data-testid="source-document-wrap-toggle"/u)
  assert.match(monacoSource, /const wrapEnabled = appState\.editorWordWrap/u)
  assert.match(monacoSource, /aria-pressed=\{wrapEnabled\}/u)
  assert.match(monacoSource, /act\.setEditorWordWrap\(!wrapEnabled\)/u)
  assert.doesNotMatch(monacoSource, /SegmentedControl|ToggleGroupItem|code\.overflow/u)
  assert.match(monacoSource, /editor\.updateOptions\(\{ wordWrap: wordWrapFor\(appState\.editorWordWrap\) \}\)/u)
  assert.match(storeSource, /editorWordWrap: INITIAL_PREFERENCES\.editorWordWrap/u)
  assert.match(storeSource, /editorWordWrap: state\.editorWordWrap/u)
  assert.match(storeSource, /setEditorWordWrap: \(editorWordWrap\)/u)
  const labels = ['zh', 'en'].map(language => JSON.parse(readFileSync(
    new URL(`../../../../localization/locales/${language}/workbench.json`, import.meta.url),
    'utf8'
  )).code)
  assert.deepEqual(labels.map(code => code.wrap), ['自动换行', 'Wrap'])
})
const dockSource = readFileSync(new URL('./Dock.tsx', import.meta.url), 'utf8')
const workbenchHarnessSource = readFileSync(new URL('../../../../main/workbench.ts', import.meta.url), 'utf8')
const workbenchE2ESource = readFileSync(new URL('../../../../../e2e/workbench.spec.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../../shell/workbench.css', import.meta.url), 'utf8')

test('Markdown switches source and visual modes inside one tab', () => {
  assert.match(featureSource, /kind: 'markdown',[\s\S]*toolbar: 'viewer'/)
  assert.match(dockSource, /useTranslation\('workbench'\)/)
  const sourceLabels = ['zh', 'en'].map(language => JSON.parse(readFileSync(new URL(`../../../../localization/locales/${language}/workbench.json`, import.meta.url), 'utf8')).dock.source)
  assert.deepEqual(sourceLabels, ['源码', 'Source'])
  assert.doesNotMatch(dockSource, /data-testid="document-preview"/)
  assert.doesNotMatch(dockSource, /data-testid="document-edit"/)
  assert.doesNotMatch(dockSource, /modeSwitcher/)
  assert.doesNotMatch(featureSource, /modeSwitcher/)
  assert.match(workbenchHarnessSource, /MARKDOWN_EDIT_TEST_ID = 'markdown-open-editor'/)
  assert.doesNotMatch(workbenchHarnessSource, /DOCUMENT_EDIT_TEST_ID/)
  assert.match(workbenchHarnessSource, /真实 Office 文档不显示工作台模式切换/)
  assert.doesNotMatch(dockSource, /tab-open-markdown-source/)
  assert.doesNotMatch(dockSource, /tab-open-markdown-editor/)
  assert.match(markdownSource, /data-testid="markdown-open-source"/)
  assert.match(markdownSource, /data-testid="markdown-open-editor"/)
  assert.match(markdownSource, /<Tabs/)
  assert.match(markdownSource, /workspace\.setTabView\(tabId, target\)/)
  assert.doesNotMatch(markdownSource, /workspace\.open\(session\.source, target/)
  assert.match(monacoSource, /isMarkdownSource/)
  assert.match(markdownSource, /viewKind === 'preview'[\s\S]*MonacoDocument/)
  assert.match(markdownSource, /<MarkdownVisualEditor[\s\S]*sessionId=\{sessionId\}[\s\S]*tabId=\{tabId\}[\s\S]*toolbarHost=\{editorToolbarHost\}/)
  assert.match(markdownSource, /workspace\.updateText\(sessionId, markdown\)/)
  assert.match(markdownSource, /replaceExternalText\(crepe, session\.text\)/)
  assert.match(markdownSource, /TextSelection\.between/)
  assert.match(markdownSource, /hostRef\.current\.scrollTop = scrollTop/)
  assert.match(markdownSource, /if \(!crepeReadyRef\.current\) return/)
  assert.match(markdownSource, /const projectedMarkdownRef = useRef\(''\)/)
  assert.match(markdownSource, /const userEditPendingRef = useRef\(false\)/)
  assert.match(markdownSource, /if \(!userEditPendingRef\.current\) \{[\s\S]*projectedMarkdownRef\.current = markdown[\s\S]*return/)
  assert.match(markdownSource, /prepare: \(\) => commitVisualEdit\(crepe\.getMarkdown\(\)\)/)
  assert.match(markdownSource, /latest\.changeVersion !== sourceChangeVersion[\s\S]*userEditPendingRef\.current/)
  assert.match(markdownSource, /serialize:[\s\S]*encodeTextForSave\(current\.text, current\.savedBytes\)/)
  assert.doesNotMatch(markdownSource, /serialize:[\s\S]{0,300}crepe\.getMarkdown\(\)/)
  assert.match(monacoSource, /saveViewState\(\)/)
  assert.match(monacoSource, /restoreViewState\(viewState\)/)
  assert.match(monacoSource, /applyingExternalRef/)
  assert.doesNotMatch(markdownSource, /workspace\.(undo|redo)\(sessionId\)/)
  assert.match(markdownSource, /session\?\.lightweightText/)
  assert.match(markdownSource, /markdown\.large/)
  assert.match(featureSource, /toolbarActions=\{toolbarActions\}/)
  assert.match(markdownSource, /\{toolbarActions\}/)
  assert.match(dockSource, /DocumentToolbarActions session=\{session\}/)
  assert.match(dockSource, /toolbarActions:[\s\S]*DocumentVersionActions session=\{session\}/)
})

test('lightweight Monaco saves synchronize the live model and preserve edits made during save', () => {
  assert.match(
    monacoSource,
    /registerSaveDelegate\(sessionId, \{[\s\S]*prepare: \(\) => controller\.updateText\(sessionId, model\.getValue\(\)\)/
  )
  assert.match(monacoSource, /session\.lightweightText && session\.dirty/)
})

test('visual Markdown editing provides the approved toolbar and slash commands', () => {
  for (const label of [
    'markdown.h1', 'markdown.h2', 'markdown.h3', 'markdown.h4', 'markdown.h5', 'markdown.h6',
    'markdown.bold', 'markdown.italic', 'markdown.unordered', 'markdown.ordered', 'markdown.quote', 'markdown.link', 'markdown.table', 'markdown.math', 'markdown.image', 'markdown.codeBlock', 'markdown.divider'
  ]) {
    assert.match(markdownSource, new RegExp(label))
  }
  assert.match(markdownSource, /CrepeFeature\.TopBar\]: true/)
  assert.match(markdownSource, /builder\.build\(\)/)
  assert.doesNotMatch(markdownSource, /boldIcon: '<b>B<\/b>'/)
  assert.doesNotMatch(markdownSource.split('buildTopBar:')[1].split('[CrepeFeature.BlockEdit]')[0], /window\.prompt/)
  assert.match(markdownSource, /CrepeFeature\.AI\]: false/)
  assert.doesNotMatch(markdownSource, /disabled title="二期能力">[^<]*版本历史/)
  assert.match(markdownSource, /<\/Tabs>\s*\{toolbarActions\}/)
  assert.match(markdownSource, /<div className="vds-markdown-header[^"]*flex-nowrap[^"]*"/)
  assert.match(markdownSource, /min-w-0 truncate[^"]*text-\[var\(--vds-text-tertiary\)\]/)
  assert.doesNotMatch(markdownSource, /className="vds-markdown-ai-hint"/)
  assert.match(markdownSource, /grid-rows-\[auto_minmax\(0,1fr\)\]/)
  assert.match(markdownSource, /<Tabs\s+className="flex-none"\s+value=\{viewKind\}/)
  assert.match(markdownSource, /ml-auto flex shrink-0 items-center/)
  assert.doesNotMatch(markdownSource, /formatVisible|is-format-hidden/)
  assert.doesNotMatch(markdownSource, /min-w-\[700px\]|grid-rows-\[48px_minmax/)
  assert.match(markdownSource, /externallyAppliedMarkdownRef/)
  assert.match(markdownSource, /markdown === externallyAppliedMarkdownRef\.current/)
  assert.match(styles, /\.vds-markdown-crepe \.milkdown-slash-menu\s*\{[^}]*width: 244px/s)
  assert.doesNotMatch(styles, /li\[data-index=/)
})

test('visual Markdown routes configurable shortcuts to native editor commands', () => {
  assert.match(markdownSource, /undoCommand/u)
  assert.match(markdownSource, /redoCommand/u)
  assert.match(markdownSource, /selectAll/u)
  assert.match(markdownSource, /openLinkEditorCommand/u)
  assert.match(markdownSource, /setBlockTypeCommand/u)
  assert.match(markdownSource, /resolveMarkdownShortcut/u)
  assert.match(markdownSource, /suppressMarkdownDefaultShortcut/u)
  assert.match(markdownSource, /data-testid="markdown-find-input"/u)
  assert.doesNotMatch(markdownSource, /markdown\.runCodeBlock/u)
})

test('Markdown toolbars use the shared S controls and design spacing', () => {
  assert.match(markdownSource, /vds-markdown-header[^"\n]*gap-\[var\(--vds-space-2\)\]/u)
  assert.match(monacoSource, /vds-code-actions[^"\n]*gap-\[var\(--vds-toolbar-icon-gap\)\]/u)
  assert.match(monacoSource, /vds-code-actions[^"\n]*!border-b-0/u)
  assert.match(monacoSource, /markdown-undo[^\n]*variant="ghostIcon" size="sm"/u)
  assert.match(markdownSource, /top-bar-inner\]:!gap-\[var\(--vds-toolbar-icon-gap\)\]/u)
  assert.match(markdownSource, /top-bar-item\]:!size-\[var\(--vds-control-height-sm\)\]/u)
  assert.match(markdownSource, /top-bar-item\]:!text-\[length:var\(--vds-font-body-lv2\)\]/u)
  assert.match(markdownSource, /top-bar-item_svg\]:!size-\[var\(--vds-icon-7\)\]/u)
})

test('visual Markdown selection contributes one unified quick-format toolbar', () => {
  assert.match(markdownSource, /CrepeFeature\.Toolbar\]: false/)
  assert.match(markdownSource, /useSelectionActionContribution\(tabId,/)
  assert.match(markdownSource, /setFormatActions\(FORMAT_ACTIONS\.map/)
  assert.match(markdownSource, /aria-label=\{t\(action.labelKey\)\}/)
  assert.match(markdownSource, /onClick=\{\(\) => runFormat\(action.onRun\)\}/)
  for (const label of ['markdown.bold', 'markdown.italic', 'markdown.strike', 'markdown.inlineCode', 'markdown.inlineMath', 'markdown.link']) {
    assert.ok(markdownSource.includes(`labelKey: '${label}'`))
  }
  assert.doesNotMatch(markdownSource, /aria-label=["']润色["']/)
})

test('Markdown visual and source editors replace a guarded selection through native edit transactions', () => {
  assert.match(markdownSource, /replaceSelection/)
  assert.match(markdownSource, /tr\.replaceRange/)
  assert.match(markdownSource, /editorPositionAtDOM\(view, range\.startContainer, range\.startOffset\)/)
  assert.match(markdownSource, /CodeEditorView\.findFromDOM\(host\)/)
  assert.match(markdownSource, /syncCodeEditorSelections\(view, \{ anchor, focus \}\)/)
  assert.match(markdownSource, /code\.dispatch\(\{ selection: \{ anchor, head \} \}\)/)
  assert.match(markdownSource, /onMouseMoveCapture=/)
  assert.match(markdownSource, /syncCodeEditorPointerSelection\(ctx\.get\(editorViewCtx\), pointerStart, host, point\)/)
  assert.match(markdownSource, /markdownSourceRange\(source, syntaxTreeRef\.current\.tree, rendered, renderedFrom, rendered\.length\)/)
  assert.match(markdownSource, /editorSelection\.text\.replace\(\/\\s\/gu, ''\) === text\.replace\(\/\\s\/gu, ''\)/)
  assert.match(markdownSource, /if \(selected !== captured\.text\) return/)
  assert.doesNotMatch(markdownSource, /active\.from !== captured\.from/)
  assert.match(markdownSource, /expectedChangeVersion/)
  assert.match(monacoSource, /replaceSelection/)
  assert.match(monacoSource, /executeEdits/)
  assert.match(monacoSource, /pushUndoStop/)
})


test('Markdown display fetches with credentials, deduplicates and releases local image URLs', async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { scholarseed: { getApiBase: () => 'http://127.0.0.1:9999' } } })
  const nativeFetch = globalThis.fetch
  const fetchImage = t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, options?: RequestInit) => {
    assert.equal(options?.credentials, 'include')
    assert.ok(options?.signal instanceof AbortSignal)
    assert.equal(new URL(String(url)).searchParams.get('path'), 'nested/.assert/中文 name.md/img/a.png')
    return new Response('image bytes', { headers: { 'Content-Type': 'image/png' } })
  })
  const resolver = createMarkdownImageResolver({ kind: 'project', project: 'project-a', path: 'nested/中文 name.md' })
  try {
    const relative = '.assert/%E4%B8%AD%E6%96%87%20name.md/img/a.png'
    const first = resolver.resolve(relative)
    const second = resolver.resolve(relative)
    assert.equal(first, second)
    const local = await first
    assert.match(local, /^blob:/)
    assert.equal(await (await nativeFetch(local)).text(), 'image bytes')
    assert.equal(fetchImage.mock.callCount(), 1)
    assert.equal(resolver.resolve('https://example.com/a.png'), 'https://example.com/a.png')
    resolver.dispose()
    await assert.rejects(nativeFetch(local))
  } finally {
    resolver.dispose()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('Markdown display cannot allocate an image after its editor is disposed', async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { scholarseed: { getApiBase: () => '' } } })
  let finish!: (value: Response) => void
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve) => { finish = resolve }))
  const createUrl = t.mock.method(URL, 'createObjectURL')
  const resolver = createMarkdownImageResolver({ kind: 'project', path: 'notes.md' })
  try {
    const pending = resolver.resolve('.assert/notes.md/img/a.png')
    resolver.dispose()
    finish(new Response('late image'))
    await assert.rejects(Promise.resolve(pending), { name: 'AbortError' })
    assert.equal(createUrl.mock.callCount(), 0)
  } finally {
    resolver.dispose()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('math compatibility normalizes bracket delimiters before escapes and protects examples', () => {
  const source = String.raw`Prose \(x_i^2\) and \[\frac{a}{b}\]. Code \`\(raw\)\` and existing $\text{\(literal\)}$.`
  const codeStart = source.indexOf('`') - 1
  const codeEnd = source.indexOf('`', codeStart + 2) + 1
  const mathStart = source.indexOf('$')
  const tree = { type: 'root', children: [
    { type: 'inlineCode', position: { start: { offset: codeStart }, end: { offset: codeEnd } } },
    { type: 'inlineMath', position: { start: { offset: mathStart }, end: { offset: source.length - 1 } } }
  ] }
  const normalized = normalizeMathDelimiters(source, tree)
  assert.ok(normalized.startsWith('Prose $x_i^2$ and \n$$\n\\frac{a}{b}\n$$\n.'))
  assert.ok(normalized.includes(String.raw`\(raw\)`))
  assert.ok(normalized.includes(String.raw`$\text{\(literal\)}$`))
  assert.equal(normalizeMathDelimiters(String.raw`> \[
> x^2
> \]`, { type: 'root' }), '> $$\n> x^2\n> $$')
  assert.equal(normalizeMathDelimiters(String.raw`Escaped \\(x\\) and unclosed \(x`, { type: 'root' }), String.raw`Escaped \\(x\\) and unclosed \(x`)
})


test('Markdown image failures retain HTTP diagnostics and allow a later retry', async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { scholarseed: { getApiBase: () => '' } } })
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('unavailable', { status: 503 }))
  const resolver = createMarkdownImageResolver({ kind: 'project', path: 'notes.md' })
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(Promise.resolve(resolver.resolve('.assert/notes.md/img/a.png')), (error: unknown) => {
        assert.ok(error instanceof ImageOperationError)
        assert.equal(error.code, 'readFailed')
        assert.equal(error.status, 503)
        return true
      })
    }
    assert.equal(fetchMock.mock.callCount(), 2)
  } finally {
    resolver.dispose()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})


test('Monaco runs in a language-scoped frame while the application renderer stays mounted', () => {
  assert.match(frameBootstrapSource, /language === 'zh'[\s\S]*import\('monaco-editor\/nls\/lang\/zh-cn'\)/)
  assert.match(frameBootstrapSource, /await import\('\.\/runtime'\)/)
  assert.match(frameSource, /new URL\('\.\/monaco\.html'/)
  assert.match(frameSource, /event\.source !== frameRef\.current\?\.contentWindow/)
  assert.match(featureSource, /editorRuntimeRevision/)
  assert.doesNotMatch(storeSource, /reloadRenderer\(/)
  for (const source of [monacoSource, diffSource]) {
    assert.match(source, /<MonacoFrame/)
    assert.doesNotMatch(source, /languagePending|MONACO_LANGUAGE/)
  }
})

test('literal LaTeX labels use the editor locale while language IDs stay intact', () => {
  assert.equal(codeLanguageLabel('latex-source', 'LaTeX (code)'), 'LaTeX (code)')
  assert.equal(codeLanguageLabel('latex-source', 'LaTeX（代码）'), 'LaTeX（代码）')
  assert.equal(codeLanguageLabel('latex', 'LaTeX (code)'), 'latex')
  assert.equal(codeLanguageLabel('typescript', 'LaTeX（代码）'), 'typescript')
  assert.match(markdownSource, /getFixedT\(editorLanguage, 'workbench'\)/)
  assert.match(markdownSource, /renderLanguage: \(language\) => codeLanguageLabel\(language, t\('markdown.literalLatex'\)\)/)
})

test('Crepe image, link and language inputs receive localized labels from the frozen editor scope', () => {
  const creation = markdownSource.slice(markdownSource.indexOf("const t = i18n.getFixedT(editorLanguage, 'workbench')"), markdownSource.indexOf('crepe.editor.use(mathCompatibilityPlugin)'))
  const fields = {
    inlineUploadButton: 'uploadImage',
    inlineUploadPlaceholderText: 'pasteImageLink',
    blockUploadButton: 'uploadImageFile',
    blockConfirmButton: 'confirmImage',
    blockCaptionPlaceholderText: 'imageCaptionPlaceholder',
    blockUploadPlaceholderText: 'pasteImageLink',
    searchPlaceholder: 'searchLanguage',
    copyText: 'codeCopy',
    noResultText: 'codeNoResults',
    previewLabel: 'codePreview',
    previewLoading: 'codeLoading',
    inputPlaceholder: 'pasteLink'
  }
  for (const [field, key] of Object.entries(fields)) {
    assert.ok(creation.includes(`${field}: t('markdown.${key}')`), field)
  }
  assert.match(creation, /onUpload: async \(file\) => \{[\s\S]*persistMarkdownImage\(session.source, file\)/)
  assert.match(creation, /proxyDomURL: \(url\) => imageResolver.resolve\(url\)/)
  assert.match(creation, /previewOnlyByDefault: true/)
  assert.match(creation, /previewToggleText: \(previewOnlyMode\) => previewOnlyMode \? t\('markdown\.edit'\) : t\('markdown\.codeHide'\)/)
  const labels = ['zh', 'en'].map(language => JSON.parse(readFileSync(new URL(`../../../../localization/locales/${language}/workbench.json`, import.meta.url), 'utf8')).markdown)
  for (const key of new Set([...Object.values(fields), 'edit', 'codeHide'])) {
    assert.equal(typeof labels[0][key], 'string')
    assert.equal(typeof labels[1][key], 'string')
    assert.notEqual(labels[0][key], labels[1][key])
  }
})

test('localized Crepe chrome uses installed public options and retains the editor language lifetime', () => {
  const crepe = new URL('../../../../../node_modules/@milkdown/crepe/', import.meta.url)
  const codeFeature = readFileSync(new URL('src/feature/code-mirror/index.ts', crepe), 'utf8')
  const blockConfig = readFileSync(new URL('../../../../../node_modules/@milkdown/components/src/code-block/config.ts', import.meta.url), 'utf8')
  for (const field of ['copyText', 'noResultText', 'previewLabel', 'previewLoading']) {
    assert.ok(blockConfig.includes(`${field}: string`), `${field} is a public CodeBlockConfig option`)
    assert.ok(codeFeature.includes(`config.${field}`), `${field} reaches the native block config`)
  }
  const featureTypes = readFileSync(new URL('lib/types/feature/code-mirror/index.d.ts', crepe), 'utf8')
  assert.match(featureTypes, /previewToggleText: \(previewOnlyMode: boolean\) => string/)
  assert.match(codeFeature, /config\.previewToggleText\?\.\(previewOnlyMode\)/)
  const imageFeature = readFileSync(new URL('src/feature/image-block/index.ts', crepe), 'utf8')
  assert.match(imageFeature, /blockConfirmButton: string/)
  assert.match(imageFeature, /confirmButton: config\?\.blockConfirmButton/)
  assert.match(markdownSource, /const \[editorLanguage\] = useState\(requestedLanguage\)/)
  assert.match(markdownSource, /getFixedT\(editorLanguage, 'workbench'\)/)
  assert.match(markdownSource, /requestedLanguage !== editorLanguage/)
})

test('Markdown code block copy uses the desktop clipboard bridge and reports the outcome', () => {
  assert.match(markdownSource, /import \{ writeClipboard \} from '\.\.\/\.\.\/components\/primitive\/clipboard'/u)
  assert.match(markdownSource, /const CODE_COPY_BUTTON_SELECTOR = '\.milkdown-code-block \.copy-button'/u)
  assert.match(markdownSource, /CodeEditorView\.findFromDOM\(editorHost\)\?\.state\.doc\.toString\(\) \?\? null/u)
  assert.match(markdownSource, /writeClipboard\(code\)[\s\S]*markdown\.codeCopied[\s\S]*markdown\.codeCopyFailed/u)
  assert.match(markdownSource, /event\.preventDefault\(\)[\s\S]*event\.stopPropagation\(\)/u)
  assert.match(markdownSource, /if \(copyButtonFromTarget\(event\.target\)\) return/u)
  assert.match(workbenchHarnessSource, /MARKDOWN_CODE_COPY_TEXT/u)
  assert.match(workbenchHarnessSource, /clipboard\.writeText\(''\)[\s\S]*\.milkdown-code-block \.copy-button[\s\S]*clipboardText\(\)/u)
  assert.match(workbenchHarnessSource, /Markdown 代码块复制写入真实系统剪贴板/u)
  assert.match(workbenchE2ESource, /\.milkdown-code-block \.copy-button[\s\S]*clipboard\.readText\(\)[\s\S]*已复制代码/u)

  const labels = ['zh', 'en'].map(language => JSON.parse(readFileSync(
    new URL(`../../../../localization/locales/${language}/workbench.json`, import.meta.url),
    'utf8'
  )).markdown)
  assert.deepEqual(labels.map(markdown => markdown.codeCopied), ['已复制代码', 'Code copied'])
  assert.deepEqual(labels.map(markdown => markdown.codeCopyFailed), ['复制失败，请重试', 'Copy failed. Try again.'])
})

test('Monaco source editor binds native copy and paste handlers', () => {
  assert.match(monacoSource, /editContext: false/u)
  assert.match(monacoSource, /const copyKeybindings = \[monaco\.KeyMod\.CtrlCmd \| monaco\.KeyCode\.KeyC\]/u)
  assert.match(monacoSource, /copyKeybindings\.push\(monaco\.KeyMod\.WinCtrl \| monaco\.KeyCode\.KeyC\)/u)
  assert.match(monacoSource, /const copyAction = editor\.addAction\(\{[\s\S]*keybindings: copyKeybindings,[\s\S]*precondition: EDITOR_TEXT_FOCUS,[\s\S]*run: copyCommand/u)
  assert.match(monacoSource, /copyAction\.dispose\(\)/u)
  assert.match(monacoSource, /const pasteAction = editor\.addAction\(\{[\s\S]*monaco\.KeyMod\.CtrlCmd \| monaco\.KeyCode\.KeyV[\s\S]*precondition: EDITOR_WRITABLE_FOCUS,[\s\S]*window\.scholarseed\.pasteClipboard\(\)/u)
  assert.match(monacoSource, /const EDITOR_WRITABLE_FOCUS = 'editorTextFocus && !editorReadonly'/u)
  assert.match(monacoSource, /pasteAction\.dispose\(\)/u)
})
