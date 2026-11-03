import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

import { apiBase, DesktopSession, liveStatus, waitForFinishedTurn } from './fixtures/electron'
import { createReadyProject } from './fixtures/projects'
import { createRuntime, seedLiveConfig } from './fixtures/runtime'
import { importBibliography } from './fixtures/workbench'

const READY_TIMEOUT_MS = 45_000
const TURN_TIMEOUT_MS = 180_000
const DELIVERY_TIMEOUT_MS = 360_000
const RUNNING_COMMAND_DELAY_SECONDS = 60
const COMPLETION_MARKER = 'LIFECYCLE_DELIVERY_COMPLETE'
const RESTORE_MARKER = 'ARCHIVE_CONTEXT_RESTORED'
const INTERNAL_FILES = ['internal-worker.py', 'tool-response.json', 'execution.log']

async function send(page: Page, message: string): Promise<void> {
  await page.getByTestId('composer-input').fill(message)
  await page.getByTestId('composer-send').click()
}

async function enterProject(page: Page, name: string): Promise<void> {
  await page.getByTestId('activity-home').click()
  await page.getByTestId(`home-project-${name}`).click()
  await expect
    .poll(async () => (await liveStatus(page))?.runtimeReady, {
      timeout: READY_TIMEOUT_MS,
    })
    .toBe(true)
}

async function taskMenu(page: Page, sessionId: string): Promise<void> {
  await page.getByTestId(`project-task-${sessionId}`).hover()
  await page
    .getByTestId(`project-task-${sessionId}`)
    .getByRole('button', {
      name: '任务操作',
      exact: true,
    })
    .click()
}

async function expectProjectTaskRead(page: Page, sessionId: string): Promise<void> {
  const base = await apiBase(page)
  await expect
    .poll(async () => {
      const response = await page.request.get(`${base}/api/serve/attention`)
      return (await response.json()).items.filter(
        (item: { session_id: string }) => item.session_id === sessionId
      ).length
    })
    .toBe(0)
  const row = page.getByTestId(`project-task-${sessionId}`)
  await expect(row).toBeVisible()
  await expect(row.locator('[aria-label="已完成 · 未查看"]')).toHaveCount(0)
  await expect(row.locator('[aria-label="已完成 · 已查看"]')).toHaveCount(0)
}

async function archive(page: Page, sessionId: string): Promise<void> {
  await taskMenu(page, sessionId)
  await page.getByTestId('project-task-archive').click()
  await expect(page.getByTestId('task-archive-confirm')).toContainText('停止')
  await page.getByTestId('task-archive-submit').click()
  await expect(page.getByTestId('task-archive-confirm')).toHaveCount(0, {
    timeout: READY_TIMEOUT_MS,
  })
  await expect(page.getByTestId(`project-task-${sessionId}`)).toHaveCount(0)
  const toggle = page.getByTestId('project-archive-toggle')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(page.getByTestId(`project-archived-task-${sessionId}`)).toBeVisible()
}

