/* SPDX-License-Identifier: MIT */

'use strict'

let zetajs
let css
let desktop
let xModel
let documentListener
let layoutListener
let layoutBroadcaster
let selectionListener
let selectionReportTimer
let calcSelectionSheet
let impressShape
let caretReportTimer
let caretTracked = false
let caretUnavailable = false
let programmaticSave = false
let releasePolicy
let protection
let officeSearch
let replacementAllowed = false
let pendingImage
let imageSequence = 0
let embedded
let documentPolicy
let documentKind
let writerSelection
let selectionDragging = false
let pendingWriterAutoscroll
let writerAutoscrollCursor
const OFFICE_IMAGE_FAILED = 'office_image_failed'
const OFFICE_POLICY_FAILED = 'office_policy_failed'
const OFFICE_FORMULA_POLICY_FAILED = 'office_formula_policy_failed'
const INSERT_IMAGE_COMMAND = '.uno:InsertGraphic'
const PASTE_COMMAND = '.uno:Paste'
const TEXT_CLIPBOARD_FLAVOR = 'text/plain;charset=utf-16'
const IMAGE_WASM_DIRECTORY = '/tmp/office/images/'
const GRAPHIC_SERVICE = 'com.sun.star.text.TextGraphicObject'
const PAGE_STYLES = 'PageStyles'
const HUNDREDTH_MM_PER_CSS_PIXEL = 2540 / 96
const REPLACEMENT_STALE_ERROR = 'selection_stale'
const REPLACEMENT_UNSUPPORTED_ERROR = 'selection_unsupported'
const REPLACEMENT_FAILED_ERROR = 'replacement_failed'
const SELECTION_REPORT_DELAY_MS = 32
const PASTE_FAILED_ERROR = 'paste_failed'
const VIEWPORT_RESIZE_COMMAND = 'resize_viewport'
const VIEWPORT_RESIZED_COMMAND = 'viewport_resized'
const HTML_MIME = 'text/html;charset=utf-8'
const RTF_MIME = 'text/rtf'
const PLAIN_MIME = 'text/plain;charset=utf-16'
const COPY_COMMAND = '.uno:Copy'
const CARET_COMMAND = 'caret'
const SELECTION_COMMIT_COMMAND = 'selection_commit'
const SELECTION_DRAG_COMMAND = 'selection_drag'
const SELECTION_AUTOSCROLL_COMMAND = 'selection_autoscroll'
const SELECTION_AUTOSCROLL_READY_COMMAND = 'selection_autoscroll_ready'
const SELECTION_AUTOSCROLL_COMMIT_COMMAND = 'selection_autoscroll_commit'
const SELECTION_AUTOSCROLL_APPLIED_COMMAND = 'selection_autoscroll_applied'
const SELECTION_STEP_COUNT = 1
const CARET_REPORT_DELAY_MS = 16
const PRESENTATION_NAVIGATE_COMMAND = 'presentation_navigate'
const PRESENTATION_FIT_COMMAND = '.uno:ZoomPage'
const PRESENTATION_PREVIOUS_COMMAND = '.uno:PreviousPage'
const PRESENTATION_NEXT_COMMAND = '.uno:NextPage'
const PRESENTATION_PREVIOUS_DIRECTION = 'previous'
const PRESENTATION_NEXT_DIRECTION = 'next'
const OFFICE_SELECTION_LOG_PREFIX = '[office-selection] '
const WRITER_PROCESSORS = Object.freeze({
  doc: () => ScholarSeedOfficeDocSelection,
  docx: () => ScholarSeedOfficeDocxSelection,
})

function post(message) { zetajs.mainPort.postMessage(message) }

function transferableItems(sequence) {
  if (Array.isArray(sequence)) return sequence
  if (typeof sequence?.size !== 'function' || typeof sequence?.get !== 'function') return []
  return Array.from({ length: sequence.size() }, (_value, index) => sequence.get(index))
}

