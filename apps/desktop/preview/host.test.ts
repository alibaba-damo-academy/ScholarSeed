import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { RENDERER_OPTIMIZE_DEPS, supportedFontSources } from '../renderer.ts'
import { WORKSPACE_WINDOW_SIZE } from '../src/window.ts'
import { createPreviewService } from './service.ts'

const DESKTOP_ROOT = fileURLToPath(new URL('../', import.meta.url))
const CONSUMER_ENTRY = '/__settings-consumer.tsx'
const HIDDEN_PAGES = ['account', 'preferences', 'skills', 'permissions', 'shortcuts'] as const
const SCREENSHOT_ROOT = join(DESKTOP_ROOT, 'test-results/preview-host/settings-corrections')
const HOST = '127.0.0.1'

async function temporaryPort(): Promise<number> {
  const listener = createNetServer()
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject)
      listener.listen(0, HOST, resolve)
    })
    const address = listener.address()
    if (!address || typeof address === 'string' || !Number.isInteger(address.port) || address.port <= 0) throw new Error('Invalid temporary preview consumer address')
    return address.port
  } finally {
    if (listener.listening) await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
  }
}

test('hidden settings reuse real content and providers while production navigation still falls back', { timeout: 180_000 }, async context => {
  const port = await temporaryPort()
  const cache = mkdtempSync(join(tmpdir(), 'preview-settings-consumer-'))
  const service = createPreviewService()
  const source = (path: string): string => '/@fs/' + join(DESKTOP_ROOT, path).split('\\').join('/')
  const server = await createServer({
    configFile: false,
    root: join(DESKTOP_ROOT, 'src/renderer'),
    cacheDir: cache,
    plugins: [react(), supportedFontSources(), {
      name: 'settings-public-consumer',
      resolveId(id) { if (id === CONSUMER_ENTRY) return id },
      load(id) {
        if (id !== CONSUMER_ENTRY) return
        return `
          import React from 'react';
          import { installPreviewBridge, previewStatePath } from ${JSON.stringify(source('preview/bridge.ts'))};
          const query = new URLSearchParams(location.search);
          if (query.has('language')) {
            const path = previewStatePath(query.get('previewInstance'), query.get('scene'));
            const state = await (await fetch(path)).json();
            await fetch(path, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({preferences:{...state.preferences,language:query.get('language')}}) });
          }
          await installPreviewBridge();
          if (query.get('permissionVariant') === 'loading') window.scholarseed.systemPermissions = async () => new Promise(() => {});
          if (query.get('permissionVariant') === 'error') window.scholarseed.systemPermissions = async () => { throw new Error('Fixture permission query failed'); };
          if (query.has('accountVariant')) {
            const { setAccountBase } = await import(${JSON.stringify(source('src/renderer/src/account.ts'))});
            setAccountBase(location.origin);
            window.scholarseed.getAuthToken = async () => query.get('accountVariant') === 'anonymous' ? '' : 'fixture-only-token';
          }
          const page = query.get('page');
          if (query.has('production')) {
            const { mountRenderer } = await import(${JSON.stringify(source('src/renderer/src/app/root.tsx'))});
            const { AccountPanel } = await import(${JSON.stringify(source('src/renderer/src/components/business/AccountPanel.tsx'))});
            mountRenderer(React.createElement(AccountPanel, { embedded: true, page: page.replace('settings-', ''), onPage() {}, onClose() {}, onLogin() {}, onLogout: async () => ({ok:true,data:{local_cleared:true}}) }));
          } else {
            const { mountPreviewHost } = await import(${JSON.stringify(source('preview/host.tsx'))});
            mountPreviewHost(page);
          }
        `
      },
      transformIndexHtml(html) { return html.replace('/src/main.tsx', CONSUMER_ENTRY) },
      configureServer(vite) { vite.middlewares.use(service.middleware) },
    }],
    optimizeDeps: RENDERER_OPTIMIZE_DEPS,
    server: { host: HOST, port, strictPort: true, fs: { allow: [DESKTOP_ROOT] } },
  })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    browser = await chromium.launch({ headless: true, channel: process.env.SCHOLARSEED_PREVIEW_BROWSER_CHANNEL || 'chrome' })
    const page = await browser.newPage({ viewport: WORKSPACE_WINDOW_SIZE })
    mkdirSync(SCREENSHOT_ROOT, { recursive: true })
    const capture = async (name: string): Promise<void> => {
      await page.evaluate(async () => {
        await document.fonts.ready
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      })
      await page.screenshot({ path: join(SCREENSHOT_ROOT, `${name}.png`), animations: 'disabled' })
    }
    const errors: string[] = []
    const diagnostics: unknown[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error' || message.type() === 'warning') diagnostics.push({ type: 'console', level: message.type(), text: message.text(), location: message.location() })
    })
    page.on('requestfailed', request => diagnostics.push({ type: 'requestfailed', url: request.url(), method: request.method(), error: request.failure()?.errorText }))
    page.on('response', response => {
      if (response.status() >= 400) diagnostics.push({ type: 'http-error', url: response.url(), method: response.request().method(), status: response.status() })
    })
    const diagnosticRoot = join(SCREENSHOT_ROOT, 'diagnostics', new Date().toISOString().replace(/[:.]/g, '-'))
    const diagnose = async (stage: string): Promise<void> => {
      mkdirSync(diagnosticRoot, { recursive: true })
      writeFileSync(join(diagnosticRoot, `${stage}.json`), JSON.stringify({ stage, url: page.url(), errors, diagnostics, body: await page.locator('body').innerText() }, null, 2))
      writeFileSync(join(diagnosticRoot, `${stage}.html`), await page.content())
      await page.screenshot({ path: join(diagnosticRoot, `${stage}.png`), animations: 'disabled' })
    }
    const origin = server.resolvedUrls!.local[0]
    let accountVariant = 'ready'
    await page.route('**/api/account/me', async route => {
      if (accountVariant === 'loading') return
      await route.fulfill({ status: accountVariant === 'error' ? 503 : 200, contentType: 'application/json', body: JSON.stringify(accountVariant === 'error' ? { code: 'fixture_unavailable' } : { user_id: 'fixture-user', nickname: 'Fixture User', phone: '13800138000' }) })
    })
    for (const name of HIDDEN_PAGES) {
      await page.goto(`${origin}?previewInstance=hidden-${name}&scene=settings-${name}-states&page=settings-${name}`)
      try {
        await expect(page.getByTestId(`account-settings-${name}`)).toBeVisible({ timeout: 10_000 })
        if (name === 'account') await expect(page.getByTestId('account-profile-retry')).toBeVisible()
        if (name === 'skills') {
          await page.getByTestId('skills-tab-user').click()
          await expect(page.getByTestId('skill-card-preview-notes')).toBeVisible()
        }
        if (name === 'permissions') await expect(page.getByTestId('permissions-refresh')).toBeEnabled()
      } catch (error) { await diagnose(`hidden-${name}`); throw error }
      assert.equal(await page.getByTestId('account-settings-nav-notifications').count(), 0)
      await capture(`hidden-${name}`)
    }
    await page.getByTestId('shortcut-search').fill('PDF')
    await expect(page.getByTestId('shortcut-search')).toHaveValue('PDF')
    await page.goto(`${origin}?previewInstance=hidden-preferences&page=settings-preferences&scene=settings-preferences-states`)
    await page.getByTestId('preferences-auto-save').click()
    await expect.poll(async () => {
      const response = await page.request.get(`${origin}__preview/state?previewInstance=hidden-preferences`)
      return (await response.json()).preferences.autoSave
    }).toBe(false)
    await page.reload()
    await expect(page.getByTestId('preferences-auto-save')).toHaveAttribute('aria-checked', 'false')
    await capture('preferences-saved-reloaded')
    await page.goto(`${origin}?previewInstance=hidden-account&page=settings-account&scene=settings-account-states`)
    await expect(page.getByTestId('account-profile-retry')).toBeVisible()
    await expect(page.getByTestId('account-login-open')).toHaveCount(0)
    for (const language of ['zh', 'en']) {
      for (const variant of ['normal', 'loading', 'error']) await context.test(`permissions ${language} ${variant} has real labels rather than initialization failures`, async () => {
        await page.goto(`${origin}?previewInstance=permissions-${language}-${variant}&page=settings-permissions&scene=settings-permissions-states&language=${language}&permissionVariant=${variant}`)
        if (variant === 'loading') await expect(page.getByTestId('permissions-refresh')).toBeDisabled()
        else await expect(page.getByTestId('permissions-refresh')).toBeEnabled()
        try {
          await expect(page.getByTestId('account-settings-permissions')).not.toContainText(/界面语言初始化失败|language initialization failed/i)
          await expect(page.getByRole('heading', { name: language === 'zh' ? '权限与隐私' : 'Permissions and privacy', exact: true })).toBeVisible()
          if (variant === 'normal') {
            await expect(page.getByTestId('permission-screen')).toContainText(language === 'zh' ? '不可用' : 'Unavailable')
            await expect(page.getByTestId('permission-full-disk')).toContainText(language === 'zh' ? '查询失败' : 'Query failed')
          } else if (variant === 'loading') await expect(page.getByTestId('permissions-refresh')).toHaveText(language === 'zh' ? '正在检查…' : 'Checking…')
          else await expect(page.getByRole('alert')).toContainText(language === 'zh' ? '无法读取系统能力状态' : 'Could not read system permission status')
          await capture(`fixed-permissions-${language}-${variant}`)
        } catch (error) { await capture(`failure-permissions-${language}-${variant}`); throw error }
      })
      for (const variant of ['ready', 'loading', 'error', 'anonymous', 'no-base']) await context.test(`account ${language} ${variant} keeps identity claims tied to confirmed profile`, async () => {
        accountVariant = variant
        const query = new URLSearchParams({ previewInstance: `account-${language}-${variant}`, page: 'settings-account', scene: 'settings-account-states', language })
        if (variant !== 'no-base') query.set('accountVariant', variant)
        await page.goto(`${origin}?${query}`)
        const content = page.getByTestId('account-settings-account')
        await expect(content).toBeVisible()
        try {
          if (variant === 'ready') {
            await expect(page.getByTestId('account-edit-nickname')).toHaveText('Fixture User')
            await expect(content).toContainText(language === 'zh' ? '已登录' : 'Signed in')
            await expect(page.getByTestId('account-reset-password-open')).toBeEnabled()
            await expect(page.getByTestId('account-switch')).toBeEnabled()
          } else {
            if (variant === 'error' || variant === 'no-base') await expect(page.getByTestId('account-profile-retry')).toBeVisible()
            if (variant === 'anonymous') await expect(page.getByTestId('account-login-open')).toBeVisible()
            await expect(content).not.toContainText(language === 'zh' ? '已登录' : 'Signed in')
            for (const identityAction of ['account-edit-nickname', 'account-change-phone-open', 'account-reset-password-open', 'account-switch', 'account-logout', 'account-nickname-save']) await expect(page.getByTestId(identityAction)).toHaveCount(0)
          }
          await capture(`fixed-account-${language}-${variant}`)
          if (variant === 'ready') {
            accountVariant = 'error'
            await page.evaluate(() => window.dispatchEvent(new Event('scholarseed:auth-restored')))
            await expect(page.getByTestId('account-profile-retry')).toBeVisible()
            await expect(content).not.toContainText(language === 'zh' ? '已登录' : 'Signed in')
            await expect(page.getByTestId('account-edit-nickname')).toHaveCount(0)
            await expect(page.getByTestId('account-logout')).toHaveCount(0)
            await capture(`fixed-account-${language}-refresh-error`)
          }
        } catch (error) { await capture(`failure-account-${language}-${variant}`); throw error }
      })
    }
    for (const name of HIDDEN_PAGES) {
      await page.goto(`${origin}?previewInstance=production-${name}&page=settings-${name}&scene=settings-${name}-states&production=1`)
      try {
        await expect(page.getByTestId('account-settings-notifications')).toBeVisible({ timeout: 10_000 })
      } catch (error) {
        throw Object.assign(new Error(JSON.stringify({ page: name, errors, body: await page.locator('body').innerText() })), { cause: error })
      }
      assert.equal(await page.getByTestId(`account-settings-${name}`).count(), 0)
      assert.equal(await page.getByTestId(`account-settings-nav-${name}`).count(), 0)
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await server.close()
    service.dispose()
    rmSync(cache, { recursive: true, force: true })
  }
})
