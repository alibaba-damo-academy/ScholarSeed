import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

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
  assert.match(
    document,
    /data-testid="pdf-annotation-toggle"[^>]*label=\{t\('pdfAnnotation\.records'\)\}/
  )
  assert.match(document, /<nav\s+aria-label=\{t\('pdfToolbar\.toolbar'\)\}[^>]*items-center/)
  assert.match(document, /const label = panel\.label\(i18n\)/)
  assert.match(
    document,
    /<Tooltip key=\{panel\.id\} portalled content=\{label\} side="left">[\s\S]*data-testid=\{`document-panel-toggle-\$\{panel\.id\}`\}[\s\S]*label=\{label\}[\s\S]*title=\{undefined\}/
  )
  assert.match(
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
    /className="flex min-h-\[var\(--vds-workbench-header-height\)\] items-center justify-between gap-\[var\(--vds-space-2\)\][^"\n]*px-\[var\(--vds-space-3\)\] py-\[var\(--vds-space-2\)\]"/
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
    /action !== 'figure_explanation' &&\s*action !== 'document_translation' &&\s*action !== 'formula_latex' &&\s*jobBusy\(job\)/
  )
  assert.match(reading, /floating !== 'figure_explanation' && canAnnotate/)
  assert.match(reading, /<FigureGuide t=\{t\}/)
  assert.match(reading, /const FIGURE_GUIDE_SCALE = 4 \/ 7/)
  assert.match(
    reading,
    /width: `min\(\$\{FIGURE_GUIDE_WIDTH_PX\}px, calc\(100vw - \$\{FIGURE_GUIDE_VIEWPORT_GUTTER_PX\}px\)\)`/
  )
  assert.match(reading, /zoom: FIGURE_GUIDE_SCALE/)
  assert.match(reading, /gridTemplateColumns: '220px minmax\(0, 1fr\)'/)
  assert.match(reading, /variant=\{figure \? 'primary' : 'outline'\}/)
  expressions(reading)(
    "() => { setFloating(null); if (floating === 'figure_explanation') { void cancel('figure_explanation'); exitFigureSelection() } }"
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
    /toggleDocumentTranslation[\s\S]*exitFigureSelection\(\)[\s\S]*onExclusiveSurfaceOpen\(\)/
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
  assert.match(viewer, /data-testid="pdf-annotation-toggle"[\s\S]*exitFigureSelection\(\)/)
})

