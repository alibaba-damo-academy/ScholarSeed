import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { PDFDocument, PDFName, PDFString } from 'pdf-lib'
import { createInstance } from 'i18next'

import type { PdfRecordSnapshot } from './api.ts'
import { buildAnnotatedPdf } from './pdf/export.ts'
import { evidencePages } from './pdf/evidence.ts'
import { externalPdfLinks, PDF_ANNOTATION_INTENT } from './pdf/links.ts'
import { PDF_HIGHLIGHT_VISUAL_CLASS, pdfMarkVisualClass } from './pdf/records.ts'

test('PDF evidence navigation groups duplicate pages without losing supporting quotes', () => {
  const anchors = [{ page: 2, quote: 'B' }, { page: 1, quote: 'A' }, { page: 1, quote: 'A2' }, { page: 1, quote: 'A' }]
  assert.deepEqual(evidencePages(anchors), [{ page: 1, quote: 'A\n\nA2' }, { page: 2, quote: 'B' }])
  assert.equal(anchors.length, 4)
  assert.deepEqual(evidencePages(), [])
})

test('figure explanation omits page navigation while other reading outputs retain it', () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  assert.match(source, /<Markdown text=\{floatingResult\?\.text \?\? figureText\}/)
  assert.match(source, /output\(floatingResult, true\)/)
  assert.match(source, /showEvidence && evidencePages\(content.evidence\)/)
})

test('PDF owns its toolbar so the Dock does not reserve an empty row', () => {
  const feature = readFileSync(new URL('./feature.tsx', import.meta.url), 'utf8')
  assert.match(feature, /kind: 'pdf',[\s\S]*toolbar: 'viewer'/)
})

test('PDF rail actions are icon-only and side panels can fill the PDF area', () => {
  const document = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const reading = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const panel = readFileSync(new URL('./pdf/Panel.tsx', import.meta.url), 'utf8')
  const floatingWindow = readFileSync(new URL('../../components/primitive/FloatingWindow.tsx', import.meta.url), 'utf8')
  assert.match(document, /data-testid="pdf-annotation-toggle"[^>]*label=\{t\('pdfAnnotation\.records'\)\}/)
  assert.match(document, /<nav aria-label=\{t\('pdfToolbar\.toolbar'\)\}[^>]*items-center/)
  assert.match(document, /const label = panel\.label\(i18n\)/)
  assert.match(document, /<Tooltip key=\{panel\.id\} portalled content=\{label\} side="left">[\s\S]*data-testid=\{`document-panel-toggle-\$\{panel\.id\}`\}[\s\S]*label=\{label\}[\s\S]*title=\{undefined\}/)
  assert.match(document, /<Tooltip portalled content=\{t\('pdfAnnotation\.records'\)\} side="left">/)
  assert.match(reading, /<Tooltip portalled content=\{LABELS\.document_translation\} side="left">[\s\S]*data-testid="pdf-document-translation"[^>]*title=\{undefined\}/)
  assert.match(reading, /<Tooltip portalled content=\{LABELS\.interpretation\} side="left">[\s\S]*data-testid="pdf-interpretation"[^>]*title=\{undefined\}/)
  assert.match(reading, /<PdfPanel[\s\S]*testId="pdf-reading-panel"/)
  assert.match(document, /<PdfPanel[\s\S]*testId=\{`document-panel-\$\{activeDocumentPanel\.id\}`\}/)
  assert.match(panel, /className="flex min-h-12 items-center justify-between gap-2[^"\n]*px-3 py-2"/)
  assert.match(panel, /icon=\{<Icon name="close" size=\{14\} \/>\}/)
  assert.match(floatingWindow, /data-testid="floating-window-toggle-size"/)
})