function cloneTransferable(transferable) {
  const entries = transferableItems(transferable.getTransferDataFlavors()).map(flavor => ({
    flavor,
    data: transferable.getTransferData(flavor)
  }))
  return zetajs.unoObject([css.datatransfer.XTransferable], {
    getTransferDataFlavors() { return entries.map(entry => entry.flavor) },
    isDataFlavorSupported(candidate) { return entries.some(entry => entry.flavor.MimeType === candidate.MimeType) },
    getTransferData(candidate) {
      const entry = entries.find(item => item.flavor.MimeType === candidate.MimeType)
      if (!entry) throw new Error(`Unsupported clipboard flavor: ${candidate.MimeType}`)
      return entry.data
    }
  })
}

function impressTransferableSupplier() {
  return {
    getTransferable() {
      const clipboard = css.datatransfer.clipboard.SystemClipboard.create(zetajs.getUnoComponentContext())
      const existing = clipboard.getContents()
      if (!existing) return undefined
      const snapshot = cloneTransferable(existing)
      try {
        releasePolicy.dispatchNative(COPY_COMMAND, [])
        return cloneTransferable(clipboard.getContents())
      } finally {
        clipboard.setContents(snapshot, null)
      }
    }
  }
}

function applyPalette(palette) {
  try {
    ScholarSeedOfficePalette.apply(zetajs, css, palette)
    post({ cmd: 'theme_applied' })
  } catch (error) {
    const detail = error instanceof WebAssembly.Exception ? zetajs.catchUnoException(error)?.Message : error
    console.warn('[office-theme] palette unavailable', String(detail))
  }
}

function removeDocumentListener() {
  if (!xModel || !documentListener) return
  try { xModel.removeDocumentEventListener(documentListener) } catch (error) { /* disposed */ }
  documentListener = undefined
}

function removeLayoutListener() {
  if (!layoutBroadcaster || !layoutListener) return
  try { layoutBroadcaster.removeDocumentEventListener(layoutListener) } catch (error) { /* disposed */ }
  layoutListener = undefined
  layoutBroadcaster = undefined
}

function cancelSelectionReport() {
  if (selectionReportTimer === undefined) return
  clearTimeout(selectionReportTimer)
  selectionReportTimer = undefined
}

function cancelCaretReport() {
  if (caretReportTimer === undefined) return
  clearTimeout(caretReportTimer)
  caretReportTimer = undefined
}

function reportCaret() {
  caretReportTimer = undefined
  if (!xModel || !caretTracked || embedded?.active) return
  try {
    const caret = ScholarSeedOfficeCaret.locate(xModel.getCurrentController().getFrame())
    if (!caret) throw new Error('caret_not_found')
    caretUnavailable = false
    post({ cmd: CARET_COMMAND, ...caret })
  } catch (error) {
    const detail = error instanceof WebAssembly.Exception ? zetajs.catchUnoException(error)?.Message : error
    if (!caretUnavailable) console.warn('[office-caret] unavailable', String(detail))
    caretUnavailable = true
  }
}

function scheduleCaretReport() {
  if (!caretTracked) return
  cancelCaretReport()
  caretReportTimer = setTimeout(reportCaret, CARET_REPORT_DELAY_MS)
}

function closeDocument() {
  replacementAllowed = false
  caretTracked = false
  caretUnavailable = false
  cancelCaretReport()
  documentPolicy = undefined
  documentKind = undefined
  selectionDragging = false
  pendingWriterAutoscroll = undefined
  writerAutoscrollCursor = undefined
  writerSelection?.invalidate()
  writerSelection = undefined
  pendingImage = undefined
  embedded?.dispose()
  embedded = undefined
  officeSearch = undefined
  calcSelectionSheet = undefined
  impressShape = undefined
  cancelSelectionReport()
  protection?.dispose()
  protection = undefined
  releasePolicy?.()
  releasePolicy = undefined
  removeDocumentListener()
  removeLayoutListener()
  if (xModel && selectionListener) {
    try { xModel.getCurrentController().removeSelectionChangeListener(selectionListener) } catch (error) { /* disposed */ }
    selectionListener = undefined
  }
  if (!xModel) return
  try { xModel.close(true) } catch (error) {
    try { xModel.dispose() } catch (disposeError) { /* already disposed */ }
  }
  xModel = undefined
}