test('literature AI actions expose independent persisted model selectors', () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const viewer = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  assert.match(
    source,
    /import \{ ModelMenu \} from '\.\.\/\.\.\/\.\.\/components\/business\/ModelMenu'/
  )
  assert.match(source, /t\('reading\.currentModel'\)/)
  assert.match(source, /state\.literatureAiModels/)
  assert.match(source, /actions\.setLiteratureAiModel\(kind, model\.key\)/)
  assert.match(source, /modelControl\('figure_explanation', true\)/)
  assert.match(source, /modelControl\('document_translation'\)/)
  assert.match(source, /modelControl\('interpretation'\)/)
  assert.match(source, /modelControl\('selection_explanation'\)/)
  assert.match(source, /new Set<PdfAction>\(LITERATURE_AI_MODEL_ACTIONS\)/)
  assert.match(source, /data-testid=\{`pdf-\$\{floating\}-regenerate`\}/)
  assert.match(
    source,
    /run\(\s*floating,\s*request.module,\s*undefined,\s*request,\s*directions\[floating\] \?\? request.target_language\s*\)/
  )
  assert.match(source, /modelFilter=\{multimodal \? MULTIMODAL_MODEL_FILTER : undefined\}/)
  assert.match(source, /kind === 'formula_latex' \? 'figure_explanation' : kind/)
  assert.match(source, /const modelKey = actionModelKey\(kind\)/)
  assert.match(source, /model_key: modelKey,\s*kind/)
  assert.match(source, /literature_id: literatureId,\s*attachment_id: attachmentId/)
  assert.match(
    viewer,
    /usePdfAnalysis\(\{\s*active,\s*literatureId,\s*literatureTitle: excerptSource\?\.literatureId === literatureId \? excerptSource\.title : '',\s*attachmentId/
  )
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

test('selection actions replace in-flight work and never present a previous selection result', () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  assert.match(
    source,
    /lastRequest.current\?\.kind === 'selection_translation'\s*\? lastRequest.current.text/
  )
  assert.match(source, /<p>\{translationSource\}<\/p>/)
  assert.match(source, /REPLACEABLE_ACTIONS\.has\(kind\)/)
  assert.match(source, /const \{ \[kind\]: _stale, \.\.\.remaining \} = previous/)
  assert.match(
    source,
    /const floatingResult = floating && !busy \? results\[floating\] : undefined/
  )
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

test('document translation pairs every PDF page with a same-scale translation page in one scroll flow', () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const documentSource = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const panelSource = readFileSync(new URL('./pdf/Panel.tsx', import.meta.url), 'utf8')

  assert.match(source, /data-testid="pdf-document-translation"/)
  assert.match(source, /checked=\{automaticTranslation\}/)
  assert.match(
    source,
    /onCheckedChange=\{\(checked\) => changeAutomaticTranslation\(checked, sourcePage\)\}/
  )
  assert.match(source, /onClick=\{\(\) => runTranslationPage\(sourcePage\)\}/)
  assert.match(
    source,
    /<Tooltip\s+portalled\s+content=\{content \? t\('reading\.retranslate'\) : t\('reading\.translatePage'\)\}\s+side="top"\s*>/
  )
  assert.match(
    source,
    /page === sourcePage \? \(\s*<Tooltip\s+portalled\s+content=\{content \? t\('reading\.retranslate'\) : t\('reading\.translatePage'\)\}/
  )
  assert.match(
    source,
    /data-testid=\{`pdf-translation-retry-\$\{sourcePage\}`\}[\s\S]*className="ml-auto"[\s\S]*icon=\{<RefreshCw size=\{14\} \/>\}[\s\S]*size="sm"[\s\S]*variant="ghostIcon"/
  )
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
    /<CardHeader className="relative mb-0 border-b border-\[var\(--vds-border-default\)\] bg-transparent/
  )
  assert.match(source, /className="grid min-w-0 gap-\[var\(--vds-space-2\)\]"/)
  assert.equal(
    source
      .slice(
        source.indexOf('const translationPage ='),
        source.indexOf('const interpretationCanGenerate =')
      )
      .match(/className="flex min-w-0 items-center gap-\[var\(--vds-space-2\)\]"/g)?.length,
    2
  )
  assert.match(
    source,
    /className="shrink-0 text-\[length:var\(--vds-font-body-lv1\)\]! leading-\[var\(--vds-lh-body-lv1\)\]!"/
  )
  assert.match(
    source,
    /data-testid=\{`pdf-translation-close-\$\{sourcePage\}`\}[\s\S]*icon=\{<X size=\{14\} \/>\}[\s\S]*size="sm"[\s\S]*className="ml-auto"/
  )
  assert.doesNotMatch(
    source,
    /data-testid=\{`pdf-translation-auto-\$\{sourcePage\}`\}[\s\S]*variant="text"/
  )
  assert.match(
    source,
    /shrink-0 \[&_button\]:!w-auto \[&_button\]:!min-w-0 \[&_button\]:!px-\[var\(--vds-space-2\)\]/
  )
  assert.doesNotMatch(source, /w-\[var\(--vds-layout-pdf-translation-language-width\)\]/)
  assert.match(source, /<Translation\s+sentences=\{content\.blocks\}[\s\S]*?compact\s+\/>/)
  const translation = readFileSync(new URL('./pdf/Translation.tsx', import.meta.url), 'utf8')
  assert.match(
    translation,
    /compact \? 'text-\[length:var\(--vds-font-body-lv2\)\] font-\[var\(--vds-fw-regular\)\] leading-\[var\(--vds-pdf-translation-line-height\)\]' : 'text-sm leading-\[var\(--vds-pdf-reading-content-line-height\)\]'/
  )
  assert.match(translation, /sentence\.heading === true && !compact \? 'font-semibold' : ''/)
  assert.match(translation, /compact \? 'block h-\[var\(--vds-space-1\)\]' : 'block h-4'/)
  assert.match(source, /setAutomaticTranslation\(true\)/)
  assert.match(source, /runTranslationPage\(page, next\)/)
  assert.match(source, /aria-pressed=\{automaticTranslation\}/)
  assert.match(source, /variant=\{automaticTranslation \? 'primary' : 'ghost'\}/)
  assert.match(
    source,
    /onCheckedChange=\{\(checked\) => changeAutomaticTranslation\(checked, sourcePage\)\}/
  )
  const automaticToggle = source.slice(
    source.indexOf('const changeAutomaticTranslation'),
    source.indexOf('useEffect(() => {', source.indexOf('const changeAutomaticTranslation'))
  )
  assert.match(automaticToggle, /if \(!checked\) return/)
  assert.doesNotMatch(automaticToggle, /setPanel\(null\)/)
  const documentToggle = source.slice(
    source.indexOf('const toggleDocumentTranslation'),
    source.indexOf('const selectPanel')
  )
  assert.match(documentToggle, /changeAutomaticTranslation\(!automaticTranslation, page\)/)
  assert.doesNotMatch(documentToggle, /setPanel\(null\)/)
  assert.match(source, /translationOpen: panel === 'document_translation'/)
  assert.match(source, /translationPage,/)
  assert.match(
    source,
    /style=\{\{ width: pageSize\.width, height: pageSize\.height, zoom: pageScale \}\}/
  )
  assert.match(
    source,
    /<CardContent className="min-h-0 flex-1 overflow-y-auto p-\[var\(--vds-space-5\)\]">/
  )
  assert.match(source, /data-testid=\{`pdf-translation-page-\$\{sourcePage\}`\}/)
  assert.match(documentSource, /data-testid=\{`pdf-page-pair-\$\{number\}`\}/)
  assert.match(
    documentSource,
    /shadow-\[var\(--vds-shadow-2-center\)\][\s\S]*\[&>\.vds-pdf-page\]:m-0 \[&>\.vds-pdf-page\]:!\[box-shadow:none\]/
  )
  assert.match(
    documentSource,
    /before:left-\[var\(--pdf-source-page-width\)\][\s\S]*before:bg-\[var\(--vds-border-default\)\]/
  )
  assert.match(
    documentSource,
    /'--pdf-source-page-width': `\$\{estimatedPageSize\.width \* scale\}px`/
  )
  assert.match(documentSource, /TRANSLATION_COLUMN_RATIO/)
  documentExpressions(
    '(open: boolean): void => { setTranslationLayoutOpen(open); if (open) set({ modulePanelOpen: false }) }',
    'handleDocumentTranslationChange'
  )
  assert.match(documentSource, /onDocumentTranslationChange: handleDocumentTranslationChange/)
  documentExpressions(
    'analysis.translationPage(number, { width: estimatedPageSize.width * scale * TRANSLATION_COLUMN_RATIO, height: estimatedPageSize.height * scale }, 1)'
  )
  assert.match(
    documentSource,
    /gridTemplateColumns: `\$\{estimatedPageSize\.width \* scale\}px \$\{estimatedPageSize\.width \* scale \* TRANSLATION_COLUMN_RATIO\}px`/
  )
  assert.doesNotMatch(documentSource, /items-start gap-\[var\(--vds-space-4\)\]/)
  assert.match(
    documentSource,
    /const rightPanelOpen = Boolean\(analysis\.sidePanel \|\| recordsOpen \|\| activeDocumentPanelId\)/
  )
  assert.doesNotMatch(source, /translationPanelRef|pdf-translation-panel|translationCard\(page\)/)
  assert.doesNotMatch(panelSource, /layout\?: 'overlay' \| 'split'|vds-pdf-panel--split/)
  assert.doesNotMatch(source, /reading\.translateAll/)
})

test('AI interpretation opens idle and starts only from the summary action', () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')

  const toggle = source.slice(
    source.indexOf('const toggleInterpretation'),
    source.indexOf('const toggleDocumentTranslation')
  )
  assert.doesNotMatch(toggle, /run\('interpretation'\)/)
  assert.match(source, /data-testid="pdf-interpretation"/)
  assert.match(source, /data-testid="pdf-generate-summary"[\s\S]*run\('interpretation'\)/)
  assert.doesNotMatch(source, /reading\.documentScope/)
  assert.match(
    source,
    /: \(\s*!isBusy\('interpretation'\) && \(\s*<div className="grid gap-\[var\(--vds-space-5\)\] p-\[var\(--vds-space-5\)\]">/
  )
  assert.match(source, /footer=\{\s*<footer/)
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

test('PDF toolbar uses S controls with visible and ghost group spacing', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  const tools = readFileSync(new URL('./pdf/Tools.tsx', import.meta.url), 'utf8')

  assert.match(source, /vds-pdf-tools[^"\n]*min-h-12/u)
  assert.match(source, /justify-self-start[^"\n]*gap-\[var\(--vds-space-2\)\]/u)
  assert.match(source, /justify-self-end[^"\n]*gap-\[var\(--vds-space-2\)\]/u)
  assert.match(source, /size="sm"[^>]*data-testid="pdf-sidebar-toggle"/u)
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
  assert.match(source, /className="vds-selection-action-result"/)
  assert.match(source, /<CopyButton/)
  assert.match(source, /<PdfAnnotations/)
  assert.doesNotMatch(source, /写入笔记|添加到笔记/)
  assert.match(annotations, /bodyTestId="pdf-annotation-list"/)
  assert.match(annotations, /filterMarks/)
  assert.match(annotations, /<Tabs value=\{filter\}/)
  assert.match(annotations, /<TabsTrigger\s+key=\{category\}\s+value=\{category\}/)
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
    /data-testid="pdf-annotation-styles"[\s\S]*data-testid="pdf-annotation-colors"[\s\S]*data-testid="pdf-annotation-actions"[\s\S]*data-testid="pdf-annotation-delete"/
  )
  assert.match(annotation, /data-testid="pdf-annotation-styles"[^>]*grid-cols-3/)
  assert.match(
    annotation,
    /data-testid="pdf-annotation-actions"[^>]*grid[^>]*>[\s\S]*pdfAnnotation\.comment[\s\S]*pdfAnnotation\.explain[\s\S]*pdfAnnotation\.translate[\s\S]*pdfAnnotation\.copy/
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
  assert.match(documentSource, /renderAnnotation=\{\(mark, close\) => (?:\(\s*)?<PdfAnnotation/)
  documentExpressions(
    '(instruction) => { analysis.explainSelection({ page: mark.page, text: mark.text, quads: mark.quads }, instruction); close(); setActiveMark(null) }',
    { attribute: 'onExplain' }
  )
  documentExpressions(
    '() => { analysis.translateSelection({ page: mark.page, text: mark.text, quads: mark.quads }); close(); setActiveMark(null) }',
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
  assert.match(reading, /canAnalyzeSelection,\s*selectionAnalyzing:/)
  expressions(reading)(
    "(target?: PdfSelection, requirement = '') => { void run('selection_explanation', 'summary', undefined, undefined, undefined, undefined, target ? [target] : selection, selectionInstruction(state.selectionPrompts, 'explain', requirement)) }"
  )
  expressions(reading)(
    "(target?: PdfSelection) => { void run('selection_translation', 'summary', undefined, undefined, undefined, undefined, target ? [target] : selection) }"
  )
  assert.doesNotMatch(
    reading,
    /if \(selection\.length \|\| !selectionResult\) return[\s\S]*setFloating\(null\)/
  )
})

test('PDF explanations accept optional instructions and link to prompt settings', () => {
  const annotation = readFileSync(new URL('./pdf/Annotation.tsx', import.meta.url), 'utf8')
  const reading = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const guide = readFileSync(
    new URL('../../components/business/PromptSettingsGuide.tsx', import.meta.url),
    'utf8'
  )

  assert.match(annotation, /<Textarea[^>]*autoFocus[^>]*pdfAnnotation\.explainPrompt/)
  assert.match(annotation, /onExplain\(explanationDraft\.trim\(\)\)/)
  assert.doesNotMatch(annotation, /if \(!explanationDraft\.trim\(\)\) return/)
  assert.doesNotMatch(annotation, /disabled=\{!explanationDraft\.trim\(\) \|\| analyzing\}/)
  assert.match(
    annotation,
    /<PromptSettingsGuide[^>]*prefix=\{t\('pdfAnnotation\.promptGuide'\)\}[^>]*linkPrefix=\{t\('pdfAnnotation\.promptGuideLinkPrefix'\)\}/
  )
  assert.match(reading, /selectionExplanationOpen/)
  assert.match(reading, /selectionExplanationSnapshot/)
  assert.match(reading, /<Textarea[^>]*autoFocus[^>]*reading\.explanationPrompt/)
  assert.match(reading, /labelClassName="!text-\[length:var\(--vds-font-body-lv2\)\]"/)
  assert.match(
    reading,
    /<PromptSettingsGuide\s+className="!text-\[length:var\(--vds-font-body-lv2\)\]/
  )
  assert.match(
    reading,
    /<Button[^>]*size="sm"\s+disabled=\{!selectionExplanationSnapshot\.length\}\s+onClick=\{submitSelectionExplanation\}/
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
  assert.match(
    reading,
    /<PromptSettingsGuide[^>]*prefix=\{t\('reading\.explanationPromptGuide'\)\}[^>]*linkPrefix=\{t\('reading\.promptGuideLinkPrefix'\)\}/
  )
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
  assert.match(
    annotations,
    /className="mt-\[var\(--vds-space-2\)\] flex flex-wrap items-center gap-\[var\(--vds-space-1\)\]">[\s\S]*markComments\.map\(\(comment\) => \(\s*<CopyButton[\s\S]*value=\{comment\.body\}[\s\S]*pdfAnnotation\.copyComment[\s\S]*value=\{mark\.text\}/
  )
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
  const floatingWindow = readFileSync(
    new URL('../../components/primitive/FloatingWindow.tsx', import.meta.url),
    'utf8'
  )

  assert.doesNotMatch(reading, /[Ff]loatingPinned/)
  assert.doesNotMatch(reading, /onPinnedChange=/)
  assert.doesNotMatch(reading, /documentSelectionInteractionProps/)
  assert.doesNotMatch(reading, /selection\.length[\s\S]*setFloating\(null\)/)
  assert.match(reading, /<FloatingWindow[\s\S]*title=\{LABELS\[floating\]\}[\s\S]*onClose=/)
  assert.match(
    reading,
    /initialHorizontalCenterRef=\{\s*floating === 'selection_translation' \|\| floating === 'figure_explanation'\s*\? viewportRef\s*: undefined\s*\}/
  )
  assert.match(reading, /variant=\{floating === 'figure_explanation' \? 'outline' : 'ghost'\}/)
  assert.match(floatingWindow, /aria-pressed=\{pinned\}/)
  assert.match(reading, /ghostIconHeader=\{floating === 'figure_explanation'\}/)
  assert.match(reading, /plainFooter=\{floating === 'figure_explanation'\}/)
  assert.match(reading, /size=\{floating === 'figure_explanation' \? 'default' : 'sm'\}/)
  assert.match(reading, /stableLabelWidth=\{floating !== 'figure_explanation'\}/)
  assert.match(
    reading,
    /<CardTitle className="!text-\[length:var\(--vds-font-body-lv2\)\] !leading-\[var\(--vds-lh-body-lv2\)\]">/
  )
  assert.match(
    reading,
    /icon=\{floating === 'figure_explanation' \? <Copy \/> : <Icon name="copy" size=\{14\} \/>\}/
  )
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

  assert.match(
    reading,
    /<Button[^>]*variant="outline"[^>]*size="sm"[^>]*icon=\{\s*annotationIdentity === annotatedResult \? \(\s*<Check[^>]*>\s*\) : \(\s*<Icon name="annotation"/
  )
  assert.match(
    reading,
    /<CopyButton[\s\S]*?size=\{floating === 'figure_explanation' \? 'default' : 'sm'\}[\s\S]*?variant=\{floating === 'figure_explanation' \? 'outline' : 'ghost'\}[\s\S]*?icon=\{floating === 'figure_explanation' \? <Copy \/> : <Icon name="copy"/
  )
  assert.match(
    reading,
    /<Button[^>]*size="sm"[^>]*variant="primary"[^>]*icon=\{<Icon name="talk"[^>]*>\}[^>]*onClick=\{quote\}/
  )
})

test('literature follow-ups attach the current document before entering chat', () => {
  const source = readFileSync(new URL('./pdf/Reading.tsx', import.meta.url), 'utf8')
  const zh = JSON.parse(
    readFileSync(new URL('../../../../localization/locales/zh/pdf.json', import.meta.url), 'utf8')
  )
  const en = JSON.parse(
    readFileSync(new URL('../../../../localization/locales/en/pdf.json', import.meta.url), 'utf8')
  )

  assert.match(source, /const openDocumentChat = async \(text: string\): Promise<void> =>/)
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
  assert.match(
    source,
    /floating !== 'figure_explanation' && \(\s*<Button\s+disabled=\{!floatingResult\}[\s\S]*?onClick=\{quote\}/
  )
  assert.match(source, /void openDocumentChat\(\s*summary\?\.text/)
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
  documentExpressions('(width) => update({ navigationWidth: Number.parseFloat(width) })', {
    attribute: 'onWidthChange',
  })
  assert.match(
    source,
    /style=\{\{ marginLeft: sidebar \? `\$\{navigationWidth\}px` : undefined \}\}/
  )
  assert.match(source, /const fitViewportWidth = size\.width \+ \(sidebar \? navigationWidth : 0\)/)
  assert.match(source, /translationLayoutOpen[\s\S]*?width: natural\.width \* 2/)
  documentExpressions(
    'fittedScale(mode, fittedPageSize, { width: Math.max(1, fitViewportWidth - PAGE_GUTTER), height: Math.max(1, size.height - PAGE_GUTTER) })'
  )
  assert.match(
    source,
    /const rightPanelOpen = Boolean\(analysis\.sidePanel \|\| recordsOpen \|\| activeDocumentPanelId\)/
  )
  assert.match(source, /data-testid="pdf-pages-track"/)
  assert.match(
    source,
    /rightPanelOpen \? ' min-w-\[calc\(100%\+var\(--vds-layout-pdf-panel-width\)\)\] pr-\[var\(--vds-layout-pdf-panel-width\)\]'/
  )
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
  assert.match(
    source,
    /className="w-full min-w-0 justify-start text-left whitespace-normal! \[overflow-wrap:anywhere\]"/
  )
  assert.match(
    source,
    /<mark\s+className="rounded-\[var\(--vds-radius-2\)\] bg-\[var\(--vds-brand-bg-light\)\] px-\[var\(--vds-space-half\)\] text-inherit"/
  )
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
    /openLiteratureAttachment: \(\s*id: string,\s*attachmentId\?: string,\s*page\?: number,\s*options\?: \{ projectId\?: string \| null \}\s*\) => Promise<boolean>/
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
    /<Textarea[\s\S]*?value=\{commentDraft\}[\s\S]*?<Button\s+className="justify-self-end"[\s\S]*?\{t\('saveAnnotation'\)\}/
  )
})

test('PDF selection controls update their locale without replacing document or draft state', () => {
  const source = readFileSync(new URL('./PdfDocument.tsx', import.meta.url), 'utf8')
  documentExpressions(
    '[activeMark, addAiComment, commentDraft, commentFormOpen, highlightOpen, markColors, saving, selections, session?.capabilities.can_annotate, session?.revision, sessionId, sidecar, t]',
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