test('figure explanation keeps a stable toolbar button and replaces in-flight streams', () => {
  const reading = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const viewer = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const zh = JSON.parse(readFileSync(new URL('../../../../localization/locales/zh/pdf.json', import.meta.url), 'utf8'))
  const en = JSON.parse(readFileSync(new URL('../../../../localization/locales/en/pdf.json', import.meta.url), 'utf8'))

  assert.match(reading, /data-testid="pdf-figure-explanation"/)
  assert.match(reading, /const figureModelSupportsImageInput = Boolean/)
  assert.match(reading, /if \(!figureModelSupportsImageInput\)/)
  assert.match(reading, /code: 'pdf_ai_image_input_unsupported'/)
  assert.match(reading, /lastFigureRegion\.current = region/)
  assert.match(reading, /kind === 'figure_explanation' && lastFigureRegion\.current\) startFigure\(lastFigureRegion\.current\)/)
  assert.doesNotMatch(reading, /data-testid="pdf-figure-explanation"[^>]*disabled/)
  assert.match(reading, /<HoverCardContent side="bottom"/)
  assert.doesNotMatch(reading, /reading\.figureScope/)
  assert.match(reading, /figureAbort\.current\?\.abort\(\)/)
  assert.match(reading, /invokeFigure\(request, figureController\.signal/)
  assert.doesNotMatch(reading, /figureQueue|figureQueued/)
  assert.doesNotMatch(reading, /figureHistory|setFigureHistory/)
  assert.match(reading, /floatingResult \|\| busy \|\| cropPreview \|\| jobs\.figure_explanation\?\.error \|\| jobs\.figure_explanation\?\.failed \? <Card/)
  assert.doesNotMatch(reading, /figureResult', \{ index:/)
  assert.doesNotMatch(reading, /figureResultPending', \{ index:/)
  assert.equal(zh.reading.figureResult, '选区 · 第 {{page}} 页')
  assert.equal(zh.reading.figureResultPending, '选区 · 正在解释…')
  assert.equal(en.reading.figureResult, 'Selection · Page {{page}}')
  assert.equal(en.reading.figureResultPending, 'Selection · Explaining…')
  assert.match(zh.reading.figureUnavailable, /当前模型.*图片输入/)
  assert.match(en.reading.figureUnavailable, /current model.*image input/i)
  assert.match(reading, /action !== 'figure_explanation' && action !== 'document_translation' && jobBusy\(job\)/)
  assert.match(reading, /literatureId && kind !== 'figure_explanation'/)
  assert.match(reading, /<FigureGuide t=\{t\}/)
  assert.match(reading, /const FIGURE_GUIDE_SCALE = 4 \/ 7/)
  assert.match(reading, /width: `min\(\$\{FIGURE_GUIDE_WIDTH_PX\}px, calc\(100vw - \$\{FIGURE_GUIDE_VIEWPORT_GUTTER_PX\}px\)\)`/)
  assert.match(reading, /zoom: FIGURE_GUIDE_SCALE/)
  assert.match(reading, /gridTemplateColumns: '220px minmax\(0, 1fr\)'/)
  assert.match(reading, /variant=\{figure \? 'primary' : 'outline'\}/)
  assert.match(reading, /onClose=\{\(\) => \{ setFloating\(null\); if \(floating === 'figure_explanation'\) \{ void cancel\('figure_explanation'\); exitFigureSelection\(\) \} \}\}/)
  assert.match(reading, /figurePromptGuide/)
  assert.match(reading, /<HoverCardTrigger asChild onClick=\{\(\) => \{ if \(figure\) exitFigureSelection\(\); else \{ onExclusiveSurfaceOpen\(\); setFigure\(true\); setFigureGuideOpen\(false\) \}/)
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

test('PDF surfaces exit figure selection through one transition', () => {
  const reading = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const viewer = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')

  assert.match(reading, /const exitFigureSelection = useCallback\(\(\): void => \{ setFigure\(false\); setFigureGuideOpen\(false\) \}, \[\]\)/)
  assert.match(reading, /toggleInterpretation[\s\S]*exitFigureSelection\(\)[\s\S]*onExclusiveSurfaceOpen\(\)/)
  assert.match(reading, /toggleDocumentTranslation[\s\S]*exitFigureSelection\(\)[\s\S]*onExclusiveSurfaceOpen\(\)/)
  assert.match(viewer, /const clearFigureSelection = useCallback\(\(\): void => \{\s*cropStart\.current = undefined\s*setCropBox\(null\)/)
  assert.match(viewer, /const exitFigureSelection = useCallback\(\(\): void => \{\s*clearFigureSelection\(\)\s*analysis\.exitFigureSelection\(\)/)
  assert.match(viewer, /data-testid=\{`document-panel-toggle-\$\{panel\.id\}`\}[\s\S]*exitFigureSelection\(\)[\s\S]*documentPanels\.toggle\(panel\.id\)/)
  assert.match(viewer, /data-testid="pdf-annotation-toggle"[\s\S]*exitFigureSelection\(\)/)
})

test('literature AI actions expose independent persisted model selectors', () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  assert.match(source, /import \{ ModelMenu \} from '\.\.\/\.\.\/\.\.\/components\/business\/ModelMenu'/)
  assert.match(source, /t\('reading\.currentModel'\)/)
  assert.match(source, /state\.literatureAiModels/)
  assert.match(source, /actions\.setLiteratureAiModel\(kind, model\.key\)/)
  assert.match(source, /modelControl\('figure_explanation', true\)/)
  assert.match(source, /modelControl\(panel as 'document_translation' \| 'interpretation'\)/)
  assert.match(source, /modelFilter=\{multimodal \? MULTIMODAL_MODEL_FILTER : undefined\}/)
  assert.match(source, /model_key: actionModelKey\(kind\)/)
})

test('PDF explanation requests follow the committed interface language', () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const analysis = readFileSync(new URL('./pdf/analysis.ts', import.meta.url), 'utf8')

  assert.match(source, /pdfResponseLanguage\(i18n\.resolvedLanguage \|\| i18n\.language\)/)
  assert.match(source, /response_language: responseLanguage/)
  assert.match(source, /data\.interpretation\.response_language !== responseLanguage/)
  assert.match(analysis, /startsWith\('en'\) \? 'en' : 'zh'/)
})

test('figure explanation keeps a synchronous capability failure visible', () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  assert.match(source, /jobs\.figure_explanation\?\.error \|\| jobs\.figure_explanation\?\.failed \? <Card/)
  assert.match(source, /feedback\('figure_explanation'\)/)
})

const BROKEN_CONTENTS_PDF = new URL('../../../../../e2e/fixtures/preview_pdf_1MB.pdf', import.meta.url)

test('selection actions replace in-flight work and never present a previous selection result', () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  assert.match(source, /lastRequest.current\?\.kind === 'selection_translation'\s*\? lastRequest.current.text/)
  assert.match(source, /<p>\{translationSource\}<\/p>/)
  assert.match(source, /REPLACEABLE_ACTIONS\.has\(kind\)/)
  assert.match(source, /const \{ \[kind\]: _stale, \.\.\.remaining \} = previous/)
  assert.match(source, /const floatingResult = floating && !busy \? results\[floating\] : undefined/)
  assert.doesNotMatch(source, /reading\.previousSource/)
  assert.doesNotMatch(source, /previousTranslation/)
})

test('PDF actions isolate requests and allow a new selection to replace busy work', () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  assert.match(source, /requests.current\[kind\] = request/)
  assert.doesNotMatch(source, /disabled=\{isBusy\('selection_explanation'\)\}/)
  assert.doesNotMatch(source, /disabled=\{isBusy\('selection_translation'\)\}/)
  assert.match(source, /REPLACEABLE_ACTIONS\.has\(kind\)/)
  assert.match(source, /feedback\(panel\)/)
  assert.match(source, /feedback\(floating\)/)
  assert.match(source, /cancel\(kind\)/)
  assert.doesNotMatch(source, /if \(busy\) return/)
})

test('document translation uses one global automatic switch and page-aligned results', () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')

  assert.match(source, /data-testid="pdf-document-translation"/)
  assert.match(source, /aria-pressed=\{automaticTranslation\}/)
  assert.match(source, /onCheckedChange=\{checked => changeAutomaticTranslation\(checked, sourcePage\)\}/)
  assert.match(source, /Array\.from\(\{ length: pageCount \}, \(_, index\) => translationCard\(index \+ 1\)\)/)
  assert.match(source, /data-testid=\{`pdf-translation-page-\$\{sourcePage\}`\}/)
  assert.doesNotMatch(source, /reading\.translateAll/)
})

test('AI interpretation opens idle and starts only from the summary action', () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')

  const toggle = source.slice(source.indexOf('const toggleInterpretation'), source.indexOf('const toggleDocumentTranslation'))
  assert.doesNotMatch(toggle, /run\('interpretation'\)/)
  assert.match(source, /data-testid="pdf-interpretation"/)
  assert.match(source, /data-testid="pdf-generate-summary"[\s\S]*run\('interpretation'\)/)
  assert.doesNotMatch(source, /reading\.documentScope/)
  assert.match(source, /: !isBusy\('interpretation'\) && <div className="grid gap-5 p-5">/)
  assert.match(source, /footer=\{panel === 'interpretation' \? <footer/)
})

test('the Electron PDF adapter uses the legacy-compatible PDF.js entry and matching worker', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  assert.match(source, /pdfjs-dist\/legacy\/build\/pdf\.mjs/)
  assert.match(source, /pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs\?url/)
})

test('PDF pages expose URI annotations through the default-browser bridge', () => {
  const source = readFileSync(new URL('./pdf/Page.tsx', import.meta.url), 'utf8')
  assert.match(source, /page\.getAnnotations\(\{ intent: PDF_ANNOTATION_INTENT \}\)/)
  assert.match(source, /externalPdfLinks\(annotations, view\)/)
  assert.match(source, /data-testid=\{`pdf-external-link-\$\{page\.pageNumber\}-\$\{index\}`\}/)
  assert.match(source, /window\.scholarseed\.openExternal\(link\.url\)/)
})

test('PDF toolbar uses S controls with visible and ghost group spacing', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const tools = readFileSync(new URL('./pdf/Tools.tsx', import.meta.url), 'utf8')

  assert.match(source, /vds-pdf-tools[^"\n]*min-h-12/u)
  assert.match(source, /justify-self-start[^"\n]*gap-\[var\(--vds-space-2\)\]/u)
  assert.match(source, /justify-self-end[^"\n]*gap-\[var\(--vds-space-2\)\]/u)
  assert.match(source, /size="sm"[^\n]*data-testid="pdf-sidebar-toggle"/u)
  assert.doesNotMatch(source, /data-testid="pdf-search-open"/u)
  assert.match(tools, /gap-\[var\(--vds-toolbar-icon-gap\)\][^>]*data-pdf-annotation-tools/u)
})

test('PDF page number uses a plain numeric text input without stepper controls', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')

  assert.match(source, /data-testid="pdf-page-input"[^>]*type="text"[^>]*inputMode="numeric"/u)
  assert.doesNotMatch(source, /data-testid="pdf-page-input"[^>]*type="number"/u)
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
  assert.match(source, /pageInSelectionSpan\(number, selectionDragSpan\.anchor, selectionDragSpan\.focus\)/)
  assert.match(source, /if \(selections\.length && selectionDragSpan === null\) window\.getSelection\(\)\?\.removeAllRanges\(\)/)
  assert.match(page, /const renderable = near \|\| keepRendered/)
  assert.match(page, /\{renderable && <canvas/)
  assert.match(page, /releaseCanvas\(target\)/)
  assert.match(page, /releaseCanvas\(stagingCanvas\.current\)/)
})

test('PDF annotation rendering and hit testing share the newest-first overlap projection', () => {
  const page = readFileSync(new URL('./pdf/Page.tsx', import.meta.url), 'utf8')

  assert.match(page, /const visibleAnnotations = useMemo\(\(\) => projectVisibleMarks\(annotations\), \[annotations\]\)/)
  assert.match(page, /visibleAnnotations\.find\(annotation => annotation\.quads\.some/)
  assert.match(page, /visibleAnnotations\.flatMap\(\(\{ mark: annotation, quads \}\) => quads\.map/)
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

  assert.match(contract, /interface PdfMarkRecord/)
  assert.match(contract, /style: 'highlight' \| 'underline' \| 'strikethrough'/)
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
  assert.match(source, /disabled=\{!sidecar \|\| exporting\}/)
  assert.match(source, /exportingRef\.current/)
  assert.match(source, /\[pdf-export\]/)
  assert.doesNotMatch(source, /data-testid="pdf-export" disabled=\{!sidecar\?\.records\.marks\.length/)
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
  assert.match(source, /className="vds-selection-action-result"/)
  assert.match(source, /<CopyButton/)
  assert.match(source, /<PdfAnnotations/)
  assert.doesNotMatch(source, /写入笔记|添加到笔记/)
  assert.match(annotations, /bodyTestId="pdf-annotation-list"/)
  assert.match(annotations, /filterMarks/)
  assert.match(annotations, /<Tabs value=\{filter\}/)
  assert.match(annotations, /<TabsTrigger key=\{category\} value=\{category\}/)
  assert.match(annotations, /groupMarksByPage/)
  assert.match(page, /<Popover/)
  assert.match(page, /renderAnnotation/)
  assert.match(annotation, /PDF_MARK_PALETTE\.map/)
  assert.match(annotation, /comments\.length > 0/)
  assert.match(annotation, /pdfAnnotation\.commentedLocation/)
  assert.match(annotation, /pdfAnnotation\.commentStatus/)
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
  assert.doesNotMatch(source, /status\.(underlineSaved|highlightSaved|markSaved|strikethroughSaved|updated|commentSaved)/)
  assert.doesNotMatch(source, /pdfAnnotation\.undo/)
  assert.doesNotMatch(source, /const \{ dismiss, toast \} = useToast\(\)/)
})

test('PDF annotation inspector groups controls and silently persists direct edits', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const annotation = readFileSync(new URL('./pdf/Annotation.tsx', import.meta.url), 'utf8')
  const updateMark = source.slice(source.indexOf('const updateMark'), source.indexOf('const applyMark'))

  assert.match(annotation, /data-testid="pdf-annotation-styles"[\s\S]*data-testid="pdf-annotation-colors"[\s\S]*data-testid="pdf-annotation-actions"[\s\S]*data-testid="pdf-annotation-delete"/)
  assert.match(annotation, /data-testid="pdf-annotation-styles"[^>]*grid-cols-3/)
  assert.match(annotation, /data-testid="pdf-annotation-actions"[^>]*grid[^>]*>[\s\S]*pdfAnnotation\.comment[\s\S]*pdfAnnotation\.explain[\s\S]*pdfAnnotation\.translate[\s\S]*pdfAnnotation\.copy/)
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
  assert.match(documentSource, /renderAnnotation=\{\(mark, close\) => <PdfAnnotation/)
  assert.match(documentSource, /onExplain=\{\(instruction\) => \{ analysis\.explainSelection\(\{ page: mark\.page, text: mark\.text, quads: mark\.quads \}, instruction\); close\(\); setActiveMark\(null\) \}\}/)
  assert.match(documentSource, /onTranslate=\{\(\) => \{ analysis\.translateSelection\(\{ page: mark\.page, text: mark\.text, quads: mark\.quads \}\); close\(\); setActiveMark\(null\) \}\}/)
  assert.match(reading, /const run = async \([^)]*selected = selection/)
  assert.match(reading, /page: requestedPage \?\? region\?\.page \?\? selected\[0\]\?\.page \?\? page, text: selected\.map/)
  assert.match(reading, /quads: selected\.filter/)
  assert.match(reading, /const canAnalyzeSelection = Boolean\(literatureId \|\| \(projectId && path\)\)/)
  assert.match(reading, /canAnalyzeSelection,\s*selectionAnalyzing:/)
  assert.match(reading, /explainSelection: \(target\?: PdfSelection, requirement = ''\) => \{ void run\('selection_explanation',[^\n]*target \? \[target\] : selection, selectionInstruction\(state\.selectionPrompts, 'explain', requirement\)\) \}/)
  assert.match(reading, /translateSelection: \(target\?: PdfSelection\) => \{ void run\('selection_translation',[^\n]*target \? \[target\] : selection\) \}/)
  assert.doesNotMatch(reading, /if \(selection\.length \|\| !selectionResult\) return[\s\S]*setFloating\(null\)/)
})

test('PDF explanations accept optional instructions and link to prompt settings', () => {
  const annotation = readFileSync(new URL('./pdf/Annotation.tsx', import.meta.url), 'utf8')
  const reading = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const guide = readFileSync(new URL('../../components/business/PromptSettingsGuide.tsx', import.meta.url), 'utf8')

  assert.match(annotation, /<Textarea[^>]*autoFocus[^>]*pdfAnnotation\.explainPrompt/)
  assert.match(annotation, /onExplain\(explanationDraft\.trim\(\)\)/)
  assert.doesNotMatch(annotation, /if \(!explanationDraft\.trim\(\)\) return/)
  assert.doesNotMatch(annotation, /disabled=\{!explanationDraft\.trim\(\) \|\| analyzing\}/)
  assert.match(annotation, /<PromptSettingsGuide[^>]*prefix=\{t\('pdfAnnotation\.promptGuide'\)\}[^>]*linkPrefix=\{t\('pdfAnnotation\.promptGuideLinkPrefix'\)\}/)
  assert.match(reading, /selectionExplanationOpen/)
  assert.match(reading, /selectionExplanationSnapshot/)
  assert.match(reading, /<Textarea[^>]*autoFocus[^>]*reading\.explanationPrompt/)
  assert.match(reading, /selectionInstruction\(state\.selectionPrompts, 'explain', selectionExplanationDraft\)/)
  assert.doesNotMatch(reading, /if \(!requirement \|\| !selectionExplanationSnapshot\.length\) return/)
  assert.doesNotMatch(reading, /disabled=\{!selectionExplanationDraft\.trim\(\)\}/)
  assert.match(reading, /<PromptSettingsGuide[^>]*prefix=\{t\('reading\.explanationPromptGuide'\)\}[^>]*linkPrefix=\{t\('reading\.promptGuideLinkPrefix'\)\}/)
  assert.match(reading, /floating === 'selection_translation'[\s\S]*PromptSettingsGuide/)
  assert.match(reading, /expanded: selectionExplanationOpen/)
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
  assert.match(annotations, /<PdfPanel[\s\S]*testId="pdf-annotations"/)
  assert.match(document, /<PdfPanel[\s\S]*testId=\{`document-panel-/)
  assert.match(reading, /<PdfPanel[\s\S]*testId="pdf-reading-panel"/)
})

test('PDF annotation list copies source text and each comment independently', () => {
  const annotations = readFileSync(new URL('./pdf/Annotations.tsx', import.meta.url), 'utf8')

  assert.match(annotations, /value=\{mark\.text\}[\s\S]*pdfAnnotation\.copySource/)
  assert.match(annotations, /className="mt-2 flex flex-wrap items-center gap-1">[\s\S]*markComments\.map\(\(comment\) => <CopyButton[\s\S]*value=\{comment\.body\}[\s\S]*pdfAnnotation\.copyComment[\s\S]*value=\{mark\.text\}/)
  assert.doesNotMatch(annotations, /markComments[\s\S]*\.join\(/)
})

test('PDF annotation comments do not repeat source text above the source block', () => {
  const annotations = readFileSync(new URL('./pdf/Annotations.tsx', import.meta.url), 'utf8')

  assert.match(annotations, /const hasComments = markComments\.length > 0/)
  assert.match(annotations, /\{!hasComments \? \(/)
  assert.match(annotations, /\{!hasComments && expandable \? \(/)
  assert.match(annotations, /pdfAnnotation\.sourceLabel/)
})

test('PDF AI results no longer expose an add-to-note action', () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /添加到笔记|onNote|saveNote/)
  assert.match(source, /explainSelection/)
  assert.match(source, /translateSelection/)
})

test('PDF selection AI result windows survive selection dismissal and keep explicit controls', () => {
  const reading = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const floatingWindow = readFileSync(new URL('../../components/primitive/FloatingWindow.tsx', import.meta.url), 'utf8')

  assert.doesNotMatch(reading, /[Ff]loatingPinned/)
  assert.doesNotMatch(reading, /onPinnedChange=/)
  assert.doesNotMatch(reading, /documentSelectionInteractionProps/)
  assert.doesNotMatch(reading, /selection\.length[\s\S]*setFloating\(null\)/)
  assert.match(reading, /<FloatingWindow[\s\S]*title=\{LABELS\[floating\]\}[\s\S]*onClose=/)
  assert.match(floatingWindow, /aria-pressed=\{pinned\}/)
  assert.match(floatingWindow, /cursor-move/)
  assert.match(floatingWindow, /onPointerMove=\{move\}/)
  assert.match(floatingWindow, /floatingWindow\.close/)
})

test('PDF AI generated bodies remain text-selectable across markdown, summary, and translation', () => {
  const reading = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const markdown = readFileSync(new URL('../../components/primitive/Markdown.tsx', import.meta.url), 'utf8')
  const summary = readFileSync(new URL('./pdf/Summary.tsx', import.meta.url), 'utf8')
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

test('PDF selection AI result actions have one primary follow-up and stable secondary controls', () => {
  const reading = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')

  assert.match(reading, /<Button[^>]*variant="outline"[^>]*size="sm"[^>]*icon=\{annotationIdentity === annotatedResult \? <Check[^>]*> : <Icon name="annotation"/)
  assert.match(reading, /<CopyButton[^>]*size="sm"[^>]*variant="ghost"[^>]*icon=\{<Icon name="copy"/)
  assert.match(reading, /<Button[^>]*size="sm"[^>]*variant="primary"[^>]*icon=\{<Icon name="talk"[^>]*>\}[^>]*onClick=\{quote\}/)
})

test('selection explanation and translation follow-ups enter chat as self-contained snapshots', () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const zh = JSON.parse(readFileSync(new URL('../../../../localization/locales/zh/pdf.json', import.meta.url), 'utf8'))
  const en = JSON.parse(readFileSync(new URL('../../../../localization/locales/en/pdf.json', import.meta.url), 'utf8'))

  assert.match(source, /actions\.askAiFromPanel\(t\('reading\.selectionDraft'/)
  assert.match(source, /source: floatingResult\.selected_text/)
  assert.match(source, /result: floatingResult\.text/)
  assert.match(source, /floating !== 'figure_explanation' && <Button disabled=\{!floatingResult\}[\s\S]*?onClick=\{quote\}/)
  assert.match(source, /focusComposer\(\)/)
  assert.doesNotMatch(source, /ingress\.addContext|useAssistantIngress/)
  for (const draft of [zh.reading.selectionDraft, en.reading.selectionDraft]) {
    assert.match(draft, /\{\{source\}\}/)
    assert.match(draft, /\{\{result\}\}/)
  }
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
    assert.match(source, new RegExp(`<TabsTrigger value="${value}"`))
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
  assert.match(source, /PDF_NAVIGATION_DEFAULT_WIDTH_PX = 190/)
  assert.match(source, /PDF_NAVIGATION_MIN_WIDTH_PX = 190/)
  assert.match(source, /PDF_NAVIGATION_MAX_WIDTH_PX = 360/)
  assert.match(source, /<ResizablePanel/)
  assert.match(source, /data-testid="pdf-navigation-resizable"/)
  assert.match(source, /leftWidth=\{`\$\{navigationWidth\}px`\}/)
  assert.match(source, /onWidthChange=\{width => update\(\{ navigationWidth: Number\.parseFloat\(width\) \}\)\}/)
  assert.match(source, /style=\{\{ marginLeft: sidebar \? `\$\{navigationWidth\}px` : undefined \}\}/)
  assert.match(source, /const fitViewportWidth = size\.width \+ \(sidebar \? navigationWidth : 0\)/)
  assert.match(source, /fittedScale\(mode, natural, \{ width: Math\.max\(1, fitViewportWidth - PAGE_GUTTER\)/)
  assert.match(source, /const rightPanelOpen = Boolean\(analysis\.panel \|\| recordsOpen \|\| activeDocumentPanelId\)/)
  assert.match(source, /data-testid="pdf-pages-track"/)
  assert.match(source, /rightPanelOpen \? ' min-w-\[calc\(100%\+var\(--vds-layout-pdf-panel-width\)\)\] pr-\[var\(--vds-layout-pdf-panel-width\)\]'/)
  assert.match(source, /overflow-x-hidden/)
  assert.match(source, /bg-\[var\(--vds-bg-white-default\)\]!/)
  assert.match(panel, /absolute inset-y-0 right-\[var\(--vds-layout-pdf-rail-width\)\]/)
  assert.match(panel, /expanded \? ' left-0 max-w-none'/)
  assert.match(annotations, /<PdfPanel/)
  assert.match(reading, /<PdfPanel/)
  for (const panelSource of [source, panel]) {
    assert.match(panelSource, /bg-\[var\(--vds-bg-white-default\)\]/)
    assert.doesNotMatch(panelSource, /backdrop-opacity|bg-opacity|opacity-\d/)
  }
  assert.match(source, /className="w-full min-w-0 justify-start text-left whitespace-normal! \[overflow-wrap:anywhere\]"/)
  assert.match(source, /<mark className="rounded-\[var\(--vds-radius-2\)\] bg-\[var\(--vds-brand-bg-light\)\] px-0\.5 text-inherit"/)
  assert.match(outline, /<Collapsible[^>]*defaultOpen/)
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
  assert.match(outline, /<OutlineBranch items=\{item\.children\} depth=\{depth \+ 1\}/)
  assert.match(outline, /data-outline-depth=\{depth\}/)
  for (const name of ['highlighter', 'underline', 'annotation', 'strikethrough']) {
    assert.match(icons, new RegExp(`\\| '${name}'`))
  }
  assert.match(readFileSync(new URL('./pdf/Tools.tsx', import.meta.url), 'utf8'), /icon: 'highlighter'/)
  assert.match(readFileSync(new URL('./pdf/Tools.tsx', import.meta.url), 'utf8'), /icon: 'underline'/)
  assert.match(readFileSync(new URL('./pdf/Tools.tsx', import.meta.url), 'utf8'), /MessageSquareText/)
})

test('literature PDF tabs expose the reusable multi-selection resource import component', () => {
  const pdf = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const feature = readFileSync(new URL('./feature.tsx', import.meta.url), 'utf8')
  const store = readFileSync(new URL('../../store.tsx', import.meta.url), 'utf8')
  const component = readFileSync(new URL('../../components/business/Excerpts.tsx', import.meta.url), 'utf8')
  assert.match(store, /LITERATURE_EXCERPT_VIEW_STATE_KEY/)
  assert.match(store, /activeTab: OVERVIEW_TAB\.id/)
  assert.match(pdf, /<LiteratureExcerptImport/)
  assert.match(pdf, /documentRevision=\{session\.revision\}/)
  assert.match(pdf, /selections=\{excerptSelections\}/)
  assert.match(feature, /onResourceImported=\{async \(\) => \{\s+await act\.reloadResourceTree\(\)/)
  assert.match(component, /useTranslation\('literature'\)/)
  assert.match(component, /<DialogDescription>\s*\{t\('excerpts\.description'\)\}\s*<\/DialogDescription>/)
  const descriptions = ['zh', 'en'].map(language => JSON.parse(readFileSync(new URL(`../../../../localization/locales/${language}/literature.json`, import.meta.url), 'utf8')).excerpts.description)
  assert.deepEqual(descriptions, [
    '同一篇文献的多个选段会聚合到一份 Markdown 资料；已保存的相同页码和文本会自动跳过。',
    'Selections from the same paper are combined into one Markdown resource; duplicate pages and text are skipped.'
  ])
})

test('literature PDF opening preserves attachment identity and record ownership', () => {
  const store = readFileSync(new URL('../../store.tsx', import.meta.url), 'utf8')
  const detail = readFileSync(new URL('../literature/LiteratureDetail.tsx', import.meta.url), 'utf8')

  assert.match(store, /openLiteratureAttachment: \(\s*id: string,\s*attachmentId\?: string,\s*page\?: number,\s*options\?: \{ projectId\?: string \| null \}\s*\) => void/)
  assert.match(store, /detail\.attachments\.find\(\(candidate\) => candidate\.id === attachmentId\)/)
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
  const annotation = source.context.register(source.context.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Link'),
    Rect: [20, 30, 120, 50],
    Border: [0, 0, 0],
    A: {
      S: PDFName.of('URI'),
      URI: PDFString.of('https://example.com/paper')
    }
  }))
  page.node.set(PDFName.of('Annots'), source.context.obj([annotation]))

  const task = getDocument({ data: await source.save() })
  try {
    const parsedPage = await (await task.promise).getPage(1)
    const viewport = parsedPage.getViewport({ scale: 1 })
    assert.deepEqual(externalPdfLinks(await parsedPage.getAnnotations({ intent: PDF_ANNOTATION_INTENT }), viewport), [{
      url: 'https://example.com/paper',
      left: 20,
      top: 190,
      width: 100,
      height: 20
    }])
    assert.deepEqual(externalPdfLinks([
      { subtype: 'Link', url: 'javascript:alert(1)', rect: [20, 30, 120, 50] },
      { subtype: 'Link', unsafeUrl: 'file:///tmp/private', rect: [20, 30, 120, 50] }
    ], viewport), [])
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
      marks: [{
        id: 'highlight-1',
        style: 'highlight',
        color: 'yellow',
        page: 1,
        quads: [[0.1, 0.1, 0.4, 0.15]],
        text: 'PDF Preview Test',
        anchor_state: 'anchored',
        created_at: 1,
        updated_at: 1
      }],
      comments: [],
      notes: []
    }
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
  assert.match(source, /<Textarea[\s\S]*?value=\{commentDraft\}[\s\S]*?<Button\s+className="justify-self-end"[\s\S]*?\{t\('saveAnnotation'\)\}/)
})

test('PDF selection controls update their locale without replacing document or draft state', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  assert.match(source, /const selectionContribution = useMemo[\s\S]*?\[activeMark, addAiComment, commentDraft, commentFormOpen, highlightOpen, markColors, saving, selections, session\?\.capabilities\.can_annotate, session\?\.revision, sessionId, sidecar, t\]/)
  assert.match(source, /id: 'pdf-copy'/)
  assert.doesNotMatch(source, /quoteBefore/)
  assert.match(source, /value=\{commentDraft\}/)
  assert.match(source, /useSelectionActionContribution\(tabId, selectionContribution\)/)
  assert.match(source, /useSelectionActionContribution\(tabId, copyContribution\)/)
})


test('reading and table draft templates preserve interpolated source bytes in both languages', async () => {
  const resources = Object.fromEntries(['zh', 'en'].map(language => [language,
    Object.fromEntries(['pdf', 'workbench'].map(namespace => [namespace,
      JSON.parse(readFileSync(new URL(`../../../../localization/locales/${language}/${namespace}.json`, import.meta.url), 'utf8'))
    ]))
  ]))
  const locale = createInstance()
  await locale.init({ lng: 'zh', fallbackLng: false, interpolation: { escapeValue: false }, resources })
  const source = '  原文 <tag> & {{untouched}}\n$&  '
  const result = 'AI output\n  <b>原样</b> & {{source}}  '
  const summary = '  Summary\n原文 & {{literatureId}}  '
  const path = '目录/原始 <file> & {{path}}.csv'
  for (const language of ['zh', 'en']) {
    await locale.changeLanguage(language)
    const selection = locale.t('reading.selectionDraft', { ns: 'pdf', literatureId: 'id/原文', page: 3, revision: 'r&1', source, result })
    assert.ok(selection.includes(source))
    assert.ok(selection.endsWith(result))
    assert.ok(selection.includes('id/原文'))
    assert.ok(selection.includes('r&1'))
    assert.ok(locale.t('reading.summaryDraft', { ns: 'pdf', literatureId: 'id/原文', summary }).endsWith(summary))
    const table = locale.t('table.analysisDraft', { ns: 'workbench', path })
    assert.ok(table.includes(path))
    assert.ok(table.endsWith('\n\n'))
    assert.match(selection, language === 'zh' ? /^请基于/ : /^Continue the analysis/)
    assert.match(table, language === 'zh' ? /^分析这份表格/ : /^Analyze trends/)
    assert.equal(locale.t('reading.evidencePage', { ns: 'pdf', page: 3 }), resources[language].pdf.reading.evidencePage.replace('{{page}}', '3'))
  }
})
