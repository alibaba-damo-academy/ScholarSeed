/* SPDX-License-Identifier: MIT */

'use strict'

globalThis.ScholarSeedOfficeSelection = (() => {
  const MAXIMUM_INLINE_CELLS = 150
  const REFERENCE_MODE = 'reference'
  const INVALID_RANGE_ERROR = 'calc_selection_range_invalid'
  const PLAIN_TEXT_MIME = 'text/plain'
  const WRITER_FORMAT_DOC = 'doc'
  const WRITER_FORMAT_DOCX = 'docx'
  const WRITER_FORMATS = Object.freeze({
    '.doc': WRITER_FORMAT_DOC,
    '.docx': WRITER_FORMAT_DOCX,
  })
  const AUTOSCROLL_KIND_WRITER = 'writer'
  const AUTOSCROLL_KIND_CALC = 'calc'
  const CALC_FORMATS = Object.freeze(['.csv', '.xls', '.xlsx'])

  function writerFormat(filename) {
    const normalized = typeof filename === 'string' ? filename.toLowerCase() : ''
    return Object.entries(WRITER_FORMATS).find(([suffix]) => normalized.endsWith(suffix))?.[1]
  }

  function autoscrollKind(filename) {
    const normalized = typeof filename === 'string' ? filename.toLowerCase() : ''
    if (writerFormat(normalized)) return AUTOSCROLL_KIND_WRITER
    if (CALC_FORMATS.some((suffix) => normalized.endsWith(suffix))) return AUTOSCROLL_KIND_CALC
    return undefined
  }

  function cellCount(range) {
    const columns = Number(range.EndColumn) - Number(range.StartColumn) + 1
    const rows = Number(range.EndRow) - Number(range.StartRow) + 1
    if (!Number.isSafeInteger(columns) || !Number.isSafeInteger(rows) || columns < 1 || rows < 1) {
      throw new Error(INVALID_RANGE_ERROR)
    }
    const count = columns * rows
    if (!Number.isSafeInteger(count)) throw new Error(INVALID_RANGE_ERROR)
    return count
  }

  function selectionText(selection) {
    const values = selection.getDataArray()
    return values.map((row, rowIndex) => row.map((_value, columnIndex) => (
      selection.getCellByPosition(columnIndex, rowIndex).getString()
    )).join('\t')).join('\n')
  }

  function contentRange(selection, range, contentFlags) {
    if (typeof selection?.queryContentCells !== 'function') return range
    const matches = selection.queryContentCells(contentFlags)
    const addresses = typeof matches?.getRangeAddresses === 'function'
      ? Array.from(matches.getRangeAddresses())
      : []
    if (!addresses.length) return undefined
    const endColumn = Math.min(
      Number(range.EndColumn),
      Math.max(...addresses.map((address) => Number(address.EndColumn)))
    )
    const endRow = Math.min(
      Number(range.EndRow),
      Math.max(...addresses.map((address) => Number(address.EndRow)))
    )
    if (endColumn < Number(range.StartColumn) || endRow < Number(range.StartRow)) return undefined
    return { ...range, EndColumn: endColumn, EndRow: endRow }
  }

  function describe(selection, sheet, range, contentFlags) {
    const croppedRange = contentRange(selection, range, contentFlags)
    const sheetName = sheet.getName()
    if (!croppedRange) return { kind: 'calc', sheet: sheetName, range, text: '' }
    if (cellCount(croppedRange) > MAXIMUM_INLINE_CELLS) {
      return { kind: 'calc', sheet: sheetName, range: croppedRange, content_mode: REFERENCE_MODE }
    }
    const croppedSelection = (
      Number(croppedRange.EndColumn) === Number(range.EndColumn)
      && Number(croppedRange.EndRow) === Number(range.EndRow)
    )
      ? selection
      : sheet.getCellRangeByPosition(
          Number(croppedRange.StartColumn),
          Number(croppedRange.StartRow),
          Number(croppedRange.EndColumn),
          Number(croppedRange.EndRow)
        )
    return { kind: 'calc', sheet: sheetName, range: croppedRange, text: selectionText(croppedSelection) }
  }

  function sequenceItems(sequence) {
    if (Array.isArray(sequence)) return sequence
    if (typeof sequence?.size !== 'function' || typeof sequence?.get !== 'function') return []
    return Array.from({ length: sequence.size() }, (_value, index) => sequence.get(index))
  }

  function transferableText(controller, report) {
    if (typeof controller?.getTransferable !== 'function') {
      report?.({ stage: 'transferable', reason: 'method_unavailable' })
      return ''
    }
    const transferable = controller.getTransferable()
    if (!transferable || typeof transferable.getTransferDataFlavors !== 'function') {
      report?.({ stage: 'transferable', reason: 'value_unavailable' })
      return ''
    }
    const flavors = sequenceItems(transferable.getTransferDataFlavors())
    report?.({
      stage: 'flavors',
      count: flavors.length,
      mimeTypes: flavors.map((candidate) => candidate?.MimeType).filter((value) => typeof value === 'string')
    })
    const flavor = flavors.find((candidate) => (
      typeof candidate?.MimeType === 'string' && candidate.MimeType.toLowerCase().startsWith(PLAIN_TEXT_MIME)
    ))
    if (!flavor || typeof transferable.getTransferData !== 'function') {
      report?.({ stage: 'transferable', reason: 'plain_text_unavailable' })
      return ''
    }
    const value = transferable.getTransferData(flavor)
    report?.({ stage: 'transferable', valueType: typeof value, length: typeof value === 'string' ? value.length : 0 })
    return typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : ''
  }

  function currentDrawPage(model, controller) {
    const pages = model.getDrawPages()
    const currentPage = controller.getCurrentPage()
    const currentName = typeof currentPage?.getName === 'function' ? currentPage.getName() : ''
    for (let index = 0; index < pages.getCount(); index += 1) {
      const page = pages.getByIndex(index)
      const pageName = typeof page?.getName === 'function' ? page.getName() : ''
      if (page === currentPage || (currentName && pageName === currentName)) return { page, slide: index + 1 }
    }
    return undefined
  }

  function shapeSnapshot(shape, fallbackName = '') {
    if (typeof shape?.getString !== 'function') return undefined
    const nativeName = typeof shape.getName === 'function' ? shape.getName() : shape.Name
    const name = typeof nativeName === 'string' && nativeName ? nativeName : fallbackName
    const text = shape.getString().replace(/\r\n?/g, '\n')
    return typeof name === 'string' && name && text ? { name, text } : undefined
  }

  function shapeSnapshots(shape, path) {
    const direct = shapeSnapshot(shape, `shape-${path}`)
    if (direct) return [direct]
    if (typeof shape?.getCount !== 'function' || typeof shape?.getByIndex !== 'function') return []
    const snapshots = []
    for (let index = 0; index < shape.getCount(); index += 1) {
      snapshots.push(...shapeSnapshots(shape.getByIndex(index), `${path}-${index}`))
    }
    return snapshots
  }

  function captureImpress(selection) {
    const count = typeof selection?.getCount === 'function' ? selection.getCount() : 0
    return count === 1 ? shapeSnapshot(selection.getByIndex(0)) : undefined
  }

  function resolveImpressShape(model, controller, cachedShape, selectedText) {
    const page = currentDrawPage(model, controller)?.page
    const count = typeof page?.getCount === 'function' ? page.getCount() : 0
    const matches = []
    for (let index = 0; index < count; index += 1) {
      for (const candidate of shapeSnapshots(page.getByIndex(index), String(index))) {
        const start = candidate.text.indexOf(selectedText)
        if (start >= 0 && candidate.text.indexOf(selectedText, start + 1) < 0) matches.push(candidate)
      }
    }
    if (matches.length === 1) return matches[0]
    if (matches.length > 1 || !cachedShape) return undefined
    const start = cachedShape.text.indexOf(selectedText)
    return start >= 0 && cachedShape.text.indexOf(selectedText, start + 1) < 0 ? cachedShape : undefined
  }

  function describeImpress(model, controller, shape, transferableSupplier = controller, report) {
    report?.({ stage: 'selection', hasShape: Boolean(shape), hasTransferable: typeof transferableSupplier?.getTransferable === 'function' })
    const text = transferableText(transferableSupplier, report)
    const resolvedShape = text ? resolveImpressShape(model, controller, shape, text) : undefined
    const contextText = resolvedShape?.text || ''
    report?.({ stage: 'shape', contextLength: contextText.length, selectedLength: text.length })
    if (!text || !contextText) return undefined
    const start = contextText.indexOf(text)
    const end = start + text.length
    if (start < 0 || contextText.indexOf(text, start + 1) >= 0) return undefined
    const current = currentDrawPage(model, controller)
    if (!current) return undefined
    return {
      kind: 'impress',
      slide: current.slide,
      shape: resolvedShape.name,
      start,
      end,
      text,
      context_text: contextText,
    }
  }

  return Object.freeze({
    MAXIMUM_INLINE_CELLS,
    REFERENCE_MODE,
    autoscrollKind,
    captureImpress,
    describe,
    describeImpress,
    writerFormat,
  })
})()
