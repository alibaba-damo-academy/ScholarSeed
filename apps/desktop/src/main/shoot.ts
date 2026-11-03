import type { BrowserWindow } from 'electron'
import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { waitForWorkspaceReady, workspaceReady } from './workspace-ready'

type LogSink = (line: string) => void

/**
 * 默认截图场景。
 *
 * 前七个是 0.1 对话页；其余是 0.2 工作台。两者同列一表而不分两个入口：
 * 验收时需要一次拿到全部界面证据，分两次跑容易漏掉一半。
 *
 * 新增场景 = 在 App.tsx 的 SCENES 里加一个键 + 这里加一行。
 */
const DEFAULT_SCENES = [
  // 0.1 对话页
  'main',
  'workspace-menu',
  'account-menu',
  'sidebar-collapsed',
  'workspace-files',
  'skills',
  'composer-multiline',
  'settings',
  'settings-models',
  'settings-files',
  // 'settings-shortcuts', // 暂时随「键盘快捷键」页面隐藏。
  'settings-developer',
  'settings-skills',
  'settings-about',
  // 0.2 工作台：四区外壳与两个主题域
  'resource',
  'workbench-blank',
  'literature',
  'panel-collapsed',
  // 资料库动作（PRD「资料管理」）
  'resource-menu',
  'resource-new-doc',
  'resource-move',
  'resource-delete',
  'resource-import',
  'resource-import-conflict',
  // 文献库（PRD「文献导入」「批量操作」「详情」）
  'literature-import-menu',
  'literature-batch',
  'literature-detail',
  'literature-notes',
  'literature-collection-new',
  'literature-row-menu',
  'literature-filter',
  // AI 面板（PRD「上下文附加」「多会话」）
  'ai-panel',
  'ai-context',
  'ai-session-menu',
  // 预览与编辑（PRD「文件预览」）
  'markdown-render',
  'table',
  'code',
  'docx-pending',
  // 跨域能力
  'global-search',
  'review',
  'writing',
  'theme-light'
]
const SHOOT_SCENES_ENV = 'SCHOLARSEED_SHOOT_SCENES'
/**
 * 需要一次真实点击才能出现的场景。
 *
 * 浮层 (Popover/Menu) 锚定触发器定位，仅靠 state 打开会拿到没有定位的内容，
 * 拍出来的是错位证据。这里登记「场景 -> 触发器 selector」，由 harness 真实点击。
 */
const SCENE_CLICKS: Record<string, { ready: string; trigger: string }> = {
  'ai-session-menu': {
    ready: '[data-testid="ai-session-flyout"]',
    trigger: '[data-testid="ai-session-toggle"]'
  }
}
/** 点击后等浮层真正上屏的超时；浮层内列表还要拉会话，再给一段稳定时间。 */
const SCENE_CLICK_READY_TIMEOUT_MS = 10_000
const SCENE_CLICK_SETTLE_MS = 700
const LIVE_TURN_TIMEOUT_ENV = 'SCHOLARSEED_LIVE_TURN_TIMEOUT_MS'
const LIVE_TURN_DEFAULT_TIMEOUT_MS = 600_000
const LIVE_TURN_POLL_MS = 1_000
const LIVE_TURN_IDLE_STABLE_MS = 3_000
const LIVE_TURN_PROGRESS_CAPTURE_MS = 20_000
const RUNTIME_PREFLIGHT_TIMEOUT_MS = 20_000
const PACKAGED_SNAPSHOT_DIR = 'scholarseed-desktop-snapshot'
const AUTOMATED_HIL_ANSWER = '自动化验收回答'
// 场景开拍前等待工作台真正 hydrate 完成。固定延时在冷启动 (后端刚起、
// 会话目录还在拉) 时会拍到 loading 卡片，得到无效证据。
const WORKSPACE_READY_TIMEOUT_MS = 60_000
const WORKSPACE_READY_POLL_MS = 500
const MODE_PANEL_READY_TIMEOUT_MS = 10_000
const MODE_CHECK_PERMISSION = 'ask'