function readonlyWriterSelectionCursor(controller, direction) {
  const described = writerSelection?.describe(controller.getSelection())
  const range = described?.writerRange
  if (!range) return undefined
  const anchor = direction > 0 ? range.getStart() : range.getEnd()
  const edge = direction > 0 ? range.getEnd() : range.getStart()
  const cursor = controller.getViewCursor()
  cursor.gotoRange(anchor, false)
  cursor.gotoRange(edge, true)
  return cursor
}

function prepareWriterAutoscroll(message) {
  pendingWriterAutoscroll = undefined
  if (selectionDragging && documentKind === 'writer' && xModel) {
    const horizontal = Number(message.x)
    const vertical = Number(message.y)
    const controller = xModel.getCurrentController()
    writerAutoscrollCursor ??= readonlyWriterSelectionCursor(controller, Math.sign(vertical || horizontal))
    const cursor = writerAutoscrollCursor
    if (cursor) pendingWriterAutoscroll = { requestId: message.requestId, cursor, horizontal, vertical }
  }
  post({ cmd: SELECTION_AUTOSCROLL_READY_COMMAND, requestId: message.requestId })
}

function commitWriterAutoscroll(message) {
  try {
    const pending = pendingWriterAutoscroll
    if (!selectionDragging || pending?.requestId !== message.requestId) return
    if (pending.vertical > 0) pending.cursor.goDown(SELECTION_STEP_COUNT, true)
    else if (pending.vertical < 0) pending.cursor.goUp(SELECTION_STEP_COUNT, true)
    if (pending.horizontal > 0) pending.cursor.goRight(SELECTION_STEP_COUNT, true)
    else if (pending.horizontal < 0) pending.cursor.goLeft(SELECTION_STEP_COUNT, true)
  } finally {
    pendingWriterAutoscroll = undefined
    post({ cmd: SELECTION_AUTOSCROLL_APPLIED_COMMAND, requestId: message.requestId })
  }
}

function reportPresentationState() {
  if (!xModel || documentPolicy?.kind !== 'impress') return
  try {
    const pages = xModel.getDrawPages()
    const total = pages.getCount()
    const currentPage = xModel.getCurrentController().getCurrentPage()
    const currentName = typeof currentPage?.getName === 'function' ? currentPage.getName() : ''
    let current = total > 0 ? 1 : 0
    for (let index = 0; index < total; index += 1) {
      const page = pages.getByIndex(index)
      if (page === currentPage || (currentName && typeof page?.getName === 'function' && page.getName() === currentName)) {
        current = index + 1
        break
      }
    }
    post({ cmd: 'presentation_state', current, total })
  } catch (error) {
    console.warn('[office-presentation] state unavailable', String(error))
  }
}

function fitPresentation() {
  if (!releasePolicy || documentPolicy?.kind !== 'impress') return
  if (!ScholarSeedOfficePolicy.allows(documentPolicy, PRESENTATION_FIT_COMMAND)) return
  releasePolicy.dispatchNative(PRESENTATION_FIT_COMMAND, [])
}

function navigatePresentation(direction) {
  if (!releasePolicy || documentPolicy?.kind !== 'impress') return
  const command = direction === PRESENTATION_PREVIOUS_DIRECTION
    ? PRESENTATION_PREVIOUS_COMMAND
    : direction === PRESENTATION_NEXT_DIRECTION
      ? PRESENTATION_NEXT_COMMAND
      : ''
  if (!command || !ScholarSeedOfficePolicy.allows(documentPolicy, command)) return
  releasePolicy.dispatchNative(command, [])
  fitPresentation()
  reportPresentationState()
}

function requestImage(source, fallback) {
  if (!replacementAllowed || pendingImage || embedded?.active) return
  const requestId = String(++imageSequence)
  pendingImage = { requestId, fallback }
  console.info('[office-image] requested', requestId, source)
  xModel.getCurrentController().getFrame().getContainerWindow().setEnable(false)
  post({ cmd: 'image_request', requestId, source })
}

