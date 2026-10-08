// drive.ts — interactive multi-turn drive harness (dev tooling, peer of shoot.ts).
//
// `--drive <dir>` keeps the app alive and executes commands appended to
// `<dir>/cmd.jsonl`, one JSON object per line. Every command drives the REAL
// renderer UI (composer typing, real button clicks) against the live backend,
// so an external orchestrator (a human, or an agent deciding the next message
// from what the app actually replied) can hold a genuine multi-turn product
// conversation — nothing is stubbed and no backend call is faked. Results are
// appended to `<dir>/ack.jsonl`; a `hello` line carries the backend apiBase so
// the orchestrator can read transcripts/state over the public HTTP API.
//
// Command reference (one JSON object per line):
//   {"op":"say","text":"..."}          type into the real composer + click send
//   {"op":"attach","path":"/...","testid":"..."} choose a local file through a real file input
//   {"op":"fill","selector":"...","text":"..."}  set any input/textarea (real events)
//   {"op":"type","selector":"...","text":"..."}  focus/select/type through Chromium (honours maxLength)
//   {"op":"append","selector":"...","text":"..."} append to an input/textarea (real events)
//   {"op":"press","text":"Enter"}      press Enter / Escape / Tab in the focused control
//   {"op":"value","selector":"..."}   read an input's value and maxLength
//   {"op":"select_text","selector":"...","text":"..."} select visible text and dispatch mouseup
//   {"op":"click","testid":"..."}      click [data-testid=...]
//   {"op":"click_frame","frame_testid":"...","testid":"..."} click a control inside an iframe
//   {"op":"dblclick","testid":"..."}   double-click [data-testid=...]
//   {"op":"contextmenu","testid":"..."} dispatch a real right-click menu event
//   {"op":"hover","testid":"..."}      hover [data-testid=...] for submenu flows
//   {"op":"click_text","text":"..."}   click the first button whose text contains
//   {"op":"click_label","text":"..."}  click the button containing an exact label span
//   {"op":"wait","wait_ms":500}           wait for real asynchronous UI work
//   {"op":"status"}                    {running, hilPending, url} from the live DOM
//   {"op":"text"}                      document.body.innerText (bounded)
//   {"op":"shot","name":"..."}         capturePage → <dir>/shots/<name>.png
//   {"op":"quit"}                      graceful app quit

import type { BrowserWindow } from 'electron'
import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'

type LogSink = (line: string) => void

const CMD_FILE = 'cmd.jsonl'
const ACK_FILE = 'ack.jsonl'
const SHOTS_DIRNAME = 'shots'
const POLL_INTERVAL_MS = 300
const RENDERER_SETTLE_MS = 250
const BODY_TEXT_LIMIT = 20_000
// pending-HIL pill labels rendered by Stream.tsx (permission / question kinds)
const HIL_PENDING_LABELS = ['等待授权', '等待回答']
const RUNNING_TESTID = 'composer-stop'
const COMPOSER_INPUT_TESTID = 'composer-input'
const COMPOSER_SEND_TESTID = 'composer-send'
const COMPOSER_FILE_INPUT_TESTID = 'composer-file-input'
const MAX_DRIVE_WAIT_MS = 10_000
const DEVTOOLS_PROTOCOL_VERSION = '1.3'
const DRIVE_KEYS = new Set(['Enter', 'Escape', 'Tab'])

interface DriveCommand {
  op: string
  text?: string
  selector?: string
  testid?: string
  frame_testid?: string
  name?: string
  path?: string
  wait_ms?: number
}

interface Ack {
  seq: number
  op: string
  ok: boolean
  data?: unknown
  error?: string
}