test('deliverable classification, overview, archive, pin restoration and deletion preserve independent sources', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
  try {
    const page = await desktop.launch()
    await desktop.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus())
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
    const project = await createReadyProject(page, '产物归档删除验收')
    const inputPath = join(project.root, 'resources', 'original-input.md')
    writeFileSync(inputPath, '原始测量记录：3组样本，每组7个。original-input-preserved。')
    const bibliography = join(project.root, 'original.bib')
    writeFileSync(
      bibliography,
      '@article{original,title={Original preserved bibliography},year={2026}}'
    )
    const papers = await importBibliography(page, project.id, [bibliography])
    await page.reload()
    await enterProject(page, project.name)
    await page.getByTestId('task-overview-toggle').click()
    await expect(page.getByTestId('task-overview').getByText('暂无', { exact: true })).toHaveCount(
      2
    )
    await expect(page.getByTestId('task-overview-directory')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await send(
      page,
      `根据本项目的original-input.md计算样本总数。请交付final-report.md最终报告和用户可直接运行的deliverable.py代码；另交付stage-draft.md作为供我独立审阅的阶段草稿，明确区分阶段交付和最终交付。为了处理数据，在会话工作目录另外实际创建${INTERNAL_FILES.join('、')}，这些仅作内部执行文件，不作为交付产物。原始资料只读，不重复交付，不导入资料库。完成后最后一行回复${COMPLETION_MARKER}。`
    )
    await expect(page.locator('.answer-annotation-root').last()).toContainText(COMPLETION_MARKER, {
      timeout: DELIVERY_TIMEOUT_MS,
    })
    const status = await waitForFinishedTurn(page)
    const sessionId = status.activeSession!
    const base = await apiBase(page)
    const history = await page.request.get(`${base}/api/serve/history/${sessionId}`)
    expect(history.ok()).toBe(true)
    const payload = await history.json()
    const artifacts = payload.artifacts as Array<{
      artifact_id: string
      name: string
      path: string
      absolute_path?: string
      role?: string
      publication_id?: string
    }>
    const deliverables = artifacts.filter(
      (item) =>
        item.publication_id && ['final', 'supporting', 'intermediate'].includes(item.role ?? '')
    )
    expect(deliverables.map((item) => item.name).sort()).toEqual([
      'deliverable.py',
      'final-report.md',
      'stage-draft.md',
    ])
    expect(deliverables.find((item) => item.name === 'stage-draft.md')?.role).toBe('intermediate')
    const report = deliverables.find((item) => item.name === 'final-report.md')!
    const catalog = await page.request.get(
      `${base}/api/serve/sessions?scope=project&project_path=${encodeURIComponent(project.root)}&limit=60`
    )
    const savedSession = (await catalog.json()).sessions.find(
      (item: { session_id: string }) => item.session_id === sessionId
    )
    const workdir = savedSession.runtime_workdir as string
    expect(workdir).toBeTruthy()
    for (const filename of INTERNAL_FILES) expect(existsSync(join(workdir, filename))).toBe(true)
    await page.getByTestId('task-overview-toggle').click()
    await expect(page.getByTestId('task-overview-outputs')).toContainText('final-report.md')
    await expect(page.getByTestId('task-overview-outputs')).toContainText('deliverable.py')
    await expect(page.getByTestId('task-overview-process')).toContainText('stage-draft.md')
    for (const filename of [...INTERNAL_FILES, 'original-input.md']) {
      await expect(page.getByTestId('task-overview-outputs')).not.toContainText(filename)
      await expect(page.getByTestId('task-overview-process')).not.toContainText(filename)
    }
    await page.screenshot({ path: testInfo.outputPath('classified-overview.png') })
    await page.getByTestId('task-overview-directory').click()
    if (process.platform === 'darwin') {
      await expect
        .poll(() =>
          execFileSync(
            '/usr/bin/osascript',
            [
              '-e',
              'tell application "Finder" to get POSIX path of (target of front window as alias)',
            ],
            { encoding: 'utf8' }
          )
            .trim()
            .replace(/\/$/, '')
        )
        .toBe(workdir)
    }
    await desktop.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus())
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
    await page.keyboard.press('Escape')
    const card = page.getByTestId(`turn-artifact-${report.artifact_id}`)
    await expect(card).toBeVisible()
    for (const artifact of deliverables) {
      const deliveryCard = page.getByTestId(`turn-artifact-${artifact.artifact_id}`)
      if (artifact.role === 'intermediate') await expect(deliveryCard).toHaveCount(0)
      else await expect(deliveryCard).toBeVisible()
    }
    for (const filename of INTERNAL_FILES)
      await expect(page.getByTestId('turn-artifacts')).not.toContainText(filename)
    await card.getByTestId('artifact-import-resources').click()
    const save = page.getByRole('dialog')
    await expect(save).toBeVisible()
    await save.getByRole('button', { name: '导入', exact: true }).click()
    await expect(save).toHaveCount(0)
    await page.getByTestId('project-library').click()
    await page
      .getByTestId('project-library-content')
      .getByRole('tab', { name: '任务产物', exact: true })
      .click()
    const outputs = page.getByTestId('project-outputs')
    await expect(outputs).toContainText('final-report.md')
    await expect(outputs).toContainText('stage-draft.md')
    await expect(outputs).toContainText('deliverable.py')
    for (const filename of [...INTERNAL_FILES, 'original-input.md'])
      await expect(outputs).not.toContainText(filename)
    await page.screenshot({ path: testInfo.outputPath('classified-project-outputs.png') })
    await taskMenu(page, sessionId)
    await page.getByRole('menuitem', { name: '置顶', exact: true }).click()
    await expect(page.getByTestId('project-task-list')).toContainText(savedSession.title)
    await archive(page, sessionId)
    const archived = page.getByTestId(`project-archived-task-${sessionId}`)
    await archived.getByRole('button').first().click()
    const readonly = page.getByTestId('archived-conversation')
    await expect(readonly).toContainText(COMPLETION_MARKER)
    await expect(readonly.getByRole('textbox')).toBeDisabled()
    await page.screenshot({ path: testInfo.outputPath('archived-readonly-deliverables.png') })
    await archived.hover()
    await archived.getByRole('button', { name: '恢复任务', exact: true }).click()
    await expect(
      page.getByTestId('project-task-list').getByTestId(`project-task-${sessionId}`)
    ).toBeVisible()
    await expect(page.getByTestId('composer-input')).toBeEnabled()
    await send(page, `不要调用工具，只根据已有对话回答样本总数，并附上${RESTORE_MARKER}。`)
    await expect(page.locator('.answer-annotation-root').last()).toContainText(RESTORE_MARKER, {
      timeout: TURN_TIMEOUT_MS,
    })
    await waitForFinishedTurn(page)
    await archive(page, sessionId)
    const deletionRow = page.getByTestId(`project-archived-task-${sessionId}`)
    await deletionRow.hover()
    await deletionRow.getByRole('button', { name: '删除任务', exact: true }).click()
    const confirmation = page.getByTestId('session-delete-confirm')
    await expect(confirmation).toContainText('不可恢复')
    await confirmation.getByRole('button', { name: '取消', exact: true }).click()
    await expect(deletionRow).toBeVisible()
    expect(existsSync(workdir)).toBe(true)
    await deletionRow.hover()
    await deletionRow.getByRole('button', { name: '删除任务', exact: true }).click()
    await confirmation.getByRole('button', { name: '删除', exact: true }).click()
    await expect(confirmation).toHaveCount(0, { timeout: READY_TIMEOUT_MS })
    await expect(deletionRow).toHaveCount(0)
    await expect.poll(() => existsSync(workdir)).toBe(false)
    expect(readFileSync(inputPath, 'utf8')).toContain('original-input-preserved')
    const retained = await page.request.get(
      `${base}/api/v1/literatures/${papers[0]}?project_id=${project.id}`
    )
    expect(retained.ok()).toBe(true)
    await page.getByTestId('project-library').click()
    await page
      .getByTestId('project-library-content')
      .getByRole('tab', { name: '任务产物', exact: true })
      .click()
    await expect(page.getByTestId('project-outputs')).not.toContainText('final-report.md')
    await page
      .getByTestId('project-library-content')
      .getByRole('tab', { name: '资料', exact: true })
      .click()
    await page.getByTestId('material-resources/final-report.md').dblclick()
    await expect(page.locator('.ProseMirror')).toContainText('21')
    await expect(page.getByTestId('resource-agent-origin-deleted')).toBeVisible()
    await expect(page.getByTestId('resource-agent-origin')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('deleted-task-independent-copy.png') })
    desktop.assertNoPageErrors()
  } finally {
    if (desktop.page)
      await desktop.page.screenshot({ path: testInfo.outputPath('final-state.png') })
    await desktop.attachArtifacts()
  }
})

