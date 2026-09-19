import { _electron as electron, expect, test } from '@playwright/test'
import { createServer, type Server } from 'http'
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

import { seedRendererLanguage } from './fixtures/runtime'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const DESKTOP_ROOT = join(REPO_ROOT, 'apps', 'desktop')
const PYTHON = join(REPO_ROOT, '.venv', 'bin', 'python')
const UPDATE_VERSION = '0.2.1'
const UPDATE_BUILD_NUMBER = '202608271500'
const CLIENT_BUILD_NUMBER = '202608270900'
const UPDATE_TEAM_ID = 'ABCD123456'
const SHA512 = 'a'.repeat(128)
const PRODUCT_WINDOW_TIMEOUT_MS = 45_000

async function closeServer(server: Server | null): Promise<void> {
  if (!server) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

// local lane 不是更新目标（product.ts 只对 distribution + darwin 强制签名身份），所以
// 这个 spec 验的是「不支持更新，但支持调试」这条已裁决的行为：自动检查一律短路、更新
// 入口不出现、关于页给出只读诊断通道。六态渲染需要 distribution lane，而它强制
// https 更新地址 + system_keychain 凭据档，本地 mock 服务器结构上喂不进去。
test('local lane skips update checks and still offers the read-only diagnosis', async ({}, testInfo) => {
  let checkRequests = 0
  const server = createServer((request, response) => {
    if (!request.url?.startsWith('/api/v1/updates/check?')) {
      response.writeHead(404).end()
      return
    }
    checkRequests += 1
    const url = new URL(request.url, 'http://127.0.0.1')
    const expected = {
      product: 'scholarseed',
      version: '0.2.0',
      build_number: CLIENT_BUILD_NUMBER,
      channel: 'release',
      arch_type: process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x86_64'
    }
    for (const [key, value] of Object.entries(expected)) {
      if (url.searchParams.get(key) !== value) {
        response.writeHead(400).end(JSON.stringify({ error: `unexpected ${key}` }))
        return
      }
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      has_update: true,
      latest: {
        id: 'scholarseed-update-ui-acceptance',
        version: UPDATE_VERSION,
        build_number: UPDATE_BUILD_NUMBER,
        product_id: 'scholarseed',
        bundle_id: 'com.scholarseed.desktop',
        arch_type: expected.arch_type,
        team_id: UPDATE_TEAM_ID,
        channel: 'release',
        file_size: 42,
        sha512: SHA512,
        release_notes: '检索式回看、入库选分类、稳定性修复'
      }
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('update contract server did not bind')

  const appRoot = testInfo.outputPath('desktop-app')
  const artifacts = testInfo.outputPath('artifacts')
  // serve 会在 home 下绑 AF_UNIX socket（home/.scholarseed/… + endpoint-<8 随机> + api.sock，
  // 约再拼 35 字符），macOS 上限 104；而 macOS 的 tmpdir() 自身就 49 字符。所以标签必须
  // 压到最短，playwright 输出目录那种哈希路径更是必然超限、后端直接 OSError 起不来。
  const runTag = `su${process.pid}`
  const home = join(tmpdir(), `${runTag}-h`)
  const workspace = join(tmpdir(), `${runTag}-w`)
  const userData = join(tmpdir(), `${runTag}-u`)
  for (const directory of [appRoot, home, workspace, userData, artifacts]) {
    mkdirSync(directory, { recursive: true })
  }
  copyFileSync(join(DESKTOP_ROOT, 'package.json'), join(appRoot, 'package.json'))
  cpSync(join(DESKTOP_ROOT, 'out'), join(appRoot, 'out'), { recursive: true })
  // runtime/codex.cjs 把 vendor 根锚在 resolve(desktopRoot, '..', '..', 'scripts/vendor/codex')。
  // 本用例的 app 根在 playwright 输出目录里，上两级不是仓库根，后端会因读不到
  // codex manifest 而起不来。符号链接只落在测试输出目录，比拷 363MB 的 vendor 便宜。
  const vendorAnchor = resolve(appRoot, '..', '..', 'scripts')
  if (!existsSync(vendorAnchor)) {
    symlinkSync(join(REPO_ROOT, 'scripts'), vendorAnchor, 'dir')
  }
  mkdirSync(join(appRoot, 'resources'), { recursive: true })
  // product.ts 的策略校验是 fail-closed 的：缺 runtimes / credential_profiles 会让整份
  // 配置解析抛错、后端起不来、渲染进程卡在启动屏。所以以仓库配置为底，只覆盖本用例
  // 需要的字段 —— 以后 product.ts 再加必填项也不会悄悄弄坏这条用例。
  const productBase = JSON.parse(
    readFileSync(join(DESKTOP_ROOT, 'resources', 'product.json'), 'utf8')
  ) as Record<string, unknown>
  writeFileSync(join(appRoot, 'resources', 'product.json'), `${JSON.stringify({
    ...productBase,
    release_lane: 'local',
    update_channel: 'release',
    update_base_url: `http://127.0.0.1:${address.port}`,
    build_number: CLIENT_BUILD_NUMBER,
    expected_team_id: UPDATE_TEAM_ID,
    auth_mode: 'off',
    account_base_url: ''
  }, null, 2)}\n`)
  writeFileSync(join(home, '.adopted-from-veda'), 'isolated update acceptance\n')
  // 本 spec 自建 userData、不走 createRuntime，语言要单独播种：下面的断言直接匹配中文文案。
  seedRendererLanguage(userData)

  const desktopLog = join(artifacts, 'desktop.log')
  const app = await electron.launch({
    args: [appRoot, `--user-data-dir=${userData}`],
    cwd: DESKTOP_ROOT,
    env: {
      ...process.env,
      SCHOLARSEED_HOME: home,
      DAMOAGENT_HOME: home,
      DAMOAGENT_PROJECT_DIRNAME: '.scholarseed',
      SCHOLARSEED_DEFAULT_WORKSPACE: workspace,
      SCHOLARSEED_DESKTOP_AUTH: 'off',
      SCHOLARSEED_REPO: REPO_ROOT,
      SCHOLARSEED_PYTHON: PYTHON
    }
  })
  app.process().stdout?.on('data', (chunk) => appendFileSync(desktopLog, chunk))
  app.process().stderr?.on('data', (chunk) => appendFileSync(desktopLog, chunk))
  try {
    await expect.poll(
      () => app.windows().find((candidate) => candidate.url().startsWith('http://'))?.url() ?? '',
      { timeout: PRODUCT_WINDOW_TIMEOUT_MS }
    ).not.toBe('')
    const page = app.windows().find((candidate) => candidate.url().startsWith('http://'))
    if (!page) throw new Error('ScholarSeed product window did not open')
    // 0.2 首屏是工作台：composer 在默认收起的 AI 面板里，活动栏才是恒在的就绪信号。
    await page.screenshot({ path: join(artifacts, 'step-window.png') })
    await expect(page.getByTestId('activity-account')).toBeVisible()

    // PRD 第 1 条：未发现新版本时不展示更新入口。local lane 根本不做检查，所以入口恒不出现。
    await expect(page.getByTestId('update-entry')).toHaveCount(0)
    await expect(page.getByTestId('activity-update')).toHaveCount(0)
    // 启动期静默检查（窗口起来 4s 后）必须被车道闸短路：一次都不许打到更新服务。
    await page.waitForTimeout(6_000)
    expect(checkRequests).toBe(0)

    // 工作台进设置页的真实路径：头像菜单 → 设置 → 左侧导航。
    await page.getByTestId('activity-account').click()
    await page.getByTestId('account-menu-settings').click()
    await page.getByTestId('account-settings-nav-about').click()
    await expect(page.getByTestId('about-settings-page')).toBeVisible()
    await expect(page.getByTestId('version-current')).toContainText('当前版本：0.2.0')
    await expect(page.getByTestId('version-status')).toContainText('开发构建不检查更新')
    await expect(page.getByTestId('version-diagnose')).toHaveText('诊断更新链路')
    // 版权行是 PRD「关于书深」第 6 条，此前页面缺失。
    await expect(page.getByTestId('about-copyright')).toContainText('书深')
    // 检查更新入口在 local lane 下不出现，否则用户点了只会拿到一个恒不通过的身份门。
    await expect(page.getByTestId('version-check')).toHaveCount(0)
    await page.screenshot({ path: join(artifacts, '关于书深-local-lane.png') })

    // 只读诊断通道仍可用：它是 local lane 唯一被保留的更新面能力。
    await page.getByTestId('version-diagnose').click()
    const diagnosis = page.getByTestId('version-diagnosis')
    await expect(diagnosis).toBeVisible()
    await expect(diagnosis).toContainText(UPDATE_VERSION)
    expect(checkRequests).toBeGreaterThan(0)
    await page.screenshot({ path: join(artifacts, '关于书深-诊断.png') })
  } finally {
    await app.close().catch(() => undefined)
    await closeServer(server)
    for (const directory of [home, workspace, userData]) {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})