function receiveImage(message) {
  if (!pendingImage || pendingImage.requestId !== message.requestId) return
  const pending = pendingImage
  pendingImage = undefined
  xModel.getCurrentController().getFrame().getContainerWindow().setEnable(true)
  try {
    if (message.status === 'image') {
      console.info('[office-image] dispatching embedded PNG', message.requestId)
      const provider = css.graphic.GraphicProvider.create(zetajs.getUnoComponentContext())
      const graphic = provider.queryGraphic([
        new css.beans.PropertyValue({ Name: 'URL', Value: `file://${IMAGE_WASM_DIRECTORY}${message.requestId}.png` })
      ])
      const physical = graphic.getPropertyValue('Size100thMM')
      const pixels = graphic.getPropertyValue('SizePixel')
      const width = physical.Width || pixels.Width * HUNDREDTH_MM_PER_CSS_PIXEL
      const height = physical.Height || pixels.Height * HUNDREDTH_MM_PER_CSS_PIXEL
      if (!(width > 0 && height > 0)) throw new Error('office_image_invalid')
      const cursor = xModel.getCurrentController().getViewCursor()
      const pageName = cursor.getPropertyValue('PageStyleName')
      const page = xModel.getStyleFamilies().getByName(PAGE_STYLES).getByName(pageName)
      const scale = Math.min(1, (page.getPropertyValue('Width') - page.getPropertyValue('LeftMargin') - page.getPropertyValue('RightMargin')) / width)
      const object = xModel.createInstance(GRAPHIC_SERVICE)
      object.setPropertyValue('Graphic', graphic)
      object.setPropertyValue('AnchorType', css.text.TextContentAnchorType.AS_CHARACTER)
      object.setPropertyValue('Width', Math.round(width * scale))
      object.setPropertyValue('Height', Math.round(height * scale))
      const undo = xModel.getUndoManager()
      undo.enterUndoContext(message.undoLabel)
      try { cursor.getText().insertTextContent(cursor, object, true) }
      finally { undo.leaveUndoContext() }
      console.info('[office-image] native graphic inserted', message.requestId, width, height)
      reportModified()
    } else if (message.status === 'text') {
      if (message.formats?.length) {
        insertTransferable(message.requestId, message.formats)
        return
      }
      const clipboard = css.datatransfer.clipboard.SystemClipboard.create(zetajs.getUnoComponentContext())
      const existing = clipboard.getContents()
      const flavor = new css.datatransfer.DataFlavor({
        MimeType: TEXT_CLIPBOARD_FLAVOR, HumanPresentableName: 'Text', DataType: zetajs.type.string
      })
      // Keep the native rich transferable when copying within Office.
      if (!existing?.isDataFlavorSupported(flavor) || existing.getTransferData(flavor) !== message.text) {
        clipboard.setContents(zetajs.unoObject([css.datatransfer.XTransferable], {
          getTransferDataFlavors() { return [flavor] },
          isDataFlavorSupported(candidate) { return candidate.MimeType === TEXT_CLIPBOARD_FLAVOR },
          getTransferData() { return message.text }
        }), null)
      }
      pending.fallback?.()
      reportModified()
    } else if (message.status === 'empty') pending.fallback?.()
    else post({ cmd: 'image_failed', requestId: message.requestId })
  } catch (error) {
    console.error('[office-image] insertion failed', String(error))
    post({ cmd: 'image_failed', requestId: message.requestId })
    post({ cmd: 'operation_rejected', message: OFFICE_IMAGE_FAILED })
  }
}

