import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

import { visibleOfficeBounds } from './office/bounds.ts'
import { officeColor } from './office/theme.ts'

const source = readFileSync(new URL('./office/frame.ts', import.meta.url), 'utf8')
const hostSource = readFileSync(new URL('./OfficeDocument.tsx', import.meta.url), 'utf8')
const draggingSource = readFileSync(new URL('./Dragging.tsx', import.meta.url), 'utf8')
const menuSource = readFileSync(new URL('./Menu.tsx', import.meta.url), 'utf8')
const dockSource = readFileSync(new URL('./Dock.tsx', import.meta.url), 'utf8')
const externalSource = readFileSync(new URL('./External.tsx', import.meta.url), 'utf8')
const topBarSource = readFileSync(new URL('../../shell/TopBar.tsx', import.meta.url), 'utf8')
const storeSource = readFileSync(new URL('../../store.tsx', import.meta.url), 'utf8')
const versionStatusMessages = ['zh', 'en'].map(language => ({
  resources: JSON.parse(readFileSync(new URL(`../../../../localization/locales/${language}/resources.json`, import.meta.url), 'utf8')).versionBadge,
  workbench: JSON.parse(readFileSync(new URL(`../../../../localization/locales/${language}/workbench.json`, import.meta.url), 'utf8')).dock
}))
const officeDocumentMessages = ['zh', 'en'].map(language => JSON.parse(
  readFileSync(new URL(`../../../../localization/locales/${language}/workbench.json`, import.meta.url), 'utf8')
).officeDocument)
const historyMessages = ['zh', 'en'].map(language => JSON.parse(readFileSync(new URL(`../../../../localization/locales/${language}/workbench.json`, import.meta.url), 'utf8')).history)
const historySource = readFileSync(new URL('./VersionHistory.tsx', import.meta.url), 'utf8')
const runtimeSource = readFileSync(new URL('./office/runtime.tsx', import.meta.url), 'utf8')
const versionDiffSource = readFileSync(new URL('./VersionDiff.tsx', import.meta.url), 'utf8')
const boundsSource = readFileSync(new URL('./office/bounds.ts', import.meta.url), 'utf8')
const preloadSource = readFileSync(new URL('../../../../preload/index.ts', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../../../../main/index.ts', import.meta.url), 'utf8')
const threadSource = readFileSync(new URL('./office/office-thread.js', import.meta.url), 'utf8')
const policySource = readFileSync(new URL('./office/policy.js', import.meta.url), 'utf8')
const searchSource = readFileSync(new URL('./office/search.js', import.meta.url), 'utf8')
const governanceSource = readFileSync(new URL('./office/governance.js', import.meta.url), 'utf8')
const caretSource = readFileSync(new URL('./office/caret.js', import.meta.url), 'utf8')
const clipboardSource = readFileSync(new URL('./office/clipboard.js', import.meta.url), 'utf8')
const paletteSource = readFileSync(new URL('./office/palette.js', import.meta.url), 'utf8')
const selectionSource = readFileSync(new URL('./office/selection.js', import.meta.url), 'utf8')
const docSelectionSource = readFileSync(new URL('./office/doc.js', import.meta.url), 'utf8')
const docxSelectionSource = readFileSync(new URL('./office/docx.js', import.meta.url), 'utf8')
const featureSource = readFileSync(new URL('./feature.tsx', import.meta.url), 'utf8')
const workbenchStyles = readFileSync(new URL('../../shell/workbench.css', import.meta.url), 'utf8')
const appStyles = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8')
const dialogClasses = readFileSync(new URL('../../components/ui/classes.ts', import.meta.url), 'utf8')

function rect(left: number, top: number, width: number, height: number): DOMRectReadOnly {
  return { left, top, width, height, right: left + width, bottom: top + height } as DOMRectReadOnly
}

function anchor(viewports: Record<string, DOMRectReadOnly>): HTMLElement {
  return {
    getBoundingClientRect: () => rect(100, 100, 800, 600),
    closest: (selector: string) => viewports[selector]
      ? { getBoundingClientRect: () => viewports[selector] }
      : null
  } as unknown as HTMLElement
}

test('Office bounds support review surfaces outside the document dock', () => {
  assert.deepEqual(visibleOfficeBounds(anchor({
    '.vds-workbench-pane': rect(0, 0, 700, 500)
  })), { left: 100, top: 100, width: 600, height: 400 })
})

test('Office bounds retain every available document-dock clipping layer', () => {
  assert.deepEqual(visibleOfficeBounds(anchor({
    '.vds-workbench-pane': rect(0, 0, 1000, 800),
    '.vds-document-view-body': rect(120, 110, 760, 560),
    '.vds-dock-leaf': rect(140, 130, 700, 500)
  })), { left: 140, top: 130, width: 700, height: 500 })
  assert.equal(visibleOfficeBounds(anchor({})), null)
})

test('snapshot rejection reconciles all affected editors without an unguarded reload', () => {
  const review = readFileSync(new URL('./SnapshotReview.tsx', import.meta.url), 'utf8')
  assert.match(review, /reconcileResourceEditors/)
  assert.match(review, /resourceEditorHasChanges/)
  assert.match(review, /previousPath: path/)
  assert.match(review, /path: review\.base\.path, state: review\.base\.state/)
  assert.doesNotMatch(review, /documentWorkspace\.reload\(/)
})

test('external review reconciliation shares a guarded explicit confirmation surface', () => {
  const conflict = readFileSync(new URL('../../components/business/ReviewConflict.tsx', import.meta.url), 'utf8')
  const review = readFileSync(new URL('./SnapshotReview.tsx', import.meta.url), 'utf8')
  assert.match(review, /capability\.drifted && <ReviewConflict/)
  assert.match(conflict, /createPortal\(<AlertDialog/)
  assert.match(conflict, /resourceEditorHasChanges/)
  assert.match(conflict, /if \(editorBusy\(\)\)/)
  assert.match(conflict, /reviewConflictMatches\(confirmation\.preview, pending\)/)
  assert.match(conflict, /confirmation\.action, confirmation\.preview\.token, confirmation\.key/)
  assert.match(conflict, /reconcileResourceEditors/)
  assert.match(conflict, /act\.reloadResourceTree/)
  const confirm = conflict.slice(conflict.indexOf('const confirm ='), conflict.indexOf('return <div'))
  assert.doesNotMatch(confirm, /fetchResourceReviewConflict|randomUUID/)
})

test('Office startup prewarms the complete system font catalog before a document is bound', () => {
  assert.doesNotMatch(source, /使用内置字体/)
  assert.doesNotMatch(source, /id="builtin"/)
  assert.match(source, /data-testid="office-fonts-retry"/)
  assert.match(source, /post\('font-permission-request'\)/)
  assert.match(source, /const entries=ZetaLocalFonts\.dedupeFontEntries\(await globalThis\.queryLocalFonts\(\)\)/)
  assert.match(source, /ZetaLocalFonts\.readAllFontEntries\(entries/)
  assert.match(source, /void start\(\);/)
  assert.doesNotMatch(source, /if\(started\|\|starting\|\|disposed\|\|!bytes\)return/)
  assert.match(source, /post\('warmup'/)
  assert.match(source, /message\.type==='font-permission-result'/)
  assert.match(source, /officeFrame\.permission/)
})

test('every Office runtime loads its packaged CJK UI font before document fonts', () => {
  assert.match(source, /NotoSansCJKsc-Regular\.otf/)
  assert.match(source, /ZetaLocalFonts\.readFontAssets\(config\.defaultFonts/)
  assert.match(source, /default-font-read/)
  assert.match(source, /defaultFontCount:defaultFonts\.length/)
})

test('Office startup exposes one retry surface without registering a save shortcut', () => {
  assert.match(source, /officeFrame\.loading/)
  assert.match(source, /zeta-20250513/)
  assert.doesNotMatch(source, /cdn\.zetaoffice\.net/)
  assert.doesNotMatch(source, /save-request|config\.shortcuts/)
  assert.match(runtimeSource, /controller\.save\(session\.id\)/)
})

test('Impress selection extraction contains browser clipboard rejection and restores the prior transferable', () => {
  assert.match(source, /clipboardUrl/)
  assert.match(source, /<script src="\$\{clipboardUrl\}"><\/script>/)
  assert.match(source, /ScholarSeedOfficeClipboard\.install\(navigator\.clipboard/)
  assert.match(clipboardSource, /Promise\.resolve\(writeText\(text\)\)\.catch/)
  assert.match(threadSource, /const snapshot = cloneTransferable\(existing\)/)
  assert.match(threadSource, /finally \{\s*clipboard\.setContents\(snapshot, null\)/)
})

test('Office runtime errors do not rewrite completed font warmup as a font failure', () => {
  assert.match(source, /if\(!runtimeReadyAt\)warmup\('error'/)
  assert.doesNotMatch(source, /loading\.hidden=false;warmup\('error'/)
})

test('Office startup reports stable warmup failure categories', () => {
  assert.match(source, /fail\('font-permission'/)
  assert.match(source, /failureReason='font-catalog'/)
  assert.match(source, /failureReason='font-read'/)
  assert.match(source, /fail\('runtime-assets'/)
  assert.match(source, /fail\('runtime-initialization'/)
  assert.match(source, /fail\('runtime-execution'/)
  assert.doesNotMatch(source, /warmup\('error',\{error:'zeta-/)
})

test('Office document switches hide the previous canvas and correlate readiness to the active binding', () => {
  assert.match(source, /canvas\.style\.visibility='hidden'/)
  assert.match(source, /loading\.hidden=false/)
  assert.match(source, /bindingId=String\(message\.bindingId/)
  assert.match(source, /message\.bindingId!==bindingId/)
  assert.match(source, /documentReadyFrames=2/)
  assert.match(source, /message\.cmd==='layout_finished'/)
  assert.match(source, /message\.cmd===viewportResizedCommand/)
  assert.match(source, /layoutPaintAcknowledged=true/)
  assert.match(source, /workerReady\|\|!layoutFinished\|\|!layoutPaintAcknowledged/)
  assert.doesNotMatch(source, /documentLayoutQuietDelay|documentReadyTimer|setTimeout\(.*revealDocument/)
  assert.doesNotMatch(source, /documentReadyDelay=400/)
  assert.match(runtimeSource, /bindingId: identity/)
  assert.match(runtimeSource, /message\.bindingId !== loadedBinding\.current/)
  assert.match(runtimeSource, /workspace\.pendingExclusiveOpen\?\.ownerTabId === viewId/)
  assert.match(runtimeSource, /data-testid="office-switch-mask"/)
  assert.match(workbenchStyles, /\.vds-office-switch-mask \{[\s\S]*backdrop-filter: blur\(var\(--vds-space-3\)\)/)
  assert.match(threadSource, /bindingId/)
  assert.match(threadSource, /event\.EventName === 'OnLayoutFinished'/)
  assert.match(threadSource, /cmd: 'layout_finished', bindingId/)
  assert.match(threadSource, /cmd: VIEWPORT_RESIZED_COMMAND,[\s\S]*bindingId: event\.data\.bindingId,[\s\S]*requestId: event\.data\.requestId/)
  assert.match(threadSource, /GlobalEventBroadcaster\.create/)
  assert.match(threadSource, /observeLayout\(bindingId\)[\s\S]*loadComponentFromURL/)
  assert.match(threadSource, /officeSearch = [^\n]+\n  observeDocument\(\)/)
  assert.match(threadSource, /cmd: 'ui_ready',[^}]*bindingId/)
})

test('readonly Office capability reaches the native ReadOnly load property', () => {
  assert.match(runtimeSource, /session\?\.capabilities\.can_edit === true/)
  assert.match(source, /readOnly:!editable/)
  assert.doesNotMatch(dockSource, /runtimeReadonlyReason|dock\.readonly/)
  assert.match(threadSource, /Name: 'ReadOnly', Value: true/)
  assert.match(threadSource, /loadComponentFromURL\(`file:\/\/\/tmp\/office\/\$\{filename\}`/)
  assert.match(source, /diagnostic\('document-ready',\{[^}]*editable\}/)
  assert.match(governanceSource, /if \(!policy\.contextMenus\) return css\.ui\.ContextMenuInterceptorAction\.CANCELLED/)
  assert.match(governanceSource, /function hideDisallowedChrome\(\)/)
  assert.match(governanceSource, /layoutEvent\([^)]*\) \{[\s\S]*hideDisallowedChrome\(\)/)
  assert.match(governanceSource, /hideDisallowedChrome\(\)[\s\S]*removeInfobar/)
  assert.match(governanceSource, /sidebar\?\.showDecks\(false\)/)
  assert.match(governanceSource, /layout\.setVisible\(false\)/)
  assert.match(threadSource, /documentEventOccured\(event\) \{\s*releasePolicy\?\.enforce\(\)/)
})

test('Office palette follows platform theme tokens without rebuilding or restarting ZetaOffice', () => {
  assert.match(runtimeSource, /officePalette\(document\.documentElement\)/)
  assert.match(runtimeSource, /MutationObserver/)
  assert.match(runtimeSource, /attributeFilter: \['data-theme'\]/)
  assert.match(runtimeSource, /post\('theme', \{ palette \}\)/)
  assert.doesNotMatch(runtimeSource, /officeFrameDocument\([^)]*palette/)
  assert.match(source, /message\.type==='theme'/)
  assert.match(source, /port\?\.postMessage\(\{cmd:'theme',palette\}\)/)
  assert.match(source, /config\.paletteUrl,config\.docUrl,config\.docxUrl,config\.selectionUrl,config\.threadUrl/)
  assert.match(threadSource, /case 'theme': applyPalette\(event\.data\.palette\); break/)
  assert.match(paletteSource, /ApplicationAppearance/)
  assert.match(paletteSource, /AppBackground/)
  assert.match(paletteSource, /CalcGrid/)
  assert.match(paletteSource, /ConfigurationUpdateAccess/)
  assert.match(paletteSource, /commitChanges\(\)/)
  assert.match(workbenchStyles, /\.vds-office-anchor \{[\s\S]*background: var\(--vds-bg-page\)/)
  assert.match(workbenchStyles, /\.vds-office-runtime-frame \{[\s\S]*background: var\(--vds-bg-page\)/)
})

test('Office palette converts platform CSS colors to native LibreOffice colors', () => {
  assert.equal(officeColor('#f4f1eb'), 0xf4f1eb)
  assert.equal(officeColor('rgb(31, 31, 31)'), 0x1f1f1f)
  assert.equal(officeColor('rgba(64, 64, 64, 0.5)'), 0x404040)
  assert.throws(() => officeColor('Canvas'))
})

test('Office native palette commits application appearance, background and Calc grid together', () => {
  const updates: Array<{ path: string; values: Record<string, unknown>; committed: boolean }> = []
  const provider = {
    createInstanceWithArguments: (_service: string, args: Array<{ Value: string }>) => {
      const update: { path: string; values: Record<string, unknown>; committed: boolean } = {
        path: args[0].Value,
        values: {},
        committed: false
      }
      updates.push(update)
      return {
        setPropertyValue: (name: string, value: unknown) => { update.values[name] = value },
        commitChanges: () => { update.committed = true }
      }
    }
  }
  const context = {
    getServiceManager: () => ({ createInstanceWithContext: () => provider })
  }
  const sandbox = {} as Record<string, unknown>
  runInNewContext(paletteSource, sandbox)
  const nativePalette = sandbox.ScholarSeedOfficePalette as {
    apply: (zetajs: unknown, css: unknown, palette: unknown) => void
  }
  nativePalette.apply(
    {
      Any: class { type: string; value: number; constructor(type: string, value: number) { this.type = type; this.value = value } },
      type: { short: 'short', long: 'long' },
      getUnoComponentContext: () => context
    },
    { beans: { PropertyValue: class { Name: string; Value: string; constructor(value: { Name: string; Value: string }) { this.Name = value.Name; this.Value = value.Value } } } },
    { mode: 'dark', appBackground: 0x1f1f1f, calcGrid: 0x404040 }
  )
  assert.deepEqual(plain(updates.map(update => ({ ...update }))), [
    { path: '/org.openoffice.Office.Common/Misc', values: { Appearance: { type: 'short', value: 2 }, ApplicationAppearance: { type: 'short', value: 2 } }, committed: true },
    { path: '/org.openoffice.Office.UI/ColorScheme/ColorSchemes/COLOR_SCHEME_LIBREOFFICE_AUTOMATIC/AppBackground', values: { Color: { type: 'long', value: 0x1f1f1f } }, committed: true },
    { path: '/org.openoffice.Office.UI/ColorScheme/ColorSchemes/COLOR_SCHEME_LIBREOFFICE_AUTOMATIC/CalcGrid', values: { Color: { type: 'long', value: 0x404040 } }, committed: true }
  ])
})

test('Office staging preserves the source filename instead of the display title', () => {
  assert.match(runtimeSource, /const documentFilename = binding\?\.title \?\? session\?\.source\.path \?\? documentTitle/)
  assert.match(runtimeSource, /filename: documentFilename/)
  assert.doesNotMatch(runtimeSource, /filename: session\.title/)
  assert.match(threadSource, /if \(!xModel\)/)
})

test('Writer rich paste carries host clipboard MIME formats into the governed Office worker', () => {
  assert.match(preloadSource, /readOfficeClipboard/)
  assert.match(runtimeSource, /window\.scholarseed\.readOfficeClipboard\(\)/)
  assert.doesNotMatch(source, /config\.shortcuts|shortcutMatches|image_request.*keydown/)
  assert.match(source, /formats:message\.formats/)
  assert.match(runtimeSource, /status: 'text', formats: clipboard\.formats/)
  assert.match(threadSource, /insertTransferable\(message\.requestId, message\.formats\)/)
  assert.match(threadSource, /pendingImage \|\| embedded\?\.active/)
  assert.match(source, /message\.type==='paste-result'/)
  assert.match(threadSource, /XTransferable/)
  assert.match(threadSource, /text\/html/)
  assert.match(threadSource, /text\/rtf/)
  assert.match(threadSource, /const flavors = \[preferred\]/)
  assert.match(threadSource, /cmd: 'paste_done'/)
})

test('Office iframe lifetime belongs to one persistent app-level host', () => {
  assert.doesNotMatch(hostSource, /<iframe/)
  assert.match(hostSource, /registerAnchor\(tabId, element\)/)
  assert.match(runtimeSource, /const \[frameTranslation\] = useState\(\(\) => i18n\.getFixedT\(frameLanguage, 'workbench'\)\)/)
  assert.match(runtimeSource, /const nextFrame = officeFrameDocument\(frameTranslation/)
  assert.match(runtimeSource, /const \[frameLanguage\] = useState<'zh' \| 'en'>\(requestedLanguage\)/)
  assert.match(runtimeSource, /LOCALES\[frameLanguage\]\.office/)
  assert.doesNotMatch(runtimeSource, /setFrameLanguage/)
  assert.doesNotMatch(runtimeSource, /frameEpoch, frameLanguage, i18n/)
  assert.match(runtimeSource, /loadedBinding\.current = ''/)
  assert.match(runtimeSource, /data-runtime-language=\{frameLanguage\}/)
  assert.match(runtimeSource, /data-runtime-slot=/)
  assert.match(runtimeSource, /window\.scholarseed\.requestOfficeFontAccess\(\)/)
  assert.doesNotMatch(runtimeSource, /inspectOfficeFonts|fontManifest/)
  assert.doesNotMatch(source, /requiredFonts|fontManifestStatus|fontManifest/)
  assert.match(runtimeSource, /type: 'dispose'/)
  assert.match(source, /message\.type==='bind'/)
  assert.match(runtimeSource, /reconcileOfficeHosts\([\s\S]*\[\]/)
  assert.doesNotMatch(runtimeSource, /MAX_OFFICE_RUNTIME_HOSTS/)
  assert.match(source, /ZetaLocalFonts\.readAllFontEntries\(entries/)
  assert.doesNotMatch(source, /SharedArrayBuffer|font-cache-ready/)
  assert.match(runtimeSource, /createPortal/)
  assert.match(runtimeSource, /OFFICE_RUNTIME_ROOT_ID/)
})

test('Office selection reports a frame-local point and binds its viewport projection to the tab', () => {
  assert.match(source, /point:selectionAnchorPoint\|\|selectionPoint/)
  assert.match(source, /function captureSelectionAnchor\(event\)[\s\S]*selectionAnchorPoint=selectionPoint/)
  assert.match(source, /document\.addEventListener\('pointermove',event=>\{selectionPoint=\{x:event\.clientX,y:event\.clientY\};const edgeActive=selectionAutoscroll\.move\(event\);if\(selectionAutoscrollKind==='writer'\)updateWriterPointerSelection\(event,edgeActive\);if\(\(edgeActive\|\|writerAutoscrollEngaged\)&&selectionAutoscrollKind==='writer'\)\{event\.preventDefault\(\);event\.stopImmediatePropagation\(\)\}\},true\)/)
  assert.doesNotMatch(source, /document\.addEventListener\('pointermove',[\s\S]*selectionAnchorPoint=selectionPoint[\s\S]*selectionAutoscroll\.move\(event\)/)
  assert.match(runtimeSource, /controller\.setSelection\(viewId/)
  assert.match(runtimeSource, /selectionViewport\(/)
})

test('Office uses native formatting without a parallel host rich-content toolbar', () => {
  assert.match(threadSource, /ScholarSeedOfficeGovernance.install/)
  assert.match(policySource, /formulabar/)
  assert.match(governanceSource, /private:resource\/menubar\/menubar/)
  assert.match(governanceSource, /registerDispatchProviderInterceptor/)
  assert.match(governanceSource, /registerContextMenuInterceptor/)
  assert.doesNotMatch(hostSource, /Office 常用编辑工具|runtime\.dispatch|<Select|office-insert-|office-heading-style|office-edit-hyperlink/)
  assert.doesNotMatch(runtimeSource, /runWriterAction|writer-action/)
  assert.doesNotMatch(runtimeSource, /post\('format'/)
})

test('Office canvas is read-only and does not register text editing input', () => {
  assert.match(source, /<canvas id="qtcanvas" oncontextmenu="event\.preventDefault\(\)"/)
  assert.doesNotMatch(source, /contenteditable|ime-input|ScholarSeedOfficeInput|input_text|input_command/)
  assert.doesNotMatch(threadSource, /input_text|input_command|InsertText/)
})

interface AccessibleNode {
  getAccessibleContext?: () => AccessibleNode
  getAccessibleChildCount: () => number
  getAccessibleChild: (index: number) => AccessibleNode
  getCaretPosition?: () => number
  getCharacterBounds?: (index: number) => { X: number; Y: number; Width: number; Height: number }
  getLocationOnScreen?: () => { X: number; Y: number }
}

function accessibleParagraph(text: string, caret: number, origin: { X: number; Y: number }): AccessibleNode {
  const glyphWidth = 10
  const lineHeight = 18
  return {
    getAccessibleChildCount: () => 0,
    getAccessibleChild: () => { throw new Error('no children') },
    getCaretPosition: () => caret,
    getCharacterBounds: (index: number) => {
      if (index < 0 || index >= text.length) throw new Error('IndexOutOfBoundsException')
      return { X: index * glyphWidth, Y: 2, Width: glyphWidth, Height: lineHeight }
    },
    getLocationOnScreen: () => origin
  }
}

function accessibleContainer(children: AccessibleNode[]): AccessibleNode {
  const node: AccessibleNode = {
    getAccessibleChildCount: () => children.length,
    // Native children are XAccessible wrappers; the locator must unwrap their context.
    getAccessibleChild: (index: number) => ({ ...children[index], getAccessibleContext: () => children[index] })
  }
  return node
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

function officeCaret(): { locate: (frame: unknown) => { rect: { x: number; y: number; height: number }; screen: { width: number; height: number } } | undefined } {
  const context = {} as Record<string, unknown>
  runInNewContext(caretSource, context)
  return context.ScholarSeedOfficeCaret as ReturnType<typeof officeCaret>
}

function writerFrame(root: AccessibleNode): unknown {
  return {
    getComponentWindow: () => ({ getAccessibleContext: () => root }),
    getContainerWindow: () => ({ getPosSize: () => ({ X: 0, Y: 0, Width: 1600, Height: 1000 }) })
  }
}

test('Office caret locator reads the native Writer caret rectangle from the accessible paragraph that owns it', () => {
  const caret = officeCaret()
  const inactive = accessibleParagraph('first paragraph', -1, { X: 100, Y: 200 })
  const active = accessibleParagraph('second paragraph', 3, { X: 120, Y: 420 })
  const root = accessibleContainer([accessibleContainer([inactive, accessibleContainer([active])])])
  assert.deepEqual(plain(caret.locate(writerFrame(root))), {
    rect: { x: 150, y: 422, height: 18 },
    screen: { width: 1600, height: 1000 }
  })
})

test('Office caret locator anchors an end-of-paragraph caret after the last glyph and reports a missing caret', () => {
  const caret = officeCaret()
  const end = accessibleParagraph('abc', 3, { X: 40, Y: 60 })
  assert.deepEqual(plain(caret.locate(writerFrame(accessibleContainer([end])))), {
    rect: { x: 70, y: 62, height: 18 },
    screen: { width: 1600, height: 1000 }
  })
  const none = accessibleContainer([accessibleParagraph('abc', -1, { X: 0, Y: 0 })])
  assert.equal(caret.locate(writerFrame(none)), undefined)
})

test('Office context menus recursively replace native labels with stable English command labels', () => {
  assert.match(governanceSource, /labelContextMenu\(event\.ActionTriggerContainer\)/)
  const context = {
    console,
    ScholarSeedOfficePolicy: {}
  } as Record<string, unknown>
  runInNewContext(governanceSource, context)
  const labels = new Map<string, string>()
  const container = (entries: unknown[]) => ({
    getCount: () => entries.length,
    getByIndex: (index: number) => entries[index]
  })
  const entry = (command: string, text: string, children?: unknown) => ({
    getPropertySetInfo: () => ({ hasPropertyByName: (name: string) => name === 'CommandURL' || name === 'Text' || (name === 'SubContainer' && Boolean(children)) }),
    getPropertyValue: (name: string) => name === 'CommandURL' ? command : name === 'SubContainer' ? children : text,
    setPropertyValue: (name: string, value: string) => { if (name === 'Text') labels.set(command, value) }
  })
  const nested = container([entry('.uno:ParagraphDialog', '段落')])
  const items = container([
    entry('.uno:PasteSpecial?SelectedFormat:string=text/html', '选择性粘贴'),
    entry('.uno:FormatMenu', '格式', nested),
    entry('vnd.example:extension', '扩展命令')
  ])
  const governance = context.ScholarSeedOfficeGovernance as { labelContextMenu: (value: unknown) => void }
  governance.labelContextMenu(items)
  assert.deepEqual([...labels], [
    ['.uno:PasteSpecial?SelectedFormat:string=text/html', 'Paste Special'],
    ['.uno:ParagraphDialog', 'Paragraph Dialog'],
    ['.uno:FormatMenu', 'Format']
  ])
})

test('Writer editing is offered by the governed native menu and commands', () => {
  for (const command of ['StyleApply', 'HyperlinkDialog', 'ParagraphDialog', 'OutlineBullet', 'InsertPagebreak', 'GraphicDialog']) {
    assert.match(policySource, new RegExp(`['\"]${command}['\"]`))
  }
  assert.match(governanceSource, /policy\.menus/)
})

test('DOCX and read-only spreadsheet external opening offers the default and discovered applications', () => {
  assert.match(externalSource, /openDocumentExternally/)
  assert.match(externalSource, /session\.dirty[\s\S]*workspace\.save\(session\.id\)/)
  assert.match(externalSource, /openSystemPath\(prepared\.path\)/)
  assert.match(externalSource, /listOpenWithApps/)
  assert.match(externalSource, /openPathWith/)
  assert.match(externalSource, /revealInFinder/)
  assert.match(externalSource, /saveFileCopy/)
  assert.match(mainSource, /app\.getFileIcon\(application\.path/)
  assert.match(readFileSync(new URL('../../../../main/appsForFile.ts', import.meta.url), 'utf8'), /displayNameAtPath/)
  assert.match(externalSource, /application\.icon/)
  assert.match(externalSource, /office-open-external/)
  assert.doesNotMatch(externalSource, /PREFERRED_SPREADSHEET_APP/)
})

test('Calc selections preserve two-dimensional display values', () => {
  assert.match(threadSource, /ScholarSeedOfficeSelection\.describe/)
  assert.match(selectionSource, /getDataArray\(\)/)
  assert.match(selectionSource, /join\('\\t'\)/)
  assert.match(selectionSource, /join\('\\n'\)/)
  assert.match(runtimeSource, /session\?\.viewer !== 'spreadsheet'/)
  assert.match(runtimeSource, /session\?\.capabilities\.can_edit/)
})

test('Office selection extraction yields to native highlighting and coalesces drag events', () => {
  assert.match(threadSource, /SELECTION_REPORT_DELAY_MS/)
  assert.match(threadSource, /function scheduleSelectionReport\(\)/)
  assert.match(threadSource, /clearTimeout\(selectionReportTimer\)/)
  assert.match(threadSource, /selectionReportTimer = setTimeout\(reportSelection, SELECTION_REPORT_DELAY_MS\)/)
  assert.match(threadSource, /selectionChanged\(\) \{[\s\S]*scheduleSelectionReport\(\)[\s\S]*scheduleCaretReport\(\)/)
  assert.match(threadSource, /if \(documentKind === 'impress'\) \{[\s\S]*ScholarSeedOfficeSelection\.captureImpress\(controller\.getSelection\(\)\)[\s\S]*scheduleSelectionReport\(\)/)
  assert.doesNotMatch(threadSource, /selectionChanged\(\) \{ reportSelection\(\) \}/)
  assert.doesNotMatch(threadSource, /if \(documentKind === 'calc'\) scheduleSelectionReport\(\)[\s\S]*else reportSelection\(\)/)
})

test('Office selection reporting retains document kind beyond the load callback', () => {
  assert.match(threadSource, /let documentKind/)
  assert.match(threadSource, /documentKind = Object\.keys\(ScholarSeedOfficePolicy\.MODULES\)/)
  assert.doesNotMatch(threadSource, /const documentKind = Object\.keys\(ScholarSeedOfficePolicy\.MODULES\)/)
  assert.match(threadSource, /documentKind = undefined/)
  assert.match(threadSource, /const writer = documentKind === 'writer' \? writerSelection\?\.describe\(selection\) : undefined/)
})

test('Impress selections preserve exact UTF-16 ranges through the runtime locator', () => {
  assert.match(threadSource, /releasePolicy\.dispatchNative\(COPY_COMMAND, \[\]\)/)
  assert.match(threadSource, /clipboard\.setContents\(snapshot, null\)/)
  assert.match(threadSource, /ScholarSeedOfficeSelection\.describeImpress\(xModel, controller, impressShape, impressTransferableSupplier\(\),/)
  assert.match(runtimeSource, /if \(selection\.kind === 'impress' && \([\s\S]*typeof selection\.slide !== 'number'[\s\S]*typeof selection\.end !== 'number'/)
  assert.match(runtimeSource, /kind: 'impress',[\s\S]*slide: Number\(selection\.slide\),[\s\S]*shape: String\(selection\.shape\),[\s\S]*start: Number\(selection\.start\),[\s\S]*end: Number\(selection\.end\)/)
  assert.doesNotMatch(threadSource, /shape\.getString\(\)[\s\S]*kind: 'impress'/)
})

test('Impress pointer release commits the final native text selection', () => {
  assert.match(source, /const selectionCommitCommand='selection_commit'/)
  assert.match(source, /document\.addEventListener\('pointerup',[\s\S]*documentKind==='impress'[\s\S]*port\?\.postMessage\(\{cmd:selectionCommitCommand\}\)/)
  assert.match(threadSource, /const SELECTION_COMMIT_COMMAND = 'selection_commit'/)
  assert.match(threadSource, /case SELECTION_COMMIT_COMMAND: scheduleSelectionReport\(\); break/)
})

test('Writer and Calc pointer drags keep the action menu hidden until release', () => {
  assert.match(source, /const selectionDragCommand='selection_drag'/)
  assert.match(source, /documentKind===selectionAutoscrollKind&&event\.isPrimary&&event\.button===primaryPointerButton/)
  assert.match(source, /selectionDragging=true;[\s\S]*selectionAutoscroll\.start\(event\);port\?\.postMessage\(\{cmd:selectionDragCommand,active:true\}\)/)
  assert.match(source, /function finishSelectionDrag\(event\)[\s\S]*selectionDragging=false;[\s\S]*captureSelectionAnchor\(event\);[\s\S]*port\?\.postMessage\(\{cmd:selectionDragCommand,active:false\}\)[\s\S]*selectionAutoscroll\.stop\(event\)/)
  assert.match(source, /document\.addEventListener\('pointerup',event=>\{[\s\S]*if\(!selectionDragging\)captureSelectionAnchor\(event\);[\s\S]*finishSelectionDrag\(event\)/)
  assert.match(source, /selectionAutoscrollKind==='writer'\)port\?\.postMessage\(\{cmd:selectionCommitCommand\}\)/)
  assert.match(source, /canvas\.addEventListener\('lostpointercapture',finishSelectionDrag,true\)/)
  assert.match(source, /hostDocument\.addEventListener\('pointerup',finishSelectionDrag,true\)/)
  assert.match(source, /hostDocument\.removeEventListener\('pointerup',finishSelectionDrag,true\)/)
  assert.match(source, /view:window,clientX:selectionPoint\.x,clientY:selectionPoint\.y[\s\S]*canvas\.dispatchEvent\(new PointerEvent\('pointerup',[\s\S]*canvas\.dispatchEvent\(new MouseEvent\('mouseup'/)
  assert.match(threadSource, /let selectionDragging = false/)
  assert.match(threadSource, /case SELECTION_DRAG_COMMAND:[\s\S]*selectionDragging = Boolean\(event\.data\.active\)[\s\S]*documentKind === 'calc'\) reportSelection\(\)[\s\S]*else scheduleSelectionReport\(\)/)
  assert.match(threadSource, /selectionChanged\(\) \{[\s\S]*if \(!selectionDragging\) scheduleSelectionReport\(\)/)
  assert.match(threadSource, /function readonlyWriterSelectionCursor\(controller, direction\)[\s\S]*writerSelection\?\.describe\(controller\.getSelection\(\)\)[\s\S]*controller\.getViewCursor\(\)[\s\S]*cursor\.gotoRange\(anchor, false\)[\s\S]*cursor\.gotoRange\(edge, true\)/)
  assert.match(threadSource, /const SELECTION_STEP_COUNT = 1/)
  assert.match(threadSource, /function prepareWriterAutoscroll\(message\)[\s\S]*selectionDragging && documentKind === 'writer' && xModel[\s\S]*readonlyWriterSelectionCursor\(controller, Math\.sign\(vertical \|\| horizontal\)\)[\s\S]*pendingWriterAutoscroll = \{ requestId: message\.requestId, cursor, horizontal, vertical \}[\s\S]*SELECTION_AUTOSCROLL_READY_COMMAND/)
  assert.match(threadSource, /function commitWriterAutoscroll\(message\)[\s\S]*pending\.vertical > 0\) pending\.cursor\.goDown\(SELECTION_STEP_COUNT, true\)[\s\S]*pending\.vertical < 0\) pending\.cursor\.goUp\(SELECTION_STEP_COUNT, true\)[\s\S]*SELECTION_AUTOSCROLL_APPLIED_COMMAND/)
  assert.doesNotMatch(threadSource, /measureWriterSelectionLine|advanceWriterSelectionLine|writerSelectionMotion/)
  assert.match(threadSource, /post\(\{ cmd: SELECTION_AUTOSCROLL_APPLIED_COMMAND, requestId: message\.requestId \}\)/)
  assert.match(threadSource, /case SELECTION_AUTOSCROLL_COMMAND:[\s\S]*prepareWriterAutoscroll\(event\.data\)[\s\S]*case SELECTION_AUTOSCROLL_COMMIT_COMMAND:[\s\S]*commitWriterAutoscroll\(event\.data\)/)
  assert.match(source, /selectionAutoscrollKind==='writer'\)return advanceWriterAutoscroll\(speed\)/)
})

test('Calc selection autoscroll leaves range extension to the native pointer drag', () => {
  assert.match(source, /if\(selectionAutoscrollKind==='writer'\)return advanceWriterAutoscroll\(speed\);[\s\S]*return true/)
  assert.doesNotMatch(threadSource, /function autoscrollCalcSelection/)
})

test('Writer selections retain their complete cross-paragraph range', () => {
  assert.match(threadSource, /writerProcessor\.createInspector/)
  assert.match(threadSource, /writerSelection\?\.describe\(selection\)/)
  for (const writerSource of [docSelectionSource, docxSelectionSource]) {
    assert.match(writerSource, /end_paragraph: `paragraph-\$\{endIndex \+ 1\}`/)
    assert.doesNotMatch(writerSource, /context_text: body\.getString\(\)/)
    assert.match(writerSource, /context_text: contextText\(indexed\.text, startIndex, endIndex, text\)/)
  }
  assert.match(threadSource, /current\.selection\.end_paragraph !== locator\.end_paragraph/)
  assert.match(runtimeSource, /\.\.\.\(selection\.end_paragraph \? \{ end_paragraph: selection\.end_paragraph \} : \{\}\)/)
})

test('Writer selection diagnostics expose extraction and pointer-to-menu latency', () => {
  assert.match(threadSource, /extractionDurationMs: performance\.now\(\) - startedAt/)
  assert.match(source, /diagnostic\('selection-extracted',\{extractionDurationMs:message\.extractionDurationMs,presentationDelayMs\}\)/)
  assert.match(source, /selectionPointAt=performance\.now\(\)/)
})

test('Calc sheet switches clear the shared selection instead of opening its action menu', () => {
  assert.match(threadSource, /let calcSelectionSheet/)
  assert.match(threadSource, /calcSelectionSheet = documentKind === 'calc' \? controller\.getActiveSheet\(\)\.getName\(\) : undefined/)
  assert.match(threadSource, /if \(documentKind === 'calc' && calcSelectionSheet !== activeSheet\) \{[\s\S]*calcSelectionSheet = activeSheet[\s\S]*post\(\{ cmd: 'selection', selection: \{ kind: 'calc', text: '' \} \}\)[\s\S]*return/)
  assert.match(threadSource, /calcSelectionSheet = undefined[\s\S]*cancelSelectionReport\(\)/)
})

test('CSV loading preserves its detected delimiter through the native Calc filter', () => {
  assert.match(source, /csvFilterOptions/)
  assert.match(source, /csvOptions:csvFilterOptions/)
  assert.match(threadSource, /FilterName/)
  assert.match(threadSource, /FilterOptions/)
})

test('Office viewers expose no shell mode switcher and offer a native-app menu', () => {
  assert.doesNotMatch(featureSource, /modeSwitcher/)
  assert.doesNotMatch(dockSource, /data-testid="document-preview"/)
  assert.doesNotMatch(dockSource, /data-testid="document-edit"/)
  assert.match(externalSource, /t\('dock\.openExternal'\)/)
  for (const language of ['zh', 'en']) {
    const messages = JSON.parse(readFileSync(new URL(`../../../../localization/locales/${language}/workbench.json`, import.meta.url), 'utf8'))
    assert.ok(messages.dock.openExternal.trim())
    assert.ok(messages.dock.openWith.trim())
    assert.ok(messages.dock.openLocation.trim())
    assert.ok(messages.dock.openAppsEmpty.trim())
  }
  assert.match(externalSource, /openDocumentExternally/)
})

test('Office search is request-scoped across React, iframe and the UNO worker', () => {
  assert.match(hostSource, /data-testid="office-search"/)
  assert.match(hostSource, /data-testid="office-search-status"/)
  assert.match(hostSource, /officeDocument\.previous/)
  assert.match(hostSource, /officeDocument\.next/)
  assert.match(hostSource, /OFFICE_SEARCH_DELAY_MS/)
  assert.match(runtimeSource, /pendingSearches/)
  assert.match(runtimeSource, /post\('office-search'/)
  assert.match(source, /cmd:'office_search'/)
  assert.match(source, /office-search-result/)
  assert.match(threadSource, /runOfficeSearch/)
  assert.match(threadSource, /ScholarSeedOfficeSearch\.create\(documentKind, controller, xModel\)/)
  assert.match(searchSource, /createSearchDescriptor\(\)/)
  assert.match(searchSource, /findAll\(descriptor\(/)
  assert.match(searchSource, /controller\.select\(match\)/)
})

test('Writer body reveal reuses the counted Office search bridge and selects the native match', () => {
  assert.match(runtimeSource, /documentTextReveal\(tab\)/)
  assert.match(runtimeSource, /post\('office-search', \{ requestId, query: reveal\.query, direction: 'first' \}\)/)
  assert.match(source, /message\.type==='office-search'/)
  assert.match(source, /cmd:'office_search'/)
  assert.match(source, /office-search-result/)
  assert.match(threadSource, /runOfficeSearch/)
  assert.match(threadSource, /ScholarSeedOfficeSearch\.create\(documentKind, controller, xModel\)/)
  assert.match(searchSource, /controller\.select\(match\)/)
})

test('all Office modules use the counted host search without duplicating the native findbar', () => {
  assert.match(policySource, /calc:[\s\S]*toolbars: \['standardbar', 'formulabar'\]/)
  assert.match(policySource, /writer:[\s\S]*toolbars: \['standardbar', 'textobjectbar'\]/)
  assert.doesNotMatch(source, /effectiveShortcutBindings|shortcutMatches|office-search-open/)
  assert.match(source, /searchVisible&&event\.key==='Escape'/)
  assert.match(hostSource, /className="vds-office-search"/)
  assert.match(hostSource, /placeholder=\{t\('officeDocument\.fullSearch'\)\}/)
  assert.match(hostSource, /label=\{t\('officeDocument\.previous'\)\}/)
  assert.match(hostSource, /label=\{t\('officeDocument\.next'\)\}/)
  assert.match(workbenchStyles, /\.vds-office-search\s*\{[^}]*position:\s*absolute[^}]*z-index:\s*var\(--vds-z-elevated\)/s)
})

test('Writer and Impress share the counted Office search surface with Calc', () => {
  assert.match(hostSource, /data-testid="office-search"/)
  assert.match(hostSource, /runtime\.searchOffice\(tabId/)
  assert.match(runtimeSource, /post\('office-search'/)
  assert.match(source, /cmd:'office_search'/)
  assert.match(threadSource, /ScholarSeedOfficeSearch\.create\(documentKind, controller, xModel\)/)
  assert.match(searchSource, /writer/)
  assert.match(searchSource, /impress/)
  assert.doesNotMatch(hostSource, /kind !== 'spreadsheet'/)
})

test('Office replacement is request-scoped and only mutates the revalidated Writer selection', () => {
  assert.match(hostSource, /replaceSelection: viewKind === 'edit'/)
  assert.match(hostSource, /useSelectionActionContribution\(tabId, replacement\)/)
  assert.match(hostSource, /session\.changeVersion !== request\.expectedChangeVersion/)
  assert.match(hostSource, /selectionFingerprint\(session\.selection\) !== request\.expectedFingerprint/)
  assert.match(runtimeSource, /replaceSelection:/)
  assert.match(runtimeSource, /crypto\.randomUUID\(\)/)
  assert.match(runtimeSource, /pendingReplacements/)
  assert.match(runtimeSource, /post\('replace-selection'/)
  assert.match(source, /message\.type==='replace-selection'/)
  assert.match(source, /cmd:'replace_selection'/)
  assert.match(source, /selection-replaced/)
  assert.match(source, /selection-replace-failed/)
  assert.match(threadSource, /writerSelection\?\.describe/)
  assert.match(threadSource, /expectedText/)
  assert.match(threadSource, /writerRange\.setString\(replacement\)/)
  assert.match(threadSource, /cmd: 'selection_replaced'/)
  assert.match(threadSource, /cmd: 'selection_replace_failed'/)
  assert.doesNotMatch(threadSource, /setModified\(true\)/)
})

test('legacy DOC and OOXML DOCX select explicit Writer profiles before inspection', () => {
  assert.match(selectionSource, /function writerFormat\(filename\)/)
  assert.match(threadSource, /writerFormat\(filename\)/)
  assert.match(threadSource, /doc: \(\) => ScholarSeedOfficeDocSelection/)
  assert.match(threadSource, /docx: \(\) => ScholarSeedOfficeDocxSelection/)
  assert.match(threadSource, /writerProcessor\.createInspector/)
  assert.match(source, /import docSource from '\.\/doc\.js\?raw'/)
  assert.match(source, /import docxSource from '\.\/docx\.js\?raw'/)
  assert.match(docSelectionSource, /globalThis\.ScholarSeedOfficeDocSelection/)
  assert.match(docxSelectionSource, /globalThis\.ScholarSeedOfficeDocxSelection/)
  assert.match(runtimeSource, /format: selection\.format/)
})

test('Office replacement failure and teardown settle the matching pending request', () => {
  assert.match(runtimeSource, /message\.type === 'selection-replaced'/)
  assert.match(runtimeSource, /message\.type === 'selection-replace-failed'/)
  assert.match(runtimeSource, /REPLACEMENT_TIMEOUT_MS/)
  assert.match(runtimeSource, /replacement_failed/)
})

test('Writer replacement respects runtime readonly downgrade and native module policy', () => {
  assert.match(hostSource, /!session\.capabilities\.can_edit/)
  assert.match(threadSource, /!replacementAllowed/)
  assert.match(threadSource, /replacementAllowed = policy\.editable && documentKind === 'writer'/)
  assert.match(threadSource, /function closeDocument\(\) \{\s*replacementAllowed = false/)
})

test('Office history compares immutable versions through one toggled snapshot', () => {
  assert.match(historySource, /act\.openVersionDiff\(\{/)
  assert.match(historySource, /historicalVersionId: version\.id/)
  assert.match(historySource, /currentVersionId/)
  assert.match(versionDiffSource, /Promise\.all\(\[/)
  assert.match(versionDiffSource, /fetchResourceVersionContent\(reference\.project, reference\.historicalVersionId\)/)
  assert.match(versionDiffSource, /fetchResourceVersionContent\(reference\.project, reference\.currentVersionId\)/)
  assert.match(versionDiffSource, /<OfficeSnapshot binding=\{active\}/)
  assert.match(versionDiffSource, /<SegmentedControl/)
  assert.doesNotMatch(versionDiffSource, /<ResizableHandle/)
  assert.match(versionDiffSource, /readOnly/)
  assert.match(hostSource, /runtime\.registerView\(binding\.viewId, binding\)/)
  assert.match(hostSource, /runtime\.registerView\(binding\.viewId, null\)/)
  assert.match(runtimeSource, /editable: !binding && tab\?\.viewKind === 'edit'/)
  assert.match(runtimeSource, /\.concat\(Object\.keys\(registeredViews\)\)/)
})

test('file history can open from retained identity without manufacturing an editor session', () => {
  assert.match(historySource, /file\?: ResourceHistoryTarget/)
  assert.match(historySource, /knownFileId \?\? capability\?\.file_id/)
  assert.match(historySource, /fileCanDiff \|\| session\?\.capabilities\.can_diff/)
  assert.match(historySource, /createPortal/)
  assert.doesNotMatch(historySource, /as DocumentSession/)
})

test('Office runtime reloads restored bytes when the shared document revision changes', () => {
  assert.match(runtimeSource, /`\$\{tab\?\.id\}:\$\{session\?\.id\}:\$\{session\?\.documentId\}:\$\{session\?\.revision\}:\$\{tab\?\.viewKind\}`/)
  assert.match(runtimeSource, /session\?\.revision/)
})

test('document toolbar exposes history without a separate save-version action', () => {
  assert.doesNotMatch(dockSource, /document-save-version|sealResourceVersion|snapshotSaveMessage/)
  assert.match(dockSource, /data-testid="document-version-history"/)
  assert.match(dockSource, /<Tooltip portalled content=\{t\('history\.trigger'\)\}>/)
  assert.match(dockSource, /MANAGEMENT_LABEL/)
  assert.match(historySource, /historyAccess\(session\.versioning\)\.available/)
  assert.doesNotMatch(historySource, /fetchResourceVersionAnnotations|PdfPreview|history\.preview\.pdf/)
  assert.match(historySource, /const canInspectVersion = \(path: string\): boolean => viewerForPath\(path\) !== 'pdf'/)
  assert.match(historySource, /const disabled = !canPreview \|\| !canInspectVersion\(version\.path\) \|\| version\.state === 'tombstone'/)
  assert.match(historySource, /\{!disabled && <IconButton[^>]*icon=\{<ChevronRight \/>\}/)
  assert.match(historySource, /useTranslation\('workbench'\)/)
  assert.match(historySource, /<SheetTrigger data-testid="document-version-history">\{t\('history\.trigger'\)\}<\/SheetTrigger>/)
  assert.deepEqual(historyMessages.map(messages => messages.trigger), ['版本历史', 'Version history'])
  assert.doesNotMatch(historySource, /<Button\b[^>]*data-testid="document-version-history"/)
})

test('document toolbar distinguishes every non-managed version state', () => {
  assert.match(dockSource, /migration_required: 'dock\.migrationRequired'/)
  assert.deepEqual(versionStatusMessages.map(messages => ({
    ignored: messages.workbench.ignored,
    unsupported: messages.workbench.unsupported,
    oversized: messages.workbench.oversized,
    unavailable: messages.workbench.unavailable,
    migrationRequired: messages.workbench.migrationRequired,
    treeIgnored: messages.resources.ignored,
    treeUnsupported: messages.resources.unsupported,
    treeOversized: messages.resources.oversized,
    treeUnavailable: messages.resources.unavailable
  })), [
    {
      ignored: '未加入版本管理',
      unsupported: '未加入版本管理',
      oversized: '文件大小超过版本管理上限',
      unavailable: '无法确认版本状态',
      migrationRequired: '版本管理待设置',
      treeIgnored: '未加入版本管理',
      treeUnsupported: '未加入版本管理',
      treeOversized: '文件大小超过版本管理上限',
      treeUnavailable: '无法确认版本状态'
    },
    {
      ignored: 'Not managed by version history',
      unsupported: 'Not managed by version history',
      oversized: 'File exceeds the version management size limit',
      unavailable: 'Unable to determine version status',
      migrationRequired: 'Version management needs setup',
      treeIgnored: 'Not managed by version history',
      treeUnsupported: 'Not managed by version history',
      treeOversized: 'File exceeds the version management size limit',
      treeUnavailable: 'Unable to determine version status'
    }
  ])
})

test('document toolbar keeps external open beside the breadcrumb without stretching it', () => {
  const toolbar = dockSource.slice(dockSource.indexOf('function DocumentToolbar('), dockSource.indexOf('function DocumentView('))
  const history = toolbar.indexOf('<DocumentVersionActions session={session} />')
  const externalOpen = toolbar.indexOf('<DocumentExternalOpen session={session} />')
  const save = toolbar.indexOf('data-testid="document-save"')
  assert.ok(externalOpen >= 0 && history > externalOpen && save > history)
  assert.match(toolbar, /<div className="vds-document-toolbar-spacer" \/>/)
  assert.doesNotMatch(topBarSource, /DocumentExternalOpen|canOpenDocumentExternally/)
  assert.match(workbenchStyles, /\.vds-document-toolbar-spacer\s*\{[^}]*flex:\s*1/s)
  assert.doesNotMatch(workbenchStyles, /\.vds-document-toolbar\s*>\s*div\s*\{[^}]*flex:\s*1/s)
  assert.match(externalSource, /size="sm"/)
  assert.match(externalSource, /w-\[var\(--vds-control-height-sm\)\]/)
  assert.match(externalSource, /size-\[var\(--vds-icon-7\)\]/)
  assert.doesNotMatch(externalSource, /size="lg"|vds-control-height-lg|vds-icon-10/)
  assert.match(externalSource, /w-56/)
  assert.match(externalSource, /<DropdownMenuTrigger asChild>[\s\S]*external-open-menu/)
  assert.match(externalSource, /<DropdownMenuContent align="end"/)
  assert.match(externalSource, /<DropdownMenuItem[\s\S]*openDocumentWithApplication/)
  assert.match(externalSource, /<DropdownMenuItem[^>]*disabled=\{!externalContext\}[\s\S]*revealInFinder/)
  assert.match(externalSource, /<DropdownMenuItem[\s\S]*saveDocumentCopy/)
  assert.doesNotMatch(externalSource, /defaultExternalApp\?\.name|defaultApp/)
  assert.match(toolbar, /\{session\.capabilities\.can_save\s*&&\s*\(\s*<Tooltip[\s\S]*data-testid="document-save"[\s\S]*<\/Tooltip>\s*\)\}/)
  assert.match(toolbar, /<IconButton[\s\S]*icon=\{<Save \/>\}[\s\S]*data-testid="document-save"/)
  assert.match(toolbar, /data-testid="document-save-dirty"/)
})

test('document toolbar keeps short breadcrumbs compact and truncates only overflowing paths', () => {
  assert.match(dockSource, /<Breadcrumb[\s\S]*className="min-w-0 max-w-\[min\(52vw,560px\)\] text-\[14px\] leading-5"/)
  assert.match(dockSource, /<BreadcrumbList className="flex-nowrap gap-2 overflow-hidden">/)
  assert.match(dockSource, /<BreadcrumbItem className="min-w-0 max-w-\[45%\] shrink overflow-hidden/)
  assert.match(dockSource, /<EllipsisText[\s\S]*tooltip=\{parentPath\}[\s\S]*tooltipPortalled[\s\S]*wrapperClassName="max-w-full"/)
  assert.match(dockSource, /<BreadcrumbItem className="min-w-0 shrink overflow-hidden">/)
  assert.match(dockSource, /<EllipsisText[\s\S]*tooltip=\{fileName\}[\s\S]*tooltipPortalled[\s\S]*wrapperClassName="max-w-full"[\s\S]*>\s*\{fileName\}\s*<\/EllipsisText>/)
  assert.doesNotMatch(dockSource, /wrapperClassName="min-w-0 w-0 flex-1"/)
})

test('literature attachments show a filename stem only in the top tab', () => {
  assert.match(storeSource, /const attachmentTitle = resourceNameParts\(attachment\.name, 'file'\)\.basename/)
  assert.match(storeSource, /path: attachment\.name,[\s\S]*mediaType: attachment\.media_type[\s\S]*\}, 'edit', attachmentTitle\)/)
  assert.doesNotMatch(storeSource, /\}, 'edit', detail\.title\)/)
  assert.match(dockSource, /session\.source\.kind !== 'literature' && \(\s*<Breadcrumb/)
})

test('Agent versions expose their durable turn source in file history', () => {
  assert.match(historySource, /AGENT_ORIGINS\.has\(version\.origin\)/)
  assert.match(historySource, /version\.turn_id/)
  assert.match(historySource, /t\('history\.agentTurn', \{ id: version\.turn_id \}\)/)
  assert.deepEqual(historyMessages.map(messages => messages.agentTurn), ['Agent 回合 {{id}}', 'Agent turn {{id}}'])
})

test('historical version rows do not duplicate save-as actions', () => {
  assert.doesNotMatch(historySource, /saveResourceVersionAs|saveToLibrary/)
  assert.doesNotMatch(historySource, /t\('history\.save'\)/)
})

test('the document tab menu uses an existing opaque surface token', () => {
  assert.match(workbenchStyles, /\.vds-tab-menu\s*\{[^}]*background:\s*var\(--bg-2\)/s)
  assert.doesNotMatch(workbenchStyles, /\.vds-tab-menu\s*\{[^}]*background:\s*var\(--surface\)/s)
})

test('Office tabs expose neither drag relocation nor context-menu layout actions', () => {
  assert.match(draggingSource, /workspace\.canRelocateTab\(tab\.id\)/)
  assert.match(draggingSource, /if \(!tab \|\| !workspace\.canRelocateTab\(tab\.id\)\)/)
  assert.match(draggingSource, /return \{ 'data-testid':/)
  assert.match(menuSource, /workspace\.canSplitTab\(tab\.id, direction, false\)/)
  assert.match(menuSource, /workspace\.moveTargetsForTab\(tab\.id\)/)
})

test('Dock overlays stay above Office and disable frame hit testing while dragging', () => {
  assert.match(runtimeSource, /interactionBlocked/)
  assert.match(runtimeSource, /pointerEvents:\s*interactionBlocked\s*\?\s*'none'/)
  assert.match(workbenchStyles, /\.vds-tab-menu\s*\{[^}]*z-index:\s*var\(--vds-z-context-menu\)/s)
  assert.match(workbenchStyles, /\.vds-dock-drop-preview\s*\{[^}]*z-index:\s*calc\(var\(--vds-z-context-menu\) \+ 1\)/s)
  assert.match(workbenchStyles, /\.vds-office-runtime-layer\s*\{[^}]*z-index:\s*var\(--vds-z-content\)/s)
  assert.doesNotMatch(appStyles, /\.vds-workspace-body\s*\{[^}]*animation:[^;}]*\bboth\b/s)
})

test('Office viewport follows the clipped work-area intersection without remounting the runtime', () => {
  assert.match(runtimeSource, /visibleOfficeBounds/)
  assert.match(boundsSource, /closest<HTMLElement>\(OFFICE_WORKBENCH_VIEWPORT_SELECTOR\)/)
  assert.match(runtimeSource, /requestAnimationFrame\(measure\)/)
  assert.match(runtimeSource, /post\('viewport-resize'/)
  assert.match(source, /message\.type==='viewport-resize'/)
  assert.match(source, /requestAnimationFrame\(resizeViewport\)/)
  assert.match(workbenchStyles, /\.vds-office-document\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\)/s)
})

test('PPT and PPTX reserve a native control row and drive governed Impress navigation', () => {
  assert.match(hostSource, /const isPresentation = \/\\\.pptx\?\$\/i\.test\(session\?\.source\.path \?\? ''\)/)
  assert.match(hostSource, /data-office-presentation=\{isPresentation\}/)
  assert.match(hostSource, /data-testid="office-presentation-controls"/)
  assert.match(hostSource, /runtime\.navigatePresentation\(tabId, 'previous'\)/)
  assert.match(hostSource, /runtime\.navigatePresentation\(tabId, 'next'\)/)
  assert.match(hostSource, /disabled=\{!presentationState\.canPrevious\}/)
  assert.match(hostSource, /disabled=\{!presentationState\.canNext\}/)
  assert.match(workbenchStyles, /\.vds-office-document\[data-office-presentation='true'\]\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\) var\(--vds-office-presentation-controls-height\)/s)
  assert.match(workbenchStyles, /\.vds-office-presentation-controls\s*\{[^}]*background:\s*var\(--vds-bg-page\)/s)
  assert.match(runtimeSource, /registerPresentationNavigation/)
  assert.match(runtimeSource, /message\.type === 'presentation-state'/)
  assert.match(source, /message\.type==='presentation-navigate'/)
  assert.match(source, /message\.cmd==='presentation_state'/)
  assert.match(threadSource, /PRESENTATION_NAVIGATE_COMMAND/)
  assert.match(threadSource, /PRESENTATION_FIT_COMMAND/)
  assert.match(threadSource, /\.uno:PreviousPage/)
  assert.match(threadSource, /\.uno:NextPage/)
  assert.match(threadSource, /\.uno:ZoomPage/)
  assert.match(runtimeSource, /width: isPresentationDocument \? `calc\(\$\{bounds\.width\}px \+ var\(--vds-space-5\)\)`/)
  assert.match(runtimeSource, /height: isPresentationDocument \? `calc\(\$\{bounds\.height\}px \+ var\(--vds-space-5\)\)`/)
  assert.match(runtimeSource, /clipPath: isPresentationDocument \? 'inset\(0 var\(--vds-space-5\) var\(--vds-space-5\) 0\)'/)
  assert.match(policySource, /'ZoomPage'/)
  assert.deepEqual(officeDocumentMessages.map(messages => messages.previousSlide), ['上一页', 'Previous slide'])
  assert.deepEqual(officeDocumentMessages.map(messages => messages.nextSlide), ['下一页', 'Next slide'])
})

test('the dirty-close surface uses the design-system AlertDialog and an opaque token', () => {
  assert.match(dockSource, /AlertDialog/)
  assert.match(dockSource, /data-testid="document-close-dialog"/)
  assert.doesNotMatch(dockSource, /vds-document-close-dialog/)
  assert.match(dialogClasses, /DIALOG_CLASS_NAME[\s\S]*\[background:var\(--vds-bg-white-default\)\]/)
  assert.doesNotMatch(workbenchStyles, /\.vds-document-close-dialog[\s\S]*var\(--surface\)/)
})


test('Office reveal ignores unsolicited sheet refreshes and stale request results', () => {
  const body = runtimeSource.match(/const finishReveal = useCallback\(\(requestId: string, found: boolean\): void => \{([\s\S]*?)\n  \}, \[clearRevealTimeout, reveal, session\]\)/)?.[1]
  assert.ok(body, 'extract the actual reveal completion callback')
  const activeRevealRequest = { current: '' }
  const notices: Array<{ message: string }> = []
  let cleared = 0
  const finishReveal = runInNewContext(`(requestId, found) => {${body}}`, {
    activeRevealRequest,
    clearRevealTimeout: () => { cleared += 1 },
    reveal: null,
    session: null,
    setNotice: (notice: { message: string }) => notices.push(notice),
    crypto: { randomUUID: () => 'notice-id' },
    OFFICE_REVEAL_CHANGED: 'office_reveal_changed',
    OFFICE_REVEAL_MISSING: 'office_reveal_missing'
  })

  finishReveal('', false)
  assert.equal(notices.length, 0, 'a sheet refresh without a request must not warn')
  assert.equal(cleared, 0)

  activeRevealRequest.current = 'active-request'
  finishReveal('', false)
  finishReveal('stale-request', false)
  assert.equal(activeRevealRequest.current, 'active-request')
  assert.equal(cleared, 0, 'unrelated results must preserve the active request timeout')

  finishReveal('active-request', false)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].message, 'office_reveal_missing', 'a real missing reveal must still warn')
  assert.equal(activeRevealRequest.current, '')
  assert.equal(cleared, 1)

  finishReveal('', false)
  assert.equal(notices.length, 1, 'refreshes after completion must not repeat the warning')

  activeRevealRequest.current = 'found-request'
  finishReveal('found-request', true)
  assert.equal(notices.length, 1, 'a successful reveal must not warn')
  assert.equal(activeRevealRequest.current, '')
  assert.equal(cleared, 2)
})
