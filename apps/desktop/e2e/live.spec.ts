import { randomUUID } from 'crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { join, sep } from 'path'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import { expect, test, type Page } from '@playwright/test'
import { WORKSPACE_WINDOW_MINIMUM } from '../src/window'
import { apiBase, DesktopSession, liveStatus, waitForFinishedTurn } from './fixtures/electron'
import { createRuntime, seedLiveConfig, type RuntimePaths } from './fixtures/runtime'
import type { OpenResp } from '../src/renderer/src/api'

const GREETING = '请用一句话确认本次桌面端端到端测试已收到。'
const BRANCH_FIRST_MARKER = 'BRANCH_FIRST_87828014'
const BRANCH_SECOND_MARKER = 'BRANCH_SECOND_87828014'
const BRANCH_EXCLUDED_MARKER = 'BRANCH_EXCLUDED_87828014'
const CONTINUATION_MARKER_FILE = 'continued-task.txt'
const CONTINUATION_MARKER = 'CONTINUED_TASK_COMPLETE'
const CONTINUATION_DRAFT = '这条草稿不应被继续任务按钮发送或清空'
const PROVIDER_MARKER_FILE = 'provider-continuation.txt'
const PROVIDER_MARKER = 'PROVIDER_TOOL_COMPLETED'
const PROVIDER_COMPLETION = 'PROVIDER_CONTINUATION_COMPLETE'
const PROVIDER_FAILURE_STATUS = 503
const PROVIDER_FAILURE_TIMEOUT_MS = 240_000
const PROVIDER_PROXY_PATH = '/v1/chat/completions'
const PROVIDER_STREAM_PREFIX_BYTES = 64
const PROVIDER_TERMINAL_TIMEOUT_MS = 300_000
const PROVIDER_HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'content-encoding'])
const CONTROLLED_PROVIDER_FAILURES = [
  { kind: 'auth', status: 401, code: 'authentication_error', recoverable: false, message: '模型服务认证失败。' },
  { kind: 'rate-limit', status: 429, code: 'rate_limit_error', recoverable: true, message: '模型请求过于频繁，请稍后再试。' },
  { kind: 'quota', status: 429, code: 'insufficient_quota', recoverable: false, message: '模型分配额度已用完。' },
  { kind: 'credits', status: 402, code: 'credit_balance_exhausted', recoverable: false, message: '积分余额已用尽，本次生成已停止。' },
  { kind: 'request', status: 400, code: 'invalid_request_error', recoverable: false, message: '当前请求未被模型服务接受。' },
  { kind: 'model-config', status: 404, code: 'model_not_found', recoverable: false, message: '该模型不被当前端点支持。' },
  { kind: 'content-policy', status: 400, code: 'content_policy_violation', recoverable: false, message: '本次内容未通过安全审核，请修改后重试。' },
  { kind: 'overloaded', status: 503, code: 'overloaded', recoverable: true, message: '模型服务暂时不可用' },
  { kind: 'unavailable', status: 503, code: 'service_unavailable', recoverable: true, message: '模型服务暂时不可用' },
  { kind: 'unknown', status: 418, code: 'controlled_unrecognized_failure', recoverable: true, message: '本轮未能完成。' },
] as const
const INTERRUPTION_STYLE_PROMPT = `请实际使用 shell 运行 python -c "import time; from pathlib import Path; time.sleep(20); Path('${CONTINUATION_MARKER_FILE}').write_text('${CONTINUATION_MARKER}')"，等待命令完成后只回复 ${CONTINUATION_MARKER}。如果任务中断，继续时先检查该文件；已写入则不要重复执行。`
const DATABASE_READ_TIMEOUT_MS = 5_000
const PERMISSION_TERMINAL_STATUSES = new Set(['completed', 'failed', 'interrupted'])
const PERMISSION_DIALOG_VIEWPORT = { width: 600, height: 500 }

function nativeThread(runtime: RuntimePaths, sessionId: string): string {
  const database = new DatabaseSync(join(runtime.home, 'service', 'sessions.sqlite3'), {
    readOnly: true, timeout: DATABASE_READ_TIMEOUT_MS
  })
  try {
    const row = database.prepare('SELECT vendor_thread_id FROM session_catalog WHERE session_id = ?').get(sessionId)
    return String(row?.vendor_thread_id ?? '')
  } finally {
    database.close()
  }
}

for (const faultMode of ['http-503', 'sse-cut'] as const) {
for (const theme of ['light', 'dark'] as const) {
test(`recoverable provider gateway failure continues once with the real upstream and preserves the draft (${faultMode}, ${theme})`, async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  const preferencesPath = join(runtime.userData, 'renderer-preferences.json')
  writeFileSync(preferencesPath, JSON.stringify({ ...JSON.parse(readFileSync(preferencesPath, 'utf8')), theme }))
  const modelKey = process.env.SCHOLARSEED_ACTION_MODEL ?? ''
  const separator = modelKey.indexOf(':')
  expect(separator, 'SCHOLARSEED_ACTION_MODEL must identify a personal profile:model').toBeGreaterThan(0)
  const profilesPath = join(runtime.home, 'model_profiles.json')
  const profiles = JSON.parse(readFileSync(profilesPath, 'utf8'))
  const profile = profiles.profiles[modelKey.slice(0, separator)]
  expect(profile?.wire_api).toBe('chat_completions')
  const upstreamUrl = `${String(profile.base_url).replace(/\/$/, '')}/chat/completions`
  let markerPath = ''
  let faultEnabled = false
  let injectedRequests = 0
  let forwardedRequests = 0
  let recoveredRequests = 0
  let truncatedResponses = 0
  const gatewayErrors: string[] = []
  const gateway = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== PROVIDER_PROXY_PATH) {
        response.writeHead(404).end()
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const shouldFault = Boolean(faultEnabled && markerPath && existsSync(markerPath))
      if (shouldFault && faultMode === 'http-503') {
        injectedRequests += 1
        response.writeHead(PROVIDER_FAILURE_STATUS, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'service_unavailable', message: 'Controlled acceptance gateway outage' } }))
        return
      }
      const headers = new Headers()
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined && !PROVIDER_HOP_HEADERS.has(name)) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
      }
      const upstream = await fetch(upstreamUrl, { method: 'POST', headers, body: Buffer.concat(chunks) })
      forwardedRequests += 1
      if (!shouldFault && injectedRequests > 0 && upstream.ok) recoveredRequests += 1
      response.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([name]) => !PROVIDER_HOP_HEADERS.has(name))))
      if (upstream.body) {
        for await (const chunk of upstream.body) {
          if (shouldFault && faultMode === 'sse-cut' && upstream.ok) {
            injectedRequests += 1
            truncatedResponses += 1
            await new Promise<void>(resolve => {
              response.write(chunk.subarray(0, PROVIDER_STREAM_PREFIX_BYTES), () => {
                response.destroy()
                resolve()
              })
            })
            return
          }
          response.write(chunk)
        }
      }
      response.end()
    } catch (error) {
      gatewayErrors.push(error instanceof Error ? error.message : String(error))
      response.destroy()
    }
  })
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve))
  const address = gateway.address()
  expect(address && typeof address !== 'string').toBeTruthy()
  profile.base_url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`
  writeFileSync(profilesPath, JSON.stringify(profiles, null, 2))
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
  const startedAt = Date.now()
  try {
    const page = await desktop.launch()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, { timeout: RUNTIME_READY_TIMEOUT_MS }).toBe(true)
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-bypassPermissions').click()
    await page.getByTestId('mode-bypassPermissions-confirm').click()
    await send(page, GREETING)
    expect((await waitForFinishedTurn(page)).status).toBe('done')
    const sessionId = (await liveStatus(page))?.activeSession
    const workdir = await activeSessionWorkdir(page, sessionId ?? null)
    expect(workdir).not.toBe('')
    markerPath = join(workdir, PROVIDER_MARKER_FILE)
    expect(forwardedRequests).toBeGreaterThan(0)
    const faultStartSeq = (await liveStatus(page))?.lastSeq ?? -1
    faultEnabled = true
    await send(page, `请实际调用 shell，使用 python 在当前目录以独占创建模式 open('${PROVIDER_MARKER_FILE}', 'x') 写入 ${PROVIDER_MARKER}。工具结束后只回复 ${PROVIDER_COMPLETION}。如果中断后继续，先用工具读取并检查已有文件，内容正确就不要重新创建文件，只回复 ${PROVIDER_COMPLETION}。`)
    await expect.poll(() => existsSync(markerPath), { timeout: TURN_COMPLETE_TIMEOUT_MS }).toBe(true)
    const base = await apiBase(page)
    const terminal = await page.evaluate(({ base, sessionId, fromSeq, timeoutMs }) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const source = new EventSource(`${base}/api/serve/sessions/${sessionId}/events?from_seq=${fromSeq}`, { withCredentials: true })
      const timer = setTimeout(() => {
        source.close()
        reject(new Error('provider fault terminal event was not observed'))
      }, timeoutMs)
      source.onmessage = message => {
        const event = JSON.parse(message.data)
        if (['turn_failed', 'turn_unknown', 'turn_completed', 'turn_interrupted'].includes(event.type)) {
          clearTimeout(timer)
          source.close()
          resolve(event)
        }
      }
    }), { base, sessionId, fromSeq: faultStartSeq, timeoutMs: PROVIDER_TERMINAL_TIMEOUT_MS })
    await testInfo.attach('actual-provider-fault-terminal', { body: JSON.stringify({ faultMode, terminal }), contentType: 'application/json' })
    expect(terminal.type).toBe('turn_failed')
    const notice = page.getByTestId('turn-recoverable-notice')
    await expect(notice).toBeVisible({ timeout: PROVIDER_FAILURE_TIMEOUT_MS })
    await expect(page.getByTestId('turn-failure-card')).toHaveCount(0)
    await expect(notice).toHaveAttribute('role', 'status')
    if (faultMode === 'sse-cut') {
      expect(truncatedResponses).toBeGreaterThan(0)
      await expect(notice).toContainText('本轮未能完成。')
    }
    await expect(notice.getByTestId('turn-continue')).toBeEnabled()
    expect(injectedRequests).toBeGreaterThan(0)
    expect(readFileSync(markerPath, 'utf8')).toBe(PROVIDER_MARKER)
    await page.getByTestId('composer-input').fill(CONTINUATION_DRAFT)
    await page.screenshot({ path: testInfo.outputPath('provider-recoverable-notice.png') })
    const nativeWindow = await desktop.browserWindow(page)
    await nativeWindow.evaluate((window, minimum) => {
      window.setSize(minimum.width, minimum.height)
    }, WORKSPACE_WINDOW_MINIMUM)
    await notice.scrollIntoViewIfNeeded()
    await expect.poll(() => notice.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      const button = element.querySelector('[data-testid="turn-continue"]')?.getBoundingClientRect()
      return element.scrollWidth <= element.clientWidth && bounds.left >= 0 && bounds.right <= innerWidth && Boolean(button && button.left >= bounds.left && button.right <= bounds.right)
    })).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('provider-recoverable-notice-minimum.png') })
    const turnStarts: Array<Record<string, unknown>> = []
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith(`/api/serve/sessions/${sessionId}/turns`)) turnStarts.push(request.postDataJSON())
    })
    const failureSeq = (await liveStatus(page))?.lastSeq ?? -1
    const continuation = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/api/serve/sessions/${sessionId}/turns`))
    faultEnabled = false
    const continueButton = notice.getByTestId('turn-continue')
    if (theme === 'dark') {
      await continueButton.focus()
      await expect(continueButton).toBeFocused()
      await page.keyboard.press('Enter')
    } else {
      await continueButton.click()
    }
    expect((await continuation).status()).toBe(202)
    expect(turnStarts).toHaveLength(1)
    expect(turnStarts[0].continue_turn_id).toEqual(expect.any(String))
    expect(turnStarts[0].input).toEqual([{ type: 'text', text: expect.stringContaining('继续完成上次未完成的任务') }])
    await expect(page.getByTestId('composer-input')).toHaveValue(CONTINUATION_DRAFT)
    await expect.poll(async () => {
      const status = await liveStatus(page)
      return Boolean(status && !status.running && status.status === 'done' && status.lastSeq > failureSeq)
    }, { timeout: TURN_COMPLETE_TIMEOUT_MS }).toBe(true)
    await expect(page.getByText(PROVIDER_COMPLETION, { exact: true }).last()).toBeVisible({ timeout: TURN_COMPLETE_TIMEOUT_MS })
    await expect(notice.getByTestId('turn-continue')).toHaveCount(0)
    await expect(page.getByTestId('composer-input')).toHaveValue(CONTINUATION_DRAFT)
    expect(turnStarts).toHaveLength(1)
    expect(recoveredRequests).toBeGreaterThan(0)
    expect(readFileSync(markerPath, 'utf8')).toBe(PROVIDER_MARKER)
    expect(gatewayErrors).toEqual([])
    await page.getByText(PROVIDER_COMPLETION, { exact: true }).last().scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('provider-continuation-completed.png') })
    desktop.assertNoPageErrors()
  } finally {
    await testInfo.attach('provider-gateway-statistics', { body: JSON.stringify({ faultMode, injectedRequests, truncatedResponses, forwardedRequests, recoveredRequests, elapsedMs: Date.now() - startedAt, gatewayErrors }), contentType: 'application/json' })
    try {
      await desktop.attachArtifacts()
    } finally {
      gateway.closeAllConnections()
      await new Promise<void>((resolve, reject) => gateway.close(error => error ? reject(error) : resolve()))
    }
  }
})
}
}