function settle(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

async function setInputValue(win: BrowserWindow, selector: string, text: string): Promise<boolean> {
  // real controlled-input path: native value setter + input event, same as a user typing
  return Boolean(await win.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      setter?.call(el, ${JSON.stringify(text)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()
  `))
}

async function pressActiveKey(win: BrowserWindow, key: string): Promise<boolean> {
  return Boolean(await win.webContents.executeJavaScript(`
    (() => {
      const target = document.activeElement
      if (!(target instanceof HTMLElement)) return false
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: ${JSON.stringify(key)},
        code: ${JSON.stringify(key)},
        bubbles: true,
        cancelable: true
      }))
      target.dispatchEvent(new KeyboardEvent('keyup', {
        key: ${JSON.stringify(key)},
        code: ${JSON.stringify(key)},
        bubbles: true,
        cancelable: true
      }))
      // Synthetic key events do not run browser defaults. Tab changes focus,
      // and the session title treats Enter as a commit, so preserve those focus
      // semantics explicitly on the public drive surface.
      if (${JSON.stringify(key)} === 'Tab' || ${JSON.stringify(key)} === 'Enter') target.blur()
      return true
    })()
  `))
}

async function appendInputValue(win: BrowserWindow, selector: string, text: string): Promise<boolean> {
  return Boolean(await win.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!(el instanceof HTMLTextAreaElement) && !(el instanceof HTMLInputElement)) return false
      const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      setter?.call(el, el.value + ${JSON.stringify(text)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()
  `))
}

export async function typeInputValue(win: BrowserWindow, selector: string, text: string): Promise<boolean> {
  const target = JSON.parse(String(await win.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!(el instanceof HTMLElement)) return 'null'
      const isFrame = el instanceof HTMLIFrameElement
      const editable = isFrame
        ? el
        : el.matches('input,textarea,[contenteditable="true"]')
          ? el
          : el.querySelector('input,textarea,[contenteditable="true"]')
      if (!(editable instanceof HTMLElement)) return 'null'
      const editableRect = editable.getBoundingClientRect()
      const clickRect = isFrame || el === editable ? editableRect : el.getBoundingClientRect()
      editable.focus()
      if (editable instanceof HTMLTextAreaElement || editable instanceof HTMLInputElement) editable.select()
      return JSON.stringify({
        x: Math.round(clickRect.left + Math.min(Math.max(clickRect.width / 3, 24), 180)),
        y: Math.round(clickRect.top + Math.min(Math.max(clickRect.height / 2, 48), 360)),
        isFrame
      })
    })()
  `))) as { x: number; y: number; isFrame: boolean } | null
  if (!target) return false
  win.webContents.sendInputEvent({ type: 'mouseMove', ...target })
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...target })
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...target })
  const debuggerApi = win.webContents.debugger
  const attachedHere = !debuggerApi.isAttached()
  if (attachedHere) debuggerApi.attach(DEVTOOLS_PROTOCOL_VERSION)
  try {
    // CDP's Input domain follows Chromium's native editing path and emits the
    // beforeinput/input sequence consumed by React-controlled fields.
    await debuggerApi.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      modifiers: 4
    })
    await debuggerApi.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      modifiers: 4
    })
    await debuggerApi.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Backspace',
      code: 'Backspace'
    })
    await debuggerApi.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Backspace',
      code: 'Backspace'
    })
    if (target.isFrame) {
      await debuggerApi.sendCommand('Input.dispatchKeyEvent', {
        type: 'char',
        key: text,
        text
      })
    } else {
      await debuggerApi.sendCommand('Input.insertText', { text })
    }
    return true
  } finally {
    if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach()
  }
}

async function readInputValue(
  win: BrowserWindow,
  selector: string
): Promise<{ value: string; maxLength: number } | null> {
  const raw = String(await win.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!(el instanceof HTMLTextAreaElement) && !(el instanceof HTMLInputElement)) return 'null'
      return JSON.stringify({ value: el.value, maxLength: el.maxLength })
    })()
  `))
  return JSON.parse(raw) as { value: string; maxLength: number } | null
}

