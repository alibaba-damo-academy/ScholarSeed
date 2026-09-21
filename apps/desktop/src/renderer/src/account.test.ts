import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createInstance } from 'i18next'

import {
  CLOUD_PAGE_ANCHORS,
  CREDITS_LOW_WARNING_THRESHOLD,
  accountDisplayName,
  accountDisplayText,
  accountFailureText,
  apiKeyDisplayName,
  accountMe,
  accountCredits,
  changePhone,
  createApiKey,
  creditsAreExhausted,
  creditsBlockBuiltInModel,
  creditsWarningBucket,
  dropSession,
  listApiKeys,
  markCreditsExhausted,
  resetPassword,
  revokeApiKey,
  rotateApiKey,
  sendCode,
  updateNickname,
  cloudPageUrl,
  maskPhone,
  parseAccountProfile,
  parseCreditsSummary,
  setAccountBase
} from './account.ts'
import { logoutDesktopSession } from './logout.ts'
import { RESET_PASSWORD_DIALOG, resetPasswordSubmitReady } from './dialogs.ts'

const accountResources = Object.fromEntries(['zh', 'en'].map(language => [language, {
  account: JSON.parse(readFileSync(new URL(`../../localization/locales/${language}/account.json`, import.meta.url), 'utf8'))
}]))

async function accountTranslator() {
  const instance = createInstance()
  await instance.init({ lng: 'zh', fallbackLng: false, resources: accountResources, interpolation: { escapeValue: false } })
  return instance
}

test('API key display names translate managed provenance and preserve identical user names', async () => {
  const locale = await accountTranslator()
  const managed = { managed: true, name: '书深技能凭据' }
  const custom = { managed: false, name: managed.name }
  const original = structuredClone([managed, custom])
  assert.equal(apiKeyDisplayName(managed, locale.getFixedT(null, 'account')), '书深技能凭据')
  await locale.changeLanguage('en')
  const t = locale.getFixedT(null, 'account')
  assert.equal(apiKeyDisplayName(managed, t), 'ScholarSeed skill credential')
  assert.equal(apiKeyDisplayName({ managed: true, name: '旧系统名称' }, t), 'ScholarSeed skill credential')
  assert.equal(apiKeyDisplayName(custom, t), '书深技能凭据')
  assert.equal(apiKeyDisplayName({ managed: false, name: '用户 <name> & {{name}}' }, t), '用户 <name> & {{name}}')
  assert.equal(apiKeyDisplayName({ managed: false, name: '' }, t), 'Unnamed key')
  await locale.changeLanguage('zh')
  assert.equal(apiKeyDisplayName(managed, locale.getFixedT(null, 'account')), '书深技能凭据')
  assert.deepEqual([managed, custom], original)
})

function accountBrowser(fetcher: typeof fetch, bridge: Record<string, unknown> = {}) {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const priorFetch = globalThis.fetch
  const events: string[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    scholarseed: { getApiBase: () => 'http://serve.test', getAuthToken: async () => 'test-token', ...bridge },
    setTimeout, clearTimeout, dispatchEvent: (event: Event) => { events.push(event.type); return true }
  } })
  globalThis.fetch = fetcher
  setAccountBase('https://account.test')
  return {
    events,
    restore() {
      globalThis.fetch = priorFetch
      setAccountBase('')
      if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  }
}

