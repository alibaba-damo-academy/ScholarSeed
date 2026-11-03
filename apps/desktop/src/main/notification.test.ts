import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import {
  WindowsNotifications,
  notificationXml,
  findNotificationUrl,
  notificationLaunchAttentionId,
  type ToastNative,
} from './notification.ts'

const input = { attentionId: randomUUID(), title: '<title>&', body: '"body"\u0001', silent: true }
test('toast text cannot inject XML or activation payloads', () => {
  assert.equal(
    notificationXml(input, 'scholarseed://notification/test'),
    '<toast activationType="protocol" launch="scholarseed://notification/test"><visual><binding template="ToastGeneric"><text>&lt;title&gt;&amp;</text><text>&quot;body&quot;</text></binding></visual><audio silent="true"/></toast>'
  )
})
function fixture() {
  const closed: unknown[] = [],
    events: string[] = []
  let activationUrl = ''
  let callback: (event: string, error: number) => void = () => {}
  const native: ToastNative = {
    history: () => [],
    remove() {},
    detach(handle) {
      closed.push(handle)
    },
    show(id, xml, cb) {
      assert.equal(id, 'velopack.scholarseed')
      assert.ok(xml.includes('ToastGeneric'))
      activationUrl = xml.match(/launch="([^"]+)"/)![1]
      callback = cb
      return 'handle'
    },
    close(handle) {
      closed.push(handle)
    },
  }
  const owner = new WindowsNotifications(native)
  owner.show(input, {
    click: () => events.push('click'),
    failed: (error) => events.push(error),
    submitted: () => events.push('submitted'),
  })
  return {
    owner,
    closed,
    events,
    activationUrl,
    emit: (event: string, code = 0) => callback(event, code),
  }
}
test('timed-out notifications retain action-center click routing', () => {
  const f = fixture()
  f.emit('timeout')
  assert.deepEqual(f.closed, [])
  f.emit('click')
  assert.deepEqual(f.events, ['submitted', 'click'])
  assert.deepEqual(f.closed, ['handle'])
  f.emit('click')
  f.owner.dispose()
  assert.equal(f.closed.length, 1)
})
test('user dismissal closes a toast without navigating', () => {
  const f = fixture()
  f.emit('close')
  assert.deepEqual(f.events, ['submitted'])
  assert.equal(f.closed.length, 1)
})
test('native failure is visible and releases its notification', () => {
  const f = fixture()
  f.emit('failed', -2147024891)
  assert.match(f.events[1], /80070005/)
  assert.equal(f.closed.length, 1)
})
test('application shutdown hides outstanding notifications and ignores queued events', () => {
  const f = fixture()
  f.owner.dispose()
  f.emit('click')
  assert.deepEqual(f.events, ['submitted'])
  assert.deepEqual(f.closed, ['handle'])
})
test('native submission failure propagates without retained handles', () => {
  const owner = new WindowsNotifications({
    history: () => [],
    remove() {},
    detach() {},
    show() {
      throw new Error('disabled')
    },
    close() {
      assert.fail()
    },
  })
  assert.throws(
    () =>
      owner.show(input, {
        click() {},
        failed() {},
        submitted() {
          assert.fail()
        },
      }),
    /disabled/
  )
  owner.dispose()
})
test('retention is bounded even if notifications stay in Action Center', () => {
  let next = 0
  const closed: unknown[] = []
  const owner = new WindowsNotifications({
    history: () => [],
    remove() {},
    detach(handle) {
      closed.push(handle)
    },
    show() {
      return ++next
    },
    close(handle) {
      closed.push(handle)
    },
  })
  for (let index = 0; index < 40; index++)
    owner.show({ ...input, attentionId: randomUUID() }, { click() {}, failed() {}, submitted() {} })
  assert.equal(closed.length, 8)
  owner.dispose()
  assert.equal(closed.length, 40)
})

test('protocol activation after dismissal navigates once without trusting arbitrary URLs', () => {
  const f = fixture()
  f.emit('timeout')
  f.emit('close')
  assert.equal(f.owner.activate('scholarseed://notification/unknown'), false)
  assert.equal(f.owner.activate(f.activationUrl + '?session=other'), false)
  assert.equal(f.owner.activate(f.activationUrl), true)
  assert.deepEqual(f.events, ['submitted', 'click'])
  assert.equal(f.owner.activate(f.activationUrl), false)
  assert.deepEqual(f.closed, ['handle'])
})
test('disposed and evicted routes cannot navigate', () => {
  const f = fixture()
  f.owner.dispose()
  assert.equal(f.owner.activate(f.activationUrl), false)
  const g = fixture()
  for (let index = 0; index < 32; index++)
    g.owner.show(
      { ...input, attentionId: randomUUID() },
      { click() {}, failed() {}, submitted() {} }
    )
  assert.equal(g.owner.activate(g.activationUrl), false)
  g.owner.dispose()
})