async function selectText(win: BrowserWindow, selector: string, text: string): Promise<boolean> {
  return Boolean(await win.webContents.executeJavaScript(`
    (() => {
      const root = document.querySelector(${JSON.stringify(selector)})
      const wanted = ${JSON.stringify(text)}
      if (!root || !wanted) return false
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node && !(node.textContent || '').includes(wanted)) node = walker.nextNode()
      if (!node) return false
      const start = (node.textContent || '').indexOf(wanted)
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + wanted.length)
      const selection = window.getSelection()
      if (!selection) return false
      selection.removeAllRanges()
      selection.addRange(range)
      node.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' })
      root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      return true
    })()
  `))
}

async function clickTestid(win: BrowserWindow, testid: string): Promise<boolean> {
  const position = await testidPosition(win, testid)
  if (!position) return false
  win.webContents.sendInputEvent({ type: 'mouseMove', ...position })
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...position })
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...position })
  return true
}

async function clickFrameTestid(
  win: BrowserWindow,
  frameTestid: string,
  testid: string
): Promise<boolean> {
  if (!await testidPosition(win, frameTestid)) return false
  const debuggerApi = win.webContents.debugger
  const attachedHere = !debuggerApi.isAttached()
  if (attachedHere) debuggerApi.attach(DEVTOOLS_PROTOCOL_VERSION)
  try {
    await debuggerApi.sendCommand('DOM.enable')
    const document = await debuggerApi.sendCommand('DOM.getFlattenedDocument', {
      depth: -1,
      pierce: true
    }) as { nodes?: Array<{ nodeId: number; attributes?: string[] }> }
    const node = document.nodes?.find((candidate) => {
      const attributes = candidate.attributes ?? []
      const index = attributes.indexOf('data-testid')
      return index >= 0 && attributes[index + 1] === testid
    })
    if (!node) return false
    const model = await debuggerApi.sendCommand('DOM.getBoxModel', { nodeId: node.nodeId }) as {
      model?: { content?: number[] }
    }
    const quad = model.model?.content
    if (!quad || quad.length < 8) return false
    const x = Math.round((quad[0] + quad[2] + quad[4] + quad[6]) / 4)
    const y = Math.round((quad[1] + quad[3] + quad[5] + quad[7]) / 4)
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    return true
  } catch (error) {
    throw new Error(`embedded control click failed: ${String(error)}`)
  } finally {
    if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach()
  }
}

async function testidPosition(
  win: BrowserWindow,
  testid: string
): Promise<{ x: number; y: number } | null> {
  const raw = String(await win.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector('[data-testid=' + ${JSON.stringify(JSON.stringify(testid))} + ']')
      if (!el) return 'null'
      el.scrollIntoView({ block: 'center', inline: 'nearest' })
      const rect = el.getBoundingClientRect()
      return JSON.stringify({
        x: Math.round(rect.left + Math.min(rect.width / 2, 24)),
        y: Math.round(rect.top + Math.min(rect.height / 2, 12))
      })
    })()
  `))
  return JSON.parse(raw) as { x: number; y: number } | null
}

async function hoverTestid(win: BrowserWindow, testid: string): Promise<boolean> {
  const position = await testidPosition(win, testid)
  if (!position) return false
  win.webContents.sendInputEvent({ type: 'mouseMove', ...position })
  return true
}

async function doubleClickTestid(win: BrowserWindow, testid: string): Promise<boolean> {
  const position = await testidPosition(win, testid)
  if (!position) return false
  win.webContents.sendInputEvent({ type: 'mouseMove', ...position })
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...position })
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...position })
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 2, ...position })
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 2, ...position })
  return true
}

async function dispatchTestidMouse(
  win: BrowserWindow,
  testid: string,
  eventType: 'contextmenu'
): Promise<boolean> {
  return Boolean(await win.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector('[data-testid=' + ${JSON.stringify(JSON.stringify(testid))} + ']')
      if (!el) return false
      const rect = el.getBoundingClientRect()
      el.dispatchEvent(new MouseEvent(${JSON.stringify(eventType)}, {
        bubbles: true,
        cancelable: true,
        button: 2,
        buttons: 2,
        detail: 1,
        clientX: rect.left + Math.min(rect.width / 2, 24),
        clientY: rect.top + Math.min(rect.height / 2, 12)
      }))
      return true
    })()
  `))
}

