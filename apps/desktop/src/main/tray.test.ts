import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { BrowserWindow } from 'electron'
import * as windowContract from '../window.ts'
import type { WindowsCloseController } from './tray'

const traySource = readFileSync(new URL('./tray.ts', import.meta.url), 'utf8')

function fixture(options: { platform?: NodeJS.Platform; askOnClose?: boolean; saveFails?: boolean; revealSucceeds?: boolean } = {}) {
  const state = {
    quit: 0, hidden: 0, prevented: 0, marked: 0, trays: 0, destroyed: false, visible: true,
    revealed: [] as string[],
    trayHandlers: new Map<string, () => void>(),
    menuHandlers: new Map<string, () => void>(),
    events: [] as Array<{ channel: string; request: windowContract.WindowCloseRequest }>,
    saved: [] as unknown[], logs: [] as string[], popupMenus: 0,
    trayMenu: [] as Array<{ label: string; click?: () => void }>
  }
  class FakeTray {
    constructor() { state.trays += 1 }
    isDestroyed(): boolean { return false }
    setToolTip(): void {}
    setContextMenu(menu: typeof state.trayMenu): void { state.trayMenu = menu }
    popUpContextMenu(): void { state.popupMenus += 1 }
    on(event: string, handler: () => void): void { state.trayHandlers.set(event, handler) }
  }
  const dependencies: Record<string, unknown> = {
    electron: {
      app: {
        getPath: () => '/tmp/scholarseed', getAppPath: () => '/repo/apps/desktop',
        isPackaged: false, quit: () => { state.quit += 1 }
      },
      Menu: { buildFromTemplate: (template: typeof state.trayMenu) => {
        state.trayMenu = template
        return Object.assign(template, {
          on: (event: string, handler: () => void) => state.menuHandlers.set(event, handler)
        })
      } }, Tray: FakeTray,
      nativeImage: { createFromPath: () => ({ isEmpty: () => false }) }
    },
    fs: { existsSync: () => false }, path: { dirname, join }, '../window': windowContract
  }
  const exports: Record<string, unknown> = {}
  runInNewContext(ts.transpileModule(traySource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, {
    exports,
    require: (name: string) => {
      assert.ok(Object.hasOwn(dependencies, name), `unexpected import: ${name}`)
      return dependencies[name]
    },
    process: { platform: 'win32', resourcesPath: '/resources' }
  })
  const create = exports.createWindowsCloseController as (options: unknown) => WindowsCloseController
  const controller = create({
    localizer: () => ({ getFixedT: () => (key: string) => key }),
    revealWindow: (reason: string) => {
      state.revealed.push(reason)
      if (options.revealSucceeds === false) return false
      state.visible = true
      return true
    },
    markQuitting: () => { state.marked += 1 },
    log: (line: string) => state.logs.push(line),
    platform: options.platform ?? 'win32',
    stateStore: {
      load: () => ({ askOnClose: options.askOnClose ?? true }),
      save: (value: unknown) => {
        if (options.saveFails) throw new Error('read-only state directory')
        state.saved.push(value)
      }
    }
  })
  const window = {
    id: 1,
    hide: () => { state.hidden += 1; state.visible = false },
    isDestroyed: () => state.destroyed, isVisible: () => state.visible,
    webContents: { send: (channel: string, request: windowContract.WindowCloseRequest) => state.events.push({ channel, request }) }
  } as unknown as BrowserWindow
  const close = (): void => controller.handleClose(window, { preventDefault: () => { state.prevented += 1 } } as Electron.Event)
  const respond = (action: windowContract.WindowCloseAction, remember = false): boolean => controller.respond(window, {
    requestId: controller.currentRequest(window), action, remember
  })
  return { controller, window, state, close, respond, exports }
}

test('损坏或缺失的关闭偏好仍需询问', () => {
  const { exports } = fixture()
  const sanitize = exports.sanitizeWindowCloseState as (value: unknown) => { askOnClose: boolean }
  for (const value of [undefined, null, [], {}, { askOnClose: 'false' }]) assert.equal(sanitize(value).askOnClose, true)
  assert.equal(sanitize({ askOnClose: false }).askOnClose, false)
})

test('Windows 关闭请求交给主渲染器，重复关闭不创建重复请求', () => {
  const { close, state, controller, window } = fixture()
  close()
  close()
  assert.equal(state.prevented, 2)
  assert.equal(state.trays, 1)
  assert.deepEqual(state.events, [{ channel: windowContract.WINDOW_CLOSE_REQUEST_CHANNEL, request: 1 }])
  assert.equal(controller.currentRequest(window), 1)
  assert.equal(state.hidden, 0)
  assert.equal(state.quit, 0)
})

test('最小化到托盘并保存偏好，后台进程不退出', () => {
  const { close, respond, state, controller, window } = fixture()
  close()
  assert.equal(respond('minimize', true), true)
  assert.equal(state.hidden, 1)
  assert.equal(state.quit, 0)
  assert.equal(JSON.stringify(state.saved), JSON.stringify([{ askOnClose: false }]))
  assert.equal(controller.currentRequest(window), null)
  assert.equal(state.events.at(-1)?.request, null)
  assert.equal(respond('quit'), false)
})

test('取消不保存偏好、不隐藏、不退出，后续关闭可再次询问', () => {
  const { close, respond, state, controller, window } = fixture()
  close()
  assert.equal(respond('cancel', true), true)
  assert.equal(state.saved.length, 0)
  assert.equal(state.hidden, 0)
  assert.equal(state.quit, 0)
  close()
  assert.equal(controller.currentRequest(window), 2)
})

test('退出确认先标记退出，保持现有记住偏好语义', () => {
  const { close, respond, state } = fixture()
  close()
  respond('quit', true)
  assert.equal(state.marked, 1)
  assert.equal(state.quit, 1)
  assert.equal(state.hidden, 0)
  assert.equal(state.saved.length, 1)
})

test('记住最小化后不发送询问，直接隐藏到托盘', () => {
  const { close, state } = fixture({ askOnClose: false })
  close()
  assert.equal(state.hidden, 1)
  assert.equal(state.events.length, 0)
  assert.equal(state.quit, 0)
})

test('拒绝非所属窗口、非法参数、过期及重复回复', () => {
  const { close, respond, controller, window, state } = fixture()
  close()
  const reply = { requestId: 1, action: 'quit', remember: false }
  assert.equal(controller.respond({} as BrowserWindow, reply), false)
  for (const value of [null, {}, { ...reply, requestId: 0 }, { ...reply, action: 'delete' }, { ...reply, remember: 'true' }]) {
    assert.equal(controller.respond(window, value), false)
  }
  respond('cancel')
  close()
  assert.equal(controller.respond(window, reply), false)
  assert.equal(state.quit, 0)
})

test('窗口销毁后不处理遗留回复', () => {
  const { close, controller, window, state } = fixture()
  close()
  state.destroyed = true
  assert.equal(controller.currentRequest(window), null)
  assert.equal(controller.respond(window, { requestId: 1, action: 'quit', remember: false }), false)
  assert.equal(state.quit, 0)
})

test('偏好保存失败记录日志，但不阻止当次关闭选择', () => {
  const { close, respond, state } = fixture({ saveFails: true })
  close()
  assert.equal(respond('minimize', true), true)
  assert.equal(state.hidden, 1)
  assert.ok(state.logs.some((line) => line.includes('read-only state directory')))
})

test('macOS 与其他平台不接管原有关闭行为', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const { close, state, controller, window } = fixture({ platform })
    close()
    controller.ensureTray(window)
    assert.equal(state.prevented, 0)
    assert.equal(state.trays, 0)
    assert.equal(state.events.length, 0)
    assert.equal(controller.currentRequest(window), null)
    assert.equal(state.hidden, 0)
    assert.equal(state.quit, 0)
  }
})