test('real permission, running and stopped tasks agree across home and project while archiving cancels queued work', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
  try {
    const page = await desktop.launch()
    await desktop.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus())
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
    const project = await createReadyProject(page, '状态与运行归档验收')
    await page.reload()
    await enterProject(page, project.name)
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-ask').click()
    await send(
      page,
      '请调用exec_command在当前会话工作目录运行printf PERMISSION_STATE_COMPLETE > permission-state.txt，并请求sandbox_permissions=require_escalated。获得允许后完成写入，最后回复PERMISSION_STATE_COMPLETE。'
    )
    const approval = page.getByTestId('hil-card').last()
    await expect(approval).toBeVisible({ timeout: TURN_TIMEOUT_MS })
    const sessionId = (await liveStatus(page))!.activeSession!
    const row = page.getByTestId(`project-task-${sessionId}`)
    await expect(row.locator('[aria-label="等待中"]')).toBeVisible()
    await page.getByRole('button', { name: '返回项目中心', exact: true }).click()
    await expect(
      page.getByTestId(`home-task-${sessionId}`).locator('[aria-label="等待中"]')
    ).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('waiting-home.png') })
    await page.getByTestId(`home-task-${sessionId}`).click()
    await approval.locator('button[data-hil-decision="allow-once"]').click()
    await expect(page.locator('.answer-annotation-root').last()).toContainText(
      'PERMISSION_STATE_COMPLETE',
      { timeout: TURN_TIMEOUT_MS }
    )
    await waitForFinishedTurn(page)
    await expectProjectTaskRead(page, sessionId)
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-bypassPermissions').click()
    await page.getByTestId('mode-bypassPermissions-confirm').click()
    await send(
      page,
      `请实际用shell运行python：先在本会话工作目录写started.txt，内容STARTED；然后等待${RUNNING_COMMAND_DELAY_SECONDS}秒；最后写should-not-finish.txt，内容FINISHED。等待命令完成后再回答，不提前返回。`
    )
    await expect(page.getByTestId('composer-stop')).toBeVisible({ timeout: READY_TIMEOUT_MS })
    const base = await apiBase(page)
    const workdirResponse = await page.request.get(
      `${base}/api/serve/sessions?scope=project&project_path=${encodeURIComponent(project.root)}&limit=60`
    )
    const workdir = (await workdirResponse.json()).sessions.find(
      (item: { session_id: string }) => item.session_id === sessionId
    ).runtime_workdir as string
    await expect
      .poll(() => existsSync(join(workdir, 'started.txt')), { timeout: TURN_TIMEOUT_MS })
      .toBe(true)
    const commandStartedAt = Date.now()
    await row.getByRole('button').first().click()
    await row.hover()
    await expect(row.locator('[aria-label="进行中"]')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('running-focused.png') })
    await page.getByRole('button', { name: '返回项目中心', exact: true }).click()
    await expect(
      page.getByTestId(`home-task-${sessionId}`).locator('[aria-label="进行中"]')
    ).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('running-home.png') })
    await page.getByTestId(`home-task-${sessionId}`).click()
    await page
      .getByTestId('composer-input')
      .fill('这是排队请求，请创建queued-should-not-run.txt，内容QUEUED。')
    await page.getByTestId('composer-input').press('Enter')
    await expect(page.getByTestId('composer-message-queue')).toContainText(
      'queued-should-not-run.txt'
    )
    await taskMenu(page, sessionId)
    await page.getByTestId('project-task-archive').click()
    await page
      .getByTestId('task-archive-confirm')
      .getByRole('button', { name: '取消', exact: true })
      .last()
      .click()
    await expect(page.getByTestId('composer-stop')).toBeVisible()
    await expect(page.getByTestId('composer-message-queue')).toContainText(
      'queued-should-not-run.txt'
    )
    await archive(page, sessionId)
    const archived = page.getByTestId(`project-archived-task-${sessionId}`)
    await archived.getByRole('button').first().click()
    await expect(page.getByTestId('archived-conversation').getByRole('textbox')).toBeDisabled()
    await expect(page.getByTestId('archived-conversation')).toContainText('started.txt', {
      timeout: READY_TIMEOUT_MS,
    })
    expect(existsSync(join(workdir, 'started.txt'))).toBe(true)
    expect(existsSync(join(workdir, 'should-not-finish.txt'))).toBe(false)
    expect(existsSync(join(workdir, 'queued-should-not-run.txt'))).toBe(false)
    await page.screenshot({ path: testInfo.outputPath('running-queued-stopped-archive.png') })
    await archived.hover()
    await archived.getByRole('button', { name: '恢复任务', exact: true }).click()
    await expect(row.locator('[aria-label="暂停中"]')).toBeVisible()
    await expect(page.getByTestId('composer-message-queue')).toHaveCount(0)
    await expect.poll(async () => (await liveStatus(page))?.running).toBe(false)
    await page.getByRole('button', { name: '返回项目中心', exact: true }).click()
    await expect(
      page.getByTestId(`home-task-${sessionId}`).locator('[aria-label="暂停中"]')
    ).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('paused-home.png') })
    await page.getByTestId(`home-task-${sessionId}`).click()
    await send(
      page,
      '取消此前所有未完成和排队请求，不再运行它们，不调用工具。只回复：停止归档后可以继续。'
    )
    await expect(page.locator('.answer-annotation-root').last()).toContainText(
      '停止归档后可以继续',
      { timeout: TURN_TIMEOUT_MS }
    )
    await waitForFinishedTurn(page)
    await expect
      .poll(() => Date.now() - commandStartedAt, {
        timeout: TURN_TIMEOUT_MS,
      })
      .toBeGreaterThanOrEqual(RUNNING_COMMAND_DELAY_SECONDS * 1_000)
    expect(existsSync(join(workdir, 'should-not-finish.txt'))).toBe(false)
    expect(existsSync(join(workdir, 'queued-should-not-run.txt'))).toBe(false)
    await expectProjectTaskRead(page, sessionId)
    await page.screenshot({ path: testInfo.outputPath('restored-conversation-completed.png') })
    desktop.assertNoPageErrors()
  } finally {
    if (desktop.page)
      await desktop.page.screenshot({ path: testInfo.outputPath('final-state.png') })
    await desktop.attachArtifacts()
  }
})

