/* SPDX-License-Identifier: MIT */

'use strict'

globalThis.ScholarSeedOfficeDocSelection = (() => {
  const FORMAT = 'doc'
  const MAXIMUM_CONTEXT_CHARS = 36_000

  function ranges(selection) {
    const selected = typeof selection?.getCount === 'function'
      ? Array.from({ length: selection.getCount() }, (_, index) => selection.getByIndex(index))
      : (typeof selection?.getString === 'function' ? [selection] : [])
    return selected.filter((range) => (
      typeof range?.getString === 'function'
      && typeof range?.getStart === 'function'
      && typeof range?.getEnd === 'function'
      && typeof range?.getText === 'function'
    ))
  }

  function createInspector(sameObject) {
    const catalogs = []

    function catalog(body) {
      const cached = catalogs.find((entry) => sameObject(entry.body, body))
      if (cached) return cached
      const paragraphs = body.createEnumeration()
      const all = []
      const text = []
      while (paragraphs.hasMoreElements()) {
        const paragraph = paragraphs.nextElement()
        if (typeof paragraph?.getStart !== 'function' || typeof paragraph?.getEnd !== 'function') continue
        all.push(paragraph)
        text.push(typeof paragraph.getString === 'function' ? paragraph.getString() : '')
      }
      const entry = { body, paragraphs: all, text }
      catalogs.push(entry)
      return entry
    }

    function prepare(body) {
      if (body) catalog(body)
    }

    function invalidate() {
      catalogs.length = 0
    }

    function contextText(paragraphText, startIndex, endIndex, selectionText) {
      const remaining = Math.max(0, MAXIMUM_CONTEXT_CHARS - selectionText.length)
      const beforeBudget = Math.floor(remaining / 2)
      const afterBudget = remaining - beforeBudget
      const before = []
      let beforeLength = 0
      for (let index = startIndex - 1; index >= 0 && beforeLength < beforeBudget; index -= 1) {
        before.unshift(paragraphText[index])
        beforeLength += paragraphText[index].length + 1
      }
      const after = []
      let afterLength = 0
      for (let index = endIndex + 1; index < paragraphText.length && afterLength < afterBudget; index += 1) {
        after.push(paragraphText[index])
        afterLength += paragraphText[index].length + 1
      }
      const prefix = before.join('\n').slice(-beforeBudget)
      const suffix = after.join('\n').slice(0, afterBudget)
      return [prefix, selectionText, suffix].filter(Boolean).join('\n')
    }

    function describe(selection) {
      const selectedRanges = ranges(selection)
      if (!selectedRanges.length) return undefined
      const body = selectedRanges[0].getText()
      if (!selectedRanges.every((range) => sameObject(body, range.getText()))) return undefined
      const ordered = selectedRanges.slice().sort((left, right) => (
        -body.compareRegionStarts(left.getStart(), right.getStart())
      ))
      const firstRange = ordered[0]
      const lastRange = ordered[ordered.length - 1]
      const text = ordered.map((range) => range.getString()).filter(Boolean).join('\n')
      if (!text) return undefined
      const indexed = catalog(body)
      const all = indexed.paragraphs
      if (!all.length) return undefined
      const before = all.length > 1 ? body.compareRegionStarts(all[0], all[1]) : 1
      const locate = (point) => {
        let lower = 0
        let upper = all.length - 1
        while (lower <= upper) {
          const index = Math.floor((lower + upper) / 2)
          const paragraph = all[index]
          const startOrder = body.compareRegionStarts(paragraph, point)
          const endOrder = body.compareRegionEnds(paragraph, point)
          if ((startOrder === 0 || startOrder === before) && (endOrder === 0 || endOrder === -before)) return index
          if (startOrder === -before) upper = index - 1
          else lower = index + 1
        }
        return -1
      }
      const startIndex = locate(firstRange.getStart())
      const endIndex = locate(lastRange.getEnd())
      if (startIndex < 0 || endIndex < startIndex) return undefined
      const startCursor = body.createTextCursorByRange(all[startIndex].getStart())
      startCursor.gotoRange(firstRange.getStart(), true)
      const endCursor = body.createTextCursorByRange(all[endIndex].getStart())
      endCursor.gotoRange(lastRange.getEnd(), true)
      return {
        writerRange: ordered.length === 1 ? firstRange : undefined,
        selection: {
          kind: 'writer',
          format: FORMAT,
          paragraph: `paragraph-${startIndex + 1}`,
          end_paragraph: `paragraph-${endIndex + 1}`,
          start: startCursor.getString().length,
          end: endCursor.getString().length,
          text,
          context_text: contextText(indexed.text, startIndex, endIndex, text),
        },
      }
    }

    return Object.freeze({ describe, invalidate, prepare })
  }

  return Object.freeze({ FORMAT, MAXIMUM_CONTEXT_CHARS, createInspector })
})()