test('托盘菜单退出先标记退出状态', () => {
  const { controller, window, state } = fixture()
  controller.ensureTray(window)
  state.trayMenu.find((item) => item.label === 'tray.quit')?.click?.()
  assert.equal(state.marked, 1)
  assert.equal(state.quit, 1)
})

test('隐藏后托盘单击调用恢复入口，并记录事件与恢复结果', () => {
  const { close, respond, state } = fixture()
  close()
  respond('minimize')
  assert.equal(state.visible, false)
  assert.ok(state.trayHandlers.has('click'))
  state.trayHandlers.get('click')!()
  assert.deepEqual(state.revealed, ['tray click'])
  assert.equal(state.visible, true)
  assert.ok(state.logs.some((line) => line.includes('[tray] click window=1')))
  assert.ok(state.logs.some((line) => line.includes('reveal completed restored=true')))
})

test('托盘双击与菜单显示窗口都调用恢复入口', () => {
  const { close, respond, state } = fixture()
  close()
  respond('minimize')
  state.trayHandlers.get('double-click')!()
  close()
  respond('minimize')
  state.trayMenu.find((item) => item.label === 'tray.show')!.click!()
  assert.deepEqual(state.revealed, ['tray double click', 'tray menu'])
  assert.equal(state.quit, 0)
})

test('鼠标进入和原生菜单生命周期均可观测', () => {
  const { close, state } = fixture()
  close()
  state.trayHandlers.get('mouse-enter')!()
  state.trayHandlers.get('right-click')!()
  state.menuHandlers.get('menu-will-show')!()
  state.menuHandlers.get('menu-will-close')!()
  assert.ok(state.logs.includes('[tray] mouse entered\n'))
  assert.ok(state.logs.some((line) => line.includes('[tray] right click window=1')))
  assert.equal(state.popupMenus, 1)
  assert.ok(state.logs.includes('[tray] context menu opening\n'))
  assert.ok(state.logs.includes('[tray] context menu closing\n'))
})

test('恢复入口找不到窗口时记录失败，而非误报已恢复', () => {
  const { close, respond, state } = fixture({ revealSucceeds: false })
  close()
  respond('minimize')
  state.trayHandlers.get('click')!()
  assert.equal(state.visible, false)
  assert.ok(state.logs.includes('[tray] reveal completed restored=false\n'))
  assert.equal(state.quit, 0)
})
