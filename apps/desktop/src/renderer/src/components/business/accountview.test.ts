import assert from 'node:assert/strict'
import test from 'node:test'
import * as account from './accountview.ts'
import * as menu from '../../../../menu.ts'
import { SYSTEM_LANGUAGE_MODE } from '../../../../preferences.ts'

for (const locale of ['en', 'zh-CN'] as const)
  for (const languageMode of [undefined, SYSTEM_LANGUAGE_MODE])
    for (const logoutBusy of [false, true])
      test(`generated account language choices pass the shared validator: ${locale}/${languageMode}/${logoutBusy}`, () => {
        assert.equal(typeof menu.isAccountMenuLanguageValue, 'function')
        const view: menu.AccountMenuView = {
          alias: null,
          avatar: '',
          credits: { phase: 'error', value: null, unlimited: false },
          availableActions: [menu.MENU_ACTION.language],
          logoutBusy,
          logoutError: null,
          locale,
          ...(languageMode === SYSTEM_LANGUAGE_MODE ? { languageMode } : {}),
        }
        const choices = menu
          .menuActions(account.accountMenuItems(view))
          .filter((item) => item.actionId === menu.MENU_ACTION.language)
        assert.deepEqual(
          choices.map((item) => item.value),
          ['zh-CN', 'en', SYSTEM_LANGUAGE_MODE].map((value) => ({ kind: 'choice', value }))
        )
        for (const item of choices) {
          assert.equal(menu.isAccountMenuLanguageValue(item.value), true)
          assert.equal(item.disabled, logoutBusy)
        }
        assert.equal(choices.filter((item) => item.checked).length, 1)
      })

test('identity_change_invalidates_old_action including replaced menus and busy logout', () => {
  const allowed = (
    account as unknown as {
      accountActionAllowed: (expected: unknown, current: unknown, action: string) => boolean
    }
  ).accountActionAllowed
  assert.equal(typeof allowed, 'function')
  const expected = { identityRevision: 1, menuRevision: 2 }
  const current = { ...expected, open: true, busy: false, availableActions: ['account.logout'] }
  assert.equal(allowed(expected, current, 'account.logout'), true)
  assert.equal(allowed(expected, { ...current, identityRevision: 3 }, 'account.logout'), false)
  assert.equal(allowed(expected, { ...current, menuRevision: 4 }, 'account.logout'), false)
  assert.equal(allowed(expected, { ...current, busy: true }, 'account.logout'), false)
  assert.equal(allowed(expected, { ...current, open: false }, 'account.logout'), false)
  assert.equal(allowed(expected, current, 'account.settings'), false)
})