function reportSelection() {
  selectionReportTimer = undefined
  if (!xModel) return
  const startedAt = performance.now()
  try {
    embedded?.scan()
    const searchResult = officeSearch?.refresh()
    if (searchResult) post({ cmd: 'office_search_result', ...searchResult })
    const controller = xModel.getCurrentController()
    const activeSheet = documentKind === 'calc' ? controller.getActiveSheet().getName() : undefined
    if (documentKind === 'calc' && calcSelectionSheet !== activeSheet) {
      calcSelectionSheet = activeSheet
      post({ cmd: 'selection', selection: { kind: 'calc', text: '' } })
      return
    }
    const selection = controller.getSelection()
    if (!selection) {
      post({ cmd: 'selection', selection: { text: '' } })
      return
    }
    if (typeof selection.getRangeAddress === 'function') {
      const range = selection.getRangeAddress()
      const sheet = xModel.getSheets().getByIndex(range.Sheet)
      const cellFlags = css.sheet.CellFlags
      const contentFlags = cellFlags.VALUE | cellFlags.DATETIME | cellFlags.STRING | cellFlags.FORMULA
      const described = ScholarSeedOfficeSelection.describe(selection, sheet, range, contentFlags)
      post({
        cmd: 'selection',
        selection: described
      })
      return
    }
    const writer = documentKind === 'writer' ? writerSelection?.describe(selection) : undefined
    if (writer) {
      post({ cmd: 'selection', selection: writer.selection, extractionDurationMs: performance.now() - startedAt })
      return
    }
    const currentImpressShape = documentKind === 'impress' ? ScholarSeedOfficeSelection.captureImpress(selection) : undefined
    if (currentImpressShape) impressShape = currentImpressShape
    const impress = documentKind === 'impress'
      ? ScholarSeedOfficeSelection.describeImpress(xModel, controller, impressShape, impressTransferableSupplier(), (diagnostic) => {
          console.info(OFFICE_SELECTION_LOG_PREFIX + JSON.stringify(diagnostic))
        })
      : undefined
    if (impress) {
      post({ cmd: 'selection', selection: impress })
      return
    }
    post({ cmd: 'selection', selection: { text: '' } })
  } catch (error) {
    if (documentKind === 'impress') {
      const detail = error instanceof WebAssembly.Exception ? zetajs.catchUnoException(error)?.Message : error
      console.info(OFFICE_SELECTION_LOG_PREFIX + JSON.stringify({ stage: 'failed', detail: String(detail) }))
    } else {
      console.error('[office-selection] report failed', error)
    }
    post({ cmd: 'selection', selection: { text: '' } })
  }
}

function scheduleSelectionReport() {
  cancelSelectionReport()
  selectionReportTimer = setTimeout(reportSelection, SELECTION_REPORT_DELAY_MS)
}

function replaceWriterSelection(requestId, locator, expectedText, replacement, undoLabel) {
  if (!xModel
    || !replacementAllowed
    || typeof requestId !== 'string'
    || locator?.kind !== 'writer'
    || typeof expectedText !== 'string'
    || typeof replacement !== 'string'
    || typeof undoLabel !== 'string'
    || !undoLabel.trim()) {
    post({ cmd: 'selection_replace_failed', requestId, error: REPLACEMENT_UNSUPPORTED_ERROR })
    return
  }
  try {
    const current = writerSelection?.describe(xModel.getCurrentController().getSelection())
    if (!current
      || !current.writerRange
      || current.selection.paragraph !== locator.paragraph
      || current.selection.end_paragraph !== locator.end_paragraph
      || current.selection.start !== locator.start
      || current.selection.end !== locator.end
      || current.selection.text !== expectedText) {
      post({ cmd: 'selection_replace_failed', requestId, error: REPLACEMENT_STALE_ERROR })
      return
    }
    const undo = xModel.getUndoManager()
    undo.enterUndoContext(undoLabel)
    try { current.writerRange.setString(replacement) }
    finally { undo.leaveUndoContext() }
    reportModified()
    post({ cmd: 'selection_replaced', requestId })
  } catch (error) {
    post({ cmd: 'selection_replace_failed', requestId, error: REPLACEMENT_FAILED_ERROR })
  }
}

function runOfficeSearch(requestId, query, direction) {
  if (!officeSearch || typeof requestId !== 'string') {
    post({ cmd: 'office_search_failed', requestId, error: 'search_unsupported' })
    return
  }
  try {
    post({
      cmd: 'office_search_result',
      requestId,
      ...officeSearch.run(query, direction),
    })
  } catch (error) {
    post({ cmd: 'office_search_failed', requestId, error: 'search_failed' })
  }
}

