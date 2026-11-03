import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { BrowserWindow } from 'electron'
import * as windowContract from '../window.ts'
import * as trayContract from '../tray.ts'
import * as journal from './journal.ts'
import * as windowRecord from './window-record.ts'
import type { WindowController } from './tray'

const traySource = readFileSync(new URL('./tray.ts', import.meta.url), 'utf8')

function fixture(
  options: {
    platform?: NodeJS.Platform
    packaged?: boolean
    systemDark?: boolean
    nativeSystemDark?: boolean
    registryOutput?: string
    registryFails?: boolean
    askOnClose?: boolean
    saveFails?: boolean
    revealSucceeds?: boolean
    translate?: (key: string, values?: { name: string }) => string
  } = {}
) {
  const state = {
    quit: 0,
    hidden: 0,
    prevented: 0,
    marked: 0,
    trays: 0,
    iconPaths: [] as string[],
    templateImages: [] as boolean[],
    updatedImages: 0,
    themeHandlers: new Set<() => void>(),
    systemDark: options.systemDark ?? false,
    registryQueries: 0,
    destroyed: false,
    disposedTrays: 0,
    windowHandlers: new Map<string, () => void>(),
    visible: true,
    revealed: [] as string[],
    trayHandlers: new Map<string, () => void>(),
    menuHandlers: new Map<string, () => void>(),
    snapshotRequests: [] as number[],
    navigation: [] as trayContract.TrayNavigation[],
    events: [] as Array<{ channel: string; request: windowContract.WindowCloseRequest }>,
    saved: [] as unknown[],
    logs: [] as string[],
    popupMenus: 0,
    trayMenu: [] as Array<{
      label: string
      toolTip?: string
      accessibilityLabel?: string
      click?: () => void
    }>,
  }
  class FakeTray {
    destroyed = false
    destroy(): void {
      assert.equal(this.destroyed, false)
      this.destroyed = true
      state.disposedTrays += 1
    }
    removeAllListeners(): void {
      state.trayHandlers.clear()
    }
    constructor() {
      state.trays += 1
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    setToolTip(): void {}
    setImage(): void {
      state.updatedImages += 1
    }
    setContextMenu(menu: typeof state.trayMenu): void {
      state.trayMenu = menu
    }
    popUpContextMenu(): void {
      state.popupMenus += 1
    }
    on(event: string, handler: () => void): void {
      state.trayHandlers.set(event, handler)
    }
  }
  const dependencies: Record<string, unknown> = {
    electron: {
      nativeTheme: {
        get shouldUseDarkColors() {
          return !state.systemDark
        },
        get shouldUseDarkColorsForSystemIntegratedUI() {
          return options.nativeSystemDark ?? state.systemDark
        },
        on(_event: string, handler: () => void) {
          state.themeHandlers.add(handler)
        },
        removeListener(_event: string, handler: () => void) {
          state.themeHandlers.delete(handler)
        },
      },
      app: {
        getPath: () => '/tmp/scholarseed',
        getAppPath: () => '/repo/apps/desktop',
        isPackaged: options.packaged ?? false,
        quit: () => {
          state.quit += 1
        },
      },
      Menu: {
        buildFromTemplate: (template: typeof state.trayMenu) => {
          state.trayMenu = template
          return Object.assign(template, {
            on: (event: string, handler: () => void) => state.menuHandlers.set(event, handler),
            removeAllListeners: () => state.menuHandlers.clear(),
          })
        },
      },
      Tray: FakeTray,
      nativeImage: {
        createFromPath: (path: string) => {
          state.iconPaths.push(path)
          return {
            isEmpty: () => false,
            resize() {
              return this
            },
            setTemplateImage(template: boolean) {
              state.templateImages.push(template)
            },
          }
        },
      },
    },
    './storage': { desktopStorage: () => ({ userData: '/tmp/scholarseed' }) },
    './resources.ts': { applicationResources: () => '/resources' },
    './journal.ts': journal,
    './window-record.ts': windowRecord,
    './writer': { desktopDirectoryWriter: () => ({ close() {} }) },
    fs: { existsSync: () => false },
    'node:child_process': {
      execFileSync: (executable: string, args: string[], settings: Record<string, unknown>) => {
        state.registryQueries += 1
        assert.equal(executable, join('C:/Windows', 'System32', 'reg.exe'))
        assert.deepEqual(Array.from(args), [
          'query',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
          '/v',
          'SystemUsesLightTheme',
        ])
        assert.equal(settings.windowsHide, true)
        assert.equal(settings.encoding, 'utf8')
        assert.ok(typeof settings.timeout === 'number' && settings.timeout > 0)
        if (options.registryFails) throw new Error('registry unavailable')
        return (
          options.registryOutput ??
          `\r\n    SystemUsesLightTheme    REG_DWORD    ${state.systemDark ? '0x0' : '0x1'}\r\n`
        )
      },
    },
    path: { dirname, join },
    '../window': windowContract,
    '../tray.ts': trayContract,
  }
  const exports: Record<string, unknown> = {}
  runInNewContext(
    ts.transpileModule(traySource, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports,
      require: (name: string) => {
        assert.ok(Object.hasOwn(dependencies, name), `unexpected import: ${name}`)
        return dependencies[name]
      },
      process: {
        platform: 'win32',
        resourcesPath: '/resources',
        env: { SystemRoot: 'C:/Windows' },
      },
      setTimeout,
      clearTimeout,
    }
  )
  const create = exports.createWindowController as (options: unknown) => WindowController
  const controller = create({
    localizer: () => ({ getFixedT: () => options.translate ?? ((key: string) => key) }),
    revealWindow: (reason: string) => {
      state.revealed.push(reason)
      if (options.revealSucceeds === false) return false
      state.visible = true
      return true
    },
    markQuitting: () => {
      state.marked += 1
    },
    log: (line: string) => state.logs.push(line),
    requestSnapshot: (requestId: number) => {
      state.snapshotRequests.push(requestId)
      return true
    },
    navigate: (target: trayContract.TrayNavigation) => {
      state.navigation.push(target)
    },
    platform: options.platform ?? 'win32',
    stateStore: {
      load: () => ({ askOnClose: options.askOnClose ?? true }),
      save: (value: unknown) => {
        if (options.saveFails) throw new Error('read-only state directory')
        state.saved.push(value)
      },
    },
  })
  const window = {
    id: 1,
    once: (event: string, handler: () => void) => state.windowHandlers.set(event, handler),
    hide: () => {
      state.hidden += 1
      state.visible = false
    },
    isDestroyed: () => state.destroyed,
    isVisible: () => {
      if (state.destroyed) throw new TypeError('Object has been destroyed')
      return state.visible
    },
    webContents: {
      send: (channel: string, request: windowContract.WindowCloseRequest) =>
        state.events.push({ channel, request }),
    },
  } as unknown as BrowserWindow
  const close = (): void =>
    controller.handleClose(window, {
      preventDefault: () => {
        state.prevented += 1
      },
    } as Electron.Event)
  const respond = (action: windowContract.WindowCloseAction, remember = false): boolean =>
    controller.respond(window, {
      requestId: controller.currentRequest(window),
      action,
      remember,
    })
  return { controller, window, state, close, respond, exports }
}

test('tray artwork is independent from application icons in development and packages', () => {
  for (const packaged of [false, true]) {
    for (const platform of ['darwin', 'win32'] as const) {
      const { exports, state } = fixture({ packaged, platform })
      const createIcon = exports.createTrayIcon as (platform: NodeJS.Platform) => unknown
      createIcon(platform)
      const root = packaged ? '/resources' : '/repo/apps/desktop/resources'
      const filename = platform === 'darwin' ? 'tray.png' : 'tray.ico'
      assert.equal(state.iconPaths.at(-1), join(root, filename))
      assert.deepEqual(state.templateImages, platform === 'darwin' ? [true] : [])
    }
  }
})

test('Windows tray follows the system taskbar theme independently of the app theme', () => {
  const { controller, window, state } = fixture({ systemDark: true, nativeSystemDark: false })
  controller.ensureTray(window)
  assert.equal(state.iconPaths.at(-1), join('/repo/apps/desktop/resources', 'tray-white.ico'))
  assert.equal(state.themeHandlers.size, 1)
  const update = [...state.themeHandlers][0]
  state.systemDark = false
  update()
  assert.equal(state.iconPaths.at(-1), join('/repo/apps/desktop/resources', 'tray.ico'))
  assert.equal(state.updatedImages, 1)
  state.systemDark = true
  update()
  assert.equal(state.iconPaths.at(-1), join('/repo/apps/desktop/resources', 'tray-white.ico'))
  assert.equal(state.updatedImages, 2)
  assert.equal(state.registryQueries, 3)
  state.destroyed = true
  state.windowHandlers.get('closed')?.()
  assert.equal(state.themeHandlers.size, 0)
  update()
  assert.equal(state.updatedImages, 2)
  assert.equal(state.registryQueries, 3)
})

test('Windows light taskbar does not inherit a dark application theme at startup', () => {
  const { controller, window, state } = fixture({ systemDark: false, nativeSystemDark: true })
  controller.ensureTray(window)
  assert.equal(state.iconPaths.at(-1), join('/repo/apps/desktop/resources', 'tray.ico'))
})

test('Windows theme query failures retain the native fallback and emit a diagnostic', () => {
  for (const options of [
    { registryFails: true },
    { registryOutput: 'SystemUsesLightTheme REG_DWORD 0x2' },
    { registryOutput: 'AppsUseLightTheme REG_DWORD 0x0' },
    { registryOutput: 'SystemUsesLightTheme REG_SZ 0x0' },
  ]) {
    const { controller, window, state } = fixture({ ...options, nativeSystemDark: true })
    controller.ensureTray(window)
    assert.equal(state.iconPaths.at(-1), join('/repo/apps/desktop/resources', 'tray-white.ico'))
    assert.ok(state.logs.some((line) => line.includes('Windows system theme query failed')))
  }
})

test('packaged Windows tray selects artwork for both system taskbar themes', () => {
  for (const systemDark of [false, true]) {
    const { exports, state } = fixture({ packaged: true, systemDark })
    const createIcon = exports.createTrayIcon as (platform: NodeJS.Platform) => unknown
    createIcon('win32')
    assert.equal(
      state.iconPaths.at(-1),
      join('/resources', systemDark ? 'tray-white.ico' : 'tray.ico')
    )
  }
})

test('macOS template tray does not subscribe to Windows theme changes', () => {
  const { controller, window, state } = fixture({ platform: 'darwin' })
  controller.ensureTray(window)
  assert.equal(state.themeHandlers.size, 0)
  assert.equal(state.registryQueries, 0)
})

test('损坏或缺失的关闭偏好仍需询问', () => {
  const { exports } = fixture()
  const sanitize = exports.sanitizeWindowCloseState as (value: unknown) => { askOnClose: boolean }
  for (const value of [undefined, null, [], {}, { askOnClose: 'false' }])
    assert.equal(sanitize(value).askOnClose, true)
  assert.equal(sanitize({ askOnClose: false }).askOnClose, false)
})

test('Windows 关闭请求交给主渲染器，重复关闭不创建重复请求', () => {
  const { close, state, controller, window } = fixture()
  close()
  close()
  assert.equal(state.prevented, 2)
  assert.equal(state.trays, 1)
  assert.deepEqual(state.events, [
    { channel: windowContract.WINDOW_CLOSE_REQUEST_CHANNEL, request: 1 },
  ])
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
  for (const value of [
    null,
    {},
    { ...reply, requestId: 0 },
    { ...reply, action: 'delete' },
    { ...reply, remember: 'true' },
  ]) {
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
    assert.equal(state.trays, platform === 'darwin' ? 1 : 0)
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

test('单击先刷新菜单，不唤起隐藏窗口；项目动作才导航', () => {
  const { close, respond, state, controller, window } = fixture()
  close()
  respond('minimize')
  assert.equal(state.visible, false)
  assert.ok(state.trayHandlers.has('click'))
  state.trayHandlers.get('click')!()
  assert.deepEqual(state.revealed, [])
  assert.equal(state.visible, false)
  assert.deepEqual(state.snapshotRequests, [1])
  assert.equal(
    controller.respondTray(window, {
      requestId: 1,
      snapshot: {
        project: { id: 'project', name: '研究' },
        sessions: [{ id: 'session', title: '检索' }],
      },
    }),
    true
  )
  assert.equal(state.popupMenus, 1)
  assert.deepEqual(Array.from(state.trayMenu, (item) => item.label).filter(Boolean), [
    'tray.openProject',
    'tray.newSession',
    'tray.recentSessions',
    '检索',
    'tray.literature',
    'tray.quit',
  ])
  state.trayMenu.find((item) => item.label === 'tray.newSession')!.click!()
  assert.deepEqual(state.revealed, ['tray navigation'])
  assert.equal(state.navigation[0].kind, 'create')
})

test('右键展开空项目菜单，只有选择显示窗口才恢复', () => {
  const { close, respond, state, controller, window } = fixture()
  close()
  respond('minimize')
  state.trayHandlers.get('right-click')!()
  controller.respondTray(window, { requestId: 1, snapshot: { project: null, sessions: [] } })
  assert.equal(state.visible, false)
  assert.equal(state.trayHandlers.has('double-click'), false)
  state.trayMenu.find((item) => item.label === 'tray.show')!.click!()
  assert.deepEqual(state.revealed, ['tray menu'])
  assert.equal(state.quit, 0)
})

test('鼠标进入和原生菜单生命周期均可观测', () => {
  const { close, state, controller, window } = fixture()
  close()
  state.trayHandlers.get('mouse-enter')!()
  state.trayHandlers.get('right-click')!()
  controller.respondTray(window, { requestId: 1, snapshot: { project: null, sessions: [] } })
  state.menuHandlers.get('menu-will-show')!()
  state.menuHandlers.get('menu-will-close')!()
  assert.ok(state.logs.includes('[tray] mouse entered\n'))
  assert.ok(state.logs.some((line) => line.includes('[tray] right click window=1')))
  assert.equal(state.popupMenus, 1)
  assert.ok(state.logs.includes('[tray] context menu opening\n'))
  assert.ok(state.logs.includes('[tray] context menu closing\n'))
})

test('恢复入口找不到窗口时记录失败，而非误报已恢复', () => {
  const { close, respond, state, controller, window } = fixture({ revealSucceeds: false })
  close()
  respond('minimize')
  state.trayHandlers.get('click')!()
  controller.respondTray(window, { requestId: 1, snapshot: null })
  state.trayMenu.find((item) => item.label === 'tray.show')!.click!()
  assert.equal(state.visible, false)
  assert.ok(state.logs.includes('[tray] reveal completed restored=false\n'))
  assert.equal(state.quit, 0)
})

test('窗口已销毁时迟到的托盘事件不访问原生窗口或执行菜单动作', () => {
  const { close, state } = fixture()
  close()
  const callbacks = [
    ...state.trayHandlers.values(),
    ...state.trayMenu.flatMap((item) => (item.click ? [item.click] : [])),
  ]
  state.destroyed = true
  for (const callback of callbacks) assert.doesNotThrow(callback)
  assert.deepEqual(state.revealed, [])
  assert.equal(state.popupMenus, 0)
  assert.equal(state.quit, 0)
})

test('closed 释放托盘与监听、清除请求，旧回调不能操作重建的托盘', () => {
  const { close, state, controller, window } = fixture()
  close()
  const callbacks = [
    ...state.trayHandlers.values(),
    ...state.trayMenu.flatMap((item) => (item.click ? [item.click] : [])),
  ]
  const closed = state.windowHandlers.get('closed')
  assert.ok(closed)
  state.destroyed = true
  closed()
  closed()
  assert.equal(state.disposedTrays, 1)
  assert.equal(state.trayHandlers.size, 0)
  assert.equal(state.menuHandlers.size, 0)
  assert.equal(controller.currentRequest(window), null)
  controller.ensureTray(window)
  assert.equal(state.trays, 1)
  state.destroyed = false
  const replacement = { ...window, id: 2 } as BrowserWindow
  controller.ensureTray(replacement)
  assert.equal(state.trays, 2)
  for (const callback of callbacks) assert.doesNotThrow(callback)
  closed()
  assert.equal(state.disposedTrays, 1)
  assert.equal(state.popupMenus, 0)
  assert.equal(state.quit, 0)
  assert.deepEqual(state.revealed, [])
  assert.equal(controller.currentRequest(window), null)
  state.visible = false
  state.trayHandlers.get('click')!()
  assert.deepEqual(state.revealed, [])
  assert.equal(state.snapshotRequests.length, 1)
})

test('刷新拒绝旧请求及异窗回复，菜单不保留已删除的对话', () => {
  const { controller, window, state } = fixture({ platform: 'darwin' })
  controller.ensureTray(window)
  state.trayHandlers.get('click')!()
  const snapshot = {
    project: { id: 'project', name: '研究' },
    sessions: [{ id: 'task', title: '旧标题' }],
  }
  assert.equal(controller.respondTray({} as BrowserWindow, { requestId: 1, snapshot }), false)
  assert.equal(controller.respondTray(window, { requestId: 2, snapshot }), false)
  assert.equal(controller.respondTray(window, { requestId: 1, snapshot }), true)
  const oldAction = state.trayMenu.find((item) => item.label === '旧标题')!.click!
  state.trayHandlers.get('click')!()
  assert.equal(controller.respondTray(window, { requestId: 1, snapshot }), false)
  assert.equal(
    controller.respondTray(window, { requestId: 2, snapshot: { ...snapshot, sessions: [] } }),
    true
  )
  assert.equal(
    state.trayMenu.some((item) => item.label === '旧标题' || item.label === 'tray.recentSessions'),
    false
  )
  oldAction()
  assert.equal(state.navigation.length, 0)
  assert.equal(state.popupMenus, 2)
})

test('菜单短标题和恰好达到展示预算的标题保持原样', () => {
  const { controller, window, state } = fixture({
    translate: (key, values) => (values ? `打开“${values.name}”` : key),
  })
  const titles = ['a'.repeat(48), '文'.repeat(24), 'a'.repeat(49)]
  controller.ensureTray(window)
  state.trayHandlers.get('click')!()
  controller.respondTray(window, {
    requestId: 1,
    snapshot: {
      project: { id: 'project', name: '研究' },
      sessions: titles.map((title, index) => ({ id: `task-${index}`, title })),
    },
  })
  assert.equal(state.trayMenu[0].label, '打开“研究”')
  assert.equal(state.trayMenu[3].label, titles[0])
  assert.equal(state.trayMenu[4].label, titles[1])
  assert.equal(state.trayMenu[5].label, 'a'.repeat(30) + '…' + 'a'.repeat(16))
})

for (const platform of ['darwin', 'win32'] as const) {
  for (const locale of ['zh', 'en']) {
    test(`${platform}/${locale} 长标题菜单有界且保留完整名称和导航身份`, () => {
      const messages = JSON.parse(
        readFileSync(
          new URL(`../localization/locales/${locale}/native.json`, import.meta.url),
          'utf8'
        )
      ).tray
      const translate = (key: string, values?: { name: string }): string =>
        messages[key.replace('tray.', '')].replace('{{name}}', values?.name ?? '')
      const { controller, window, state } = fixture({ platform, translate })
      const projectName = '超长项目标题'.repeat(30) + '第二阶段'
      const titles = [
        'Long research title '.repeat(20) + 'Final report',
        '👨‍👩‍👧‍👦e\u0301'.repeat(30) + '末尾',
        '短\r\n标题\t测试',
      ]
      const snapshot = {
        project: { id: 'project', name: projectName },
        sessions: titles.map((title, index) => ({ id: `task-${index}`, title })),
      }
      controller.ensureTray(window)
      state.trayHandlers.get('click')!()
      assert.equal(controller.respondTray(window, { requestId: 1, snapshot }), true)
      const projectItem = state.trayMenu[0]
      assert.ok(projectItem.label.includes('…'))
      assert.ok(projectItem.label.endsWith('第二阶段”'))
      const fullLabels = [
        translate('tray.openProject', { name: projectName }),
        ...titles.map((title) => title.replace(/\s+/gu, ' ').trim()),
      ]
      const items = [projectItem, ...state.trayMenu.slice(3, 6)]
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      items.forEach((item, index) => {
        const segments = Array.from(segmenter.segment(item.label), (entry) => entry.segment)
        const width = segments.reduce(
          (sum, segment) => sum + (/^[\x20-\x7e]$/u.test(segment) ? 1 : 2),
          0
        )
        assert.ok(width <= 48, item.label)
        assert.equal(item.accessibilityLabel, fullLabels[index])
        assert.equal(item.toolTip, platform === 'darwin' ? fullLabels[index] : undefined)
        item.click!()
      })
      const emojiSegments = Array.from(segmenter.segment(items[2].label), (entry) => entry.segment)
      assert.ok(
        emojiSegments.every((segment) => ['👨‍👩‍👧‍👦', 'e\u0301', '…', '末', '尾'].includes(segment))
      )
      assert.equal(items[3].label, '短 标题 测试')
      assert.deepEqual(JSON.parse(JSON.stringify(state.navigation)), [
        { kind: trayContract.TRAY_ACTION.project, projectId: 'project' },
        ...titles.map((_, index) => ({
          kind: trayContract.TRAY_ACTION.session,
          projectId: 'project',
          sessionId: `task-${index}`,
        })),
      ])
      assert.equal(snapshot.project.name, projectName)
      assert.deepEqual(
        snapshot.sessions.map((session) => session.title),
        titles
      )
    })
  }
}

test('刷新超时显示不可用而非旧项目，并保留退出入口', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const { controller, window, state } = fixture()
  controller.ensureTray(window)
  state.trayHandlers.get('click')!()
  state.trayHandlers.get('click')!()
  assert.equal(state.snapshotRequests.length, 1)
  context.mock.timers.tick(trayContract.TRAY_REFRESH_TIMEOUT_MS)
  assert.equal(state.popupMenus, 1)
  assert.equal(
    state.trayMenu.some((item) => item.label === 'tray.unavailable'),
    true
  )
  assert.equal(
    controller.respondTray(window, { requestId: 1, snapshot: { project: null, sessions: [] } }),
    false
  )
  state.trayMenu.find((item) => item.label === 'tray.quit')!.click!()
  assert.equal(state.quit, 1)
})
