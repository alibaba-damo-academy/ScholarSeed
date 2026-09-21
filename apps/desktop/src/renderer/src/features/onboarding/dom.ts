import type { GuideStep } from './engine'

export const OB_TIMING = { poll: 60, targetTimeout: 2500, readerTimeout: 12000 } as const
export const OB_GEOMETRY = { margin: 16, gap: 16, padding: 6, radius: 10, maxWidth: 600 } as const
export interface Rectangle { left: number; top: number; width: number; height: number }

/** All product anchors use data-ob; no CSS class or DOM hierarchy is a contract. */
export function target(name: string): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-ob="${name}"]`))
    .find(element => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0) ?? null
}
export async function waitUntil(test: () => boolean, signal: AbortSignal, timeout: number = OB_TIMING.targetTimeout): Promise<boolean> {
  const deadline = performance.now() + timeout
  while (!signal.aborted) {
    if (test()) return true
    if (performance.now() >= deadline) return false
    await new Promise<void>(resolve => {
      const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
      const timer = setTimeout(done, OB_TIMING.poll)
      signal.addEventListener('abort', done, { once: true })
    })
  }
  return false
}
export async function settle(signal: AbortSignal): Promise<void> {
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  signal.throwIfAborted()
}
export async function prepare(step: GuideStep, signal: AbortSignal): Promise<boolean> {
  await settle(signal)
  if (!step.targets.length) return true
  return waitUntil(() => step.targets.some(name => target(name)), signal)
}
export function rectangle(element: HTMLElement): Rectangle {
  const r = element.getBoundingClientRect(), pad = OB_GEOMETRY.padding
  const left = Math.max(0, r.left - pad), top = Math.max(0, r.top - pad)
  return { left, top, width: Math.max(0, Math.min(innerWidth, r.right + pad) - left), height: Math.max(0, Math.min(innerHeight, r.bottom + pad) - top) }
}
export function cardPosition(anchor: Rectangle | undefined, width: number, height: number, viewport: { width: number; height: number }): { left: number; top: number } {
  const { margin, gap } = OB_GEOMETRY
  const clamp = (value: number, max: number): number => Math.max(margin, Math.min(value, max - margin))
  if (!anchor) return { left: clamp((viewport.width - width) / 2, viewport.width - width), top: clamp((viewport.height - height) / 2, viewport.height - height) }
  const right = anchor.left + anchor.width + gap
  const below = anchor.top + anchor.height + gap
  const left = right + width <= viewport.width - margin ? right : anchor.left - gap - width >= margin ? anchor.left - gap - width : clamp(anchor.left, viewport.width - width)
  const beside = right + width <= viewport.width - margin || anchor.left - gap - width >= margin
  const top = beside ? clamp(anchor.top + (anchor.height - height) / 2, viewport.height - height) : below + height <= viewport.height - margin ? below : clamp(anchor.top - gap - height, viewport.height - height)
  return { left, top }
}

let ownsSelection = false
export async function selectSentence(signal: AbortSignal): Promise<void> {
  const ready = await waitUntil(() => Boolean(target('pdf-first-text')?.textContent?.trim()), signal, OB_TIMING.readerTimeout)
  if (!ready) return
  const text = target('pdf-first-text')!
  text.scrollIntoView({ block: 'nearest' })
  await settle(signal)
  const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let node: Node | null
  while ((node = walker.nextNode())) if (node.textContent?.trim()) nodes.push(node as Text)
  // Choose the predominant text size to skip a larger title before the first body sentence.
  const sizes = nodes.map(item => getComputedStyle(item.parentElement!).fontSize)
  const weights = new Map<string, number>()
  nodes.forEach((item, index) => weights.set(sizes[index], (weights.get(sizes[index]) ?? 0) + item.length))
  const bodySize = [...weights].sort((a, b) => b[1] - a[1])[0]?.[0]
  const start = Math.max(0, sizes.findIndex(size => size === bodySize))
  const body = nodes.slice(start)
  // Select actual PDF.js text fragments; never insert synthetic sample text into the page.
  const joined = body.map(item => item.textContent).join('')
  const sentenceEnd = joined.search(/[。！？.!?]/)
  const length = sentenceEnd >= 0 ? sentenceEnd + 1 : Math.min(joined.length, 120)
  if (!body.length || !length) return
  let remaining = length, end = body[0], offset = 0
  for (const item of body) {
    end = item; offset = Math.min(remaining, item.length); remaining -= offset
    if (!remaining) break
  }
  end.parentElement?.scrollIntoView({ block: 'center', inline: 'end', behavior: 'instant' })
  await settle(signal)
  const range = document.createRange()
  range.setStart(body[0], 0); range.setEnd(end, offset)
  const selection = window.getSelection()
  selection?.removeAllRanges(); selection?.addRange(range)
  ownsSelection = true
  // The reader's real keyup handler captures the selection without applying an annotation tool.
  target('pdf-viewport')?.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }))
}
export function clearSelection(): void {
  if (!ownsSelection) return
  window.getSelection()?.removeAllRanges()
  target('pdf-viewport')?.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }))
  ownsSelection = false
}
