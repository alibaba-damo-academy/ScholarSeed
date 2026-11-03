import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { BROWSER_ERROR, BROWSER_FRAME_ACK_CHANNEL, BROWSER_FRAME_CHANNEL, BROWSER_FRAME_INPUT_CHANNEL, BROWSER_FRAME_RESIZE_CHANNEL } from '../browser.ts'
import type { BrowserFrame, BrowserFrameInput, BrowserFrameReply } from '../browser.ts'
import type { ChromiumFrame, ChromiumTargets } from './chromiumtarget.ts'

const MAX_VIEWPORT_EDGE = 4096
const MAX_FRAME_DATA_LENGTH = 6 * 1024 * 1024
const MAX_TEXT_LENGTH = 4096
const MAX_KEY_LENGTH = 64
const MAX_WHEEL_DELTA = 4096
const MAX_CLICK_COUNT = 3
const MAX_KEY_MODIFIERS = 15
const MAX_VIRTUAL_KEY_CODE = 255

interface ActivePage { tabId: string; targetId: string }
interface BrowserFrameOwners {
  contents(): WebContents | null
  targets(): Pick<ChromiumTargets, 'onFrame' | 'acknowledgeFrame' | 'resize' | 'input'> | null
  active(): ActivePage | null
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function viewportEdge(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= MAX_VIEWPORT_EDGE
}

function inputValid(value: unknown): value is BrowserFrameInput {
  if (!record(value)) return false
  if (value.kind === 'mouse' || value.kind === 'wheel') {
    if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return false
    if (value.kind === 'wheel') return keys(value, ['kind', 'x', 'y', 'deltaX', 'deltaY']) &&
      Number.isFinite(value.deltaX) && Number.isFinite(value.deltaY) &&
      Math.abs(Number(value.deltaX)) <= MAX_WHEEL_DELTA && Math.abs(Number(value.deltaY)) <= MAX_WHEEL_DELTA
    return keys(value, ['kind', 'type', 'x', 'y', 'button', 'clickCount']) &&
      ['mouseMoved', 'mousePressed', 'mouseReleased'].includes(String(value.type)) &&
      ['none', 'left', 'middle', 'right'].includes(String(value.button)) &&
      (value.clickCount === undefined || Number.isInteger(value.clickCount) && Number(value.clickCount) >= 1 && Number(value.clickCount) <= MAX_CLICK_COUNT)
  }
  if (value.kind === 'key') return keys(value, ['kind', 'type', 'key', 'code', 'windowsVirtualKeyCode', 'modifiers']) &&
    ['keyDown', 'keyUp', 'char'].includes(String(value.type)) &&
    typeof value.key === 'string' && value.key.length > 0 && value.key.length <= MAX_KEY_LENGTH &&
    typeof value.code === 'string' && value.code.length > 0 && value.code.length <= MAX_KEY_LENGTH &&
    Number.isInteger(value.windowsVirtualKeyCode) && Number(value.windowsVirtualKeyCode) >= 0 && Number(value.windowsVirtualKeyCode) <= MAX_VIRTUAL_KEY_CODE &&
    (value.modifiers === undefined || Number.isInteger(value.modifiers) && Number(value.modifiers) >= 0 && Number(value.modifiers) <= MAX_KEY_MODIFIERS)
  if (value.kind === 'text') return keys(value, ['kind', 'text']) && typeof value.text === 'string' && value.text.length > 0 && value.text.length <= MAX_TEXT_LENGTH
  if (value.kind !== 'composition') return false
  if (value.phase === 'cancel') return keys(value, ['kind', 'phase'])
  if (value.phase === 'commit') return keys(value, ['kind', 'phase', 'text']) && typeof value.text === 'string' && value.text.length > 0 && value.text.length <= MAX_TEXT_LENGTH
  return (value.phase === 'begin' || value.phase === 'update') &&
    keys(value, ['kind', 'phase', 'text', 'selectionStart', 'selectionEnd']) &&
    typeof value.text === 'string' && value.text.length > 0 && value.text.length <= MAX_TEXT_LENGTH &&
    Number.isInteger(value.selectionStart) && Number.isInteger(value.selectionEnd) &&
    Number(value.selectionStart) >= 0 && Number(value.selectionEnd) >= Number(value.selectionStart) && Number(value.selectionEnd) <= value.text.length
}

export function registerBrowserFrameIpc(ipc: Pick<IpcMain, 'handle'>, owners: BrowserFrameOwners): () => void {
  let pending: { tabId: string; targetId: string; sequence: number } | null = null
  let lastSequence = 0
  let previousTarget: string | null = null
  let viewport: { width: number; height: number } | null = null
  let frameSource: ReturnType<BrowserFrameOwners['targets']> = null
  let detach: (() => void) | undefined
  const attach = (targets: ReturnType<BrowserFrameOwners['targets']>): void => {
    if (targets === frameSource) return
    detach?.()
    frameSource = targets
    pending = null
    viewport = null
    detach = targets?.onFrame(frame => onFrame(frame, targets))
  }
  const current = (): ActivePage | null => {
    const active = owners.active()
    if (active?.targetId !== previousTarget) {
      previousTarget = active?.targetId ?? null
      pending = null
      lastSequence = 0
      viewport = null
    }
    return active
  }
  const validateSender = (event: IpcMainInvokeEvent): void => {
    const contents = owners.contents()
    if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame) throw new Error(BROWSER_ERROR.invalidSender)
  }
  const resolve = (value: unknown): { active: ActivePage; targets: NonNullable<ReturnType<BrowserFrameOwners['targets']>> } | null => {
    if (!record(value) || typeof value.tabId !== 'string' || !value.tabId) return null
    const active = current()
    const targets = owners.targets()
    return active && targets && active.tabId === value.tabId ? { active, targets } : null
  }
  const execute = async (event: IpcMainInvokeEvent, value: unknown, action: (request: Record<string, unknown>, active: ActivePage, targets: NonNullable<ReturnType<BrowserFrameOwners['targets']>>) => Promise<void>): Promise<BrowserFrameReply> => {
    validateSender(event)
    const resolved = resolve(value)
    if (!resolved || !record(value)) return { ok: false, error: BROWSER_ERROR.invalidCommand }
    try { attach(resolved.targets); await action(value, resolved.active, resolved.targets); return { ok: true } }
    catch (error) { return { ok: false, error: error instanceof Error && error.message === BROWSER_ERROR.invalidCommand ? BROWSER_ERROR.invalidCommand : BROWSER_ERROR.operationFailed } }
  }
  ipc.handle(BROWSER_FRAME_ACK_CHANNEL, (event, ...args: unknown[]) => execute(event, args[0], async (request, active, targets) => {
    if (args.length !== 1 || !keys(request, ['tabId', 'sequence']) || !Number.isSafeInteger(request.sequence) || !pending ||
      pending.tabId !== active.tabId || pending.targetId !== active.targetId || pending.sequence !== request.sequence) throw new Error(BROWSER_ERROR.invalidCommand)
    pending = null
    await targets.acknowledgeFrame(active.targetId, Number(request.sequence))
  }))
  ipc.handle(BROWSER_FRAME_RESIZE_CHANNEL, (event, ...args: unknown[]) => execute(event, args[0], async (request, active, targets) => {
    if (args.length !== 1 || !keys(request, ['tabId', 'width', 'height']) || !viewportEdge(request.width) || !viewportEdge(request.height)) throw new Error(BROWSER_ERROR.invalidCommand)
    const next = { width: request.width, height: request.height }
    viewport = null
    pending = null
    await targets.resize(active.targetId, next)
    viewport = next
  }))
  ipc.handle(BROWSER_FRAME_INPUT_CHANNEL, (event, ...args: unknown[]) => execute(event, args[0], async (request, active, targets) => {
    if (args.length !== 1 || !keys(request, ['tabId', 'input']) || !inputValid(request.input)) throw new Error(BROWSER_ERROR.invalidCommand)
    const input = request.input
    if ((input.kind === 'mouse' || input.kind === 'wheel') && (!viewport || input.x < 0 || input.y < 0 || input.x >= viewport.width || input.y >= viewport.height)) throw new Error(BROWSER_ERROR.invalidCommand)
    await targets.input(active.targetId, input)
  }))
  const onFrame = (frame: ChromiumFrame, source: NonNullable<ReturnType<BrowserFrameOwners['targets']>>): void => {
    const active = current()
    const discard = (): void => {
      void source.acknowledgeFrame(frame.targetId, frame.sequence).catch(error => {
        console.error('[browser-frame] rejected frame acknowledgement failed', error)
      })
    }
    if (source !== frameSource || !active || frame.targetId !== active.targetId || !viewport || pending ||
      !Number.isSafeInteger(frame.sequence) || frame.sequence <= lastSequence ||
      !viewportEdge(frame.width) || !viewportEdge(frame.height) ||
      frame.width > viewport.width || frame.height > viewport.height ||
      typeof frame.data !== 'string' || frame.data.length > MAX_FRAME_DATA_LENGTH ||
      (frame.format !== 'jpeg' && frame.format !== 'png')) { if (!pending) discard(); return }
    const contents = owners.contents()
    if (!contents || contents.isDestroyed()) { discard(); return }
    const visibleFrame: BrowserFrame = { tabId: active.tabId, sequence: frame.sequence, data: frame.data,
      format: frame.format, width: frame.width, height: frame.height }
    const previousSequence = lastSequence
    pending = { tabId: active.tabId, targetId: active.targetId, sequence: frame.sequence }
    lastSequence = frame.sequence
    try {
      contents.send(BROWSER_FRAME_CHANNEL, visibleFrame)
    } catch (error) {
      console.error('[browser-frame] renderer delivery failed', error)
      if (pending?.sequence === frame.sequence && pending.targetId === frame.targetId) pending = null
      lastSequence = previousSequence
      discard()
    }
  }
  attach(owners.targets())
  return () => { detach?.(); frameSource = null; pending = null }
}