function shotDir(): string {
  if (app.isPackaged) {
    const dir = join(app.getPath('temp'), PACKAGED_SNAPSHOT_DIR)
    mkdirSync(dir, { recursive: true })
    return dir
  }
  const repoRoot = process.env.SCHOLARSEED_REPO || resolve(app.getAppPath(), '..', '..')
  const dir = join(repoRoot, 'tmp', 'test_snapshot', 'desktop')
  mkdirSync(dir, { recursive: true })
  return dir
}

function liveTurnTimeoutMs(): number {
  const value = Number.parseInt(process.env[LIVE_TURN_TIMEOUT_ENV] || '', 10)
  return Number.isFinite(value) && value > 0 ? value : LIVE_TURN_DEFAULT_TIMEOUT_MS
}

async function settle(ms: number): Promise<void> {
  await new Promise((done) => setTimeout(done, ms))
}

async function capture(
  win: BrowserWindow,
  dir: string,
  name: string,
  log: LogSink
): Promise<void> {
  const image = await win.webContents.capturePage()
  const path = join(dir, `${name}.png`)
  writeFileSync(path, image.toPNG())
  log(`[desktop] wrote ${path}\n`)
}

async function clickSelector(win: BrowserWindow, selector: string): Promise<boolean> {
  return Boolean(await win.webContents.executeJavaScript(`
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)})
      if (!(element instanceof HTMLElement)) return false
      element.click()
      return true
    })()
  `))
}

async function waitForSelector(
  win: BrowserWindow,
  selector: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await win.webContents.executeJavaScript(
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`
    ).catch(() => false)
    if (found === true) return true
    await settle(WORKSPACE_READY_POLL_MS)
  }
  return false
}

function exitWithFailure(): void {
  process.exitCode = 1
  app.exit(1)
}

async function typeIntoComposer(win: BrowserWindow, message: string): Promise<boolean> {
  return Boolean(await win.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('[data-testid="composer-input"]')
      if (!(input instanceof HTMLTextAreaElement)) return false
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      )?.set
      setter?.call(input, ${JSON.stringify(message)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()
  `))
}

async function drivePendingHil(win: BrowserWindow, log: LogSink): Promise<boolean> {
  const result = String(await win.webContents.executeJavaScript(`
    (() => {
      const card = document.querySelector(
        '[data-testid="hil-card"][data-hil-resolved="false"]'
      )
      if (!(card instanceof HTMLElement)) return 'none'
      if (card.dataset.hilKind === 'question') {
        const optionButtons = Array.from(
          card.querySelectorAll('[data-testid^="hil-question-option-"]')
        ).filter((element) => element.getAttribute('data-testid')?.endsWith('-0'))
        optionButtons.forEach((element) => {
          if (element instanceof HTMLButtonElement) element.click()
        })
        card.querySelectorAll('[data-testid^="hil-question-text-"]').forEach((element) => {
          if (!(element instanceof HTMLTextAreaElement)) return
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype,
            'value'
          )?.set
          setter?.call(element, ${JSON.stringify(AUTOMATED_HIL_ANSWER)})
          element.dispatchEvent(new Event('input', { bubbles: true }))
        })
        const confirm = card.querySelector('[data-testid="hil-question-confirm"]')
        if (confirm instanceof HTMLButtonElement) confirm.click()
        return 'question'
      }
      const allow = card.querySelector('button[data-hil-decision="allow-once"]')
        || card.querySelector('button[data-testid^="hil-permission-"]')
      if (allow instanceof HTMLButtonElement) allow.click()
      return allow ? 'permission' : 'missing-action'
    })()
  `))
  if (result !== 'none') log(`[live] drove HIL kind=${result}\n`)
  return result !== 'none'
}