for (const failure of CONTROLLED_PROVIDER_FAILURES) {
  test(`controlled integration provider HTTP ${failure.kind} projects the expected failure surface`, async ({}, testInfo) => {
    const runtime = createRuntime(testInfo)
    const blocker = seedLiveConfig(runtime)
    test.skip(Boolean(blocker), blocker ?? '')
    const modelKey = process.env.SCHOLARSEED_ACTION_MODEL ?? ''
    const separator = modelKey.indexOf(':')
    expect(separator, 'SCHOLARSEED_ACTION_MODEL must identify a personal profile:model').toBeGreaterThan(0)
    const profilesPath = join(runtime.home, 'model_profiles.json')
    const profiles = JSON.parse(readFileSync(profilesPath, 'utf8'))
    const profile = profiles.profiles[modelKey.slice(0, separator)]
    expect(profile?.wire_api).toBe('chat_completions')
    let injectedRequests = 0
    const gateway = createServer(async (request, response) => {
      if (request.method !== 'POST' || request.url !== PROVIDER_PROXY_PATH) {
        response.writeHead(404).end()
        return
      }
      for await (const chunk of request) Buffer.byteLength(chunk)
      injectedRequests += 1
      response.writeHead(failure.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: failure.code, type: failure.code, message: failure.code } }))
    })
    await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve))
    const address = gateway.address()
    expect(address && typeof address !== 'string').toBeTruthy()
    profile.base_url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`
    writeFileSync(profilesPath, JSON.stringify(profiles, null, 2))
    const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
    const startedAt = Date.now()
    try {
      const page = await desktop.launch()
      await expect.poll(async () => (await liveStatus(page))?.runtimeReady, { timeout: RUNTIME_READY_TIMEOUT_MS }).toBe(true)
      await send(page, GREETING)
      const expectedSurface = page.getByTestId(failure.recoverable ? 'turn-recoverable-notice' : 'turn-failure-card')
      const excludedSurface = page.getByTestId(failure.recoverable ? 'turn-failure-card' : 'turn-recoverable-notice')
      await expect(expectedSurface).toBeVisible({ timeout: PROVIDER_FAILURE_TIMEOUT_MS })
      await expect(expectedSurface).toHaveAttribute('role', failure.recoverable ? 'status' : 'alert')
      await expect(expectedSurface).toContainText(failure.message)
      await expect(excludedSurface).toHaveCount(0)
      expect(injectedRequests).toBeGreaterThan(0)
      if (failure.recoverable) await expect(expectedSurface.getByTestId('turn-continue')).toBeEnabled()
      else if (failure.kind === 'auth') {
        await expect(expectedSurface.getByTestId('turn-authentication-repair')).toBeEnabled()
        await expect(expectedSurface.getByTestId('turn-authentication-repair')).toHaveText('检查模型凭证')
      } else {
        await expect(expectedSurface.getByTestId('turn-continue')).toHaveCount(0)
        await expect(expectedSurface.getByTestId('turn-authentication-repair')).toHaveCount(0)
      }
      await page.screenshot({ path: testInfo.outputPath(`controlled-${failure.kind}.png`) })
      desktop.assertNoPageErrors()
    } finally {
      await testInfo.attach('controlled-provider-http-statistics', { body: JSON.stringify({ ...failure, injectedRequests, elapsedMs: Date.now() - startedAt, realUpstreamRequests: 0 }), contentType: 'application/json' })
      try {
        await desktop.attachArtifacts()
      } finally {
        gateway.closeAllConnections()
        await new Promise<void>((resolve, reject) => gateway.close(error => error ? reject(error) : resolve()))
      }
    }
  })
}

async function permissionSnapshot(page: Page, base: string, sessionId: string): Promise<OpenResp> {
  return page.evaluate(async ({ base, sessionId }) => {
    const response = await fetch(`${base}/api/serve/sessions/open`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resume_session_id: sessionId })
    })
    if (!response.ok) throw new Error(`permission snapshot failed: ${response.status}`)
    return response.json()
  }, { base, sessionId })
}

test('interrupted task continues with one click without replaying the old request', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  writeFileSync(
    join(runtime.userData, 'renderer-preferences.json'),
    JSON.stringify({
      language: 'zh',
      onboarding: { seen: { home: true, project: true, globalLib: true, pdf: true } }
    })
  )
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    let page = await desktop.launch()
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, { timeout: RUNTIME_READY_TIMEOUT_MS }).toBe(true)
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-bypassPermissions').click()
    await page.getByTestId('mode-bypassPermissions-confirm').click()
    await send(page, INTERRUPTION_STYLE_PROMPT)
    const message = page.getByTestId('user-bubble').getByText(INTERRUPTION_STYLE_PROMPT, { exact: true })
    await expect(message).toBeVisible()
    await expect.soft(message).toHaveCSS('font-weight', '400')
    await expect(page.getByTestId('composer-stop')).toBeVisible()
    const sessionId = (await liveStatus(page))?.activeSession
    expect(sessionId).toBeTruthy()
    const workdir = await activeSessionWorkdir(page, sessionId ?? null)
    await expect.poll(async () => {
      const snapshot = await page.evaluate(async (resumeSessionId) => {
        const response = await fetch('/api/serve/sessions/open', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ resume_session_id: resumeSessionId })
        })
        if (!response.ok) throw new Error(`session open failed: ${response.status}`)
        return response.json()
      }, sessionId)
      return { running: snapshot.running, activeTurnId: snapshot.active_turn_id, status: snapshot.last_turn_status }
    }, { timeout: RUNTIME_READY_TIMEOUT_MS }).toMatchObject({ running: true, activeTurnId: expect.any(String) })
    await desktop.close()
    page = await desktop.launch()
    await page.getByTestId('ai-session-toggle').click()
    await page.getByTestId(`ai-session-${sessionId}`).click()
    const notice = page.getByTestId('turn-interrupted-notice')
    await expect(notice).toBeVisible({ timeout: RUNTIME_READY_TIMEOUT_MS })
    await expect(notice).toHaveClass(/vds-alert--warning/)
    await expect(notice).toHaveCSS('margin-bottom', '12px')
    await expect(notice.getByTestId('turn-unknown-continue')).toBeEnabled()
    await expect(notice.getByTestId('turn-unknown-continue')).toHaveText('继续任务')
    await expect(page.getByTestId('user-bubble').getByText(INTERRUPTION_STYLE_PROMPT, { exact: true })).toHaveCSS('font-weight', '400')
    await page.screenshot({ path: testInfo.outputPath('interrupted-warning-card.png') })
    await page.getByTestId('composer-input').fill(CONTINUATION_DRAFT)
    const turnStarts: Array<Record<string, unknown>> = []
    const confirmations: string[] = []
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith(`/api/serve/sessions/${sessionId}/turns`))
        turnStarts.push(request.postDataJSON())
      if (request.method() === 'POST' && request.url().includes('/confirm-unknown'))
        confirmations.push(request.url())
    })
    expect(turnStarts).toHaveLength(0)
    const nextAdmission = page.waitForResponse(response =>
      response.request().method() === 'POST' && response.url().endsWith(`/api/serve/sessions/${sessionId}/turns`))
    await notice.getByTestId('turn-unknown-continue').click()
    expect((await nextAdmission).status()).toBe(202)
    expect(turnStarts).toHaveLength(1)
    expect(turnStarts[0].continue_turn_id).toEqual(expect.any(String))
    expect(turnStarts[0].input).toEqual([{ type: 'text', text: expect.stringContaining('继续完成上次未完成的任务') }])
    expect(confirmations).toHaveLength(0)
    await expect(notice).toHaveCount(0)
    await expect(page.getByTestId('composer-stop')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('continuation-running.png') })
    await expect(page.getByText(CONTINUATION_MARKER, { exact: true }).last()).toBeVisible({ timeout: TURN_COMPLETE_TIMEOUT_MS })
    await expect(page.getByTestId('composer-stop')).toHaveCount(0, { timeout: TURN_COMPLETE_TIMEOUT_MS })
    expect(turnStarts).toHaveLength(1)
    await expect(page.getByTestId('composer-input')).toHaveValue(CONTINUATION_DRAFT)
    expect(readFileSync(join(workdir, CONTINUATION_MARKER_FILE), 'utf8')).toBe(CONTINUATION_MARKER)
    await page.getByText(CONTINUATION_MARKER, { exact: true }).last().scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('continued-task-complete.png') })
    desktop.assertNoPageErrors()
  } catch (error) {
    await desktop.page?.screenshot({ path: testInfo.outputPath('continuation-failure.png') })
    throw error
  } finally {
    await desktop.attachArtifacts()
  }
})
const PLAN_PROMPT = '请规划如何在当前项目创建一份简短的研究记录，先不要执行。'
const HIL_MARKER_FILE = 'playwright-hil-marker.txt'
const HIL_MARKER = 'PLAYWRIGHT_HIL_P0'
const HIL_PROMPT = `请实际使用受保护的文件写入工具，在当前项目根目录创建 ${HIL_MARKER_FILE}，内容必须为 ${HIL_MARKER}。不要只描述步骤；必须先请求权限，获得允许后再完成写入。`
const NAVIGATION_PROMPT = '请写一篇约1500字的中文科普，分十段介绍科学研究中如何提出问题、设计实验和验证结论。请直接写正文，不需要使用工具。'
const NAVIGATION_DRAFT = '这是一条尚未发送的后续问题'
// 超过 serve 的 ATTACHMENT_MAX_BYTES (service/platform/limits.py: 20MB), 确定性触发 413。
const OVERSIZED_ATTACHMENT_BYTES = 21 * 1024 * 1024
const RUNTIME_READY_TIMEOUT_MS = 45_000
const TURN_COMPLETE_TIMEOUT_MS = 180_000
const PERMISSION_CANCELLATION_TIMEOUT_MS = 5_000
const SESSION_OPEN_ROUTE = '**/api/serve/sessions/open'
// 注入的挂起远超客户端自己的恢复超时 (api.ts RESUME_REQUEST_TIMEOUT_MS = 20s): 若客户端
// 不封顶, 恢复窗口内就永远接不回来。
const RESUME_HANG_MS = 120_000
const RESUME_TIMEOUT_RECOVERY_TIMEOUT_MS = 60_000
// 5 次尝试 + 1/2/4/8s 退避。
const RESUME_GIVEUP_TIMEOUT_MS = 90_000
const TODO_PLAN_PROMPT = '请先调用 update_plan 创建四步待办：准备环境、执行实验、检查结果、撰写总结。创建计划后立刻执行第一步，只用 shell 运行 python -c "import time; time.sleep(30)"，等待命令完成后再继续，不能跳过计划。'
const TODO_DENIED_CONTENT = 'TODO_PERMISSION_MUST_BE_DENIED'
const RUNNING_COMPOSER_PROMPT = '请只调用一次 shell 运行 python -c "import time; time.sleep(30)"，等待命令完成后再简短回复。'
const RUNNING_COMPOSER_DRAFT = '11111'
const QUEUED_MESSAGE_ONE = 'QUEUE_MESSAGE_ONE'
const QUEUED_MESSAGE_TWO = 'QUEUE_MESSAGE_TWO'
const QUEUED_MESSAGE_THREE = 'QUEUE_MESSAGE_THREE_SEND_NOW'
const SUBAGENT_PROMPT = '请必须使用 Codex 原生协作能力并行启动两个 subagent：第一个先用 shell 执行 sleep 12，再回答 2+2；第二个回答 3+3。等待它们完成后汇总。不要由主 agent 自己直接计算。'
const DEFERRED_MODEL_TURN_PROMPT = '请只调用一次 shell 运行 python -c "import time; time.sleep(20)"，等待命令完成后再简短回复。'
const DEFERRED_MODEL_NEXT_PROMPT = '请只用一句话确认下一轮已经开始。'
const SUMMARY_ORDER_MARKER = 'FINAL_SUMMARY_ORDER_ACCEPTED'
const SUMMARY_ORDER_PROMPT = `请只调用一次 shell 工具执行 pwd，等待工具完成后用两句话给出最终总结，最后一行只能写 ${SUMMARY_ORDER_MARKER}。不要提前写这个标记，也不要调用其他工具。`
const ACTIVITY_COPY_PROMPT = '请只调用一次 shell 工具执行 sleep 8 && pwd，等待命令完成后简短回答。'
const NO_TOOL_ACTIVITY_COPY_PROMPT = '不要调用任何工具。请先在内部思考，然后只回答“完成”。'

async function send(page: Page, message: string): Promise<void> {
  await page.getByTestId('composer-input').fill(message)
  await expect(page.getByTestId('composer-send')).toBeEnabled({ timeout: RUNTIME_READY_TIMEOUT_MS })
  await page.getByTestId('composer-send').click()
}

test('branches a completed middle turn into an independent task', async ({}, testInfo) => {
  test.fixme(true, '88195309: fork entry is hidden until inherited file access is supported')
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
  try {
    const page = await desktop.launch()
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(true)
    for (const [index, marker] of [BRANCH_FIRST_MARKER, BRANCH_SECOND_MARKER, BRANCH_EXCLUDED_MARKER].entries()) {
      const before = (await liveStatus(page))?.lastSeq ?? -1
      await send(page, `这是纯文本上下文测试，本条消息的测试代号为 ${marker}。不要保存记忆、不要调用工具或执行其他操作，只输出该代号。`)
      await waitForFinishedTurn(page, before)
      await expect(page.getByTestId('message-fork-task')).toHaveCount(index + 1, { timeout: TURN_COMPLETE_TIMEOUT_MS })
    }
    const sourceId = (await liveStatus(page))?.activeSession
    expect(sourceId).toBeTruthy()
    const base = await apiBase(page)
    const history = (sessionId: string) => page.evaluate(async ({ base, sessionId }) => {
      const response = await fetch(`${base}/api/serve/history/${sessionId}`)
      if (!response.ok) throw new Error(`history failed: ${response.status}`)
      return response.json()
    }, { base, sessionId })
    const sourceBefore = await history(sourceId!)
    const buttons = page.getByTestId('message-fork-task')
    await expect(buttons).toHaveCount(3)
    await page.screenshot({ path: join(runtime.artifacts, 'fork-source.png') })
    const forkResponse = page.waitForResponse(response => response.url().endsWith('/sessions/open') &&
      Boolean(response.request().postDataJSON()?.fork_session_id))
    await buttons.nth(1).click()
    const response = await forkResponse
    const payload = await response.json()
    expect({ status: response.status(), payload }).toMatchObject({ status: 200, payload: { resumed: false } })
    const childId = String(payload.session_id)
    expect(childId).not.toBe(sourceId)
    expect(nativeThread(runtime, childId)).not.toBe(nativeThread(runtime, sourceId!))
    await expect.poll(async () => (await liveStatus(page))?.activeSession).toBe(childId)
    await expect(page.getByTestId('user-bubble')).toHaveCount(2)
    const childBefore = await history(childId)
    const inherited = childBefore.turns.map((entry: { text?: string }) => entry.text ?? '').join('\n')
    expect(inherited).toContain(BRANCH_FIRST_MARKER)
    expect(inherited).toContain(BRANCH_SECOND_MARKER)
    expect(inherited).not.toContain(BRANCH_EXCLUDED_MARKER)
    await page.screenshot({ path: join(runtime.artifacts, 'fork-child.png') })
    await page.reload()
    await expect.poll(async () => (await liveStatus(page))?.activeSession, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(childId)
    await expect(page.getByTestId('user-bubble')).toHaveCount(2)
    const before = (await liveStatus(page))?.lastSeq ?? -1
    await send(page, '这是纯文本上下文测试，不调用工具或保存记忆。只列出此前用户消息中的测试代号，按先后顺序输出。')
    await waitForFinishedTurn(page, before)
    await expect(page.getByTestId('message-fork-task')).toHaveCount(3, { timeout: TURN_COMPLETE_TIMEOUT_MS })
    const childAfter = await history(childId)
    const answer = childAfter.turns.filter((entry: { role?: string }) => entry.role === 'assistant').at(-1)?.text ?? ''
    expect(answer).toContain(BRANCH_FIRST_MARKER)
    expect(answer).toContain(BRANCH_SECOND_MARKER)
    expect(answer).not.toContain(BRANCH_EXCLUDED_MARKER)
    expect((await history(sourceId!)).turns).toEqual(sourceBefore.turns)
    await page.screenshot({ path: join(runtime.artifacts, 'fork-independent-continuation.png') })
    desktop.assertNoPageErrors()
    await testInfo.attach('fork-identities', { body: JSON.stringify({ sourceId, childId, runtimeHome: runtime.home }), contentType: 'application/json' })
  } finally {
    await desktop.attachArtifacts()
  }
})

async function activeSessionWorkdir(page: Page, sessionId: string | null): Promise<string> {
  expect(sessionId).toBeTruthy()
  const base = await apiBase(page)
  return page.evaluate(async ({ api, sid }) => {
    const response = await fetch(`${api}/api/serve/sessions?limit=60&scope=all`)
    const payload = await response.json() as { sessions?: Array<{ session_id: string; runtime_workdir?: string }> }
    return payload.sessions?.find((entry) => entry.session_id === sid)?.runtime_workdir ?? ''
  }, { api: base, sid: sessionId })
}

test('P0-9 switches completed session permissions without losing the conversation', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    let page = await desktop.launch()
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(true)
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-bypassPermissions').click()
    await page.getByTestId('mode-bypassPermissions-confirm').click()
    await send(page, GREETING)
    await expect.poll(async () => {
      const state = await liveStatus(page)
      return Boolean(state?.activeSession && !state.running && state.conversationLength >= 2)
    }, { timeout: TURN_COMPLETE_TIMEOUT_MS }).toBe(true)
    const status = await waitForFinishedTurn(page)
    const base = await apiBase(page)
    await page.getByTestId('mode-chip').click()
    const responsePromise = page.waitForResponse((response) =>
      response.url().endsWith(`/sessions/${status.activeSession}/mode`) && response.request().method() === 'POST')
    await page.getByTestId('mode-safe_auto').click()
    const response = await responsePromise
    const payload = await response.json()
    await page.screenshot({ path: join(runtime.artifacts, 'completed-mode-switch.png') })
    expect({ status: response.status(), payload }).toMatchObject({ status: 200, payload: { ok: true, mode: 'safe_auto' } })
    await expect(page.getByTestId('mode-chip')).toContainText('替我审批', { timeout: RUNTIME_READY_TIMEOUT_MS })
    expect(await page.evaluate(async ({ base, sid }) => {
      const response = await fetch(`${base}/api/serve/sessions/${sid}/mode`)
      return response.json()
    }, { base, sid: status.activeSession })).toMatchObject({ mode: 'safe_auto' })
    await desktop.close()
    page = await desktop.launch()
    await page.getByTestId('ai-session-toggle').click()
    await page.getByTestId(`ai-session-${status.activeSession}`).click()
    await expect.poll(async () => (await liveStatus(page))?.activeSession, { timeout: RUNTIME_READY_TIMEOUT_MS }).toBe(status.activeSession)
    await expect(page.getByTestId('mode-chip')).toContainText('替我审批', { timeout: RUNTIME_READY_TIMEOUT_MS })
    await expect(page.getByTestId('user-bubble').first()).toContainText(GREETING)
    await page.screenshot({ path: join(runtime.artifacts, 'permission-after-restart.png') })
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-bypassPermissions').click()
    await page.getByTestId('mode-bypassPermissions-confirm').click()
    await expect(page.getByTestId('mode-chip')).toContainText('完全访问权限')
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-safe_auto').click()
    await expect(page.getByTestId('mode-chip')).toContainText('替我审批')
    await page.screenshot({ path: join(runtime.artifacts, 'permission-cycle-after-restart.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('P0 queues running messages, hides intervention, and keeps them after stop', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { home: true, project: true, globalLib: true, pdf: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(true)
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-bypassPermissions').click()
    await page.getByTestId('mode-bypassPermissions-confirm').click()
    await send(page, RUNNING_COMPOSER_PROMPT)
    await expect(page.getByTestId('composer-stop')).toBeVisible({ timeout: RUNTIME_READY_TIMEOUT_MS })
    await expect(page.getByTestId('composer-message-queue')).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'direct-running-no-queue.png') })

    const composer = page.getByTestId('composer-input')
    const sendButton = page.getByTestId('composer-send')
    await composer.fill(QUEUED_MESSAGE_ONE)
    await expect(composer).toBeEditable()
    await expect(composer).toHaveValue(QUEUED_MESSAGE_ONE)
    await expect(sendButton).toBeEnabled()
    const userBubbleCount = await page.getByTestId('user-bubble').count()
    await composer.press('Enter')
    await send(page, QUEUED_MESSAGE_TWO)
    await send(page, QUEUED_MESSAGE_THREE)
    await expect(page.getByTestId('user-bubble')).toHaveCount(userBubbleCount)
    await expect(page.getByTestId('composer-message-queue')).toContainText(QUEUED_MESSAGE_ONE)
    await expect(page.getByTestId('composer-message-queue')).toContainText(QUEUED_MESSAGE_TWO)
    await expect(page.getByTestId('composer-message-queue')).toContainText(QUEUED_MESSAGE_THREE)
    await expect(page.getByRole('button', { name: '调整方向' })).toHaveCount(0)
    await expect(page.locator('[data-testid^="queued-send-"]')).toHaveCount(0)
    const thirdRow = page.locator('[data-testid^="queued-message-"]').filter({ hasText: QUEUED_MESSAGE_THREE })
    await thirdRow.locator('[data-testid^="queued-expand-"]').click()
    await expect(thirdRow).toContainText(QUEUED_MESSAGE_THREE)
    const rejectDelete = async (route: import('@playwright/test').Route): Promise<void> => {
      if (route.request().method() === 'DELETE') {
        await route.fulfill({ status: 409, json: { error: 'queued_message_not_editable' } })
        return
      }
      await route.continue()
    }
    await page.route('**/api/serve/sessions/*/queue/*', rejectDelete)
    await thirdRow.getByRole('button', { name: '删除' }).click()
    await expect(thirdRow).toBeVisible()
    await expect(page.getByTestId('foreground-error')).toContainText('消息状态已变化，无法撤回')
    await page.getByTestId('foreground-error').getByRole('button', { name: '关闭' }).click()
    await expect(page.getByTestId('foreground-error')).toHaveCount(0)
    await page.unroute('**/api/serve/sessions/*/queue/*', rejectDelete)
    await thirdRow.getByRole('button', { name: '删除' }).click()
    await expect(page.getByTestId('composer-message-queue')).not.toContainText(QUEUED_MESSAGE_THREE)
    await expect(page.getByTestId('user-bubble')).toHaveCount(userBubbleCount)
    await expect(page.getByTestId('composer-message-queue')).toContainText(QUEUED_MESSAGE_ONE)
    await expect(page.getByTestId('composer-message-queue')).toContainText(QUEUED_MESSAGE_TWO)
    await page.screenshot({ path: join(runtime.artifacts, 'running-queue-retracted.png') })
    await page.getByTestId('composer-stop').click()
    await expect.poll(async () => (await liveStatus(page))?.running, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(false)
    await expect(page.getByText('用户主动停止了该任务', { exact: true })).toHaveCount(1)
    await expect(page.getByText('书深正在思考', { exact: true })).toHaveCount(0)
    await expect(page.getByTestId('composer-stop')).toHaveCount(0)
    await expect(page.getByText('正在终止当前运行', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '继续', exact: true })).toHaveCount(0)
    await expect(page.getByTestId('composer-message-queue')).toContainText(QUEUED_MESSAGE_TWO)
    await expect(page.locator('[data-testid^="queued-send-"]')).toHaveCount(0)
    await expect(page.getByText('排队中', { exact: true })).toHaveCount(2)
    await expect(page.getByTestId('user-bubble')).toHaveCount(userBubbleCount)
    await expect(composer).toHaveValue('')
    await page.screenshot({ path: join(runtime.artifacts, 'queue-turn-interrupted.png') })
    desktop.assertNoPageErrors()
  } finally {
    try {
      if (desktop.page && (await liveStatus(desktop.page))?.running) {
        await desktop.page.getByTestId('composer-stop').click()
        await expect.poll(async () => desktop.page && (await liveStatus(desktop.page))?.running, {
          timeout: RUNTIME_READY_TIMEOUT_MS
        }).toBe(false)
      }
    } finally {
      await desktop.attachArtifacts()
    }
  }
})

test('P0-13 renders native Codex subagent lifecycle as product activity', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  writeFileSync(
    join(runtime.userData, 'renderer-preferences.json'),
    JSON.stringify({
      language: 'zh',
      onboarding: { seen: { home: true, project: true, globalLib: true, pdf: true } }
    })
  )
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(true)
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-bypassPermissions').click()
    await page.getByTestId('mode-bypassPermissions-confirm').click()
    await send(page, SUBAGENT_PROMPT)
    const agents = page.getByTestId('native-activity-subagent_activity')
    await expect(agents.first()).toBeVisible({
      timeout: TURN_COMPLETE_TIMEOUT_MS
    })
    const elapsed = page.getByTestId('subagent-elapsed').first()
    await expect(elapsed).toBeVisible({ timeout: TURN_COMPLETE_TIMEOUT_MS })
    await expect(agents.first().getByTestId('native-activity-status')).toHaveText('执行中')
    await expect(elapsed).toContainText('已运行')
    await expect(page.getByTestId('subagent-last-observed').first()).toContainText('最近确认')
    const initialElapsed = await elapsed.textContent()
    await expect.poll(async () => elapsed.textContent(), { timeout: RUNTIME_READY_TIMEOUT_MS }).not.toBe(initialElapsed)
    await page.screenshot({ path: join(runtime.artifacts, 'native-subagent-running.png') })
    await waitForFinishedTurn(page)
    await expect(agents).toHaveCount(2)
    const names = await agents.getByTestId('native-activity-name').allTextContents()
    expect(new Set(names).size).toBe(2)
    const identities = names.slice()
    const calls = page.getByTestId('native-activity-agent_collaboration')
    const statuses = await calls.getByTestId('native-activity-status').allTextContents()
    expect(statuses.length).toBeGreaterThan(0)
    expect(statuses.every((status) => /调用已(完成|结束)/.test(status))).toBe(true)
    await expect(page.getByTestId('subagent-elapsed')).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'native-subagent-completed.png') })
    await page.reload()
    await expect(agents).toHaveCount(2, { timeout: RUNTIME_READY_TIMEOUT_MS })
    await expect(agents.getByTestId('native-activity-name')).toHaveText(identities)
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('P0-14 terminates the whole native runtime session separately from stopping a turn', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(true)
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-bypassPermissions').click()
    await page.getByTestId('mode-bypassPermissions-confirm').click()
    await send(page, RUNNING_COMPOSER_PROMPT)
    await expect(page.getByTestId('composer-stop')).toBeVisible({ timeout: RUNTIME_READY_TIMEOUT_MS })
    const sessionId = (await liveStatus(page))?.activeSession
    expect(sessionId).toBeTruthy()
    await page.getByTestId('ai-session-toggle').click()
    await page.getByTestId(`ai-session-actions-${sessionId}`).click()
    await page.getByTestId(`ai-session-terminate-${sessionId}`).click()
    await expect.poll(async () => (await liveStatus(page))?.running, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(false)
    await expect(page.getByText('已终止整个会话，历史已保留；此会话不能继续发送。')).toBeVisible()
    await expect(page.getByTestId('composer-send')).toBeDisabled()
    const base = await apiBase(page)
    expect(await page.evaluate(async ({ base, sid }) => {
      const response = await fetch(`${base}/api/serve/sessions/${sid}/queue`)
      return { status: response.status, payload: await response.json() }
    }, { base, sid: sessionId })).toMatchObject({
      status: 404,
      payload: { ok: false, error: 'session_not_live' }
    })
    await page.screenshot({ path: join(runtime.artifacts, 'native-session-terminated.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('P0-11 defers a running model selection until the next turn', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  const desktop = new DesktopSession(runtime, testInfo)
  let sessionId: string | null = null
  try {
    let page = await desktop.launch()
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(true)
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-bypassPermissions').click()
    await page.getByTestId('mode-bypassPermissions-confirm').click()
    await send(page, DEFERRED_MODEL_TURN_PROMPT)
    await expect(page.getByTestId('composer-stop')).toBeVisible({ timeout: RUNTIME_READY_TIMEOUT_MS })
    sessionId = (await liveStatus(page))?.activeSession ?? null
    expect(sessionId).toBeTruthy()
    const base = await apiBase(page)
    const before = await page.evaluate(async ({ base, sid }) => {
      const response = await fetch(`${base}/api/serve/sessions/${sid}/model`)
      return response.json() as Promise<{ model_id: string; active_model_id: string; deferred: boolean }>
    }, { base, sid: sessionId })
    const targetModel = process.env.SCHOLARSEED_ALTERNATE_MODEL
    if (!targetModel || targetModel === before.active_model_id) {
      throw new Error('SCHOLARSEED_ALTERNATE_MODEL must name a different configured model connection')
    }

    const responsePromise = page.waitForResponse((response) =>
      response.url().endsWith(`/sessions/${sessionId}/model`) && response.request().method() === 'POST')
    await page.getByTestId('model-selector-toggle').click()
    await page.getByTestId(`model-option-${targetModel}`).click()
    const response = await responsePromise
    const selected = await response.json()
    expect({ status: response.status(), selected }).toMatchObject({
      status: 200,
      selected: {
        ok: true,
        model_id: targetModel,
        active_model_id: before.active_model_id,
        deferred: true
      }
    })
    await expect(page.getByTestId('model-selector-toggle')).not.toContainText('自动（Codex')
    await expect(page.getByTestId('composer-stop')).toBeVisible()
    await expect(page.getByTestId('foreground-error')).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'running-model-selected-for-next-turn.png') })

    await expect.poll(async () => (await liveStatus(page))?.running, {
      timeout: TURN_COMPLETE_TIMEOUT_MS
    }).toBe(false)
    expect(await liveStatus(page)).toMatchObject({ activeSession: sessionId, status: 'done' })
    const userBubbleCount = await page.getByTestId('user-bubble').count()
    const nextTurnResponse = page.waitForResponse((response) =>
      response.url().endsWith(`/sessions/${sessionId}/turns`) && response.request().method() === 'POST')
    await send(page, DEFERRED_MODEL_NEXT_PROMPT)
    expect((await nextTurnResponse).status()).toBe(202)
    await expect.poll(async () => {
      const status = (await liveStatus(page))?.status
      return status === 'done' || status === 'failed'
    }, {
      timeout: TURN_COMPLETE_TIMEOUT_MS
    }).toBe(true)
    expect(await liveStatus(page)).toMatchObject({ activeSession: sessionId, status: 'done' })
    await expect(page.getByTestId('user-bubble')).toHaveCount(userBubbleCount + 1)
    const activated = await page.evaluate(async ({ base, sid }) => {
      const response = await fetch(`${base}/api/serve/sessions/${sid}/model`)
      return response.json() as Promise<{ model_id: string; active_model_id: string; deferred: boolean }>
    }, { base, sid: sessionId })
    expect(activated).toMatchObject({
      model_id: targetModel,
      active_model_id: targetModel,
      deferred: false
    })
    await expect(page.getByTestId('foreground-error')).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'next-turn-model-active.png') })

    await desktop.close()
    page = await desktop.launch()
    await page.getByTestId(`sidebar-session-${sessionId}`).click()
    await expect.poll(async () => (await liveStatus(page))?.activeSession, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(sessionId)
    await expect(page.getByTestId('user-bubble').first()).toContainText(DEFERRED_MODEL_TURN_PROMPT)
    await expect(page.getByTestId('user-bubble').last()).toContainText(DEFERRED_MODEL_NEXT_PROMPT)
    await page.getByTestId('model-selector-toggle').click()
    await expect(page.getByTestId(`model-option-${targetModel}`)).toHaveAttribute('data-selected', 'true')
    await expect(page.getByTestId('foreground-error')).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'model-selection-after-restart.png') })
    desktop.assertNoPageErrors()
  } finally {
    try {
      if (desktop.page && sessionId && (await liveStatus(desktop.page))?.running) {
        const page = desktop.page
        const base = await apiBase(page)
        await page.evaluate(async ({ base, sid }) => {
          await fetch(`${base}/api/serve/sessions/${sid}/interrupt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          })
        }, { base, sid: sessionId })
      }
    } finally {
      await desktop.attachArtifacts()
    }
  }
})

