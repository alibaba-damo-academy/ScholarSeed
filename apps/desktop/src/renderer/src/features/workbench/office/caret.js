/* SPDX-License-Identifier: MIT */

'use strict'

// Loaded unchanged in the UNO worker and contract tests.
// Native Writer publishes its text caret through the accessibility API; the host input
// method anchors to that rectangle instead of a fixed position in the Office frame.
globalThis.ScholarSeedOfficeCaret = (() => {
  const MAX_DEPTH = 12
  const MAX_VISITED = 4000
  const NO_CARET = -1

  function accessibleContext(accessible) {
    if (!accessible) return undefined
    return typeof accessible.getAccessibleContext === 'function' ? accessible.getAccessibleContext() : accessible
  }

  function findCaretOwner(root) {
    const pending = [{ context: root, depth: 0 }]
    let visited = 0
    while (pending.length > 0 && visited < MAX_VISITED) {
      const { context, depth } = pending.pop()
      visited += 1
      if (!context) continue
      if (typeof context.getCaretPosition === 'function') {
        const caret = context.getCaretPosition()
        if (caret > NO_CARET) return { context, caret }
      }
      if (depth >= MAX_DEPTH) continue
      const count = context.getAccessibleChildCount()
      for (let index = count - 1; index >= 0; index -= 1) {
        pending.push({ context: accessibleContext(context.getAccessibleChild(index)), depth: depth + 1 })
      }
    }
    return undefined
  }

  function characterBounds(context, caret) {
    try {
      return context.getCharacterBounds(caret)
    } catch (error) {
      // The caret after the last character has no glyph; anchor to the preceding glyph's end.
      if (caret <= 0) throw error
      const previous = context.getCharacterBounds(caret - 1)
      return { X: previous.X + previous.Width, Y: previous.Y, Width: 0, Height: previous.Height }
    }
  }

  function locate(frame) {
    const root = accessibleContext(frame.getComponentWindow())
    const owner = root && findCaretOwner(root)
    if (!owner) return undefined
    const bounds = characterBounds(owner.context, owner.caret)
    const origin = owner.context.getLocationOnScreen()
    const screen = frame.getContainerWindow().getPosSize()
    return {
      rect: { x: origin.X + bounds.X, y: origin.Y + bounds.Y, height: bounds.Height },
      screen: { width: screen.X + screen.Width, height: screen.Y + screen.Height },
    }
  }

  return Object.freeze({ locate })
})()