async function clickButtonText(win: BrowserWindow, text: string): Promise<boolean> {
  return Boolean(await win.webContents.executeJavaScript(`
    (() => {
      const wanted = ${JSON.stringify(text)}
      const buttons = Array.from(document.querySelectorAll('button'))
      const match = buttons.find((b) => (b.textContent || '').includes(wanted))
      if (!match) return false
      match.click()
      return true
    })()
  `))
}

async function clickButtonLabel(win: BrowserWindow, label: string): Promise<boolean> {
  return Boolean(await win.webContents.executeJavaScript(`
    (() => {
      const wanted = ${JSON.stringify(label)}
      const buttons = Array.from(document.querySelectorAll('button'))
      const match = buttons.find((button) =>
        Array.from(button.querySelectorAll('span')).some((span) => (span.textContent || '').trim() === wanted)
      )
      if (!match) return false
      match.click()
      return true
    })()
  `))
}

async function attachFile(win: BrowserWindow, path: string, testid: string): Promise<boolean> {
  if (!path || !existsSync(path)) return false
  const debuggerApi = win.webContents.debugger
  const attachedHere = !debuggerApi.isAttached()
  if (attachedHere) debuggerApi.attach(DEVTOOLS_PROTOCOL_VERSION)
  try {
    const document = await debuggerApi.sendCommand('DOM.getDocument', {
      depth: -1,
      pierce: true
    }) as { root?: { nodeId?: number } }
    const rootNodeId = document.root?.nodeId
    if (!rootNodeId) return false
    const query = await debuggerApi.sendCommand('DOM.querySelector', {
      nodeId: rootNodeId,
      selector: `[data-testid="${testid}"]`
    }) as { nodeId?: number }
    if (!query.nodeId) return false
    await debuggerApi.sendCommand('DOM.setFileInputFiles', {
      files: [path],
      nodeId: query.nodeId
    })
    await win.webContents.executeJavaScript(`
      document.querySelector('[data-testid=' + ${JSON.stringify(JSON.stringify(testid))} + ']')
        ?.dispatchEvent(new Event('change', { bubbles: true }))
    `)
    await settle(RENDERER_SETTLE_MS)
    return true
  } finally {
    if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach()
  }
}

async function readStatus(win: BrowserWindow): Promise<{
  activeSession: string | null
  runtimeId: 'codex' | null
  running: boolean
  status: string | null
  lastSeq: number
  conversationLength: number
  todoCount: number
  artifactCount: number
  hilPending: boolean
  runtimeReadinessKnown: boolean
  runtimeReady: boolean
  sidebarRunning: boolean
  sidebarWaiting: boolean
  sidebarDone: boolean
  url: string
}> {
  const raw = String(await win.webContents.executeJavaScript(`
    (() => {
      const live = window.__scholarseedLiveTurnStatus?.() || {}
      const running = typeof live.running === 'boolean'
        ? live.running
        : Boolean(document.querySelector('[data-testid="${RUNNING_TESTID}"]'))
      const body = document.body.innerText || ''
      const hilPending = typeof live.hilPending === 'boolean'
        ? live.hilPending
        : ${JSON.stringify(HIL_PENDING_LABELS)}.some((label) => body.includes(label))
      return JSON.stringify({
        activeSession: live.activeSession || null,
        runtimeId: live.runtimeId || null,
        running,
        status: live.status || null,
        lastSeq: Number(live.lastSeq || 0),
        conversationLength: Number(live.conversationLength || 0),
        todoCount: Number(live.todoCount || 0),
        artifactCount: Number(live.artifactCount || 0),
        hilPending,
        runtimeReadinessKnown: live.runtimeReadinessKnown === true,
        runtimeReady: live.runtimeReady === true,
        sidebarRunning: Boolean(document.querySelector('.sidebar-status-spin')),
        sidebarWaiting: Boolean(document.querySelector('.sidebar-status-waiting')),
        sidebarDone: Boolean(document.querySelector('.sidebar-status-dot')),
        url: window.location.href
      })
    })()
  `))
  return JSON.parse(raw) as {
    activeSession: string | null
    runtimeId: 'codex' | null
    running: boolean
    status: string | null
    lastSeq: number
    conversationLength: number
    todoCount: number
    artifactCount: number
    hilPending: boolean
    runtimeReadinessKnown: boolean
    runtimeReady: boolean
    sidebarRunning: boolean
    sidebarWaiting: boolean
    sidebarDone: boolean
    url: string
  }
}

