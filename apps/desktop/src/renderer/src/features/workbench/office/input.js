/* SPDX-License-Identifier: MIT */

'use strict'

globalThis.ScholarSeedOfficeInput = (() => {
  const COMMANDS = Object.freeze({
    ArrowDown: '.uno:GoDown',
    ArrowLeft: '.uno:GoLeft',
    ArrowRight: '.uno:GoRight',
    ArrowUp: '.uno:GoUp',
    Backspace: '.uno:SwBackspace',
    Delete: '.uno:Delete',
    End: '.uno:GoToEndOfLine',
    Enter: '.uno:InsertPara',
    Home: '.uno:GoToStartOfLine',
    PageDown: '.uno:PageDown',
    PageUp: '.uno:PageUp',
    Tab: '.uno:InsertTab',
  })
  const MIN_CARET_SIZE = 1
  const MODIFIER_KEYS = Object.freeze(['Alt', 'Control', 'Meta', 'Shift'])
  const SELECTION_COMMANDS = Object.freeze({
    ArrowDown: '.uno:GoDownSel',
    ArrowLeft: '.uno:GoLeftSel',
    ArrowRight: '.uno:GoRightSel',
    ArrowUp: '.uno:GoUpSel',
    End: '.uno:EndOfLineSel',
    Home: '.uno:StartOfLineSel',
    PageDown: '.uno:PageDownSel',
    PageUp: '.uno:PageUpSel',
  })
  const WORD_COMMANDS = Object.freeze({
    ArrowLeft: '.uno:GoToPrevWord',
    ArrowRight: '.uno:GoToNextWord',
    Backspace: '.uno:DelToStartOfWord',
    Delete: '.uno:DelToEndOfWord',
    End: '.uno:GoToEndOfDoc',
    Home: '.uno:GoToStartOfDoc',
  })
  const WORD_SELECTION_COMMANDS = Object.freeze({
    ArrowLeft: '.uno:GoLeftBlockSel',
    ArrowRight: '.uno:GoRightBlockSel',
    End: '.uno:EndOfDocumentSel',
    Home: '.uno:StartOfDocumentSel',
  })

  function shortcutCommand(event, shortcuts) {
    const primaryPressed = /Mac|iPhone|iPad/i.test(navigator.userAgent)
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey
    return shortcuts.find(shortcut => shortcut.bindings.some(binding => {
      const modifiers = new Set(binding.modifiers)
      return event.key.toLowerCase() === binding.key.toLowerCase()
        && primaryPressed === modifiers.has('primary')
        && Boolean(event.shiftKey) === modifiers.has('shift')
        && Boolean(event.altKey) === modifiers.has('alt')
    }))?.command || ''
  }

  function commandFor(event, shortcuts = []) {
    if (MODIFIER_KEYS.includes(event.key) || (event.ctrlKey && event.altKey)) return ''
    if (event.ctrlKey || event.metaKey) {
      const shortcut = shortcutCommand(event, shortcuts)
      if (shortcut) return shortcut
      if (event.shiftKey) return WORD_SELECTION_COMMANDS[event.key] || ''
      return WORD_COMMANDS[event.key] || ''
    }
    if (event.altKey) return event.shiftKey ? WORD_SELECTION_COMMANDS[event.key] || '' : WORD_COMMANDS[event.key] || ''
    if (event.shiftKey) return SELECTION_COMMANDS[event.key] || ''
    return COMMANDS[event.key] || ''
  }

  function caretBox(caret, surface) {
    const { rect, screen } = caret || {}
    if (!rect || !screen || !(screen.width > 0 && screen.height > 0)) return undefined
    if (![rect.x, rect.y, rect.height].every(Number.isFinite)) return undefined
    const scaleX = surface.width / screen.width
    const scaleY = surface.height / screen.height
    const height = Math.max(MIN_CARET_SIZE, rect.height * scaleY)
    return {
      left: Math.min(Math.max(0, rect.x * scaleX), Math.max(0, surface.width - MIN_CARET_SIZE)),
      top: Math.min(Math.max(0, rect.y * scaleY), Math.max(0, surface.height - height)),
      height,
    }
  }

  function pointerBox(event, bounds) {
    return { left: event.clientX - bounds.left, top: event.clientY - bounds.top, height: MIN_CARET_SIZE }
  }

  function create({ element, canvas, enabled, shortcuts, sendCommand, sendText, requestCaret }) {
    let composing = false
    let ignoredInput = ''

    function focus() {
      if (enabled()) element.focus({ preventScroll: true })
    }

    function position(box) {
      element.style.left = `${box.left}px`
      element.style.top = `${box.top}px`
      element.style.height = `${box.height}px`
      element.style.fontSize = `${box.height}px`
      element.style.lineHeight = `${box.height}px`
    }

    function place(caret) {
      const box = caretBox(caret, { width: canvas.clientWidth, height: canvas.clientHeight })
      if (box) position(box)
    }

    function onCompositionStart() {
      composing = true
      ignoredInput = ''
      if (enabled()) requestCaret()
    }

    function commit(text) {
      element.value = ''
      if (text) sendText(text)
    }

    function onCompositionEnd(event) {
      composing = false
      const text = event.data || element.value
      ignoredInput = text
      commit(text)
    }

    function onInput(event) {
      if (composing || event.isComposing) return
      const text = event.data ?? element.value
      if (ignoredInput && text === ignoredInput) {
        ignoredInput = ''
        element.value = ''
        return
      }
      ignoredInput = ''
      commit(text)
    }

    function onKeyDown(event) {
      if (!enabled() || composing || event.isComposing || event.key === 'Process') return
      const command = commandFor(event, shortcuts)
      if (!command) return
      event.preventDefault()
      event.stopImmediatePropagation()
      sendCommand(command)
    }

    function onPointerUp(event) {
      if (event.button !== 0) return
      // Anchor near the click until native Writer reports the exact caret rectangle.
      if (enabled()) position(pointerBox(event, canvas.getBoundingClientRect()))
      setTimeout(focus, 0)
    }

    function onWheel() {
      if (enabled()) requestCaret()
    }

    element.addEventListener('compositionstart', onCompositionStart)
    element.addEventListener('compositionend', onCompositionEnd)
    element.addEventListener('input', onInput)
    element.addEventListener('keydown', onKeyDown)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('wheel', onWheel, { passive: true })

    return Object.freeze({
      focus,
      place,
      destroy() {
        element.removeEventListener('compositionstart', onCompositionStart)
        element.removeEventListener('compositionend', onCompositionEnd)
        element.removeEventListener('input', onInput)
        element.removeEventListener('keydown', onKeyDown)
        canvas.removeEventListener('pointerup', onPointerUp)
        canvas.removeEventListener('wheel', onWheel)
      },
    })
  }

  return Object.freeze({ caretBox, commandFor, create })
})()