test('account requests keep legacy code/error, HTTP requests and authentication while presenting explicit failures', async () => {
  const calls: Array<{ path: string; method: string; body: unknown; authorization?: string }> = []
  const diagnostic = 'upstream 原始诊断 <name> & {{name}}'
  const browser = accountBrowser(async (input, init) => {
    calls.push({ path: String(input), method: init?.method ?? 'GET', body: init?.body,
      authorization: (init?.headers as Record<string, string>)?.authorization })
    return Response.json({ code: 'invalid_code', message: diagnostic }, { status: 400 })
  })
  const operations = [
    () => sendCode('15200000000', 'change'),
    () => resetPassword('15200000000', '123456', 'password'),
    () => changePhone('15200000000', '123456'),
    () => accountMe(), () => accountCredits(), () => updateNickname('用户原名'),
    () => listApiKeys(), () => createApiKey('原始key名'),
    () => revokeApiKey('key/id'), () => rotateApiKey('key/id')
  ]
  try {
    const locale = await accountTranslator()
    for (const operation of operations) {
      const result = await operation()
      assert.equal(result.ok, false)
      if (result.ok) continue
      assert.equal(result.code, 'invalid_code')
      assert.equal(result.error, '验证码不正确')
      assert.deepEqual(result.applicationFailure, { code: 'invalid_code', diagnostic })
      await locale.changeLanguage('en')
      assert.equal(accountFailureText(result, locale.getFixedT(null, 'account')), `The verification code is incorrect\n${diagnostic}`)
      await locale.changeLanguage('zh')
      assert.equal(accountFailureText(result, locale.getFixedT(null, 'account')), `验证码不正确\n${diagnostic}`)
    }
    assert.deepEqual(calls.slice(0, 3), [
      { path: 'https://account.test/api/phone/code', method: 'POST', body: JSON.stringify({ phone: '15200000000', purpose: 'change' }), authorization: undefined },
      { path: 'https://account.test/api/phone/reset-password', method: 'POST', body: JSON.stringify({ phone: '15200000000', code: '123456', new_password: 'password' }), authorization: undefined },
      { path: 'https://account.test/api/account/phone/change', method: 'POST', body: JSON.stringify({ new_phone: '15200000000', code: '123456' }), authorization: 'Bearer test-token' }
    ])
    assert.ok(calls.slice(3).every(call => call.authorization === 'Bearer test-token'))
    assert.equal(calls[8].path, 'https://account.test/api/account/api-keys/key%2Fid')
    assert.equal(calls[8].method, 'DELETE')
    assert.equal(calls[9].path, 'https://account.test/api/account/api-keys/key%2Fid/rotate')
    assert.equal(calls[9].method, 'POST')
  } finally { browser.restore() }
})

test('account local fallbacks and unknown messages retain provenance without string guessing', async () => {
  const browser = accountBrowser(async () => Response.json({}, { status: 503 }))
  try {
    const locale = await accountTranslator()
    const t = locale.getFixedT(null, 'account')
    const httpFailure = await sendCode('15200000000', 'change')
    assert.equal(httpFailure.ok, false)
    if (httpFailure.ok) return
    assert.equal(httpFailure.error, '请求失败（503）')
    assert.equal(httpFailure.code, '')
    assert.deepEqual(httpFailure.applicationFailure, { code: 'http_failure', status: 503 })
    await locale.changeLanguage('en')
    assert.equal(accountFailureText(httpFailure, t), 'Request failed (503)')
    setAccountBase('')
    const baseFailure = await accountMe()
    assert.equal(baseFailure.ok, false)
    if (!baseFailure.ok) assert.equal(accountFailureText(baseFailure, t), 'The account service URL is not configured')
    setAccountBase('https://account.test')
    const raw = '无法连接账号服务 <original>\nnext'
    globalThis.fetch = async () => { throw new Error(raw) }
    const network = await accountMe()
    assert.equal(network.ok, false)
    if (!network.ok) {
      assert.equal(network.error, '无法连接账号服务')
      assert.equal(accountFailureText(network, t), `Could not connect to the account service\n${raw}`)
    }
    for (const code of ['unknown', '__proto__', 'constructor']) {
      globalThis.fetch = async () => Response.json({ code, message: '验证码不正确' }, { status: 400 })
      const result = await sendCode('15200000000', 'change')
      assert.equal(result.ok, false)
      if (!result.ok) {
        assert.equal(result.code, code)
        assert.equal(result.applicationFailure, undefined)
        assert.equal(accountFailureText(result, t), '验证码不正确')
      }
    }
    globalThis.fetch = async () => Response.json({ code: 'unauthorized' }, { status: 401 })
    await accountMe()
    assert.deepEqual(browser.events, ['scholarseed:auth-required'])
    const invalid = parseAccountProfile({ user_id: 'u-1' })
    assert.equal(invalid.ok, false)
    if (!invalid.ok) assert.equal(accountFailureText(invalid, t), 'The account service returned an unrecognized response. Try again later.')
  } finally { browser.restore() }
})

