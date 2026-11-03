import assert from 'node:assert/strict'
import test from 'node:test'
import { createAvailabilityPolicy } from './policy.ts'

test('product availability rejects browser routes, tabs, settings and old restore pointers', () => {
  const policy = createAvailabilityPolicy(false)
  const tabs = [{ id: 'browser', kind: 'browser' }, { id: 'document', kind: 'file' }]
  assert.equal(policy.routeAvailable('browser'), false)
  assert.equal(policy.tabAvailable(tabs[0]), false)
  assert.equal(policy.tabIdAvailable('browser'), false)
  assert.equal(policy.settingsAvailable('browser'), false)
  assert.equal(policy.hilAvailable('browser_approval'), false)
  assert.equal(policy.hilAvailable('browser_history_approval'), false)
  assert.equal(policy.hilAvailable('tool_approval'), true)
  const current = { mainView: 'resource', tabs: [tabs[1]], activeTab: 'document', accountSettingsPage: null as string | null, composerText: '' }
  assert.deepEqual(policy.navigationPatch(current, { mainView: 'browser', tabs, activeTab: 'browser', accountSettingsPage: 'browser', composerText: 'keep' }), {
    mainView: 'resource', tabs: [tabs[1]], activeTab: 'document', accountSettingsPage: null, browserSettingsSection: null, composerText: 'keep'
  })
  assert.deepEqual(policy.navigationLocation({ view: 'browser', target: { kind: 'tab', id: 'browser' }, settingsPage: 'browser', projectId: 'project', sessionId: 'session' }), {
    view: 'home', target: null, settingsPage: null, browserSettingsSection: null, projectId: 'project', sessionId: 'session'
  })
})

test('explicitly enabled browser preserves complete navigation and settings', () => {
  const policy = createAvailabilityPolicy(true)
  const location = { view: 'browser', target: { kind: 'tab', id: 'browser' }, settingsPage: 'browser', browserSettingsSection: 'overview' }
  assert.equal(policy.routeAvailable('browser'), true)
  assert.equal(policy.tabAvailable({ id: 'browser', kind: 'browser' }), true)
  assert.equal(policy.settingsAvailable('browser'), true)
  assert.equal(policy.navigationLocation(location), location)
})

test('all browser section navigation patches and restored locations share the same admission rules', () => {
  for (const enabled of [true, false]) {
    const policy = createAvailabilityPolicy(enabled)
    const current = { mainView: 'home', tabs: [], activeTab: 'overview', accountSettingsPage: null as string | null, browserSettingsSection: null as unknown }
    for (const value of ['history', 'overview', 'data', 'downloads', undefined, null, 'unknown']) {
      const expected = enabled ? value === 'history' ? 'history' : 'overview' : null
      const patch = policy.navigationPatch(current, { accountSettingsPage: 'browser', browserSettingsSection: value })
      assert.equal(patch.browserSettingsSection, expected)
      assert.equal(policy.navigationLocation({ view: 'home', settingsPage: 'browser', browserSettingsSection: value }).browserSettingsSection, expected)
    }
    assert.equal(policy.navigationPatch({ ...current, accountSettingsPage: 'browser' as string | null, browserSettingsSection: 'history' }, { accountSettingsPage: null }).browserSettingsSection, null)
    assert.equal(policy.navigationPatch({ ...current, accountSettingsPage: 'browser', browserSettingsSection: 'history' }, { accountSettingsPage: 'models' }).browserSettingsSection, null)
  }
})

test('legacy direct policy callers also receive the canonical missing section', () => {
  assert.deepEqual(createAvailabilityPolicy(true).navigationLocation({ view: 'home', settingsPage: 'browser' }), { view: 'home', settingsPage: 'browser', browserSettingsSection: 'overview' })
  assert.deepEqual(createAvailabilityPolicy(false).navigationLocation({ view: 'home', settingsPage: 'browser' }), { view: 'home', settingsPage: null, browserSettingsSection: null })
})
