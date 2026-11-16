import type { BrowserWindow, WebContentsView } from 'electron'
import { PORTAL_LAYERS } from '../portal.ts'

export const NATIVE_LAYERS = PORTAL_LAYERS
export type NativeLayer = (typeof NATIVE_LAYERS)[number]
const stacks = new WeakMap<BrowserWindow, Map<WebContentsView, NativeLayer>>()

export function registerNativeLayer(
  window: BrowserWindow,
  view: WebContentsView,
  layer: NativeLayer
): void {
  const stack = stacks.get(window) ?? new Map<WebContentsView, NativeLayer>()
  stacks.set(window, stack)
  if (stack.has(view)) return
  stack.set(view, layer)
  view.webContents.once('destroyed', () => {
    stack.delete(view)
  })
}

export function raiseNativeLayers(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  const stack = stacks.get(window)
  if (!stack) return
  const children = window.contentView.children
  const ordered = children
    .filter(
      (view): view is WebContentsView =>
        stack.has(view as WebContentsView) && !(view as WebContentsView).webContents.isDestroyed()
    )
    .sort(
      (left, right) =>
        NATIVE_LAYERS.indexOf(stack.get(left)!) - NATIVE_LAYERS.indexOf(stack.get(right)!)
    )
  if (ordered.every((view, index) => children[children.length - ordered.length + index] === view))
    return
  for (const view of ordered) window.contentView.addChildView(view)
}

export function isFrontmostNativeLayer(window: BrowserWindow, view: WebContentsView): boolean {
  if (window.isDestroyed()) return false
  const stack = stacks.get(window)
  return (
    window.contentView.children
      .slice()
      .reverse()
      .find(
        (candidate) =>
          stack?.has(candidate as WebContentsView) &&
          !(candidate as WebContentsView).webContents.isDestroyed() &&
          (candidate as WebContentsView).getVisible()
      ) === view
  )
}
