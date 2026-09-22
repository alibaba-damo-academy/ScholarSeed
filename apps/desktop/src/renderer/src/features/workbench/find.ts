import type { editor as monacoEditor, IDisposable, Range } from 'monaco-editor/editor/editor.api'

import { findMatchNeedsTopSpace } from './occlusion'

const FIND_CONTROLLER_ID = 'editor.contrib.findController'
const FIND_WIDGET_SELECTOR = '.find-widget'
const FIND_WIDGET_TOP_PROPERTY = '--vds-monaco-find-widget-top'

interface FindState {
  readonly currentMatch: Range | null
  readonly isRevealed: boolean
  readonly matchesCount: number
  readonly onFindReplaceStateChange: (listener: () => void) => IDisposable
}

interface FindControllerContribution extends IDisposable {
  getState: () => FindState
}

export function bindAdaptiveFindSpace(
  editor: monacoEditor.IStandaloneCodeEditor,
  host: HTMLElement,
  paddingOption: monacoEditor.EditorOption
): IDisposable {
  const controller = editor.getContribution<FindControllerContribution>(FIND_CONTROLLER_ID)
  if (!controller) return { dispose: () => undefined }
  const state = controller.getState()
  let observedWidget: HTMLElement | null = null
  let spaceEnabled = false
  let pendingFrame: number | null = null

  const widgetObserver = new ResizeObserver(() => syncWidgetTop())
  const findWidget = (): HTMLElement | null => {
    const widget = host.querySelector<HTMLElement>(FIND_WIDGET_SELECTOR)
    if (widget === observedWidget) return widget
    widgetObserver.disconnect()
    observedWidget = widget
    if (widget) widgetObserver.observe(widget)
    return widget
  }
  const syncWidgetTop = (): void => {
    const widget = findWidget()
    if (!widget || widget.getAttribute('aria-hidden') === 'true') return
    const hostBounds = host.getBoundingClientRect()
    const widgetBounds = widget.getBoundingClientRect()
    host.style.setProperty(FIND_WIDGET_TOP_PROPERTY, `${widgetBounds.top - hostBounds.top}px`)
  }
  host.addEventListener('pointerover', syncWidgetTop)
  host.addEventListener('focusin', syncWidgetTop)
  syncWidgetTop()

  const update = (): void => {
    pendingFrame = null
    const widget = findWidget()
    syncWidgetTop()
    const currentMatch = state.currentMatch
    const shouldEnable = Boolean(
      state.isRevealed
      && state.matchesCount > 0
      && currentMatch
      && widget
      && widget.getAttribute('aria-hidden') !== 'true'
      && findMatchNeedsTopSpace(
        editor.getTopForLineNumber(currentMatch.startLineNumber),
        widget.getBoundingClientRect().height,
        editor.getOption(paddingOption).top,
        spaceEnabled
      )
    )
    if (shouldEnable === spaceEnabled) return
    spaceEnabled = shouldEnable
    editor.updateOptions({ find: { addExtraSpaceOnTop: spaceEnabled } })
    if (spaceEnabled) editor.setScrollTop(0)
  }
  const schedule = (): void => {
    if (pendingFrame !== null) cancelAnimationFrame(pendingFrame)
    pendingFrame = requestAnimationFrame(update)
  }
  const stateListener = state.onFindReplaceStateChange(schedule)
  schedule()

  return {
    dispose: () => {
      stateListener.dispose()
      widgetObserver.disconnect()
      host.removeEventListener('pointerover', syncWidgetTop)
      host.removeEventListener('focusin', syncWidgetTop)
      if (pendingFrame !== null) cancelAnimationFrame(pendingFrame)
      if (spaceEnabled) editor.updateOptions({ find: { addExtraSpaceOnTop: false } })
      host.style.removeProperty(FIND_WIDGET_TOP_PROPERTY)
    }
  }
}
