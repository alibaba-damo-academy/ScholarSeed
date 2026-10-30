import assert from 'node:assert/strict'
import test from 'node:test'
import * as account from './accountview.ts'

test('identity_change_invalidates_old_action including replaced menus and busy logout', () => {
  const allowed = (account as unknown as { accountActionAllowed: (expected: unknown, current: unknown, action: string) => boolean }).accountActionAllowed
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