function byteSequence(value) {
  const encoded = new TextEncoder().encode(value)
  return Array.from(encoded, item => item > 127 ? item - 256 : item)
}

function insertTransferable(requestId, formats, error) {
  if (!replacementAllowed || !xModel || pendingImage || embedded?.active || error || !Array.isArray(formats) || !formats.length) {
    post({ cmd: PASTE_FAILED_ERROR, requestId })
    return
  }
  try {
    const byteType = zetajs.type.sequence(zetajs.type.byte)
    const preferred = formats.find(format => (
      format.mime === 'text/html' || format.mime === 'text/rtf' || format.mime === 'text/plain'
    ))
    if (!preferred) throw new Error('No supported clipboard flavor')
    const flavors = [preferred].map(format => {
      const isPlain = format.mime === 'text/plain'
      const mime = format.mime === 'text/html' ? HTML_MIME : format.mime === 'text/rtf' ? RTF_MIME : PLAIN_MIME
      return {
        data: isPlain ? format.data : byteSequence(format.data),
        flavor: new css.datatransfer.DataFlavor({
          MimeType: mime,
          HumanPresentableName: mime,
          DataType: isPlain ? zetajs.type.string : byteType,
        }),
        type: isPlain ? zetajs.type.string : byteType,
      }
    })
    const transferable = zetajs.unoObject([css.datatransfer.XTransferable], {
      getTransferDataFlavors() { return flavors.map(item => item.flavor) },
      isDataFlavorSupported(flavor) { return flavors.some(item => item.flavor.MimeType === flavor.MimeType) },
      getTransferData(flavor) {
        const item = flavors.find(candidate => candidate.flavor.MimeType === flavor.MimeType)
        if (!item) throw new Error(`Unsupported clipboard flavor: ${flavor.MimeType}`)
        return new zetajs.Any(item.type, item.data)
      },
    })
    xModel.getCurrentController().insertTransferable(transferable)
    reportModified()
    post({ cmd: 'paste_done', requestId })
  } catch (pasteError) {
    console.error('[office-paste] insertion failed', String(pasteError))
    post({ cmd: PASTE_FAILED_ERROR, requestId })
  }
}

function reportModified() {
  if (programmaticSave || !xModel || xModel.isReadonly()) return
  const dirty = Boolean(xModel && xModel.isModified())
  if (dirty) post({ cmd: 'modified', dirty })
}

function observeDocument() {
  documentListener = zetajs.unoObject([css.document.XDocumentEventListener], {
    documentEventOccured(event) {
      releasePolicy?.enforce()
      if (event.EventName === 'OnModifyChanged') {
        writerSelection?.invalidate()
        reportModified()
      }
      else if (event.EventName === 'OnSaveDone' && !programmaticSave) post({ cmd: 'persist' })
      else if (event.EventName === 'OnSaveFailed') post({ cmd: 'save_failed' })
    },
    disposing() {},
  })
  xModel.addDocumentEventListener(documentListener)
}

function observeLayout(bindingId) {
  layoutBroadcaster = css.frame.GlobalEventBroadcaster.create(zetajs.getUnoComponentContext())
  layoutListener = zetajs.unoObject([css.document.XDocumentEventListener], {
    documentEventOccured(event) {
      post({ cmd: 'document_event', bindingId, eventName: event.EventName })
      if (event.EventName === 'OnLayoutFinished') post({ cmd: 'layout_finished', bindingId })
    },
    disposing() {},
  })
  layoutBroadcaster.addDocumentEventListener(layoutListener)
}