test('only strict UUID notification routes enter the cross-integrity inbox', () => {
  const url = 'scholarseed://notification/12345678-1234-4123-8123-123456789abc'
  assert.equal(findNotificationUrl(['exe', `"${url}"`]), url)
  for (const value of [
    url + '?session=x',
    url + '/other',
    url.replace('notification', 'auth'),
    'scholarseed://notification/unknown',
  ])
    assert.equal(findNotificationUrl([value]), undefined)
})

test('macOS cold launch extracts the notification response identity without trusting arbitrary routes', () => {
  const identifier = '12345678-1234-4123-8123-123456789abc'
  assert.equal(
    notificationLaunchAttentionId({ identifier, actionIdentifier: 'default', userInfo: {} }),
    identifier
  )
  for (const launchInfo of [
    undefined,
    null,
    [],
    {},
    { userInfo: { identifier } },
    { identifier: 123 },
    { identifier: `scholarseed://notification/${identifier}` },
    { identifier: `${identifier}?session=other` },
    { identifier: '/tmp/target' },
  ])
    assert.equal(notificationLaunchAttentionId(launchInfo), undefined)
})

test('sound opt-in omits the mute instruction and never overrides system sound settings', () => {
  assert.ok(!notificationXml({ ...input, silent: false }, 'route').includes('<audio'))
  assert.ok(notificationXml({ ...input, silent: true }, 'route').includes('<audio silent="true"/>'))
})

test('read reconciliation removes persisted native history only in the current profile', () => {
  const deleted: string[] = []
  const kept = randomUUID()
  const read = randomUUID()
  const owner = new WindowsNotifications({
    show() {},
    close() {},
    detach() {},
    history: () => [`profile.${kept}`, `profile.${read}`, `another.${read}`],
    remove(aumid, id) {
      assert.equal(aumid, 'velopack.scholarseed')
      deleted.push(id)
    },
  })
  owner.setScope('profile')
  owner.retain(new Set([kept]))
  assert.deepEqual(deleted, [`profile.${read}`])
})

test('normal shutdown releases native handles without erasing unread Action Center entries', () => {
  const detached: unknown[] = []
  const owner = new WindowsNotifications({
    show: () => 'handle',
    history: () => [],
    remove() {},
    close() {
      assert.fail('shutdown must not hide unread notifications')
    },
    detach(handle) {
      detached.push(handle)
    },
  })
  owner.show(input, { click() {}, failed() {}, submitted() {} })
  owner.dispose(true)
  assert.deepEqual(detached, ['handle'])
})

test('permission diagnostics preserve submission and never include notification content', () => {
  const logs: string[] = []
  const events: string[] = []
  const owner = new WindowsNotifications(
    {
      history: () => [],
      remove() {},
      detach() {},
      show(_aumid, _xml, callback) {
        callback('setting', 0)
        return 'handle'
      },
      close() {
        assert.fail('diagnostic must not close the notification')
      },
    },
    (line) => logs.push(line)
  )
  owner.show(input, {
    click() {
      assert.fail()
    },
    failed() {
      assert.fail()
    },
    submitted() {
      events.push('submitted')
    },
  })
  const records = logs.map((line) => JSON.parse(line.slice('[notification] '.length)))
  assert.deepEqual(
    records.map((record) => record.event),
    ['attempt', 'setting', 'submitted']
  )
  assert.equal(records[1].stage, 'get_Setting')
  assert.equal(records[1].setting, 0)
  assert.equal(records[1].aumid, 'velopack.scholarseed')
  assert.ok(records.every((record) => record.id === input.attentionId))
  assert.deepEqual(events, ['submitted'])
  assert.ok(!logs.join('').includes(input.title))
  assert.ok(!logs.join('').includes('body'))
})

test('native stage and HRESULT persist while the original failure is rethrown without retry', () => {
  for (const stage of [
    'IToastNotification2.QueryInterface',
    'put_Tag',
    'put_Group',
    'CreateToastNotifierWithId',
    'get_Setting',
    'Show',
    'NotificationSetting',
  ]) {
    const logs: string[] = []
    let attempts = 0
    const failure = Object.assign(new Error('private diagnostic message'), {
      stage,
      hresult: 0x80070490,
      setting: -1,
    })
    const owner = new WindowsNotifications(
      {
        history: () => [],
        remove() {},
        detach() {},
        show() {
          attempts += 1
          throw failure
        },
        close() {
          assert.fail()
        },
      },
      (line) => logs.push(line)
    )
    assert.throws(
      () =>
        owner.show(input, {
          click() {
            assert.fail()
          },
          failed() {
            assert.fail()
          },
          submitted() {
            assert.fail()
          },
        }),
      (error) => error === failure
    )
    const record = JSON.parse(logs.at(-1)!.slice('[notification] '.length))
    assert.equal(record.stage, stage)
    assert.equal(record.hresult, '0x80070490')
    assert.equal(record.setting, -1)
    assert.equal(record.aumid, 'velopack.scholarseed')
    assert.equal(record.event, 'failed')
    assert.equal(attempts, 1)
    assert.ok(!logs.join('').includes(failure.message))
    owner.dispose()
  }
})

