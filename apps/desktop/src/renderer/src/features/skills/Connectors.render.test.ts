import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { chromium, expect } from '@playwright/test'
import { build } from 'esbuild'

const DESKTOP = fileURLToPath(new URL('../../../../../', import.meta.url))
const ORIGIN = 'http://127.0.0.1:18775'

test(
  'uniform connector authorization, display version and transport label',
  { timeout: 60_000 },
  async (context) => {
    const directory = mkdtempSync(join(tmpdir(), 'connector-authorization-'))
    context.after(() => rmSync(directory, { recursive: true, force: true }))
    const bundle = join(directory, 'probe.js')
    await build({
      stdin: {
        contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { I18nextProvider } from 'react-i18next';
        import { createLocalization } from './src/localization/engine';
        import { resources } from './src/localization/resources';
        import { Connectors } from './src/renderer/src/features/skills/Connectors';
        import { ToastProvider } from './src/renderer/src/components/ui';
        const engine = createLocalization('zh', resources);
        window.language = language => engine.changeLanguage(language);
        const rows = ['zotero', 'notion'].map(id => ({
          id, name: id === 'zotero' ? 'Zotero' : 'Notion', installed: true,
          authorized: false, enabled: false, custom: false, method: null, reauthorization: true,
          methods: id === 'zotero' ? ['key'] : ['key', 'oauth'],
          key_label: 'MCP Token', source_url: 'https://example.com',
          transport: 'http', version: '9.8.7', tools: [], state: 'auth_required',
        }));
        rows.push({ ...rows[1], id: 'github', name: 'GitHub', authorized: true, method: 'oauth', expires_at: 1793021439 });
        rows.push({ ...rows[1], id: 'gitlab', name: 'GitLab' });
        for (const [name, transport, error, authorized, fetched] of [
          ['local', 'stdio', 'connector_process_failed', true, null],
          ['anonymous', 'http', '', true, 1],
          ['protected', 'http', 'connector_credentials_invalid', false, null],
          ['protocol', 'http', 'connector_protocol_failed', true, null],
        ]) rows.push({
          ...rows[1], id: 'custom-' + name, name, custom: true, methods: [],
          transport, error, authorized, tools: fetched ? [] : null, tools_fetched_at: fetched,
          configuration: { id: 'custom-' + name, name, transport, url: 'https://example.com/mcp', headers: {}, enabled: true },
        });
        window.calls = [];
        window.readFailure = window.initialReadFailure ?? '';
        window.operationFailure = '';
        window.scholarseed = { mcpSettings: async request => {
          if (request.operation === 'connectors' && window.readFailure) return { status: 503, body: JSON.stringify({ detail: window.readFailure }) };
          if (request.operation === 'connectors') return { status: 200, body: JSON.stringify({ connectors: rows }) };
          window.calls.push(request);
          if (request.operation === 'connector') {
            const item = rows.find(row => row.id === request.id);
            if (window.operationFailure) return { status: 422, body: JSON.stringify({ detail: window.operationFailure }) };
            if (request.action.access_token === 'invalid') return { status: 422, body: JSON.stringify({ detail: 'connector_credentials_invalid' }) };
            if (request.action.operation === 'key') Object.assign(item, { authorized: true, method: 'key', state: 'ready', tools_fetched_at: 1, revocation_scope: '' });
            if (request.action.operation === 'revoke') Object.assign(item, { authorized: false, enabled: false, method: null, state: 'auth_required', revocation_scope: item.method === 'oauth' ? 'remote' : 'local' });
            return { status: 200, body: JSON.stringify(item) };
          }
          return { status: 200, body: JSON.stringify({ configuration: { revision: 'fixture', servers: [] } }) };
        } };
        createRoot(document.getElementById('root')).render(<I18nextProvider i18n={engine}><ToastProvider><Connectors /></ToastProvider></I18nextProvider>);
      `,
        resolveDir: DESKTOP,
        loader: 'tsx',
      },
      plugins: [
        {
          name: 'isolated-store',
          setup(builder) {
            builder.onResolve({ filter: /^\.\.\/\.\.\/store$/ }, () => ({
              path: 'store',
              namespace: 'fixture',
            }))
            builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
              contents: 'export const useApp = () => ({ state: { projects: [] }, act: {} });',
              loader: 'js',
            }))
          },
        },
      ],
      outfile: bundle,
      bundle: true,
      platform: 'browser',
      jsx: 'automatic',
      define: { 'import.meta.env.DEV': 'false' },
      loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl', '.webp': 'dataurl' },
    })
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    context.after(() => browser.close())
    const page = await browser.newPage()
    page.on('pageerror', (error) => assert.fail(error.message))
    page.setDefaultTimeout(5000)
    await page.route(`${ORIGIN}/`, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
    )
    await page.goto(ORIGIN)
    await page.evaluate(() =>
      Reflect.set(window, 'initialReadFailure', 'connector_storage_unavailable')
    )
    await page.addScriptTag({ path: bundle })
    await expect(page.getByRole('alert')).toContainText('连接器配置暂时无法读取')
    await page.evaluate(() => Reflect.set(window, 'readFailure', ''))
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '查看 GitLab', exact: true })).toHaveCount(0)
    await page.getByRole('tab', { name: '我的', exact: true }).click()
    await page.getByRole('button', { name: '查看 GitLab', exact: true }).click()
    await expect(page.getByTestId('connector-detail')).toContainText('GitLab')
    await page.keyboard.press('Escape')
    await page.getByRole('tab', { name: '市场', exact: true }).click()
    await expect(page.getByRole('button', { name: '查看 GitLab', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '重新授权', exact: true })).toHaveCount(0)
    for (const name of ['Zotero', 'Notion']) {
      await page.getByRole('button', { name: `查看 ${name}`, exact: true }).click()
      const detail = page.getByRole('dialog').last()
      await expect(detail).toContainText('1.0.0')
      await expect(detail).not.toContainText('9.8.7')
      await detail.getByRole('button', { name: '授权', exact: true }).click()
      const auth = page.getByRole('dialog').last()
      await expect(auth.locator('input[aria-label="API Key"]')).toHaveCount(1)
      await expect(auth.getByPlaceholder('请输入 API Key')).toHaveCount(1)
      await expect(auth).not.toContainText('MCP Token')
      await expect(auth.getByRole('combobox')).toHaveCount(0)
      await expect(auth).not.toContainText('资料库 ID')
      await auth.locator('input[aria-label="API Key"]').fill('test-only')
      await auth.getByRole('button', { name: '连接', exact: true }).click()
      await expect(page.getByRole('dialog')).toHaveCount(1)
      await expect(detail.getByTestId('connector-authorization-status')).toContainText('已授权')
      await expect(detail.getByRole('button', { name: '前往授权', exact: true })).toHaveCount(0)
      assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'calls').at(-1).action), {
        operation: 'key',
        access_token: 'test-only',
      })
      await detail.getByRole('button', { name: '更换授权', exact: true }).click()
      await page.getByRole('dialog').last().locator('input[aria-label="API Key"]').fill('invalid')
      await page
        .getByRole('dialog')
        .last()
        .getByRole('button', { name: '连接', exact: true })
        .click()
      await expect(page.getByRole('dialog').last()).toContainText('API Key')
      await page
        .getByRole('dialog')
        .last()
        .getByRole('button', { name: '取消', exact: true })
        .click()
      await expect(detail.getByTestId('connector-authorization-status')).toContainText('已授权')
      await page.keyboard.press('Escape')
    }
    await page.getByRole('button', { name: '查看 GitHub', exact: true }).click()
    await expect(page.getByTestId('connector-detail')).toContainText('访问令牌有效至')
    await expect(page.getByTestId('connector-detail')).toContainText(
      '若服务提供刷新凭据，将自动续期'
    )
    await page.evaluate(() => {
      Reflect.set(window, 'readFailure', 'connector_storage_unavailable')
    })
    await expect(page.getByTestId('connector-detail')).toContainText('连接器配置暂时无法读取')
    await page.evaluate(() => {
      Reflect.set(window, 'readFailure', '')
    })
    await expect(page.getByTestId('connector-detail')).not.toContainText('连接器配置暂时无法读取')
    await page.evaluate(() => {
      Reflect.set(window, 'operationFailure', 'connector_method_invalid')
    })
    await page.getByTestId('connector-detail').getByRole('switch').click()
    await expect(page.getByTestId('connector-detail')).toContainText('不支持此授权或操作方式')
    await page.waitForTimeout(2300)
    await expect(page.getByTestId('connector-detail')).toContainText('不支持此授权或操作方式')
    await page.evaluate(() => {
      Reflect.set(window, 'operationFailure', '')
    })
    await page.getByTestId('connector-detail').getByRole('switch').click()
    await expect(page.getByTestId('connector-detail')).not.toContainText('不支持此授权或操作方式')
    await expect(page.getByTestId('connector-authorization-status')).toHaveText('已授权 · OAuth')
    await expect(page.getByRole('button', { name: '前往授权', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '更换授权', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'OAuth', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await page.getByRole('tab', { name: 'API Key', exact: true }).click()
    await page.evaluate(() => Reflect.get(window, 'language')('en'))
    await expect(page.getByRole('dialog').last().getByPlaceholder('Enter API Key')).toBeVisible()
    await expect(page.getByRole('dialog').last()).not.toContainText('MCP Token')
    await page
      .getByRole('dialog')
      .last()
      .getByRole('button', { name: 'Cancel', exact: true })
      .click()
    await expect(page.getByTestId('connector-authorization-status')).toContainText('OAuth')
    await page.keyboard.press('Escape')
    await page.evaluate(() => Reflect.get(window, 'language')('zh'))
    for (const [name, notice] of [
      ['GitHub', '已撤销服务商授权并移除本机凭据'],
      ['Zotero', '已移除本机授权'],
    ]) {
      await page.getByRole('button', { name: `查看 ${name}`, exact: true }).click()
      await page.getByRole('button', { name: '撤销授权', exact: true }).click()
      await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click()
      const detail = page.getByTestId('connector-detail')
      await expect(detail).toContainText(notice)
      await expect(detail.getByTestId('connector-authorization-status')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: '查看 Notion', exact: true }).click()
      await expect(detail).not.toContainText('已撤销服务商授权')
      await expect(detail).not.toContainText('已移除本机授权')
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: `查看 ${name}`, exact: true }).click()
      await expect(detail).toContainText(notice)
      await detail.getByRole('button', { name: '授权', exact: true }).click()
      await page.getByRole('dialog').last().getByPlaceholder('请输入 API Key').fill('invalid')
      await page
        .getByRole('dialog')
        .last()
        .getByRole('button', { name: '连接', exact: true })
        .click()
      await page
        .getByRole('dialog')
        .last()
        .getByRole('button', { name: '取消', exact: true })
        .click()
      await expect(detail).toContainText(notice)
      await detail.getByRole('button', { name: '授权', exact: true }).click()
      await page.getByRole('dialog').last().getByPlaceholder('请输入 API Key').fill('test-only')
      await page
        .getByRole('dialog')
        .last()
        .getByRole('button', { name: '连接', exact: true })
        .click()
      await expect(detail.getByTestId('connector-authorization-status')).toContainText('已授权')
      await expect(detail).not.toContainText('已撤销服务商授权')
      await expect(detail).not.toContainText('已移除本机授权')
      await page.keyboard.press('Escape')
    }
    await page.getByRole('button', { name: '添加连接器', exact: true }).click()
    await expect(page.getByRole('dialog').getByText('传输方式', { exact: true })).toBeVisible()
    await expect(page.getByRole('tablist', { name: '传输方式' })).toBeVisible()
    const editor = page.getByRole('dialog')
    const timeout = editor.getByRole('textbox', { name: '工具调用超时（毫秒，选填）', exact: true })
    const preview = editor.getByRole('button', { name: '预览配置', exact: true })
    await editor.getByRole('textbox', { name: '连接器名称', exact: true }).fill('timeout-check')
    await editor.getByRole('tab', { name: 'STDIO', exact: true }).click()
    await editor.getByRole('textbox', { name: '启动命令', exact: true }).fill('npx')
    await expect(timeout).toHaveAccessibleDescription(
      '留空使用默认值；填写整数 ≥1000，建议 30000（30 秒）。'
    )
    await expect(preview).toBeEnabled()
    for (const value of ['30', '999', '1000.5', 'invalid']) {
      await timeout.fill(value)
      await expect(timeout).toHaveAttribute('aria-invalid', 'true')
      await expect(timeout).toHaveAccessibleDescription(
        /请输入不小于 1000 的整数（毫秒）；30 秒请填 30000。/
      )
      await expect(preview).toBeDisabled()
    }
    for (const value of ['1000', '30000', '']) {
      await timeout.fill(value)
      await expect(timeout).not.toHaveAttribute('aria-invalid', 'true')
      await expect(preview).toBeEnabled()
    }
    await page.evaluate(() => Reflect.get(window, 'language')('en'))
    await expect(page.getByRole('dialog').getByText('Transport', { exact: true })).toBeVisible()
    const englishTimeout = editor.getByRole('textbox', {
      name: 'Tool timeout (ms, optional)',
      exact: true,
    })
    await englishTimeout.fill('30')
    await expect(englishTimeout).toHaveAccessibleDescription(
      /Enter an integer of at least 1000 milliseconds; for 30 seconds, enter 30000./
    )
    await page.keyboard.press('Escape')
    await page.evaluate(() => Reflect.get(window, 'language')('zh'))
    await page.getByRole('tab', { name: '我的', exact: true }).click()
    for (const name of ['local', 'anonymous', 'protected', 'protocol']) {
      await page.getByRole('button', { name: `查看 ${name}`, exact: true }).click()
      const detail = page.getByTestId('connector-detail')
      await expect(detail).not.toContainText('已授权')
      await expect(detail.locator('dd').nth(1)).not.toBeEmpty()
      if (name === 'local' || name === 'anonymous') {
        await expect(detail.getByTestId('connector-authorization-status')).toHaveText('无需授权')
      } else {
        await expect(detail).toContainText('认证方式尚未识别')
      }
      if (name === 'protected') {
        await expect(detail).toContainText('当前凭据缺失、无效或已过期')
        await expect(detail.getByRole('button', { name: '授权', exact: true })).toHaveCount(0)
        await detail.getByRole('button', { name: '重试连接', exact: true }).click()
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                Reflect.get(window, 'calls').findLast(
                  (call: { operation: string }) => call.operation === 'connector'
                ).action.operation
            )
          )
          .toBe('custom_retry')
        await detail.getByRole('button', { name: '编辑配置', exact: true }).click()
        await expect(page.getByRole('dialog').last().getByRole('heading')).toHaveText('编辑配置')
        await page.keyboard.press('Escape')
      }
      if (name === 'protocol') {
        await expect(detail).toContainText('MCP 握手或协议通信失败')
        await page.evaluate(() => Reflect.get(window, 'language')('en'))
        await expect(detail).toContainText('MCP handshake or protocol communication failed')
        await page.evaluate(() => Reflect.get(window, 'language')('zh'))
      }
      await page.keyboard.press('Escape')
    }
  }
)
