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
  const CURSOR_STEP_LIMIT = 32767
  const CALC_EMPTY_RANGES_SERVICE = 'com.sun.star.sheet.SheetCellRanges'

  function moveCursor(cursor, count, expand) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('selection_position_invalid')
    let remaining = count
    while (remaining > 0) {
      const step = Math.min(remaining, CURSOR_STEP_LIMIT)
      if (!cursor.goRight(step, expand)) throw new Error('selection_position_invalid')
      remaining -= step
    }
  }

  function locate(model, locator, expectedText) {
    const controller = model.getCurrentController()
    let target
    let collapsed
    if (locator.kind === 'writer') {
      const body = model.getText()
      const paragraphs = []
      const enumeration = body.createEnumeration()
      while (enumeration.hasMoreElements()) {
        const paragraph = enumeration.nextElement()
        if (typeof paragraph?.getStart === 'function' && typeof paragraph?.getEnd === 'function')
          paragraphs.push(paragraph)
      }
      const startIndex = /^paragraph-([1-9]\d*)$/.exec(locator.paragraph)?.[1]
      const endIndex = /^paragraph-([1-9]\d*)$/.exec(
        locator.end_paragraph || locator.paragraph
      )?.[1]
      const first = paragraphs[Number(startIndex) - 1]
      const last = paragraphs[Number(endIndex) - 1]
      if (!first || !last) throw new Error('selection_position_invalid')
      target = body.createTextCursorByRange(first.getStart())
      moveCursor(target, locator.start, false)
      collapsed = body.createTextCursorByRange(target.getStart())
      const end = body.createTextCursorByRange(last.getStart())
      moveCursor(end, locator.end, false)
      target.gotoRange(end, true)
    } else if (locator.kind === 'calc') {
      const sheet = model.getSheets().getByName(locator.sheet)
      target = sheet.getCellRangeByName(locator.range)
      collapsed = model.createInstance(CALC_EMPTY_RANGES_SERVICE)
      controller.setActiveSheet(sheet)
      if (locator.content_mode !== REFERENCE_MODE && selectionText(target) !== expectedText)
        throw new Error('selection_content_changed')
    } else if (locator.kind === 'impress') {
      const page = model.getDrawPages().getByIndex(locator.slide - 1)
      const find = (container, prefix = '') => {
        for (let index = 0; index < container.getCount(); index++) {
          const shape = container.getByIndex(index)
          const path = prefix ? `${prefix}-${index}` : String(index)
          const snapshot = shapeSnapshot(shape, `shape-${path}`)
          if (snapshot?.name === locator.shape) return shape
          if (typeof shape?.getCount === 'function') {
            const nested = find(shape, path)
            if (nested) return nested
          }
        }
        return undefined
      }
      const shape = find(page)
      if (!shape) throw new Error('selection_position_invalid')
      target = shape.createTextCursor()
      target.gotoStart(false)
      moveCursor(target, locator.start, false)
      collapsed = shape.createTextCursorByRange(target.getStart())
      moveCursor(target, locator.end - locator.start, true)
      controller.setCurrentPage(page)
    } else throw new Error('selection_unsupported')
    if (
      locator.kind !== 'calc' &&
      target.getString().replace(/\r\n?/g, '\n') !== expectedText.replace(/\r\n?/g, '\n')
    )
      throw new Error('selection_content_changed')
    if (controller.select(target) === false) throw new Error('selection_position_invalid')
    return { controller, target, collapsed }
  }

  function writerFormat(filename) {
    const normalized = typeof filename === 'string' ? filename.toLowerCase() : ''
    return Object.entries(WRITER_FORMATS).find(([suffix]) => normalized.endsWith(suffix))?.[1]
  }

  function pulse(controller, target, collapsed, kind, expanded) {
    if (kind === 'writer') {
      const cursor = controller.getViewCursor()
      if (!expanded) cursor.collapseToStart()
      else {
        cursor.gotoRange(target.getStart(), false)
        cursor.gotoRange(target.getEnd(), true)
      }
      return cursor.getString().length
    }
    if (controller.select(expanded ? target : collapsed) === false)
      throw new Error('selection_position_invalid')
    return undefined
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
    return values
      .map((row, rowIndex) =>
        row
          .map((_value, columnIndex) =>
            selection.getCellByPosition(columnIndex, rowIndex).getString()
          )
          .join('\t')
      )
      .join('\n')
  }

  function contentRange(selection, range, contentFlags) {
    if (typeof selection?.queryContentCells !== 'function') return range
    const matches = selection.queryContentCells(contentFlags)
    const addresses =
      typeof matches?.getRangeAddresses === 'function'
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
    const croppedSelection =
      Number(croppedRange.EndColumn) === Number(range.EndColumn) &&
      Number(croppedRange.EndRow) === Number(range.EndRow)
        ? selection
        : sheet.getCellRangeByPosition(
            Number(croppedRange.StartColumn),
            Number(croppedRange.StartRow),
            Number(croppedRange.EndColumn),
            Number(croppedRange.EndRow)
          )
    return {
      kind: 'calc',
      sheet: sheetName,
      range: croppedRange,
      text: selectionText(croppedSelection),
    }
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
      mimeTypes: flavors
        .map((candidate) => candidate?.MimeType)
        .filter((value) => typeof value === 'string'),
    })
    const flavor = flavors.find(
      (candidate) =>
        typeof candidate?.MimeType === 'string' &&
        candidate.MimeType.toLowerCase().startsWith(PLAIN_TEXT_MIME)
    )
    if (!flavor || typeof transferable.getTransferData !== 'function') {
      report?.({ stage: 'transferable', reason: 'plain_text_unavailable' })
      return ''
    }
    const value = transferable.getTransferData(flavor)
    report?.({
      stage: 'transferable',
      valueType: typeof value,
      length: typeof value === 'string' ? value.length : 0,
    })
    return typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : ''
  }

  function currentDrawPage(model, controller) {
    const pages = model.getDrawPages()
    const currentPage = controller.getCurrentPage()
    const currentName = typeof currentPage?.getName === 'function' ? currentPage.getName() : ''
    for (let index = 0; index < pages.getCount(); index += 1) {
      const page = pages.getByIndex(index)
      const pageName = typeof page?.getName === 'function' ? page.getName() : ''
      if (page === currentPage || (currentName && pageName === currentName))
        return { page, slide: index + 1 }
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
        if (start >= 0 && candidate.text.indexOf(selectedText, start + 1) < 0)
          matches.push(candidate)
      }
    }
    if (matches.length === 1) return matches[0]
    if (matches.length > 1 || !cachedShape) return undefined
    const start = cachedShape.text.indexOf(selectedText)
    return start >= 0 && cachedShape.text.indexOf(selectedText, start + 1) < 0
      ? cachedShape
      : undefined
  }

  function describeImpress(model, controller, shape, transferableSupplier = controller, report) {
    report?.({
      stage: 'selection',
      hasShape: Boolean(shape),
      hasTransferable: typeof transferableSupplier?.getTransferable === 'function',
    })
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
    locate,
    pulse,
    MAXIMUM_INLINE_CELLS,
    REFERENCE_MODE,
    autoscrollKind,
    captureImpress,
    describe,
    describeImpress,
    writerFormat,
  })
})()
