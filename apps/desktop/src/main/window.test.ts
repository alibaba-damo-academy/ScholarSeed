import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import {
  createLoginWindowSizing,
  createStartupWindowHandoff,
  createWindowHiding,
  createWorkspaceWindowOptions,
} from './window.ts'
import { WORKSPACE_WINDOW_SIZE, WORKSPACE_WINDOW_MINIMUM } from '../window.ts'

test('workspace configuration retains macOS and Windows geometry and mandatory renderer isolation', () => {
  for (const platform of ['darwin', 'win32'] as const) {
    const options = createWorkspaceWindowOptions({
      platform,
      preload: '/owned/preload.cjs',
      icon: '/owned/app.ico',
    })
    assert.equal(options.width, WORKSPACE_WINDOW_SIZE.width)
    assert.equal(options.height, WORKSPACE_WINDOW_SIZE.height)
    assert.equal(options.minWidth, WORKSPACE_WINDOW_MINIMUM.width)
    assert.equal(options.minHeight, WORKSPACE_WINDOW_MINIMUM.height)
    assert.equal(options.useContentSize, true)
    assert.equal(options.show, false)
    assert.deepEqual(options.webPreferences, {
      preload: '/owned/preload.cjs',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    })
    if (platform === 'darwin') {
      assert.equal(options.titleBarStyle, 'hiddenInset')
      assert.deepEqual(options.trafficLightPosition, { x: 14, y: 16 })
      assert.equal(options.icon, undefined)
    } else {
      assert.equal(options.icon, '/owned/app.ico')
      assert.equal(options.titleBarStyle, undefined)
      assert.equal(options.trafficLightPosition, undefined)
    }
  }
})

test('warm startup hands off after paint without waiting for the backend', () => {
  let shows = 0
  const handoff = createStartupWindowHandoff(
    () => true,
    () => shows++
  )
  handoff.reused()
  assert.equal(shows, 0)
  handoff.painted()
  assert.equal(shows, 1)
  handoff.settled()
  assert.equal(shows, 1)
})

test('first component preparation keeps progress until the backend settles', () => {
  let shows = 0
  const handoff = createStartupWindowHandoff(
    () => true,
    () => shows++
  )
  handoff.painted()
  assert.equal(shows, 0)
  handoff.settled()
  assert.equal(shows, 1)
})

test('late component inspection and failed backend both wait for paint', () => {
  for (const signal of ['reused', 'settled'] as const) {
    let shows = 0
    const handoff = createStartupWindowHandoff(
      () => true,
      () => shows++
    )
    handoff[signal]()
    assert.equal(shows, 0)
    handoff.painted()
    assert.equal(shows, 1)
  }
})

test('retired or quitting startup never reveals a window', () => {
  let current = true
  let shows = 0
  const handoff = createStartupWindowHandoff(
    () => current,
    () => shows++
  )
  handoff.painted()
  current = false
  handoff.reused()
  handoff.settled()
  assert.equal(shows, 0)
})

function hidingFixture(fullscreen = true) {
  const operations: string[] = []
  let destroyed = false
  let allowed = true
  const window = Object.assign(new EventEmitter(), {
    isFullScreen: () => fullscreen,
    isDestroyed: () => destroyed,
    setFullScreen: (value: boolean) => {
      operations.push(`fullscreen:${value}`)
    },
    hide: () => {
      operations.push('hide')
    },
  })
  const controller = createWindowHiding(window, () => allowed)
  return {
    window,
    operations,
    controller,
    leave: () => {
      fullscreen = false
      window.emit('leave-full-screen')
    },
    destroy: () => {
      destroyed = true
      window.emit('closed')
    },
    disallow: () => {
      allowed = false
    },
  }
}

test('fullscreen close exits its Space before hiding the window', () => {
  const { controller, operations, leave } = hidingFixture()
  controller.hide()
  assert.deepEqual(operations, ['fullscreen:false'])
  leave()
  assert.deepEqual(operations, ['fullscreen:false', 'hide'])
})

test('ordinary close hides immediately without changing fullscreen', () => {
  const { controller, operations } = hidingFixture(false)
  controller.hide()
  assert.deepEqual(operations, ['hide'])
})