function loadFile(filename, processor, expectedDocumentKind, readOnly, csvOptions, bindingId, readonlyReason = '') {
  closeDocument()
  observeLayout(bindingId)
  // Native locks cover direct native entry points as well as UNO dispatch.
  // LockSave deliberately stays off: the host persists through XStorable.store().
  const properties = ['LockEditDoc', 'LockExport', 'LockPrint'].map(Name => (
    new css.beans.PropertyValue({ Name, Value: true })
  ))
  if (readOnly) properties.push(new css.beans.PropertyValue({ Name: 'ReadOnly', Value: true }))
  if (csvOptions) {
    properties.push(new css.beans.PropertyValue({ Name: 'FilterName', Value: 'Text - txt - csv (StarCalc)' }))
    properties.push(new css.beans.PropertyValue({ Name: 'FilterOptions', Value: csvOptions }))
  }
  xModel = desktop.loadComponentFromURL(`file:///tmp/office/${filename}`, '_default', 0, properties)
  if (!xModel) {
    removeLayoutListener()
    post({ cmd: 'policy_failed', message: 'office_document_unavailable' })
    return
  }
  const controller = xModel.getCurrentController()
  documentKind = Object.keys(ScholarSeedOfficePolicy.MODULES).find(kind => (
    xModel.supportsService(ScholarSeedOfficePolicy.MODULES[kind].service)
  ))
  if (expectedDocumentKind && documentKind !== expectedDocumentKind) {
    closeDocument()
    post({ cmd: 'policy_failed', message: `office_processor_mismatch:${processor}` })
    return
  }
  const policy = ScholarSeedOfficePolicy.select(documentKind, !readOnly)
  if (!readOnly && !policy.editable) {
    loadFile(filename, processor, expectedDocumentKind, true, csvOptions, bindingId)
    return
  }
  const writerFormat = documentKind === 'writer'
    ? ScholarSeedOfficeSelection.writerFormat(filename)
    : undefined
  const writerProcessor = writerFormat ? WRITER_PROCESSORS[writerFormat]?.() : undefined
  writerSelection = writerProcessor
    ? writerProcessor.createInspector((left, right) => zetajs.sameUnoObject(left, right))
    : undefined
  if (writerSelection && typeof xModel.getText === 'function') writerSelection.prepare(xModel.getText())
  if (policy.editable) {
    try {
      protection = ScholarSeedOfficeProtection.install(zetajs, css, xModel, message => {
        console.warn('[office-protection]', message)
        post({ cmd: 'operation_rejected', message })
        post({ cmd: 'modified', dirty: xModel.isModified() })
      }, policy.module.contentGuard)
    } catch (error) {
      const detail = error instanceof WebAssembly.Exception ? zetajs.catchUnoException(error) : error
      console.error('[office-protection] installation failed', detail?.Message || String(detail))
      loadFile(filename, processor, expectedDocumentKind, true, csvOptions, bindingId, 'office_editing_unavailable')
      return
    }
  }
  try {
    releasePolicy = ScholarSeedOfficeGovernance.install(
      zetajs, css, xModel, policy, documentKind === 'writer' && policy.editable ? {
        [INSERT_IMAGE_COMMAND]: () => requestImage('file'),
        [PASTE_COMMAND]: (dispatch, command, args) => requestImage('clipboard', () => dispatch.dispatch(command, args))
      } : {}
    )
  } catch (error) {
    console.error('[office-policy] document unavailable', String(error))
    closeDocument()
    post({ cmd: 'policy_failed', message: OFFICE_POLICY_FAILED })
    return
  }
  replacementAllowed = policy.editable && documentKind === 'writer'
  caretTracked = replacementAllowed
  documentPolicy = policy
  if (documentKind === 'writer') embedded = ScholarSeedOfficeEmbedded.observe(zetajs, css, xModel, policy.editable, change => {
    if (change.dirty && policy.editable) post({ cmd: 'modified', dirty: true })
    if (typeof change.active === 'boolean') post({ cmd: 'embedded_active', active: change.active })
  }, error => {
    console.error('[office-embedded] governance failed', String(error))
    post({ cmd: 'policy_failed', message: OFFICE_FORMULA_POLICY_FAILED })
  })
  calcSelectionSheet = documentKind === 'calc' ? controller.getActiveSheet().getName() : undefined
  officeSearch = ScholarSeedOfficeSearch.create(documentKind, controller, xModel)
  observeDocument()
  selectionListener = zetajs.unoObject([css.view.XSelectionChangeListener], {
    selectionChanged() {
      if (documentKind === 'impress') {
        const selectedShape = ScholarSeedOfficeSelection.captureImpress(controller.getSelection())
        if (selectedShape) impressShape = selectedShape
      }
      if (!selectionDragging) scheduleSelectionReport()
      scheduleCaretReport()
    },
    disposing() {},
  })
  controller.addSelectionChangeListener(selectionListener)
  post({ cmd: 'ui_ready', bindingId, documentKind, editable: policy.editable, readonlyReason: readonlyReason || policy.readonlyReason })
  if (documentKind === 'impress') {
    fitPresentation()
    reportPresentationState()
  }
  reportModified()
  scheduleCaretReport()
}