async function liveStatus(win: BrowserWindow): Promise<{
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
} | null> {
  return win.webContents.executeJavaScript(`
    window.__scholarseedLiveTurnStatus ? window.__scholarseedLiveTurnStatus() : null
  `) as Promise<{
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
  } | null>
}

async function waitForRuntimePreflight(win: BrowserWindow): Promise<{
  known: boolean
  ready: boolean
}> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < RUNTIME_PREFLIGHT_TIMEOUT_MS) {
    const status = await liveStatus(win)
    if (status?.runtimeReadinessKnown) {
      return { known: true, ready: status.runtimeReady }
    }
    await settle(LIVE_TURN_POLL_MS)
  }
  return { known: false, ready: false }
}

async function waitForLiveTurn(
  win: BrowserWindow,
  dir: string,
  log: LogSink
): Promise<'idle' | 'timeout'> {
  const startedAt = Date.now()
  let idleSince: number | null = null
  let progressCaptured = false
  let hilCaptured = false
  let previousStatus = ''
  while (Date.now() - startedAt < liveTurnTimeoutMs()) {
    const status = await liveStatus(win)
    const statusKey = JSON.stringify(status)
    if (statusKey !== previousStatus) {
      previousStatus = statusKey
      log(`[live] state=${statusKey}\n`)
    }
    if (!hilCaptured && status?.hilPending) {
      hilCaptured = true
      await capture(win, dir, 'live-turn-hil', log)
    }
    await drivePendingHil(win, log)
    const elapsed = Date.now() - startedAt
    if (!progressCaptured && elapsed >= LIVE_TURN_PROGRESS_CAPTURE_MS) {
      progressCaptured = true
      await capture(win, dir, 'live-turn-progress', log)
    }
    const complete = Boolean(
      status?.activeSession && !status.running && status.conversationLength >= 2
    )
    if (complete) {
      idleSince ??= Date.now()
      if (Date.now() - idleSince >= LIVE_TURN_IDLE_STABLE_MS) return 'idle'
    } else {
      idleSince = null
    }
    await settle(LIVE_TURN_POLL_MS)
  }
  return 'timeout'
}

async function fetchLatestMode(win: BrowserWindow): Promise<{
  mode: string
  pre: string | null
} | null> {
  const raw = String(await win.webContents.executeJavaScript(`
    (async () => {
      const apiBase = window.scholarseed.getApiBase()
      const sessionId = window.__scholarseedLiveTurnStatus?.().activeSession || ''
      if (!sessionId) return ''
      const response = await fetch(
        apiBase + '/api/serve/sessions/' + sessionId + '/mode'
      )
      if (!response.ok) return ''
      const mode = await response.json()
      return JSON.stringify({ mode: mode.mode, pre: mode.pre_plan_mode ?? null })
    })()
  `))
  if (!raw) return null
  return JSON.parse(raw) as { mode: string; pre: string | null }
}