test('every application wire error has both translations and missing credentials keep the unauthorized contract', async () => {
  let code = ''
  let requests = 0
  const browser = accountBrowser(async () => {
    requests += 1
    return Response.json({ code }, { status: 400 })
  })
  try {
    const source = readFileSync(new URL('./account.ts', import.meta.url), 'utf8')
    const table = source.split('const ERROR_TEXT: Record<string, string> = {')[1].split('\n}')[0]
    const codes = [...table.matchAll(/^  (\w+):/gm)].map(match => match[1]).concat('not_registered')
    const locale = await accountTranslator()
    for (const next of codes) {
      code = next
      const failure = await sendCode('15200000000', 'change')
      assert.equal(failure.ok, false)
      if (failure.ok) continue
      assert.deepEqual(failure.applicationFailure, { code })
      await locale.changeLanguage('zh')
      assert.equal(accountFailureText(failure, locale.getFixedT(null, 'account')), failure.error)
      await locale.changeLanguage('en')
      const translated = accountFailureText(failure, locale.getFixedT(null, 'account'))
      assert.ok(translated && !translated.startsWith('failure.') && !/\p{Script=Han}/u.test(translated), code)
    }
    window.scholarseed.getAuthToken = async () => ''
    const before = requests
    const missing = await accountMe()
    assert.equal(requests, before)
    assert.equal(missing.ok, false)
    if (!missing.ok) {
      assert.equal(missing.code, 'unauthorized')
      assert.equal(missing.error, '登录状态已失效，请重新登录')
      assert.equal(accountFailureText(missing, locale.getFixedT(null, 'account')), 'Your sign-in has expired. Sign in again.')
    }
  } finally { browser.restore() }
})

test('logout preserves service-before-cookie order, original bridge failures and rejected operations', async () => {
  const order: string[] = []
  let reply: { ok: boolean; error?: string } = { ok: false }
  let rejection: Error | undefined
  const browser = accountBrowser(async () => { order.push('serve'); return Response.json({ ok: true }) }, {
    setAuthToken: async (value: string) => { order.push(`credentials:${value}`); if (rejection) throw rejection; return reply }
  })
  try {
    const locale = await accountTranslator()
    await locale.changeLanguage('en')
    const t = locale.getFixedT(null, 'account')
    const failed = await logoutDesktopSession()
    assert.deepEqual(order, ['serve', 'credentials:'])
    assert.equal(failed.ok, false)
    if (!failed.ok) {
      assert.equal(failed.code, 'local_logout_failed')
      assert.equal(failed.error, '本地登录凭据未能清除，请重试')
      assert.equal(accountFailureText(failed, t), 'Could not clear local sign-in credentials. Try again.')
    }
    reply = { ok: false, error: '本地登录凭据未能清除，请重试' }
    const raw = await dropSession()
    assert.equal(raw.ok, false)
    if (!raw.ok) {
      assert.equal(raw.applicationFailure, undefined)
      assert.equal(accountFailureText(raw, t), reply.error)
    }
    reply = { ok: true }
    assert.deepEqual(await logoutDesktopSession(), { ok: true, data: { local_cleared: true } })
    rejection = new Error('native credential failure')
    await assert.rejects(logoutDesktopSession(), error => error === rejection)
  } finally { browser.restore() }
})