test('P0-12 keeps a completed turn summary below its late activity after restart', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  const desktop = new DesktopSession(runtime, testInfo)
  let sessionId: string | null = null
  const expectSummaryBelowActivity = async (page: Page): Promise<void> => {
    const summary = page.locator('.md-agent').filter({ hasText: SUMMARY_ORDER_MARKER }).last()
    const activity = page.getByTestId('turn-activity').last()
    await expect(summary).toBeVisible({ timeout: TURN_COMPLETE_TIMEOUT_MS })
    await expect(activity).toBeVisible({ timeout: TURN_COMPLETE_TIMEOUT_MS })
    expect(await activity.evaluate((activityNode, marker) => {
      const column = activityNode.closest('.vds-reading-column')
      const summaryNode = [...(column?.querySelectorAll('.md-agent') ?? [])]
        .find((node) => node.textContent?.includes(marker))
      return Boolean(
        summaryNode &&
        (activityNode.compareDocumentPosition(summaryNode) & Node.DOCUMENT_POSITION_FOLLOWING)
      )
    }, SUMMARY_ORDER_MARKER)).toBe(true)
    await summary.scrollIntoViewIfNeeded()
  }
  try {
    let page = await desktop.launch()
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(true)
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-bypassPermissions').click()
    await page.getByTestId('mode-bypassPermissions-confirm').click()
    await send(page, SUMMARY_ORDER_PROMPT)
    const status = await waitForFinishedTurn(page)
    sessionId = status.activeSession
    expect(status.status).toBe('done')
    await expectSummaryBelowActivity(page)
    await page.screenshot({ path: join(runtime.artifacts, 'summary-last-completed.png') })

    await desktop.close()
    page = await desktop.launch()
    await page.getByTestId(`sidebar-session-${sessionId}`).click()
    await expect.poll(async () => (await liveStatus(page))?.activeSession, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(sessionId)
    await expectSummaryBelowActivity(page)
    await page.screenshot({ path: join(runtime.artifacts, 'summary-last-after-restart.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('activity summary shows running and completed duration copy', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({ language: 'zh', onboarding: { seen: { home: true, project: true, globalLib: true, pdf: true } } }))
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(true)
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-bypassPermissions').click()
    await page.getByTestId('mode-bypassPermissions-confirm').click()
    await send(page, ACTIVITY_COPY_PROMPT)
    const summary = page.getByTestId('turn-activity-trigger').last()
    await expect(summary).toContainText('执行中', { timeout: TURN_COMPLETE_TIMEOUT_MS })
    await expect(summary).toContainText(/· \d+s/)
    await expect(summary).not.toContainText('执行工具')
    await page.screenshot({ path: join(runtime.artifacts, 'activity-duration-running.png') })
    const status = await waitForFinishedTurn(page)
    expect(status.status).toBe('done')
    await expect(summary).toBeVisible()
    await expect(summary).toContainText(/执行工具 1 次\s*· 用时\d+s/)
    await expect(summary).not.toContainText('已完成')
    await expect(summary).not.toContainText('任务用时')
    await page.screenshot({ path: join(runtime.artifacts, 'activity-duration-completed.png') })
    const beforeNoTool = await liveStatus(page)
    await send(page, NO_TOOL_ACTIVITY_COPY_PROMPT)
    const noToolStatus = await waitForFinishedTurn(page, beforeNoTool?.lastSeq ?? 0)
    expect(noToolStatus.status).toBe('done')
    await expect(page.getByTestId('message-fork-task')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '复制消息', exact: true }).last()).toBeVisible()
    const noToolSummary = page.getByTestId('turn-activity-trigger').last()
    await expect(noToolSummary).toContainText(/已处理\s*· 用时\d+s/)
    await expect(noToolSummary).not.toContainText('执行工具')
    await page.screenshot({ path: join(runtime.artifacts, 'activity-duration-no-tool.png') })
  } finally {
    await desktop.attachArtifacts()
  }
})

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'live', 'real LLM cases belong to the live project')
})

