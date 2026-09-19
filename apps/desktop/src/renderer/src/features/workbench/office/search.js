/* SPDX-License-Identifier: MIT */

'use strict'

globalThis.ScholarSeedOfficeSearch = (() => {
  const FIRST = 'first'
  const NEXT = 'next'
  const PREVIOUS = 'previous'
  const DIRECTIONS = new Set([FIRST, NEXT, PREVIOUS])
  const TABLE_SERVICE = 'com.sun.star.drawing.TableShape'
  const PAGE_PREFIX = '第 '
  const PAGE_SUFFIX = ' 页'

  function indexedValues(value) {
    const values = []
    for (let index = 0; index < value.getCount(); index += 1) values.push(value.getByIndex(index))
    return values
  }

  function individualCells(found) {
    const cells = []
    const seen = new Set()
    const enumeration = found.getCells().createEnumeration()
    while (enumeration.hasMoreElements()) {
      const cell = enumeration.nextElement()
      const address = cell.getCellAddress()
      const key = `${address.Sheet}:${address.Row}:${address.Column}`
      if (seen.has(key)) continue
      seen.add(key)
      cells.push({ address, cell })
    }
    cells.sort((left, right) => (
      left.address.Sheet - right.address.Sheet
      || left.address.Row - right.address.Row
      || left.address.Column - right.address.Column
    ))
    return cells.map(({ cell }) => cell)
  }

  function descriptor(target, query) {
    const value = target.createSearchDescriptor()
    value.setSearchString(query)
    value.setPropertyValue('SearchCaseSensitive', false)
    value.setPropertyValue('SearchRegularExpression', false)
    value.setPropertyValue('SearchWords', false)
    return value
  }

  function baseSearch(collect, select, refreshLocation) {
    let query = ''
    let location = ''
    let scope = ''
    let matches = []
    let index = -1

    function result() {
      return { query, location, current: matches.length ? index + 1 : 0, total: matches.length }
    }

    function run(searchQuery, direction = FIRST) {
      if (typeof searchQuery !== 'string' || !DIRECTIONS.has(direction)) {
        throw new Error('Invalid office search request')
      }
      const nextLocation = refreshLocation?.() || ''
      if (query !== searchQuery || scope !== nextLocation) {
        query = searchQuery
        scope = nextLocation
        location = nextLocation
        matches = query.trim() ? collect(query) : []
        index = matches.length ? 0 : -1
      } else if (matches.length && direction === NEXT) index = (index + 1) % matches.length
      else if (matches.length && direction === PREVIOUS) index = (index - 1 + matches.length) % matches.length
      else if (matches.length) index = 0
      if (matches.length) {
        location = select(matches[index]) || location
      }
      return result()
    }

    function refresh() {
      if (!refreshLocation || scope === refreshLocation()) return undefined
      return run(query, FIRST)
    }

    return Object.freeze({ refresh, run })
  }

  function calc(controller) {
    function activeSheet() {
      const value = controller.getActiveSheet()
      return { name: value.getName(), value }
    }
    return baseSearch(
      (query) => {
        const found = activeSheet().value.findAll(descriptor(activeSheet().value, query))
        return found ? individualCells(found) : []
      },
      (match) => { controller.select(match); return activeSheet().name },
      () => activeSheet().name
    )
  }

  function writer(controller, model) {
    return baseSearch(
      (query) => {
        const found = model.findAll(descriptor(model, query))
        return found ? indexedValues(found) : []
      },
      (match) => { controller.select(match); return '' }
    )
  }

  function textMatches(text, query, page, pageNumber) {
    const matches = []
    const source = text.getString()
    const foldedSource = source.toLocaleLowerCase()
    const foldedQuery = query.toLocaleLowerCase()
    let offset = foldedSource.indexOf(foldedQuery)
    while (offset >= 0) {
      matches.push({ text, offset, length: query.length, page, pageNumber })
      offset = foldedSource.indexOf(foldedQuery, offset + Math.max(query.length, 1))
    }
    return matches
  }

  function visible(shape) {
    try {
      return typeof shape.getPropertyValue !== 'function' || shape.getPropertyValue('Visible') !== false
    } catch {
      return true
    }
  }

  function collectShape(shape, query, page, pageNumber) {
    if (!shape || !visible(shape)) return []
    try {
      if (shape.getShapeType?.() === TABLE_SERVICE || shape.supportsService?.(TABLE_SERVICE)) {
        const table = shape.getPropertyValue('Model')
        const matches = []
        const rowCount = table.getRows().getCount()
        const columnCount = table.getColumns().getCount()
        for (let row = 0; row < rowCount; row += 1) {
          for (let column = 0; column < columnCount; column += 1) {
            matches.push(...textMatches(table.getCellByPosition(column, row), query, page, pageNumber))
          }
        }
        return matches
      }
      if (typeof shape.getString === 'function' && typeof shape.createTextCursor === 'function') {
        return textMatches(shape, query, page, pageNumber)
      }
      if (typeof shape.getCount === 'function' && typeof shape.getByIndex === 'function') {
        return indexedValues(shape).flatMap((child) => collectShape(child, query, page, pageNumber))
      }
    } catch {
      return []
    }
    return []
  }

  function impress(controller, model) {
    return baseSearch(
      (query) => indexedValues(model.getDrawPages()).flatMap((page, index) => (
        indexedValues(page).flatMap((shape) => collectShape(shape, query, page, index + 1))
      )),
      (match) => {
        const cursor = match.text.createTextCursor()
        cursor.gotoStart(false)
        if (match.offset) cursor.goRight(match.offset, false)
        cursor.goRight(match.length, true)
        controller.setCurrentPage(match.page)
        controller.select(cursor)
        return `${PAGE_PREFIX}${match.pageNumber}${PAGE_SUFFIX}`
      }
    )
  }

  function create(kind, controller, model) {
    if (kind === 'calc') return calc(controller)
    if (kind === 'writer') return writer(controller, model)
    if (kind === 'impress') return impress(controller, model)
    throw new Error(`Unsupported office search kind: ${kind}`)
  }

  return Object.freeze({ create })
})()