async function readBodyText(win: BrowserWindow): Promise<string> {
  return String(await win.webContents.executeJavaScript(
    `(document.body.innerText || '').slice(0, ${BODY_TEXT_LIMIT})`
  ))
}

export async function runDrive(win: BrowserWindow, driveDir: string, apiBase: string, log: LogSink): Promise<void> {
  mkdirSync(driveDir, { recursive: true })
  const shotsDir = join(driveDir, SHOTS_DIRNAME)
  mkdirSync(shotsDir, { recursive: true })
  const cmdPath = join(driveDir, CMD_FILE)
  const ackPath = join(driveDir, ACK_FILE)
  if (!existsSync(cmdPath)) writeFileSync(cmdPath, '')
  writeFileSync(ackPath, '')

  const ack = (a: Ack): void => {
    appendFileSync(ackPath, JSON.stringify(a) + '\n')
  }
  ack({ seq: 0, op: 'hello', ok: true, data: { apiBase, shotsDir } })
  log(`[drive] ready — watching ${cmdPath} (apiBase=${apiBase})\n`)

  let offset = 0
  let seq = 0
  let quitting = false

  const runCommand = async (cmd: DriveCommand): Promise<Ack> => {
    seq += 1
    const base = { seq, op: cmd.op }
    try {
      switch (cmd.op) {
        case 'say': {
          const typed = await setInputValue(win, `[data-testid="${COMPOSER_INPUT_TESTID}"]`, String(cmd.text ?? ''))
          await settle(RENDERER_SETTLE_MS)
          const sent = typed && (await clickTestid(win, COMPOSER_SEND_TESTID))
          return { ...base, ok: Boolean(sent), data: { typed, sent } }
        }
        case 'attach': {
          const path = String(cmd.path ?? '')
          const testid = String(cmd.testid ?? COMPOSER_FILE_INPUT_TESTID)
          const attached = await attachFile(win, path, testid)
          return { ...base, ok: attached, data: { path, testid, attached } }
        }
        case 'fill': {
          const done = await setInputValue(win, String(cmd.selector ?? ''), String(cmd.text ?? ''))
          return { ...base, ok: done }
        }
        case 'type': {
          const done = await typeInputValue(win, String(cmd.selector ?? ''), String(cmd.text ?? ''))
          return { ...base, ok: done }
        }
        case 'append': {
          const done = await appendInputValue(win, String(cmd.selector ?? ''), String(cmd.text ?? ''))
          return { ...base, ok: done }
        }
        case 'press': {
          const key = String(cmd.text ?? '')
          if (!DRIVE_KEYS.has(key)) return { ...base, ok: false, error: `unsupported key: ${key}` }
          const pressed = await pressActiveKey(win, key)
          return { ...base, ok: pressed, data: { key } }
        }
        case 'value': {
          const value = await readInputValue(win, String(cmd.selector ?? ''))
          return { ...base, ok: value !== null, data: value }
        }
        case 'select_text': {
          const selected = await selectText(win, String(cmd.selector ?? ''), String(cmd.text ?? ''))
          return { ...base, ok: selected }
        }
        case 'click': {
          const clicked = await clickTestid(win, String(cmd.testid ?? ''))
          await settle(RENDERER_SETTLE_MS)
          return { ...base, ok: clicked }
        }
        case 'click_frame': {
          const clicked = await clickFrameTestid(
            win,
            String(cmd.frame_testid ?? ''),
            String(cmd.testid ?? '')
          )
          await settle(RENDERER_SETTLE_MS)
          return { ...base, ok: clicked }
        }
        case 'dblclick': {
          const testid = String(cmd.testid ?? '')
          const opened = await doubleClickTestid(win, testid)
          await settle(RENDERER_SETTLE_MS)
          return { ...base, ok: opened }
        }
        case 'contextmenu': {
          const opened = await dispatchTestidMouse(
            win,
            String(cmd.testid ?? ''),
            'contextmenu'
          )
          await settle(RENDERER_SETTLE_MS)
          return { ...base, ok: opened }
        }
        case 'hover': {
          const hovered = await hoverTestid(win, String(cmd.testid ?? ''))
          await settle(RENDERER_SETTLE_MS)
          return { ...base, ok: hovered }
        }
        case 'click_text': {
          const clicked = await clickButtonText(win, String(cmd.text ?? ''))
          return { ...base, ok: clicked }
        }
        case 'click_label': {
          const clicked = await clickButtonLabel(win, String(cmd.text ?? ''))
          return { ...base, ok: clicked }
        }
        case 'wait': {
          const waitMs = Number(cmd.wait_ms)
          if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > MAX_DRIVE_WAIT_MS) {
            return { ...base, ok: false, error: `wait_ms must be between 0 and ${MAX_DRIVE_WAIT_MS}` }
          }
          await settle(waitMs)
          return { ...base, ok: true, data: { waitMs } }
        }
        case 'status': {
          const status = await readStatus(win)
          return { ...base, ok: true, data: status }
        }
        case 'text': {
          const body = await readBodyText(win)
          return { ...base, ok: true, data: { text: body } }
        }
        case 'shot': {
          const name = String(cmd.name ?? `shot-${seq}`)
          const img = await win.webContents.capturePage()
          const out = join(shotsDir, `${name}.png`)
          writeFileSync(out, img.toPNG())
          const status = await readStatus(win)
          return { ...base, ok: true, data: { path: out, capturedAt: new Date().toISOString(), status } }
        }
        case 'quit': {
          quitting = true
          return { ...base, ok: true }
        }
        default:
          return { ...base, ok: false, error: `unknown op: ${cmd.op}` }
      }
    } catch (e) {
      return { ...base, ok: false, error: String(e) }
    }
  }

  while (!quitting) {
    await settle(POLL_INTERVAL_MS)
    if (win.isDestroyed()) break
    let size = 0
    try {
      size = statSync(cmdPath).size
    } catch {
      continue
    }
    if (size <= offset) continue
    // `statSync().size` and `offset` are byte counts. Keep the cursor in bytes
    // too: slicing a decoded JS string with a byte offset corrupts appended
    // Chinese (or any non-ASCII) commands and turns valid JSON into fragments.
    const chunk = readFileSync(cmdPath).subarray(offset).toString('utf8')
    const lastNewline = chunk.lastIndexOf('\n')
    if (lastNewline < 0) continue // partial line — wait for the writer to finish
    const complete = chunk.slice(0, lastNewline + 1)
    offset += Buffer.byteLength(complete, 'utf8')
    for (const line of complete.slice(0, -1).split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let cmd: DriveCommand
      try {
        cmd = JSON.parse(trimmed) as DriveCommand
      } catch (e) {
        seq += 1
        ack({ seq, op: 'parse', ok: false, error: `bad command line: ${String(e)}` })
        continue
      }
      const result = await runCommand(cmd)
      ack(result)
      log(`[drive] #${result.seq} ${result.op} ok=${result.ok}\n`)
      if (quitting) break
    }
  }

  log('[drive] quit\n')
  app.quit()
}