test('repeated close during fullscreen exit only schedules one hide', () => {
  const { controller, operations, window, leave } = hidingFixture()
  controller.hide()
  controller.hide()
  assert.equal(window.listenerCount('leave-full-screen'), 1)
  leave()
  leave()
  assert.deepEqual(operations, ['fullscreen:false', 'hide'])
})

test('reveal cancels a deferred hide and permits a later close', () => {
  const { controller, operations, window, leave } = hidingFixture()
  controller.hide()
  controller.cancel()
  assert.equal(window.listenerCount('leave-full-screen'), 0)
  leave()
  assert.deepEqual(operations, ['fullscreen:false'])
  controller.hide()
  assert.deepEqual(operations, ['fullscreen:false', 'hide'])
})

test('destroyed windows release pending fullscreen callbacks', () => {
  const { controller, operations, window, destroy, leave } = hidingFixture()
  controller.hide()
  destroy()
  assert.equal(window.listenerCount('leave-full-screen'), 0)
  leave()
  controller.hide()
  assert.deepEqual(operations, ['fullscreen:false'])
})

test('quit or maintenance cancels hiding when fullscreen exit completes', () => {
  const { controller, operations, disallow, leave } = hidingFixture()
  controller.hide()
  disallow()
  leave()
  controller.hide()
  assert.deepEqual(operations, ['fullscreen:false'])
})

test('failed fullscreen exit removes its listener and does not hide the window', () => {
  const { controller, operations, window } = hidingFixture()
  window.setFullScreen = () => {
    throw new Error('native exit failed')
  }
  assert.throws(() => controller.hide(), /native exit failed/)
  assert.equal(window.listenerCount('leave-full-screen'), 0)
  window.emit('leave-full-screen')
  assert.deepEqual(operations, [])
})

function fixture(maximized = false, allowed = () => true) {
  const bounds = { x: 40, y: 50, width: 1400, height: 900 }
  const operations: unknown[][] = []
  const setVisible = createLoginWindowSizing(
    {
      getNormalBounds: () => bounds,
      isMaximized: () => maximized,
      unmaximize: () => {
        operations.push(['unmaximize'])
      },
      maximize: () => {
        operations.push(['maximize'])
      },
      setMinimumSize: (width, height) => {
        operations.push(['minimum', width, height])
      },
      setSize: (width, height) => {
        operations.push(['size', width, height])
      },
      setBounds: (value) => {
        operations.push(['bounds', value])
      },
      center: () => {
        operations.push(['center'])
      },
    },
    allowed
  )
  return { bounds, operations, setVisible }
}

test('login uses 900 × 600 after lowering the workspace minimum', () => {
  const { operations, setVisible } = fixture()
  setVisible(true)
  assert.deepEqual(operations, [['minimum', 900, 600], ['size', 900, 600], ['center']])
})

test('leaving login restores the user workspace bounds and minimum', () => {
  const { bounds, operations, setVisible } = fixture()
  setVisible(true)
  operations.length = 0
  setVisible(false)
  assert.deepEqual(operations, [
    ['minimum', 1040, 660],
    ['bounds', bounds],
  ])
})

test('repeated visibility notifications do not reset user window resizing', () => {
  const { operations, setVisible } = fixture()
  setVisible(false)
  assert.deepEqual(operations, [])
  setVisible(true)
  operations.length = 0
  setVisible(true)
  assert.deepEqual(operations, [])
  setVisible(false)
  operations.length = 0
  setVisible(false)
  assert.deepEqual(operations, [])
})

test('temporarily unmaximizes login and restores maximized workspace', () => {
  const { operations, setVisible } = fixture(true)
  setVisible(true)
  assert.deepEqual(operations[0], ['unmaximize'])
  setVisible(false)
  assert.deepEqual(operations.at(-1), ['maximize'])
})

test('login sizing defers native maximize effects and replays only the latest requested layout', () => {
  let allowed = false
  const current = fixture(true, () => allowed)
  current.setVisible(true)
  current.setVisible(false)
  current.setVisible.flush()
  assert.deepEqual(current.operations, [])
  current.setVisible(true)
  allowed = true
  current.setVisible.flush()
  assert.deepEqual(current.operations[0], ['unmaximize'])
  current.operations.length = 0
  allowed = false
  current.setVisible(false)
  assert.deepEqual(current.operations, [])
  allowed = true
  current.setVisible.flush()
  assert.deepEqual(current.operations.at(-1), ['maximize'])
})
