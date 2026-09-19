/* SPDX-License-Identifier: MIT */
'use strict';

globalThis.ScholarSeedOfficeProtection = (() => {
  const PROTECTION_PROPERTY = 'CellProtection'
  const NEXT_EVENT_LOOP = 0
  function cells(zetajs, css, model) {
    const sheets = model.getSheets()
    const password = crypto.randomUUID()
    const entries = []
    function containsFormula() {
      return entries.some(({ sheet }) => sheet.queryContentCells(css.sheet.CellFlags.FORMULA).getCount() > 0)
    }
    for (let index = 0; index < sheets.getCount(); index += 1) {
      const sheet = sheets.getByIndex(index)
      const range = sheet.getCellRangeByPosition(0, 0, sheet.getColumns().getCount() - 1, sheet.getRows().getCount() - 1)
      if (sheet.isProtected() || range.getPropertyState(PROTECTION_PROPERTY) === css.beans.PropertyState.AMBIGUOUS_VALUE) {
        throw new Error('office_cells_protected')
      }
      entries.push({ sheet, range, original: range.getPropertyValue(PROTECTION_PROPERTY) })
    }
    if (model.isProtected() || containsFormula()) throw new Error('office_workbook_protected')
    function protect() {
      for (const entry of entries) {
        entry.range.setPropertyValue(PROTECTION_PROPERTY, new css.util.CellProtection({ ...entry.original, IsLocked: false }))
        entry.sheet.protect(password)
      }
      model.protect(password)
    }
    function restore() {
      model.unprotect(password)
      for (const entry of entries) {
        entry.sheet.unprotect(password)
        entry.range.setPropertyValue(PROTECTION_PROPERTY, entry.original)
      }
    }
    return {
      metadata: true, protect, restore, forbidden: containsFormula,
      rejection: 'office_formula_rejected'
    }
  }
  function slides(zetajs, _css, model) {
    const pages = model.getDrawPages()
    const original = Array.from({ length: pages.getCount() }, (_, index) => {
      const page = pages.getByIndex(index)
      return { page, shapes: Array.from({ length: page.getCount() }, (_, shape) => page.getByIndex(shape)) }
    })
    return {
      protect() {}, restore() {},
      describe() {
        return { pages: pages.getCount(), expected: original.length, entries: original.map((entry, index) => {
          if (index >= pages.getCount()) return { missing: index }
          const page = pages.getByIndex(index)
          return { samePage: zetajs.sameUnoObject(page, entry.page), shapes: page.getCount(), expected: entry.shapes.length,
            sameShapes: entry.shapes.map((shape, shapeIndex) => shapeIndex < page.getCount() && zetajs.sameUnoObject(shape, page.getByIndex(shapeIndex))) }
        }) }
      },
      forbidden() {
        return pages.getCount() !== original.length || original.some((entry, index) => {
          const page = pages.getByIndex(index)
          return !zetajs.sameUnoObject(page, entry.page) || page.getCount() !== entry.shapes.length ||
            entry.shapes.some((shape, shapeIndex) => !zetajs.sameUnoObject(shape, page.getByIndex(shapeIndex)))
        })
      },
      rejection: 'office_structure_rejected'
    }
  }
  const GUARDS = Object.freeze({ cells, slides })
  function install(zetajs, css, model, notify, kind) {
    const factory = GUARDS[kind]
    if (!factory) return undefined
    const constraint = factory(zetajs, css, model)
    const undo = model.getUndoManager()
    let busy = false
    let pending
    let contextDepth = 0
    let undoReady = false
    let failure
    let acceptedDirty = model.isModified()
    function withoutHistory(action) {
      busy = true
      undo.lock()
      try { return action() } finally { undo.unlock(); busy = false }
    }
    if (constraint.metadata) withoutHistory(() => { constraint.protect(); model.setModified(acceptedDirty) })
    function validate(finalize = false) {
      if (busy) return
      clearTimeout(pending)
      pending = undefined
      if (failure) throw failure
      if (contextDepth > 0) return
      if (constraint.forbidden()) {
        if (!undoReady) {
          if (finalize) throw new Error('office_finish_editing')
          return
        }
        console.warn('[office-protection] rejected transaction', JSON.stringify({ kind, state: constraint.describe?.() }))
        if (!undo.isUndoPossible()) throw new Error('office_undo_failed')
        busy = true
        try {
          undo.undo()
          if (constraint.forbidden()) {
            console.error('[office-protection] rollback mismatch', JSON.stringify(constraint.describe?.()))
            // The native action was not the forbidden transaction. Put it back:
            // never discard previously accepted edits while failing closed on save.
            undo.redo()
            failure = new Error('office_protection_failed')
            throw failure
          }
          undo.clearRedo()
          model.setModified(acceptedDirty)
          notify(constraint.rejection)
        } finally { busy = false }
      }
      undoReady = false
      acceptedDirty = model.isModified()
    }
    function schedule() {
      if (busy || pending !== undefined) return
      pending = setTimeout(() => {
        try { validate() } catch (error) { console.error('[office-protection]', String(error)); notify(String(error)) }
      }, NEXT_EVENT_LOOP)
    }
    const listener = zetajs.unoObject([css.util.XModifyListener], { modified: schedule, disposing() {} })
    function contextChanged(event) {
      contextDepth = event.UndoContextDepth
      if (contextDepth === 0) committed()
    }
    function committed() {
      if (busy) return
      undoReady = true
      schedule()
    }
    const undoListener = zetajs.unoObject([css.document.XUndoManagerListener], {
      undoActionAdded: contextChanged, enteredContext: contextChanged, enteredHiddenContext: contextChanged,
      leftContext: contextChanged, leftHiddenContext: contextChanged, cancelledContext: contextChanged,
      actionUndone: committed, actionRedone: committed,
      allActionsCleared() {}, redoActionsCleared() {}, resetAll() { contextDepth = 0 }, disposing() {}
    })
    undo.addUndoManagerListener(undoListener)
    model.addModifyListener(listener)
    return {
      validate,
      saved() { acceptedDirty = false },
      store() {
        if (contextDepth > 0) throw new Error('office_finish_editing')
        validate(true)
        const dirty = model.isModified()
        if (constraint.metadata) withoutHistory(constraint.restore)
        busy = true
        try { model.store() } finally {
          busy = false
          if (constraint.metadata) withoutHistory(() => { constraint.protect(); model.setModified(dirty) })
          else model.setModified(dirty)
        }
      },
      dispose() { clearTimeout(pending); model.removeModifyListener(listener); undo.removeUndoManagerListener(undoListener) }
    }
  }
  return Object.freeze({ install })
})();