test('account form and logout state keep failures until subscribed presentation', () => {
  const panel = readFileSync(new URL('components/business/AccountPanel.tsx', import.meta.url), 'utf8')
  for (const name of ['ChangePhoneDialog', 'ResetPasswordDialog', 'AccountPage', 'DeveloperPage']) {
    const start = panel.indexOf(`function ${name}(`)
    const end = panel.indexOf('\nfunction ', start + 1)
    const body = panel.slice(start, end < 0 ? undefined : end)
    assert.match(body, /useState<AccountFailure \| null>\(null\)/, name)
    assert.match(body, /accountFailureText\(error, accountText\)/, name)
    assert.doesNotMatch(body, /setError\(result.error\)/, name)
    assert.match(body, /useTranslation\('account'\)/, name)
  }
  const menu = readFileSync(new URL('components/business/AccountMenu.tsx', import.meta.url), 'utf8')
  const hook = menu.slice(menu.indexOf('export function useAccountLogout'), menu.indexOf('interface CreditsState'))
  assert.match(hook, /useState<AccountFailure \| null>\(null\)/)
  assert.match(hook, /accountFailureText\(error, t\)/)
})

test('library file settings auto-save without confirmation and follow developer typography', () => {
  const panel = readFileSync(
    new URL('components/business/AccountPanel.tsx', import.meta.url),
    'utf8'
  )
  const start = panel.indexOf('function FileVersionPage(')
  const end = panel.indexOf('\nconst PERMISSIONS:', start)
  const page = panel.slice(start, end)
  assert.ok(start >= 0 && end > start)
  assert.doesNotMatch(page, /<AlertDialog/)
  assert.doesNotMatch(page, /confirmDescription|policyImpact|addedPath|removedPath/)
  assert.match(page, /const \{ dismiss, toast \} = useToast\(\)/)
  assert.match(page, /toast\(\{ title: t\('fileSettings\.saved'\), tone: 'success' \}\)/)
  assert.match(page, /title: t\('fileSettings\.requestFailed'\)/)
  assert.doesNotMatch(page, /\{notice &&|previewError/)
  assert.match(page, /await apply\(changes\.settings\)/)
  assert.doesNotMatch(page, /reloadResourceTree|refreshResourceVersioning|await refreshScan\(\)/)
  assert.equal((page.match(/titleClassName=\{DEVELOPER_ROW_TITLE_CLASS_NAME\}/g) ?? []).length, 4)
  assert.equal((page.match(/descriptionClassName=\{DEVELOPER_ROW_DESCRIPTION_CLASS_NAME\}/g) ?? []).length, 4)
  assert.match(page, /checked=\{state\.formatOnSave\}/)
  assert.match(page, /onCheckedChange=\{act\.setFormatOnSave\}/)
  assert.match(page, /<span className=\{DEVELOPER_ROW_DESCRIPTION_CLASS_NAME\}>\s*\{t\('fileSettings\.sizeUnit'\)\}\s*<\/span>/)
  assert.equal((page.match(/size="standard"/g) ?? []).length, 2)
  assert.match(page, /useState\('50'\)[\s\S]*useState\('50'\)/)
  assert.match(page, /setMaxFileSize\(fileVersionSizeMbText\(settings\.max_file_size_kb\)\)/)
  assert.match(page, /fileVersionSizeKb\(\s*nextMaxFileSize,\s*saved\.max_file_size_kb\s*\)/)
  assert.doesNotMatch(page, /Number\(nextMaxFileSize\)|Number\(maxFileSize\)/)
  assert.equal((page.match(/disabled=\{busy \|\| !saved\}/g) ?? []).length, 2)
  assert.equal((page.match(/saveAutomatically\(/g) ?? []).length, 2)
  assert.doesNotMatch(page, /scheduleAutomaticSave|flushAutomaticSave|AUTO_SAVE_DELAY/)
})

test('account service nickname wins over internal serve identity', () => {
  const user = {
    user_id: 'u-internal-id',
    email: '',
    auth: true,
    display_name: 'u-internal-id'
  }
  assert.equal(
    accountDisplayName(user, { user_id: 'u-internal-id', nickname: 'user9415' }),
    'user9415'
  )
})

test('serve nickname remains a safe fallback when account profile is unavailable', () => {
  const user = {
    user_id: 'u-internal-id',
    email: '',
    auth: true,
    nickname: 'Researcher'
  }
  assert.equal(accountDisplayName(user), 'Researcher')
  assert.equal(accountDisplayName(null), '书深用户')
})

test('legacy employee identifiers are ignored when choosing an account display name', () => {
  const user = {
    user_id: 'u-internal-id',
    email: 'researcher@example.test',
    auth: true,
    emp_id: '123456'
  }
  assert.equal(accountDisplayName(user), user.email)
})

test('internal account identifiers are never exposed as a display name', () => {
  const internalId = 'u-e2c2be9f09184e0d9cc06e6247e3607c'
  assert.equal(accountDisplayName({
    user_id: internalId,
    email: '',
    auth: true,
    display_name: internalId
  }), '书深用户')
})

test('account fallback display follows language without rewriting canonical or same-named users', async () => {
  const i18n = createInstance()
  const resources = Object.fromEntries(['zh', 'en'].map(language => [language, {
    account: JSON.parse(readFileSync(new URL(`../../localization/locales/${language}/account.json`, import.meta.url), 'utf8'))
  }]))
  await i18n.init({ lng: 'zh', resources, defaultNS: 'account', interpolation: { escapeValue: false } })
  const t = i18n.getFixedT(null, 'account')
  const internal = { user_id: 'u-1', email: '', auth: true, display_name: 'u-e2c2be9f09184e0d9cc06e6247e3607c' }
  assert.equal(accountDisplayText(null, null, t), '书深用户')
  assert.equal(accountDisplayText(internal, null, t), '书深用户')
  await i18n.changeLanguage('en')
  assert.equal(accountDisplayText(null, null, t), 'ScholarSeed user')
  assert.equal(accountDisplayText(internal, null, t), 'ScholarSeed user')
  assert.equal(accountDisplayName(internal), '书深用户')
  assert.equal(accountDisplayName(null), '书深用户')
  for (const name of ['书深用户', 'ScholarSeed user', 'Researcher / 中文']) {
    const profile = { user_id: 'u-1', nickname: name }
    const user = { ...internal, nickname: name, display_name: 'Other', email: 'other@example.test' }
    assert.equal(accountDisplayText(user, profile, t), name)
    assert.equal(accountDisplayText(user, null, t), name)
    assert.equal(accountDisplayText({ ...internal, display_name: name }, null, t), name)
    assert.equal(accountDisplayText({ ...internal, email: name }, null, t), name)
  }
  const user = { ...internal, nickname: '  Reader  ', email: 'reader@example.test' }
  assert.equal(accountDisplayText(user, { user_id: 'u-1', nickname: '  Profile  ' }, t), 'Profile')
  assert.equal(accountDisplayText(user, { user_id: 'u-1', nickname: '  ' }, t), 'Reader')
  assert.deepEqual(user, { ...internal, nickname: '  Reader  ', email: 'reader@example.test' })
})

test('account UI consumers share localized display names without manufacturing user nicknames', () => {
  const consumers = ['features/home/Home.tsx', 'shell/ActivityRail.tsx', 'components/business/Chrome.tsx', 'components/business/AccountMenu.tsx']
  for (const path of consumers) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    assert.match(source, /accountDisplayText\(user, profile, accountText\)/, path)
    assert.doesNotMatch(source, /accountDisplayName\(/, path)
  }
  const menu = readFileSync(new URL('components/business/AccountMenu.tsx', import.meta.url), 'utf8')
  assert.match(menu, /<UserAvatar user=\{user\} displayName=\{name\}/)
  assert.match(menu, /const label = displayName \?\? accountDisplayText\(user, null, accountText\)/)
  assert.match(menu, /userAvatarText\(label\)/)
  assert.doesNotMatch(menu, /user=\{\{[^}]*nickname: name/)
})

test('account profile validation rejects drifting remote response shapes', () => {
  assert.deepEqual(parseAccountProfile({ user_id: 'u-1', nickname: 'Researcher', phone: '15200000000' }), {
    ok: true,
    data: { user_id: 'u-1', nickname: 'Researcher', phone: '15200000000' }
  })
  const invalid = parseAccountProfile({ user_id: 'u-1' })
  assert.equal(invalid.ok, false)
  if (!invalid.ok) assert.equal(invalid.code, 'invalid_response')
})

test('displayed phone keeps only the first three and last four digits', () => {
  assert.equal(maskPhone('15279189415'), '152****9415')
  // 空号码回空串而不是一串星号：调用方要靠它判断「服务端没给手机号」并换降级文案。
  assert.equal(maskPhone(''), '')
  assert.equal(maskPhone('   '), '')
})

test('phone masking fails closed on lengths that could leak the whole number', () => {
  // 短号码整串打码：宁可全遮，也不能因为「前 3 后 4 拼起来就是原号」而等于没脱敏。
  assert.equal(maskPhone('1234567'), '****')
  assert.equal(maskPhone('88'), '****')
})

test('reset password dialog exposes stable fields and submit readiness', () => {
  assert.equal(RESET_PASSWORD_DIALOG.testId, 'account-reset-password-dialog')
  assert.equal(RESET_PASSWORD_DIALOG.codeTestId, 'account-reset-password-code')
  assert.equal(RESET_PASSWORD_DIALOG.passwordTestId, 'account-reset-password-new')
  assert.equal(
    resetPasswordSubmitReady({
      phoneValid: true,
      code: '123456',
      password: 'passw0rd',
      busy: false
    }),
    true
  )
  assert.equal(
    resetPasswordSubmitReady({
      phoneValid: true,
      code: '12345',
      password: 'passw0rd',
      busy: false
    }),
    false
  )
  assert.equal(
    resetPasswordSubmitReady({
      phoneValid: true,
      code: '123456',
      password: 'short',
      busy: false
    }),
    false
  )
})

test('credit summary carries the granted-balance reading from the gateway', () => {
  assert.deepEqual(
    parseCreditsSummary({
      user_id: 'u-1',
      balance_credits: 19500.0,
      granted_credits: 20000.0,
      used_credits: 500.0,
      unlimited: false,
      enforcing: true,
      earliest_expiry_at: '2027-03-10T10:00:00+08:00'
    }),
    {
      balance_credits: 19500,
      granted_credits: 20000,
      used_credits: 500,
      unlimited: false,
      enforcing: true,
      earliest_expiry_at: '2027-03-10T10:00:00+08:00'
    }
  )
})

test('an exhausted balance reads zero while a missing one stays unknown', () => {
  // 余额耗尽是真的 0（界面必须显示 0）；字段缺失是「不知道」。两者压成同一个值，
  // 降级就会长得像被清零 —— 那正是这条口径最容易骗人的地方。
  assert.equal(parseCreditsSummary({ balance_credits: 0 }).balance_credits, 0)
  assert.equal(parseCreditsSummary({ balance_credits: 0.0 }).balance_credits, 0)
  assert.equal(parseCreditsSummary({}).balance_credits, null)
  assert.equal(parseCreditsSummary({ balance_credits: 'not-a-number' }).balance_credits, null)
})

test('the warning bucket splits at the low threshold and at zero', () => {
  assert.equal(creditsWarningBucket(CREDITS_LOW_WARNING_THRESHOLD + 1), null)
  assert.equal(creditsWarningBucket(CREDITS_LOW_WARNING_THRESHOLD), 'low')
  assert.equal(creditsWarningBucket(1), 'low')
  assert.equal(creditsWarningBucket(0), 'exhausted')
  // 闸门内部超支为负，对外夹到 0；预警口径同样把负余额读成耗尽而不是「比 0 还安全」。
  assert.equal(creditsWarningBucket(-3), 'exhausted')
})

test('only an enforced finite zero balance blocks built-in credit usage', () => {
  const exhausted = parseCreditsSummary({
    balance_credits: 0,
    unlimited: false,
    enforcing: true
  })
  assert.equal(creditsAreExhausted(exhausted), true)
  assert.equal(creditsAreExhausted({ ...exhausted, enforcing: false }), false)
  assert.equal(creditsAreExhausted({ ...exhausted, unlimited: true }), false)
  assert.equal(creditsAreExhausted({ ...exhausted, balance_credits: null }), false)
  assert.equal(creditsAreExhausted(null), false)
  const credits = { phase: 'ready' as const, summary: exhausted }
  assert.equal(creditsBlockBuiltInModel(credits, { source: 'builtin' }), true)
  assert.equal(creditsBlockBuiltInModel(credits, { source: 'personal' }), false)
  assert.equal(creditsBlockBuiltInModel(credits, undefined), false)
})

test('a runtime exhaustion signal preserves known ledger fields while closing the gate', () => {
  assert.deepEqual(
    markCreditsExhausted({
      phase: 'ready',
      summary: parseCreditsSummary({
        balance_credits: 8,
        granted_credits: 20,
        used_credits: 12,
        enforcing: true,
        earliest_expiry_at: '2027-03-10T10:00:00+08:00'
      })
    }),
    {
      phase: 'ready',
      summary: {
        balance_credits: 0,
        granted_credits: 20,
        used_credits: 12,
        unlimited: false,
        enforcing: true,
        earliest_expiry_at: '2027-03-10T10:00:00+08:00'
      }
    }
  )
})

test('a long-lived grant keeps a null expiry instead of an invented date', () => {
  // earliest_expiry_at = null 表示没有会到期的行（长期有效）。Number(null) === 0，
  // 交给数值归一会把「长期有效」渲染成 1970-01-01，所以它走单独的时间戳归一。
  assert.equal(parseCreditsSummary({ earliest_expiry_at: null }).earliest_expiry_at, null)
  assert.equal(parseCreditsSummary({}).earliest_expiry_at, null)
  assert.equal(parseCreditsSummary({ earliest_expiry_at: '   ' }).earliest_expiry_at, null)
  assert.equal(parseCreditsSummary({ earliest_expiry_at: 'soon' }).earliest_expiry_at, null)
})

test('exemption and enforcement flags fall back to the safe reading', () => {
  // unlimited 缺失必须读成 false：把「上游没给」当成「不计量」等于给所有人开豁免。
  assert.equal(parseCreditsSummary({}).unlimited, false)
  assert.equal(parseCreditsSummary({ unlimited: 'true' }).unlimited, false)
  assert.equal(parseCreditsSummary({ unlimited: true }).unlimited, true)
  // enforcing 缺失同样按 false（只算不拒）读，界面不据此编造一个「已被拒」的解释。
  assert.equal(parseCreditsSummary({}).enforcing, false)
  assert.equal(parseCreditsSummary({ enforcing: true }).enforcing, true)
})

test('the credits anchor reuses the one cloud-page opening path', () => {
  setAccountBase('https://account.example/')
  assert.equal(cloudPageUrl('credits'), 'https://account.example/web/credits.html')
  assert.equal(cloudPageUrl('profile'), 'https://account.example/web/account.html')
  assert.equal(
    cloudPageUrl('credits', CLOUD_PAGE_ANCHORS.creditsMore),
    'https://account.example/web/credits.html#credit-more'
  )
  // 账号服务地址未下发时仍回空串（带锚点也一样），调用方据此隐藏跳转 affordance。
  setAccountBase('')
  assert.equal(cloudPageUrl('credits'), '')
  assert.equal(cloudPageUrl('credits', CLOUD_PAGE_ANCHORS.creditsMore), '')
})