export async function runShoot(win: BrowserWindow, log: LogSink): Promise<number> {
  // A hidden Windows surface can retain its loading frame after DOM hydration.
  // Exercise a real rendered window without taking focus from the user.
  win.showInactive()
  const dir = shotDir()
  const requested = String(process.env[SHOOT_SCENES_ENV] || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  const scenes = requested.length ? requested : DEFAULT_SCENES
  const ready = async (): Promise<boolean> =>
    waitForWorkspaceReady(
      () => workspaceReady(win.webContents),
      WORKSPACE_READY_TIMEOUT_MS,
      WORKSPACE_READY_POLL_MS
    )
  if (!(await ready())) {
    await capture(win, dir, 'workspace-not-ready', log)
    log('[shoot] FAIL workspace not ready before timeout\n')
    return 1
  }
  await settle(1_500)
  for (const scene of scenes) {
    win.webContents.send('scholarseed:shoot-scene', scene)
    await settle(900)
    const sceneClick = SCENE_CLICKS[scene]
    if (sceneClick) {
      const clicked = await clickSelector(win, sceneClick.trigger)
      if (!clicked) log(`[shoot] scene ${scene}: missing click target ${sceneClick.trigger}\n`)
      else await waitForSelector(win, sceneClick.ready, SCENE_CLICK_READY_TIMEOUT_MS)
      await settle(SCENE_CLICK_SETTLE_MS)
    }
    if (!(await ready())) {
      await capture(win, dir, 'workspace-not-ready', log)
      log(`[shoot] FAIL workspace not ready for scene ${scene}\n`)
      return 1
    }
    await capture(win, dir, scene, log)
  }
  log('[shoot] done\n')
  return 0
}

export async function runModeCheck(win: BrowserWindow, log: LogSink): Promise<void> {
  const dir = shotDir()
  await settle(3_200)
  const preflight = await waitForRuntimePreflight(win)
  if (!preflight.ready) {
    await capture(win, dir, 'mode-runtime-blocked', log)
    log(`[mode-check] FAIL Codex runtime preflight known=${preflight.known} ready=${preflight.ready}\n`)
    exitWithFailure()
    return
  }
  await capture(win, dir, 'mode-home', log)
  await clickSelector(win, '[data-testid="topbar-ai"]')
  const panelReady = await waitForSelector(
    win,
    '[data-testid="mode-chip"]',
    MODE_PANEL_READY_TIMEOUT_MS
  )
  if (!panelReady) {
    log('[mode-check] FAIL AI panel composer did not become ready\n')
    await capture(win, dir, 'mode-panel-blocked', log)
    exitWithFailure()
    return
  }
  await clickSelector(win, '[data-testid="mode-chip"]')
  const modeSelected = await clickSelector(
    win,
    `[data-testid="mode-${MODE_CHECK_PERMISSION}"]`
  )
  const typed = await typeIntoComposer(
    win,
    '请说明当前权限模式，不要执行工具'
  )
  const sent = modeSelected && typed && await clickSelector(win, '[data-testid="composer-send"]')
  log(`[mode-check] selected=${modeSelected} composer typed=${typed} sent=${sent}\n`)
  let mode: { mode: string; pre: string | null } | null = null
  for (let waited = 0; waited < 20_000 && !mode; waited += 2_000) {
    await settle(2_000)
    mode = await fetchLatestMode(win)
  }
  const passed = Boolean(modeSelected && typed && sent && mode?.mode === MODE_CHECK_PERMISSION)
  log(`[mode-check] ${passed ? 'PASS' : 'FAIL'} permission-first-turn selected=${modeSelected} typed=${typed} sent=${sent} mode=${mode?.mode}\n`)
  await capture(win, dir, 'mode-permission-turn', log)
  if (!passed) {
    exitWithFailure()
    return
  }
  app.quit()
}

export async function runLiveTurn(
  win: BrowserWindow,
  message: string,
  log: LogSink
): Promise<void> {
  const dir = shotDir()
  await settle(3_200)
  const preflight = await waitForRuntimePreflight(win)
  if (!preflight.ready) {
    await capture(win, dir, 'live-runtime-blocked', log)
    log(`[live] failed: Codex runtime preflight known=${preflight.known} ready=${preflight.ready}\n`)
    process.exitCode = 1
    app.quit()
    return
  }
  win.webContents.send('scholarseed:say', message)
  log(`[live] sent turn: ${message}\n`)
  await settle(800)
  const initial = await liveStatus(win)
  if (initial?.runtimeReadinessKnown && !initial.runtimeReady && !initial.activeSession) {
    await capture(win, dir, 'live-runtime-blocked', log)
    log('[live] failed: Codex runtime preflight blocked the turn\n')
    process.exitCode = 1
    app.quit()
    return
  }
  const outcome = await waitForLiveTurn(win, dir, log)
  await capture(win, dir, outcome === 'idle' ? 'live-turn-final' : 'live-turn-timeout', log)
  log(`[live] done outcome=${outcome}\n`)
  if (outcome === 'timeout') throw new Error('live desktop turn did not settle')
  app.quit()
}