test('P0-2 sends a message through the real Agent session', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await send(page, GREETING)
    const status = await waitForFinishedTurn(page)
    await expect(page.getByTestId('user-bubble')).toContainText(GREETING)
    const base = await apiBase(page)
    const history = await page.evaluate(async ({ base, sid }) => {
      const response = await fetch(`${base}/api/serve/history/${sid}`)
      return response.json()
    }, { base, sid: status.activeSession })
    expect(JSON.stringify(history)).toContain(GREETING)
    await page.screenshot({ path: join(runtime.artifacts, 'completed.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('feedback exports historical native roots and subagent rollouts from a real session', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  const historicalSession = process.env.SCHOLARSEED_FEEDBACK_SOURCE_SESSION
  test.skip(!historicalSession, 'an authentic historical session snapshot is required')
  const receipts: string[] = []
  const receiver = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const path = join(runtime.artifacts, `feedback-${receipts.length + 1}.multipart`)
    writeFileSync(path, Buffer.concat([
      Buffer.from(`Content-Type: ${request.headers['content-type']}\r\n\r\n`), ...chunks
    ]))
    receipts.push(path)
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true, id: `local-export-acceptance-${receipts.length}` }))
  })
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve))
  const address = receiver.address()
  expect(address && typeof address !== 'string').toBeTruthy()
  const configPath = join(runtime.home, 'config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  config.damoclaw_server_url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  writeFileSync(configPath, JSON.stringify(config, null, 2))
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
  try {
    const page = await desktop.launch()
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(true)
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-bypassPermissions').click()
    await page.getByTestId('mode-bypassPermissions-confirm').click()
    await send(page, SUBAGENT_PROMPT)
    await expect(page.getByTestId('turn-activity').filter({ hasText: '子代理活动' }).first()).toBeVisible({
      timeout: TURN_COMPLETE_TIMEOUT_MS
    })
    await page.screenshot({ path: join(runtime.artifacts, 'feedback-subagents-running.png') })
    const status = await waitForFinishedTurn(page)
    const rootIds = [nativeThread(runtime, status.activeSession!)]
    await desktop.app!.evaluate(({ app, BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('menu.html'))!
      main.show()
      main.focus()
      app.focus({ steal: true })
    })
    await page.bringToFront()
    await page.getByTestId('activity-account').click()
    await expect.poll(async () => {
      for (const window of desktop.app!.windows()) {
        if (await window.getByTestId('account-menu-feedback').isVisible().catch(() => false)) return true
      }
      return false
    }).toBe(true)
    for (const window of desktop.app!.windows()) {
      const feedback = window.getByTestId('account-menu-feedback')
      if (await feedback.isVisible().catch(() => false)) {
        await feedback.evaluate((element: HTMLElement) => element.click())
        break
      }
    }
    await expect(page.getByTestId('feedback-dialog')).toBeVisible()
    await page.getByTestId('feedback-description').fill('本地导出验收：真实原生子代理，不提交到线上服务。')
    await expect(page.getByTestId('feedback-include-logs')).toBeChecked()
    await expect(page.getByTestId('feedback-include-trace')).toBeChecked()
    await page.screenshot({ path: join(runtime.artifacts, 'feedback-consent.png') })
    await page.getByTestId('feedback-submit').click()
    await expect(page.getByTestId('feedback-done')).toBeVisible({ timeout: RUNTIME_READY_TIMEOUT_MS })
    await page.screenshot({ path: join(runtime.artifacts, 'feedback-received.png') })
    expect(receipts).toHaveLength(1)
    const python = process.platform === 'win32' ? join(process.cwd(), '..', '..', '.venv', 'Scripts', 'python.exe')
      : join(process.cwd(), '..', '..', '.venv', 'bin', 'python')
    const inspectReceipt = (index: number, filename: string) => JSON.parse(execFileSync(python, ['-c', `
import io,json,sys,zipfile
from email.parser import BytesParser
from email.policy import default
from pathlib import Path
message=BytesParser(policy=default).parsebytes(Path(sys.argv[1]).read_bytes())
bundle=next(part.get_payload(decode=True) for part in message.iter_parts() if part.get_param('name',header='content-disposition')=='logs_bundle')
Path(sys.argv[2]).write_bytes(bundle)
with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
    tree=json.loads(archive.read('conversation/thread-tree.json'))
    names=archive.namelist()
    for row in tree['root_threads']+tree['threads']:
        for line in archive.read(row['path']).splitlines():
            json.loads(line)
    print(json.dumps({'tree':tree,'names':names,'bytes':len(bundle)}))
`, receipts[index], join(runtime.artifacts, filename)], { encoding: 'utf8' }))
    const inspection = inspectReceipt(0, 'received-feedback.zip')
    expect(new Set(inspection.tree.root_threads.map((row: { thread_id: string }) => row.thread_id))).toEqual(new Set(rootIds))
    expect(inspection.tree.history_discovery_status).toBe('complete')
    expect(inspection.tree.discovery_status).toBe('complete')
    expect(inspection.tree.threads.length).toBeGreaterThanOrEqual(2)
    for (const row of [...inspection.tree.root_threads, ...inspection.tree.threads]) {
      expect(row.status).toBe('included')
      expect(inspection.names).toContain(row.path)
    }
    expect(new Set(inspection.names).size).toBe(inspection.names.length)
    writeFileSync(join(runtime.artifacts, 'received-feedback-index.json'), JSON.stringify(inspection, null, 2))
    await testInfo.attach('actual-received-feedback-index', { body: JSON.stringify(inspection, null, 2), contentType: 'application/json' })
    await desktop.close()
    const historicalRoots = JSON.parse(execFileSync(python, ['-c', `
import json,shutil,sqlite3,sys
from pathlib import Path
source,target,session=Path(sys.argv[1]),Path(sys.argv[2]),sys.argv[3]
with sqlite3.connect(f'file:{source / "service/sessions.sqlite3"}?mode=ro',uri=True) as original:
    original.row_factory=sqlite3.Row
    record=original.execute('SELECT * FROM session_catalog WHERE session_id=?',(session,)).fetchone()
    if record is None: raise ValueError('historical session is absent from the source catalog')
    with sqlite3.connect(target / 'service/sessions.sqlite3') as snapshot:
        columns=[row[1] for row in snapshot.execute('PRAGMA table_info(session_catalog)') if row[1] in record.keys()]
        placeholders=','.join('?' for column in columns)
        snapshot.execute(f'INSERT INTO session_catalog ({",".join(columns)}) VALUES ({placeholders})',[record[column] for column in columns])
threads=set()
for trace in (source/'logs/trace').glob(f'*-{session}.jsonl'):
    destination=target/'logs/trace'/trace.name
    destination.parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(trace,destination)
    for line in trace.open():
        try: event=json.loads(line)
        except ValueError: continue
        if event.get('session_id')==session and event.get('name')=='session.runtime.bound':
            attributes=event.get('attributes',{})
            if attributes.get('runtime_id')=='codex': threads.add(attributes['vendor_thread_id'])
for rollout in (source/'codex/sessions').rglob('rollout-*.jsonl'):
    if any(rollout.name.endswith(f'-{thread}.jsonl') for thread in threads):
        destination=target/'codex/sessions'/rollout.name
        destination.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(rollout,destination)
print(json.dumps(sorted(threads)))
`, process.env.SCHOLARSEED_REAL_HOME!, runtime.home, historicalSession!], { encoding: 'utf8' }))
    expect(historicalRoots.length).toBeGreaterThanOrEqual(2)
    const restoredPage = await desktop.launch()
    const base = await apiBase(restoredPage)
    const historicalResult = await restoredPage.evaluate(async ({ base, session }) => {
      const form = new FormData()
      form.set('description', '本地历史会话导出验收：原始日志逐字节保留，不提交到线上服务。')
      form.set('session_id', session)
      form.set('include_logs', 'true')
      form.set('include_trace', 'true')
      const result = await fetch(`${base}/api/serve/feedback`, { method: 'POST', body: form })
      return { status: result.status, body: await result.json() }
    }, { base, session: historicalSession! })
    expect(historicalResult.status).toBe(200)
    expect(receipts).toHaveLength(2)
    const historicalInspection = inspectReceipt(1, 'received-history-feedback.zip')
    expect(new Set(historicalInspection.tree.root_threads.map((row: { thread_id: string }) => row.thread_id)))
      .toEqual(new Set(historicalRoots))
    expect(historicalInspection.tree.history_discovery_status).toBe('complete')
    expect(historicalInspection.tree.root_threads.every((row: { status: string }) => row.status === 'included')).toBe(true)
    writeFileSync(join(runtime.artifacts, 'received-history-feedback-index.json'), JSON.stringify(historicalInspection, null, 2))
    await testInfo.attach('actual-received-history-feedback-index', { body: JSON.stringify(historicalInspection, null, 2), contentType: 'application/json' })
    desktop.assertNoPageErrors()
  } catch (error) {
    await desktop.page?.screenshot({ path: join(runtime.artifacts, 'feedback-failure.png') })
    throw error
  } finally {
    await desktop.attachArtifacts()
    await new Promise<void>(resolve => receiver.close(() => resolve()))
  }
})