test('background task completion remains unread independently until each real conversation is viewed', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
  try {
    const page = await desktop.launch()
    await desktop.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus())
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
    const project = await createReadyProject(page, '完成未读独立清除验收')
    await page.reload()
    await enterProject(page, project.name)
    const identifiers: string[] = []
    for (const marker of ['UNREAD_ALPHA_COMPLETE', 'UNREAD_BETA_COMPLETE']) {
      await send(page, `请实际运行shell等待15秒，再只回复${marker}。不要创建文件。`)
      await expect
        .poll(async () => (await liveStatus(page))?.activeSession, { timeout: READY_TIMEOUT_MS })
        .toBeTruthy()
      await expect(page.getByTestId('composer-stop')).toBeVisible({ timeout: READY_TIMEOUT_MS })
      identifiers.push((await liveStatus(page))!.activeSession!)
      await page.getByTestId('project-new-task').click()
      await expect(page.getByTestId('user-bubble')).toHaveCount(0)
    }
    expect(new Set(identifiers).size).toBe(2)
    const base = await apiBase(page)
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`${base}/api/serve/attention`)
          const attention = await response.json()
          return identifiers.map((id) =>
            attention.items.some(
              (item: { session_id: string; kind: string }) =>
                item.session_id === id && item.kind === 'completed'
            )
          )
        },
        { timeout: TURN_TIMEOUT_MS }
      )
      .toEqual([true, true])
    await page.getByRole('button', { name: '返回项目中心', exact: true }).click()
    for (const id of identifiers)
      await expect(
        page.getByTestId(`home-task-${id}`).locator('[aria-label="已完成 · 未查看"]')
      ).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('two-background-completions-unread.png') })
    await page.getByTestId(`home-task-${identifiers[0]}`).click()
    await expect(page.locator('.answer-annotation-root').last()).toContainText(
      'UNREAD_ALPHA_COMPLETE'
    )
    await expectProjectTaskRead(page, identifiers[0])
    await expect(
      page.getByTestId(`project-task-${identifiers[1]}`).locator('[aria-label="已完成 · 未查看"]')
    ).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('only-viewed-task-read.png') })
    await page.getByTestId(`project-task-${identifiers[1]}`).getByRole('button').first().click()
    await expect(page.locator('.answer-annotation-root').last()).toContainText(
      'UNREAD_BETA_COMPLETE'
    )
    await expect
      .poll(async () => {
        const response = await page.request.get(`${base}/api/serve/attention`)
        return (await response.json()).unread_count
      })
      .toBe(0)
    await page.getByRole('button', { name: '返回项目中心', exact: true }).click()
    for (const id of identifiers)
      await expect(
        page.getByTestId(`home-task-${id}`).locator('[aria-label="已完成 · 已查看"]')
      ).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('all-completions-viewed.png') })
    desktop.assertNoPageErrors()
  } finally {
    if (desktop.page)
      await desktop.page.screenshot({ path: testInfo.outputPath('final-state.png') })
    await desktop.attachArtifacts()
  }
})
