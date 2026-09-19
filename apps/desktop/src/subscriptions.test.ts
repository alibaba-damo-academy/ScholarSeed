import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { subscriptionAuthorizationUrl, subscriptionLoginPath } from './subscriptions.ts'

test('subscription browser capability rejects arbitrary external URLs and path injection', () => {
  const allowed = 'https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&code_challenge_method=S256'
  assert.equal(subscriptionAuthorizationUrl(allowed), allowed)
  for (const url of [allowed.replace('auth.openai.com', 'untrusted.example'), allowed.replace('https:', 'http:'), allowed.replace('1455', '9000'), 'file:///etc/passwd', 'javascript:alert(1)']) {
    assert.throws(() => subscriptionAuthorizationUrl(url))
  }
  assert.equal(subscriptionLoginPath('personal-oauth-123'), '/api/settings/model-connections/personal-oauth-123/login')
  for (const id of ['../auth/logout', 'personal-foo/bar', '', 'https://example.com']) assert.throws(() => subscriptionLoginPath(id))
})


test('subscription IPC failures carry stable codes while preserving the main-window and local-backend guards', () => {
  const main = readFileSync(new URL('./main/index.ts', import.meta.url), 'utf8')
  const consumer = readFileSync(new URL('./renderer/src/components/business/SubscriptionConnections.tsx', import.meta.url), 'utf8')
  assert.match(main, /event\.sender !== mainWindow\?\.webContents \|\| event\.senderFrame !== event\.sender\.mainFrame/)
  assert.match(main, /backendManaged && endpoint\.protocol === 'http:' && endpoint\.hostname === '127\.0\.0\.1'/)
  assert.match(main, /method: 'POST', redirect: 'error', headers: \{ \[HOST_PROCESS_HEADER\]: backendHostProcessKey\(\) \}/)
  for (const code of ['local_service_required', 'login_failed', 'window_closed', 'authorization_open_failed']) {
    assert.ok(main.includes(`errorCode: '${code}'`))
    assert.ok(consumer.includes(`${code}: t('ipc.`))
  }
  assert.match(main, /error: payload\.detail \? String\(payload\.detail\) : undefined/)
  assert.match(main, /await cancel\(\); return \{ available, errorCode: 'window_closed' \}/)
  assert.match(consumer, /ipc: result\.errorCode, detail: result\.error/)
  const labels = ['zh', 'en'].map(language => JSON.parse(readFileSync(new URL(`./localization/locales/${language}/subscription.json`, import.meta.url), 'utf8')).ipc)
  assert.equal(labels[0].windowClosed, '登录窗口已关闭。')
  assert.equal(labels[1].windowClosed, 'The sign-in window has closed.')
  assert.equal(labels[0].diagnostic, '{{message}} {{detail}}')
  assert.equal(labels[1].diagnostic, '{{message}} {{detail}}')
})