test('P0-3 persists Plan mode on the server before the first turn', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const planToggle = page.getByTestId('collaboration-mode-toggle')
    await planToggle.click()
    await expect(planToggle).toHaveAttribute('data-mode', 'plan')
    await send(page, PLAN_PROMPT)
    const status = await waitForFinishedTurn(page)
    expect(status.runtimeId).toBe('codex')
  } finally {
    await desktop.attachArtifacts()
  }
})

test('P0-4 resolves a real permission HIL and writes the requested file', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(true)
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-safe_auto').click()
    await send(page, HIL_PROMPT)
    const card = page.getByTestId('hil-card').last()
    await expect(card).toBeVisible({ timeout: TURN_COMPLETE_TIMEOUT_MS })
    await expect(card).toHaveAttribute('data-hil-resolved', 'false')
    await page.screenshot({ path: join(runtime.artifacts, 'permission-pending.png') })
    const allow = card.locator('button[data-hil-decision="allow-once"]')
    await allow.click()
    await expect(page.getByTestId('hil-card')).toHaveCount(0, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    })
    const status = await waitForFinishedTurn(page)
    const workdir = await activeSessionWorkdir(page, status.activeSession)
    expect(workdir).not.toBe('')
    const markerPath = join(workdir, HIL_MARKER_FILE)
    expect(existsSync(markerPath), `missing HIL artifact: ${markerPath}`).toBe(true)
    await expect(page.getByTestId('turn-activity').first()).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'permission-allowed.png') })
  } finally {
    await desktop.attachArtifacts()
  }
})