function saveDocument() {
  if (!xModel) return
  programmaticSave = true
  try {
    if (pendingImage) throw new Error('office_image_pending')
    embedded?.deactivate()
    if (protection) protection.store()
    else xModel.store()
    post({ cmd: 'persist' })
  } catch (error) { post({ cmd: 'save_failed', message: String(error) }) }
  finally { programmaticSave = false }
}

function start() {
  desktop = css.frame.Desktop.create(zetajs.getUnoComponentContext())
  zetajs.mainPort.onmessage = function onMainMessage(event) {
    switch (event.data.cmd) {
      case 'upload': loadFile(event.data.filename, event.data.processor, event.data.expectedDocumentKind, event.data.readOnly, event.data.csvOptions, event.data.bindingId); break
      case 'theme': applyPalette(event.data.palette); break
      case VIEWPORT_RESIZE_COMMAND:
        // Qt owns the transferred OffscreenCanvas and updates both screen geometry and backing pixels.
        Module.qtResizeAllScreens(undefined)
        post({
          cmd: VIEWPORT_RESIZED_COMMAND,
          bindingId: event.data.bindingId,
          requestId: event.data.requestId,
          width: Module.canvas.width,
          height: Module.canvas.height,
        })
        fitPresentation()
        reportPresentationState()
        scheduleCaretReport()
        break
      case 'save': saveDocument(); break
      case 'image_request': requestImage('clipboard', () => releasePolicy.dispatchNative(PASTE_COMMAND, [])); break
      case 'image_result': receiveImage(event.data); break
      case 'replace_selection': replaceWriterSelection(event.data.requestId, event.data.locator, event.data.expectedText, event.data.replacement, event.data.undoLabel); break
      case 'office_search': runOfficeSearch(event.data.requestId, event.data.query, event.data.direction); break
      case PRESENTATION_NAVIGATE_COMMAND: navigatePresentation(event.data.direction); break
      case 'paste': insertTransferable(event.data.requestId, event.data.formats, event.data.error); break
      case SELECTION_DRAG_COMMAND:
        selectionDragging = Boolean(event.data.active)
        writerAutoscrollCursor = undefined
        if (!selectionDragging) pendingWriterAutoscroll = undefined
        cancelSelectionReport()
        if (selectionDragging) post({ cmd: 'selection', selection: { text: '' } })
        else if (documentKind === 'calc') reportSelection()
        else scheduleSelectionReport()
        break
      case SELECTION_AUTOSCROLL_COMMAND:
        prepareWriterAutoscroll(event.data)
        break
      case SELECTION_AUTOSCROLL_COMMIT_COMMAND:
        commitWriterAutoscroll(event.data)
        break
      case SELECTION_COMMIT_COMMAND: scheduleSelectionReport(); break
      case 'host_saved':
        protection?.saved()
        if (xModel && typeof xModel.setModified === 'function') xModel.setModified(false)
        post({ cmd: 'modified', dirty: false })
        break
      case 'dispose': closeDocument(); zetajs.mainPort.close(); break
      default: throw new Error(`Unknown message command: ${String(event.data.cmd)}`)
    }
  }
  post({ cmd: 'thr_running' })
}

Module.zetajs.then(function initializeZetaJs(value) {
  zetajs = value
  css = zetajs.uno.com.sun.star
  start()
})