test('asynchronous native failures have a distinct diagnostic stage and retain callback behavior', () => {
  const logs: string[] = []
  const failures: string[] = []
  const closed: unknown[] = []
  let emit: (event: string, error: number) => void = () => {}
  const owner = new WindowsNotifications(
    {
      history: () => [],
      remove() {},
      detach() {},
      show(_aumid, _xml, callback) {
        emit = callback
        return 'handle'
      },
      close(handle) {
        closed.push(handle)
      },
    },
    (line) => logs.push(line)
  )
  owner.show(input, {
    click() {},
    submitted() {},
    failed(error) {
      failures.push(error)
    },
  })
  emit('failed', -2147023728)
  const record = JSON.parse(logs.at(-1)!.slice('[notification] '.length))
  assert.equal(record.stage, 'ToastFailed')
  assert.equal(record.hresult, '0x80070490')
  assert.deepEqual(closed, ['handle'])
  assert.equal(failures.length, 1)
})

test('unavailable settings remain diagnostic and preserve one real notification and its activation', () => {
  const logs: string[] = []
  const events: string[] = []
  let attempts = 0
  let closed = 0
  const owner = new WindowsNotifications(
    {
      history: () => [],
      remove() {},
      detach() {},
      show(_aumid, _xml, callback) {
        attempts += 1
        callback('setting-unavailable', -2147023728)
        return 'handle'
      },
      close() {
        closed += 1
      },
    },
    (line) => logs.push(line)
  )
  owner.show(input, {
    click() {
      events.push('click')
    },
    failed() {
      assert.fail()
    },
    submitted() {
      events.push('submitted')
    },
  })
  assert.equal(attempts, 1)
  assert.equal(closed, 0)
  const records = logs.map((line) => JSON.parse(line.slice('[notification] '.length)))
  assert.deepEqual(
    records.map((record) => record.event),
    ['attempt', 'setting-unavailable', 'submitted']
  )
  assert.equal(records[1].stage, 'get_Setting')
  assert.equal(records[1].hresult, '0x80070490')
  assert.equal(records[1].setting, -1)
  assert.equal(records[1].id, input.attentionId)
  assert.equal(owner.activate(`scholarseed://notification/${input.attentionId}`), true)
  assert.deepEqual(events, ['submitted', 'click'])
  assert.equal(closed, 1)
})

test('Show failures after unavailable settings are rethrown unchanged without retry or submission', () => {
  for (const hresult of [0x80070490, 0x80070005, 0x80004005]) {
    const logs: string[] = []
    let attempts = 0
    const failure = Object.assign(new Error('Show failed'), { stage: 'Show', hresult, setting: -1 })
    const owner = new WindowsNotifications(
      {
        history: () => [],
        remove() {},
        detach() {},
        close() {
          assert.fail()
        },
        show(_aumid, _xml, callback) {
          attempts += 1
          callback('setting-unavailable', -2147023728)
          throw failure
        },
      },
      (line) => logs.push(line)
    )
    assert.throws(
      () =>
        owner.show(input, {
          click() {
            assert.fail()
          },
          failed() {
            assert.fail()
          },
          submitted() {
            assert.fail()
          },
        }),
      (error) => error === failure
    )
    assert.equal(attempts, 1)
    const records = logs.map((line) => JSON.parse(line.slice('[notification] '.length)))
    assert.deepEqual(
      records.map((record) => record.event),
      ['attempt', 'setting-unavailable', 'failed']
    )
    assert.equal(records[2].stage, 'Show')
    assert.equal(records[2].hresult, `0x${hresult.toString(16)}`)
    assert.equal(owner.activate(`scholarseed://notification/${input.attentionId}`), false)
  }
})

test('diagnostic sink errors cannot prevent native submission or replace a native error', () => {
  let attempts = 0
  let submitted = 0
  const failure = new Error('native failure')
  const owner = new WindowsNotifications(
    {
      history: () => [],
      remove() {},
      detach() {},
      show(_aumid, _xml, callback) {
        attempts += 1
        if (attempts > 1) throw failure
        callback('setting-unavailable', -2147023728)
        callback('setting', 0)
        return 'handle'
      },
      close() {},
    },
    () => {
      throw new Error('disk unavailable')
    }
  )
  const callbacks = {
    click() {},
    failed() {},
    submitted() {
      submitted += 1
    },
  }
  owner.show(input, callbacks)
  assert.throws(
    () => owner.show(input, callbacks),
    (error) => error === failure
  )
  assert.equal(attempts, 2)
  assert.equal(submitted, 1)
  owner.dispose()
})