test('permission selection during a real approval hot switches and safely continues', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const protectedPath = join(runtime.root, 'permission-protected.txt')
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    theme: 'system',
    onboarding: { seen: { home: true, project: true, globalLib: true, pdf: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
  try {
    const page = await desktop.launch()
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(true)
    await page.getByTestId('mode-chip').click()
    await expect(page.getByTestId('mode-menu')).not.toContainText('切换不改变已挂起的审批、已开始的步骤或子会话。')
    await page.getByTestId('mode-ask').click()
    const initialModeSnapshots: Array<{ active_mode: string; deferred: boolean }> = []
    page.on('response', async (response) => {
      if (response.request().method() === 'GET' && /\/sessions\/[^/]+\/mode$/.test(response.url())) {
        initialModeSnapshots.push(await response.json())
      }
    })
    await send(page, `请实际使用 exec_command，运行 printf 'permission-switch' >> '${protectedPath}'。
该路径在当前项目可写范围之外，只属于本次隔离测试。调用时请求 sandbox_permissions=require_escalated，
不要改用 apply_patch、service_bridge 或改写项目内其它文件。批准后完成写入即可。`)
    const card = page.getByTestId('hil-card').last()
    await expect(card).toBeVisible({ timeout: TURN_COMPLETE_TIMEOUT_MS })
    await expect(page.getByTestId('mode-chip')).toBeEnabled()
    await expect.poll(() => initialModeSnapshots.some((snapshot) => snapshot.active_mode === 'ask')).toBe(true)
    for (const snapshot of initialModeSnapshots.filter((snapshot) => !snapshot.active_mode)) {
      expect(snapshot.deferred).toBe(false)
    }
    await expect(page.getByTestId('mode-chip')).toHaveText('请求批准')
    await testInfo.attach('first-turn-mode-snapshots', {
      body: JSON.stringify(initialModeSnapshots), contentType: 'application/json'
    })
    await page.getByTestId('ai-toggle-cover').click()
    await expect(page.getByTestId('ai-panel')).toHaveClass(/is-cover/)
    await page.screenshot({ path: join(runtime.artifacts, 'approval-mode-first-binding.png') })
    await page.getByTestId('ai-toggle-cover').click()
    const sessionId = (await liveStatus(page))?.activeSession
    expect(sessionId).toBeTruthy()
    const originalThread = nativeThread(runtime, sessionId!)
    expect(originalThread).not.toBe('')
    const base = await apiBase(page)
    const readMode = () => page.evaluate(async ({ base, sessionId }) => {
      const response = await fetch(`${base}/api/serve/sessions/${sessionId}/mode`, { credentials: 'include' })
      if (!response.ok) throw new Error(`mode read failed: ${response.status}`)
      return response.json()
    }, { base, sessionId })
    const cancelNextTurn = async (active: string, label: string) => {
      const before = await permissionSnapshot(page, base, sessionId!)
      await page.getByTestId('mode-chip').click()
      const cancellationResponse = page.waitForResponse((response) =>
        response.url().endsWith(`/sessions/${sessionId}/mode`) && response.request().method() === 'POST')
      await page.getByTestId(`mode-${active}`).click()
      await expect(page.getByTestId('mode-application-dialog')).toHaveCount(0)
      await expect(page.getByTestId('mode-chip')).toBeEnabled({ timeout: PERMISSION_CANCELLATION_TIMEOUT_MS })
      const cancelled = await cancellationResponse
      expect({ status: cancelled.status(), payload: await cancelled.json() }).toMatchObject({
        status: 200, payload: { ok: true, mode: active, active_mode: active, next_turn_selected: false }
      })
      await expect(page.getByTestId('mode-chip')).toHaveText(label)
      expect(await readMode()).toMatchObject({
        mode: active, active_mode: active, next_turn_selected: false, deferred: false, switch_warning: ''
      })
      const after = await permissionSnapshot(page, base, sessionId!)
      expect(after.running).toBe(true)
      expect(after.active_turn_id).toBe(before.active_turn_id)
      expect(after.pending_hil).toEqual(before.pending_hil)
      expect(nativeThread(runtime, sessionId!)).toBe(originalThread)
      await expect(card).toHaveAttribute('data-hil-resolved', 'false')
      await expect(card.getByTestId('hil-permission-accept')).toBeEnabled()
      await expect(page.getByTestId('foreground-error')).toHaveCount(0)
      await testInfo.attach(`cancel-next-turn-${active}`, {
        body: JSON.stringify({ before, after, mode: await readMode() }), contentType: 'application/json'
      })
      await page.getByTestId('ai-toggle-cover').click()
      await page.screenshot({
        path: join(runtime.artifacts, `approval-mode-cancel-${active}.png`), animations: 'disabled'
      })
      await page.getByTestId('ai-toggle-cover').click()
    }
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-bypassPermissions').click()
    await page.getByTestId('mode-application-next-turn').click()
    await expect(page.getByTestId('mode-chip')).toHaveText('请求批准 · 下一轮：完全访问')
    expect(await readMode()).toMatchObject({ mode: 'bypassPermissions', active_mode: 'ask', next_turn_selected: true })
    await cancelNextTurn('ask', '请求批准')
    await page.getByTestId('mode-chip').click()
    const switchResponse = page.waitForResponse((response) =>
      response.url().endsWith(`/sessions/${sessionId}/mode`) && response.request().method() === 'POST')
    await page.getByTestId('mode-safe_auto').click()
    await expect(page.getByTestId('mode-application-dialog')).toHaveCount(0)
    const switched = await switchResponse
    const switchResult = { status: switched.status(), payload: await switched.json() }
    expect(switchResult).toMatchObject({
      status: 200,
      payload: { ok: true, mode: 'safe_auto', active_mode: 'safe_auto', deferred: false }
    })
    await expect(card).toHaveAttribute('data-hil-resolved', 'false')
    await expect(page.getByTestId('foreground-error')).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'approval-mode-live.png') })
    const pendingSnapshot = await permissionSnapshot(page, base, sessionId!)
    assert.ok(pendingSnapshot.pending_hil)
    const offeredOptions = pendingSnapshot.pending_hil.flatMap((item) => item.options ?? [])
    await testInfo.attach('native-permission-options', {
      body: JSON.stringify(offeredOptions), contentType: 'application/json'
    })
    for (const option of offeredOptions.filter((option) => !['decline', 'cancel'].includes(option.id))) {
      await expect(card.getByTestId(`hil-permission-${option.id}`)).toBeVisible()
    }
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-bypassPermissions').click()
    const applicationDialog = page.getByTestId('mode-application-dialog')
    await expect(applicationDialog).toBeVisible()
    await expect(applicationDialog.getByRole('status')).toHaveCount(0)
    await expect(page.getByTestId('mode-deferred')).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'approval-mode-application-dialog.png') })
    const fullViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    await page.setViewportSize(PERMISSION_DIALOG_VIEWPORT)
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    for (const action of ['cancel', 'next-turn', 'now']) {
      const control = page.getByTestId(`mode-application-${action}`)
      await expect(control).toBeVisible()
      const bounds = await control.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(PERMISSION_DIALOG_VIEWPORT.height)
    }
    await page.keyboard.press('Tab')
    expect(await applicationDialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
    await page.screenshot({ path: join(runtime.artifacts, 'approval-mode-dialog-dark-narrow.png') })
    await page.keyboard.press('Escape')
    await expect(applicationDialog).toHaveCount(0)
    await page.emulateMedia({ colorScheme: 'light' })
    await page.setViewportSize(fullViewport)
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-bypassPermissions').click()
    await expect(applicationDialog).toBeVisible()
    expect(await readMode()).toMatchObject({ mode: 'safe_auto', active_mode: 'safe_auto', next_turn_selected: false })
    await page.getByTestId('mode-application-cancel').click()
    await expect(applicationDialog).toHaveCount(0)
    expect(await readMode()).toMatchObject({ mode: 'safe_auto', next_turn_selected: false })
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-bypassPermissions').click()
    await page.getByTestId('mode-application-next-turn').click()
    await expect(page.getByTestId('mode-chip')).toHaveText('帮我批准 · 下一轮：完全访问')
    await expect(page.getByTestId('mode-deferred')).toHaveCount(0)
    expect(await readMode()).toMatchObject({ mode: 'bypassPermissions', active_mode: 'safe_auto', next_turn_selected: true })
    await expect(card).toHaveAttribute('data-hil-resolved', 'false')
    await cancelNextTurn('safe_auto', '帮我批准')
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-bypassPermissions').click()
    await page.getByTestId('mode-application-next-turn').click()
    await expect(page.getByTestId('mode-chip')).toHaveText('帮我批准 · 下一轮：完全访问')
    await page.getByTestId('ai-toggle-cover').click()
    await expect(page.getByTestId('mode-chip')).toHaveText('帮我批准 · 下一轮：完全访问')
    await page.getByTestId('mode-chip').click()
    await page.screenshot({ path: join(runtime.artifacts, 'approval-mode-deferred.png') })
    await page.getByTestId('mode-bypassPermissions').click()
    await expect(applicationDialog).toBeVisible()
    const continuationResponse = page.waitForResponse((response) =>
      response.url().endsWith(`/sessions/${sessionId}/mode`) && response.request().method() === 'POST')
    await page.getByTestId('mode-application-now').click()
    const continued = await continuationResponse
    expect({ status: continued.status(), payload: await continued.json() }).toMatchObject({
      status: 200,
      payload: { ok: true, mode: 'bypassPermissions', active_mode: 'bypassPermissions', continued: true }
    })
    let continuationStatus: OpenResp['last_turn_status']
    await expect.poll(async () => {
      const snapshot = await permissionSnapshot(page, base, sessionId!)
      continuationStatus = snapshot.last_turn_status
      return !snapshot.running && typeof continuationStatus === 'string'
        && PERMISSION_TERMINAL_STATUSES.has(continuationStatus)
        && snapshot.last_turn_id !== pendingSnapshot.active_turn_id
    }, { timeout: TURN_COMPLETE_TIMEOUT_MS }).toBe(true)
    await waitForFinishedTurn(page)
    expect((await liveStatus(page))?.activeSession).toBe(sessionId)
    const continuedThread = nativeThread(runtime, sessionId!)
    expect(continuedThread).toBe(originalThread)
    await testInfo.attach('permission-runtime-identity', {
      body: JSON.stringify({ home: runtime.home, sessionId, originalThread, continuedThread }),
      contentType: 'application/json'
    })
    await page.screenshot({ path: join(runtime.artifacts, 'approval-mode-continuation-terminal.png') })
    expect(continuationStatus).toBe('completed')
    expect(readFileSync(protectedPath, 'utf8')).toBe('permission-switch')
    await expect(page.getByTestId('foreground-error')).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'approval-mode-continued.png') })
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-safe_auto').click()
    await send(page, GREETING)
    await expect.poll(async () => page.evaluate(async ({ api, sid }) => {
      const response = await fetch(`${api}/api/serve/sessions/${sid}/mode`)
      return response.json()
    }, { api: base, sid: sessionId }), { timeout: TURN_COMPLETE_TIMEOUT_MS }).toMatchObject({
      mode: 'safe_auto', active_mode: 'safe_auto', deferred: false
    })
    await waitForFinishedTurn(page)
    await page.screenshot({ path: join(runtime.artifacts, 'approval-mode-next-turn.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('live reviewer switch routes subsequent native approvals through auto review', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const filename = 'reviewer-protected.txt'
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { home: true, project: true, globalLib: true, pdf: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
  try {
    const page = await desktop.launch()
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(true)
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-ask').click()
    await send(page, `请依次调用 exec_command 两次，每次在当前实际工作目录运行 printf 'reviewer-switch' >> '${filename}'，
调用时均请求 sandbox_permissions=require_escalated。这是本次隔离测试的唯一文件，允许追加这两个标记。
第一次结果返回后再发起第二次，不要并行，不要合成一条命令，不要使用其它工具。完成后简短回复。`)
    const card = page.getByTestId('hil-card').last()
    await expect(card).toBeVisible({ timeout: TURN_COMPLETE_TIMEOUT_MS })
    const sessionId = (await liveStatus(page))?.activeSession
    const base = await apiBase(page)
    expect(sessionId).toBeTruthy()
    const workdir = await activeSessionWorkdir(page, sessionId!)
    expect(workdir).toBeTruthy()
    expect(realpathSync(workdir).startsWith(`${realpathSync(runtime.home)}${sep}`)).toBe(true)
    const protectedPath = join(workdir, filename)
    const switched = page.waitForResponse((response) =>
      response.url().endsWith(`/sessions/${sessionId}/mode`) && response.request().method() === 'POST')
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-safe_auto').click()
    expect(await (await switched).json()).toMatchObject({ active_mode: 'safe_auto', deferred: false })
    await expect(page.getByTestId('mode-application-dialog')).toHaveCount(0)
    await expect(card).toHaveAttribute('data-hil-resolved', 'false')
    await card.getByTestId('hil-permission-accept').click()
    let reviews: unknown[] = []
    await expect.poll(async () => {
      const history = await page.evaluate(async ({ base, sessionId }) => {
        const response = await fetch(`${base}/api/serve/history/${sessionId}`, { credentials: 'include' })
        if (!response.ok) throw new Error(`history read failed: ${response.status}`)
        return response.json()
      }, { base, sessionId })
      reviews = history.activity_events.filter((event: { type: string; data: { activity_type?: string } }) =>
        event.type === 'native_activity_completed' && event.data.activity_type === 'approval_review')
      return reviews.length
    }, { timeout: TURN_COMPLETE_TIMEOUT_MS }).toBeGreaterThan(0)
    await testInfo.attach('subsequent-native-auto-reviews', {
      body: JSON.stringify(reviews), contentType: 'application/json'
    })
    await waitForFinishedTurn(page)
    const completed = await permissionSnapshot(page, base, sessionId!)
    expect(completed.last_turn_status).toBe('completed')
    expect(completed.pending_hil).toHaveLength(0)
    expect(readFileSync(protectedPath, 'utf8')).toBe('reviewer-switchreviewer-switch')
    await page.getByTestId('ai-toggle-cover').click()
    await expect(page.getByTestId('mode-chip')).toHaveText('帮我批准')
    await page.screenshot({ path: join(runtime.artifacts, 'approval-reviewer-subsequent.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('native session-scope permission remains reachable in the dock', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { home: true, project: true, globalLib: true, pdf: true } }
  }))
  const target = join(runtime.root, 'session-scope.txt')
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
  try {
    const page = await desktop.launch()
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(true)
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-ask').click()
    await send(page, `请只使用 apply_patch，在项目可写范围外的隔离测试路径 ${target} 添加文件，
内容为 session-scope。必须实际提交补丁；需要授权时等待我批准，不改路径、不换工具。
补丁返回成功后直接简短回复，无需额外读取验证，验收程序会独立验证内容。`)
    const card = page.getByTestId('hil-card').last()
    await expect(card).toBeVisible({ timeout: TURN_COMPLETE_TIMEOUT_MS })
    const sessionGrant = card.getByTestId('hil-permission-acceptForSession')
    await page.screenshot({ path: join(runtime.artifacts, 'session-scope-pending.png') })
    const sessionId = (await liveStatus(page))?.activeSession
    const base = await apiBase(page)
    const snapshot = await permissionSnapshot(page, base, sessionId!)
    assert.ok(snapshot.pending_hil)
    await testInfo.attach('session-scope-offered-options', {
      body: JSON.stringify({ home: runtime.home, sessionId, options: snapshot.pending_hil.flatMap((item) => item.options ?? []) }),
      contentType: 'application/json'
    })
    await expect(sessionGrant).toBeVisible()
    await sessionGrant.click()
    await expect.poll(() => existsSync(target), { timeout: TURN_COMPLETE_TIMEOUT_MS }).toBe(true)
    expect(readFileSync(target, 'utf8').trim()).toBe('session-scope')
    await waitForFinishedTurn(page)
    await page.screenshot({ path: join(runtime.artifacts, 'session-scope-resolved.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('rejects a real command permission without writing the target', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(true)
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-safe_auto').click()
    await send(page, HIL_PROMPT)
    const card = page.getByTestId('hil-card').last()
    await expect(card).toBeVisible({ timeout: TURN_COMPLETE_TIMEOUT_MS })
    await expect(card).toHaveAttribute('data-hil-resolved', 'false')
    await page.screenshot({ path: join(runtime.artifacts, 'permission-pending.png') })
    await card.locator('button[data-hil-decision="deny"]').click()
    await expect(page.getByTestId('hil-card')).toHaveCount(0, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    })
    await expect.poll(async () => (await liveStatus(page))?.running, {
      timeout: TURN_COMPLETE_TIMEOUT_MS
    }).toBe(false)
    const status = await liveStatus(page)
    const workdir = await activeSessionWorkdir(page, status?.activeSession ?? null)
    expect(workdir).not.toBe('')
    const deniedPath = join(workdir, HIL_MARKER_FILE)
    expect(existsSync(deniedPath)).toBe(false)
    await page.screenshot({ path: join(runtime.artifacts, 'permission-denied.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('P0-5 restores the same persisted session after an Electron restart', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  const desktop = new DesktopSession(runtime, testInfo)
  const marker = `RESTART-RECALL-${randomUUID()}`
  const rememberPrompt = `请记住随机标记 ${marker}，本轮只回复“已记住”。`
  try {
    let page = await desktop.launch()
    await send(page, rememberPrompt)
    const original = await waitForFinishedTurn(page)
    await desktop.close()

    page = await desktop.launch()
    const base = await apiBase(page)
    const sessions = await page.evaluate(async (url) => {
      const response = await fetch(`${url}/api/serve/sessions?limit=20`)
      return (await response.json()).sessions as Array<{ session_id: string; title?: string }>
    }, base)
    const restored = sessions.find((session) => session.session_id === original.activeSession)
    expect(restored).toBeTruthy()
    await page.getByTestId('ai-session-toggle').click()
    await page.getByTestId(`ai-session-${original.activeSession}`).click()
    await expect(page.getByTestId('user-bubble')).toContainText(marker)
    await expect.poll(async () => page.evaluate(() => (
      window as typeof window & { __scholarseedLiveTurnStatus?: () => { activeSession: string | null } }
    ).__scholarseedLiveTurnStatus?.().activeSession ?? null)).toBe(original.activeSession)
    expect((await page.evaluate(() => (
      window as typeof window & { __scholarseedLiveTurnStatus?: () => { activeSession: string | null } }
    ).__scholarseedLiveTurnStatus?.().activeSession))).toBe(original.activeSession)
    await page.screenshot({ path: join(runtime.artifacts, 'history-after-restart.png') })

    const beforeRecall = await liveStatus(page)
    await send(page, '刚才要求你记住的随机标记是什么？只回复完整标记。')
    const recalled = await waitForFinishedTurn(page, beforeRecall?.lastSeq ?? 0)
    expect(recalled.activeSession).toBe(original.activeSession)
    await expect(page.locator('.md-agent').last()).toContainText(marker)
    await page.screenshot({ path: join(runtime.artifacts, 'recall-after-restart.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('P0-6 returns to a running session from skills and projects without losing its state', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(true)
    await send(page, NAVIGATION_PROMPT)
    await expect(page.getByTestId('composer-stop')).toBeVisible({ timeout: RUNTIME_READY_TIMEOUT_MS })
    const original = await liveStatus(page)
    expect(original?.running).toBe(true)
    expect(original?.activeSession).toBeTruthy()
    const session = page.getByTestId(`sidebar-session-${original?.activeSession}`)
    const composer = page.getByTestId('composer-input')
    await composer.fill(NAVIGATION_DRAFT)

    // MVP0.2 starts in the four-zone workbench. The activity rail no longer
    // carries a conversation-page button: the remaining public path into the
    // full 0.1 surface is a session hit in global search (openSession switches
    // mainView back to 'conversation'). Drive that real path, not a test-only hook.
    const sessionTitle = (await page.getByTestId('ai-session-title').innerText()).trim()
    await page.getByTestId('topbar-search').click()
    await page.getByTestId('global-search-input').fill(sessionTitle)
    await page.getByTestId(`search-hit-session-${original?.activeSession}`).click()
    await expect(page.getByTestId('sidebar-skills')).toBeVisible()
    await page.getByTestId('sidebar-skills').click()
    await expect(page.getByTestId('skills-page')).toBeVisible()
    await session.click()
    await page.screenshot({ path: join(runtime.artifacts, 'return-from-skills.png') })
    await expect(page.getByTestId('skills-page')).toHaveCount(0)
    await expect(composer).toHaveValue(NAVIGATION_DRAFT)
    await expect(page.locator('.conversation-main-body')).toHaveAttribute('aria-busy', 'false')
    expect(await liveStatus(page)).toMatchObject({ activeSession: original?.activeSession, running: true })

    // Repeated selection must not reset the draft or put an attached stream into resume-pending.
    await session.click()
    await expect(composer).toHaveValue(NAVIGATION_DRAFT)
    await expect(page.locator('.conversation-main-body')).toHaveAttribute('aria-busy', 'false')

    // Projects clears selection, unlike the skills overlay: cover the real reconnect path too.
    await page.getByTestId('sidebar-projects').click()
    await expect(page.getByTestId('projects-page')).toBeVisible()
    // The project page is a 0.2 workbench view and intentionally has no 0.1
    // conversation sidebar. Reopen the running session from the AI panel's
    // real multi-session menu instead of relying on a DOM node that is gone.
    await page.getByTestId('ai-session-toggle').click()
    await page.getByTestId(`ai-session-${original?.activeSession}`).click()
    await expect(page.getByTestId('user-bubble')).toContainText(NAVIGATION_PROMPT)
    await expect(page.getByTestId('ai-panel')).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'return-from-projects.png') })
    expect((await liveStatus(page))?.activeSession).toBe(original?.activeSession)

    await expect.poll(async () => (await liveStatus(page))?.running, {
      timeout: TURN_COMPLETE_TIMEOUT_MS
    }).toBe(false)
    expect(await liveStatus(page)).toMatchObject({ activeSession: original?.activeSession, status: 'done' })
    await expect(page.getByTestId('user-bubble')).toHaveCount(1)
    await page.screenshot({ path: join(runtime.artifacts, 'completed.png') })
    desktop.assertNoPageErrors()
  } finally {
    // Do not tear down the real backend halfway through a turn, including on assertion failure.
    try {
      if (desktop.page && (await liveStatus(desktop.page))?.running) {
        await expect.poll(async () => desktop.page && (await liveStatus(desktop.page))?.running, {
          timeout: TURN_COMPLETE_TIMEOUT_MS
        }).toBe(false)
      }
    } finally {
      await desktop.attachArtifacts()
    }
  }
})

test('a resume that gave up still retries when the session is selected again', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await send(page, GREETING)
    const original = await waitForFinishedTurn(page)
    const sessionId = original.activeSession
    expect(sessionId).toBeTruthy()
    const row = page.getByTestId(`sidebar-session-${sessionId}`)
    const body = page.locator('.conversation-main-body')
    const retry = page.getByTestId('session-resume-retry')

    // 故障只注入在网络层 (后端不可达 / 请求挂住)。真实 serve、真实会话与渲染进程恢复
    // 状态机全程在产品路径上, 没有任何一段被替换成假实现。
    let openFault: 'none' | 'hang' | 'abort' = 'none'
    let openAttempts = 0
    await page.route(SESSION_OPEN_ROUTE, async (route) => {
      openAttempts += 1
      const fault = openFault
      // hang 只作用于本次尝试: 下一次放行, 才能证明是客户端自己超时后重试接回的。
      if (fault === 'hang') openFault = 'none'
      if (fault === 'none') {
        await route.continue()
        return
      }
      if (fault === 'hang') await new Promise((resolve) => setTimeout(resolve, RESUME_HANG_MS))
      await route.abort().catch(() => undefined)
    })

    const reselect = async (): Promise<void> => {
      await page.getByTestId('sidebar-projects').click()
      await expect(page.getByTestId('projects-page')).toBeVisible()
      await row.click()
      await expect(page.getByTestId('projects-page')).toHaveCount(0)
    }

    // open 挂住时客户端必须自己封顶: 注入的挂起远长于断言窗口, 只有客户端超时后重试才能接回。
    openFault = 'hang'
    await reselect()
    await expect(body).toHaveAttribute('aria-busy', 'true')
    await expect(page.getByTestId('user-bubble')).toContainText(GREETING, {
      timeout: RESUME_TIMEOUT_RECOVERY_TIMEOUT_MS
    })
    await expect(body).toHaveAttribute('aria-busy', 'false')

    // 后端持续不可达: 恢复重试到上限后必须落在可操作的失败态, 而不是一直转圈。
    openFault = 'abort'
    await reselect()
    await expect(retry).toBeVisible({ timeout: RESUME_GIVEUP_TIMEOUT_MS })
    await expect(body).toHaveAttribute('aria-busy', 'false')
    const attemptsAfterGiveUp = openAttempts
    expect(attemptsAfterGiveUp).toBeGreaterThan(1)

    // 核心回归: 放弃恢复之后再次选中会话必须重新发起真实请求。旧实现在这里一个请求都不发,
    // 界面永久停在「正在恢复对话」, 而唯一的自救按钮又被加载态挡住。
    await reselect()
    await expect.poll(() => openAttempts, { timeout: RESUME_GIVEUP_TIMEOUT_MS })
      .toBeGreaterThan(attemptsAfterGiveUp)
    await expect(retry).toBeVisible({ timeout: RESUME_GIVEUP_TIMEOUT_MS })
    await expect(body).toHaveAttribute('aria-busy', 'false')
    await page.screenshot({ path: join(runtime.artifacts, 'resume-gave-up.png') })

    // 后端恢复后同一个会话必须真的把对话接回来。
    openFault = 'none'
    await retry.click()
    await expect(page.getByTestId('user-bubble')).toContainText(GREETING)
    await expect(body).toHaveAttribute('aria-busy', 'false')
    expect((await liveStatus(page))?.activeSession).toBe(sessionId)
    await page.screenshot({ path: join(runtime.artifacts, 'resume-recovered.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('foreground errors clear when navigating away from the failed action', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  const desktop = new DesktopSession(runtime, testInfo)
  let sessionId: string | null = null
  const destinations = [
    { name: 'new-chat', entry: 'sidebar-new-chat', surface: 'composer-input' },
    { name: 'skills', entry: 'sidebar-skills', surface: 'skills-page' },
    { name: 'projects', entry: 'sidebar-projects', surface: 'projects-page' },
    { name: 'settings', entry: 'settings-toggle', surface: 'account-settings-shell' }
  ] as const
  try {
    const page = await desktop.launch()
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(true)
    for (const destination of destinations) {
      // A fast provider can finish between navigation steps: start another real turn if needed.
      if (!(await liveStatus(page))?.running) await send(page, NAVIGATION_PROMPT)
      await expect(page.getByTestId('composer-stop')).toBeVisible({ timeout: RUNTIME_READY_TIMEOUT_MS })
      sessionId = (await liveStatus(page))?.activeSession ?? null
      expect(sessionId).toBeTruthy()
      // 错误源用「超限附件」而不是切权限: 权限模式选择在 turn 运行中仍可保存，若需重绑
      // runtime 则延后到下一轮，不再产生前台错误。附件超限是运行中依然确定
      // 失败的真实产品路径。
      await page.getByTestId('composer-file-input').setInputFiles({
        name: 'oversized-attachment.bin',
        mimeType: 'application/octet-stream',
        buffer: Buffer.alloc(OVERSIZED_ATTACHMENT_BYTES)
      })
      const error = page.getByTestId('foreground-error')
      await expect(error).toContainText('附件')
      // Editing on the same page must not hide a failure that the user still needs to see.
      await page.getByTestId('composer-input').fill(NAVIGATION_DRAFT)
      await expect(error).toBeVisible()
      await page.screenshot({ path: join(runtime.artifacts, `${destination.name}-before.png`) })

      await page.getByTestId(destination.entry).click()
      await expect(page.getByTestId(destination.surface)).toBeVisible()
      if (destination.name === 'new-chat') expect((await liveStatus(page))?.activeSession).toBeNull()
      await expect(error).toHaveCount(0)
      await page.screenshot({ path: join(runtime.artifacts, `${destination.name}-after.png`) })

      if (destination.name === 'settings') await page.getByTestId('account-settings-back').click()
      await page.getByTestId(`sidebar-session-${sessionId}`).click()
      await expect(page.locator('.conversation-main-body')).toHaveAttribute('aria-busy', 'false')
      await expect(page.getByTestId('user-bubble').first()).toContainText(NAVIGATION_PROMPT)
      await expect(error).toHaveCount(0)
      expect((await liveStatus(page))?.activeSession).toBe(sessionId)
    }
    await expect.poll(async () => (await liveStatus(page))?.running, {
      timeout: TURN_COMPLETE_TIMEOUT_MS
    }).toBe(false)
    expect(await liveStatus(page)).toMatchObject({ activeSession: sessionId, status: 'done' })
    await page.screenshot({ path: join(runtime.artifacts, 'completed.png') })

    await desktop.close()
    const restarted = await desktop.launch()
    await expect.poll(async () => (await liveStatus(restarted))?.runtimeReady, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(true)
    await restarted.getByTestId(`sidebar-session-${sessionId}`).click()
    await expect(restarted.locator('.conversation-main-body')).toHaveAttribute('aria-busy', 'false', {
      timeout: RUNTIME_READY_TIMEOUT_MS
    })
    await expect(restarted.getByTestId('user-bubble').first()).toContainText(NAVIGATION_PROMPT)
    await expect(restarted.getByTestId('foreground-error')).toHaveCount(0)
    await restarted.screenshot({ path: join(runtime.artifacts, 'after-restart.png') })
    desktop.assertNoPageErrors()
  } finally {
    // Selection can be cleared while the original turn is still running in the background.
    try {
      if (desktop.page && sessionId) {
        const page = desktop.page
        const base = await apiBase(page)
        await expect.poll(async () => page.evaluate(async ({ base, sid }) => {
          const response = await fetch(`${base}/api/serve/sessions`)
          return (await response.json()).sessions.find((entry: { session_id: string }) => entry.session_id === sid)?.running
        }, { base, sid: sessionId }), { timeout: TURN_COMPLETE_TIMEOUT_MS }).toBe(false)
      }
    } finally {
      await desktop.attachArtifacts()
    }
  }
})

test('todo state follows an interrupted continuation and rejected permission', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  const desktop = new DesktopSession(runtime, testInfo)
  const deniedPath = join(runtime.root, 'todo-permission-denied.txt')
  let sessionId: string | null = null
  try {
    let page = await desktop.launch()
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(true)
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-safe_auto').click()

    await send(page, TODO_PLAN_PROMPT)
    await expect.poll(async () => page.locator('.todo-row').count(), {
      timeout: TURN_COMPLETE_TIMEOUT_MS
    }).toBeGreaterThan(1)
    await expect(page.getByTestId('todo-mark-running').first()).toBeVisible()
    sessionId = (await liveStatus(page))?.activeSession ?? null
    expect(sessionId).toBeTruthy()
    const base = await apiBase(page)
    const planTurnId = await page.evaluate(async ({ api, sid }) => {
      const response = await fetch(`${api}/api/serve/history/${sid}`)
      return (await response.json()).todo_turn_id as string | null
    }, { api: base, sid: sessionId })
    expect(planTurnId).toBeTruthy()
    await page.screenshot({ path: join(runtime.artifacts, 'todo-running.png') })

    await page.getByTestId('composer-stop').click()
    await expect.poll(async () => (await liveStatus(page))?.running, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(false)
    await expect(page.getByTestId('todo-mark-failed').first()).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'todo-interrupted.png') })

    await send(page, `继续执行现有计划，不要重新规划。请通过 Codex 原生 commandExecution（bash 命令执行），不要调用名为 exec 的动态工具；只执行 printf '${TODO_DENIED_CONTENT}' > '${deniedPath}'。目标在当前工作目录之外，必须发起权限申请；如果我拒绝，立即停止本轮，不要改用其他工具或路径。`)
    const card = page.getByTestId('hil-card').last()
    await expect(card).toBeVisible({ timeout: TURN_COMPLETE_TIMEOUT_MS })
    await expect(card).toHaveAttribute('data-hil-resolved', 'false')
    await expect(page.getByTestId('todo-mark-need').first()).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'todo-awaiting-permission.png') })
    await card.locator('button[data-hil-decision="deny"]').click()
    await expect(page.getByTestId('todo-mark-failed').first()).toBeVisible({
      timeout: RUNTIME_READY_TIMEOUT_MS
    })
    await page.screenshot({ path: join(runtime.artifacts, 'todo-permission-denied.png') })
    expect(existsSync(deniedPath)).toBe(false)

    const persistedPlanTurnId = await page.evaluate(async ({ api, sid }) => {
      const response = await fetch(`${api}/api/serve/history/${sid}`)
      return (await response.json()).todo_turn_id as string | null
    }, { api: base, sid: sessionId })
    expect(persistedPlanTurnId).toBe(planTurnId)

    await expect.poll(async () => (await liveStatus(page))?.running, {
      timeout: TURN_COMPLETE_TIMEOUT_MS
    }).toBe(false)
    await desktop.close()
    page = await desktop.launch()
    await page.getByTestId(`sidebar-session-${sessionId}`).click()
    await expect(page.locator('.conversation-main-body')).toHaveAttribute('aria-busy', 'false', {
      timeout: RUNTIME_READY_TIMEOUT_MS
    })
    await expect(page.getByTestId('todo-mark-failed').first()).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'todo-failed-after-restart.png') })
    desktop.assertNoPageErrors()
  } finally {
    try {
      if (desktop.page && sessionId && (await liveStatus(desktop.page))?.running) {
        const page = desktop.page
        const base = await apiBase(page)
        await page.evaluate(async ({ api, sid }) => {
          await fetch(`${api}/api/serve/sessions/${sid}/interrupt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          })
        }, { api: base, sid: sessionId })
      }
    } finally {
      await desktop.attachArtifacts()
    }
  }
})
