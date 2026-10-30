import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createInstance } from 'i18next'
import { loginFailureText } from './login.ts'

test('login codes redraw while same-named raw diagnostics are preserved', async () => {
  const instance = createInstance()
  const resources = Object.fromEntries(
    ['zh', 'en'].map((language) => [
      language,
      {
        account: JSON.parse(
          readFileSync(
            new URL(`../../../../localization/locales/${language}/account.json`, import.meta.url),
            'utf8'
          )
        ),
      },
    ])
  )
  await instance.init({
    lng: 'zh',
    resources,
    defaultNS: 'account',
    interpolation: { escapeValue: false },
  })
  const t = instance.getFixedT(null, 'account')
  const code = { code: 'state_mismatch' }
  assert.match(loginFailureText(code, t), /重新发起登录/)
  assert.match(loginFailureText({ code: 'handoff_unclaimed' }, t), /重新发起登录/)
  assert.match(loginFailureText({ code: 'login_expired' }, t), /已过期/)
  await instance.changeLanguage('en')
  assert.match(loginFailureText(code, t), /Start sign-in again/)
  assert.match(loginFailureText({ code: 'handoff_unclaimed' }, t), /start sign-in again/)
  assert.match(loginFailureText({ code: 'login_expired' }, t), /has expired/)
  assert.deepEqual(code, { code: 'state_mismatch' })
  assert.equal(
    loginFailureText({ code: 'login_failed', diagnostic: 'state_mismatch' }, t),
    'Sign-in failed. Try again.'
  )
  assert.equal(
    loginFailureText({ code: 'constructor', diagnostic: '原始诊断' }, t),
    'Sign-in failed. Try again.'
  )
  assert.match(loginFailureText({ code: 'native_unavailable' }, t), /browser mode/)
})
