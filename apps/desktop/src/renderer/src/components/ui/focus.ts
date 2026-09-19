import { useLayoutEffect, type RefObject } from 'react'

const FOCUSABLE_SELECTOR = 'button, input, select, textarea, a[href], [tabindex], [contenteditable="true"]'
const CONTROLLED_SELECTOR = '[aria-controls][aria-expanded="true"]'
const modalScopes: HTMLElement[] = []

function topModalScope(): HTMLElement | undefined {
  return modalScopes.filter(visibleContent).reduce<HTMLElement | undefined>((top, next) => top && next.contains(top) ? top : next, undefined)
}

export function visibleContent(element: HTMLElement | null): element is HTMLElement {
  return Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
}

/** Follow open aria-controls links so portalled descendants remain inside the scope. */
export function focusRegions(content: HTMLElement): HTMLElement[] {
  const regions = [content]
  for (const region of regions) {
    for (const control of region.querySelectorAll<HTMLElement>(CONTROLLED_SELECTOR)) {
      for (const id of (control.getAttribute('aria-controls') ?? '').split(/\s+/)) {
        const linked = content.ownerDocument.getElementById(id)
        if (visibleContent(linked) && !regions.includes(linked) && !linked.contains(content)) regions.push(linked)
      }
    }
  }
  return regions
}

export function inFocusScope(content: HTMLElement, target: EventTarget | null): boolean {
  return target instanceof Node && focusRegions(content).some((region) => region.contains(target))
}

function tabStops(content: HTMLElement): HTMLElement[] {
  return [...new Set(focusRegions(content).flatMap((region) => [...region.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]))]
    .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert]') && visibleContent(element))
    .sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity))
}

export function useFocusScope(
  ref: RefObject<HTMLDivElement>,
  active: boolean,
  modal: boolean,
  autoFocus = modal,
  restoreRef?: RefObject<HTMLElement | null>
): void {
  useLayoutEffect(() => {
    const content = ref.current
    if (!active || !visibleContent(content)) return
    const document = content.ownerDocument
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (modal) modalScopes.push(content)
    const first = (): HTMLElement => tabStops(content)[0] ?? content
    if (autoFocus && (!modal || topModalScope() === content) && !inFocusScope(content, document.activeElement)) first().focus({ preventScroll: true })

    const onFocus = (event: FocusEvent): void => {
      if (modal && topModalScope() === content && visibleContent(content) && !inFocusScope(content, event.target)) first().focus({ preventScroll: true })
    }
    const onKey = (event: KeyboardEvent): void => {
      if (!modal || topModalScope() !== content || event.defaultPrevented || event.key !== 'Tab' || !visibleContent(content)) return
      const stops = tabStops(content)
      const index = stops.indexOf(document.activeElement as HTMLElement)
      if (!stops.length || index < 0 || (!event.shiftKey && index === stops.length - 1) || (event.shiftKey && index === 0)) {
        event.preventDefault()
        const next = event.shiftKey ? stops.at(-1) ?? content : first()
        next.focus({ preventScroll: true })
      }
    }
    document.addEventListener('focusin', onFocus)
    document.addEventListener('keydown', onKey)
    return () => {
      const scopeIndex = modalScopes.indexOf(content)
      if (scopeIndex >= 0) modalScopes.splice(scopeIndex, 1)
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('keydown', onKey)
      const restoreTarget = restoreRef?.current ?? previous
      if (restoreTarget?.isConnected && (inFocusScope(content, document.activeElement) || document.activeElement === document.body)) {
        restoreTarget.focus({ preventScroll: true })
      }
    }
  }, [active, autoFocus, modal, ref, restoreRef])
}
