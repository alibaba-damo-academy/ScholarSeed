import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  BrowserWindow,
  Event as ElectronEvent,
  IpcMain,
  IpcMainInvokeEvent,
  Session,
  WebContents,
  WebContentsDidStartNavigationEventParams,
  WebContentsView,
  WebPreferences,
} from 'electron'
import {
  VAULT_CHANNEL,
  VAULT_ERROR,
  VAULT_LIMIT,
  VAULT_STATE,
  exactVaultObject,
  parseVaultCancel,
  parseVaultOpen,
  parseVaultReset,
  parseVaultSubmit,
  type VaultError,
  type VaultReply,
  type VaultRequest,
  type VaultSeed,
  type VaultStatus,
} from '../vault.ts'
import type { VaultOwner } from './vault.ts'
import { type VaultPrompt } from './vault.ts'

export const PROTECTED_ASSETS = {
  manifest: 'manifest.json',
  entry: 'renderer/vault.html',
  preload: 'preload/vault.js',
  files: 4096,
  manifestBytes: 4 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  version: 1,
  partition: 'scholarseed-vault-',
  binding: 'scholarseed-protected-v1',
} as const
const SHA256 = /^[a-f0-9]{64}$/
const SAFE_PATH = /^(?:renderer|preload)\/[A-Za-z0-9_./-]+$/
const DENY = { action: 'deny' } as const
const REVOKED: VaultReply = { ok: false, error: VAULT_ERROR.revoked }
export const SECRET_CLEANUP_LIMIT = { reportMilliseconds: 5000, protectedPresentations: 1 } as const
const CLEANUP_STEP = {
  listener: 'listener_cleanup_failed',
  hide: 'hide_failed',
  remove: 'remove_failed',
  close: 'close_failed',
  request: 'request_deny_failed',
  permissionCheck: 'permission_check_deny_failed',
  permissionRequest: 'permission_request_deny_failed',
  connections: 'connections_cleanup_failed',
  storage: 'storage_cleanup_failed',
  destroyed: 'destruction_unknown',
  deadline: 'cleanup_deadline',
  consumer: 'report_consumer_failed',
  handler: 'handler_cleanup_failed',
} as const
type CleanupCode = (typeof CLEANUP_STEP)[keyof typeof CLEANUP_STEP]
export interface ProtectedCleanupReport {
  owner: 'protected'
  revokeId: string
  revision: number
  status: 'pending' | 'closed' | 'cleanup_failed' | 'containment_failed'
  resources: number
  codes: readonly CleanupCode[]
}
export interface ProtectedManifest {
  version: number
  generation: string
  tools: Record<string, string>
  sources: { path: string; sha256: string }[]
  modules: string[]
  files: { path: string; bytes: number; sha256: string }[]
}
export function protectedDigest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}
function verifyAssetContents(
  directory: string,
  generation: string,
  manifestDigest: string
): { entry: string; preload: string; resources: Set<string> } {
  const reject = (): never => {
    throw new Error(VAULT_ERROR.assets)
  }
  if (!SHA256.test(generation) || !SHA256.test(manifestDigest)) reject()
  const root = realpathSync(directory)
  const manifestBytes = readFileSync(join(root, PROTECTED_ASSETS.manifest))
  if (
    manifestBytes.length > PROTECTED_ASSETS.manifestBytes ||
    protectedDigest(manifestBytes) !== manifestDigest
  )
    reject()
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as ProtectedManifest
  if (
    !exactVaultObject(manifest, [
      'version',
      'generation',
      'tools',
      'sources',
      'modules',
      'files',
    ]) ||
    manifest.version !== PROTECTED_ASSETS.version ||
    manifest.generation !== generation ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > PROTECTED_ASSETS.files ||
    !Array.isArray(manifest.sources) ||
    !Array.isArray(manifest.modules)
  )
    reject()
  const names = new Set<string>()
  const resources = new Set<string>()
  let total = 0
  for (const file of manifest.files) {
    if (
      !exactVaultObject(file, ['path', 'bytes', 'sha256']) ||
      typeof file.path !== 'string' ||
      !SAFE_PATH.test(file.path) ||
      file.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      names.has(file.path) ||
      typeof file.sha256 !== 'string' ||
      !SHA256.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0
    )
      reject()
    const filename = join(root, ...file.path.split('/'))
    const actual = realpathSync(filename)
    const contained = relative(root, actual)
    if (
      isAbsolute(contained) ||
      contained === '..' ||
      contained.startsWith(`..${sep}`) ||
      !statSync(actual).isFile()
    )
      reject()
    const bytes = readFileSync(actual)
    total += bytes.length
    if (
      total > PROTECTED_ASSETS.totalBytes ||
      bytes.length !== file.bytes ||
      protectedDigest(bytes) !== file.sha256
    )
      reject()
    names.add(file.path)
    if (file.path.startsWith('renderer/')) resources.add(pathToFileURL(actual).href)
  }
  const actualNames: string[] = []
  const inventory = (parent: string, prefix = ''): void => {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const name = prefix + entry.name
      if (entry.isSymbolicLink()) reject()
      else if (entry.isDirectory()) inventory(join(parent, entry.name), `${name}/`)
      else if (entry.isFile()) actualNames.push(name)
      else reject()
    }
  }
  inventory(root)
  if (
    !names.has(PROTECTED_ASSETS.entry) ||
    !names.has(PROTECTED_ASSETS.preload) ||
    actualNames.length !== names.size + 1 ||
    actualNames.some((name) => name !== PROTECTED_ASSETS.manifest && !names.has(name))
  )
    reject()
  return {
    entry: pathToFileURL(join(root, ...PROTECTED_ASSETS.entry.split('/'))).href,
    preload: join(root, ...PROTECTED_ASSETS.preload.split('/')),
    resources,
  }
}
export function verifyProtectedAssets(
  directory: string,
  generation: string,
  manifestDigest: string
): { entry: string; preload: string; resources: Set<string> } {
  try {
    return verifyAssetContents(directory, generation, manifestDigest)
  } catch {
    throw new Error(VAULT_ERROR.assets)
  }
}
interface VaultIpcOptions {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>
  vault: VaultOwner
  status(): VaultStatus
  current(): boolean
  debug(): VaultError | null
  directory: string
  generation: string
  manifestDigest: string
  watch: boolean
  rendererUrl: string
  preferences(): Pick<VaultSeed, 'language' | 'theme'>
  beforeOpen(): void
  createSession(): Session
  createView(preferences: WebPreferences): WebContentsView
}
interface Presentation {
  sessionId: string
  prompt: VaultPrompt | null
  view: WebContentsView | null
  session: Session | null
  entry: string
  requests: Set<string>
  pending: boolean
  removers: (() => void)[]
  timer: ReturnType<typeof setTimeout>
  revoked: boolean
  cleaning: boolean
  failures: Set<CleanupCode>
  completed: Set<CleanupCode>
  tasks: Map<CleanupCode, Promise<void>>
  observer: (() => void) | null
}
export function createVaultIpc(window: BrowserWindow, options: VaultIpcOptions) {
  let current: Presentation | null = null
  let disposed = false
  const owned = new Set<Presentation>()
  const failures = new Set<CleanupCode>()
  const subscribers = new Set<(report: ProtectedCleanupReport) => void | Promise<void>>()
  const consumerTasks = new Set<Promise<void>>()
  const waiters = new Set<() => void>()
  let revokeId = randomUUID()
  let revision = 0
  const removers: (() => void)[] = []
  const product = window.webContents
  const rendererUrl = new URL(options.rendererUrl).href
  const listen = <Arguments extends unknown[]>(
    emitter: NodeJS.EventEmitter,
    name: string,
    listener: (...args: Arguments) => void,
    scope = removers
  ): void => {
    emitter.on(name, listener)
    scope.push(() => emitter.removeListener(name, listener))
  }
  const eligible = () =>
    !disposed &&
    options.current() &&
    !window.isDestroyed() &&
    window.isFocused() &&
    window.isVisible() &&
    !window.isMinimized() &&
    !product.isDestroyed() &&
    !product.isCrashed()
  const assets = () => {
    if (options.watch) throw new Error(VAULT_ERROR.watch)
    return verifyProtectedAssets(options.directory, options.generation, options.manifestDigest)
  }
  const destroyed = (presentation: Presentation): boolean => {
    try {
      const confirmed = !presentation.view || presentation.view.webContents.isDestroyed()
      presentation.failures.delete(CLEANUP_STEP.destroyed)
      return confirmed
    } catch {
      presentation.failures.add(CLEANUP_STEP.destroyed)
      return false
    }
  }
  const secretCustodyReady = (): boolean =>
    failures.size === 0 && ![...owned].some((presentation) => presentation.revoked)
  const snapshot = (deadline = false): ProtectedCleanupReport => {
    const residual = [...owned].filter((presentation) => presentation.revoked)
    const codes = new Set(failures)
    const alive = residual.some((presentation) => !destroyed(presentation))
    for (const presentation of residual) for (const code of presentation.failures) codes.add(code)
    if (deadline && residual.length) codes.add(CLEANUP_STEP.deadline)
    return {
      owner: 'protected',
      revokeId,
      revision,
      status:
        !residual.length && !codes.size
          ? 'closed'
          : alive
            ? deadline || codes.size
              ? 'containment_failed'
              : 'pending'
            : codes.size
              ? 'cleanup_failed'
              : 'pending',
      resources: residual.length,
      codes: [...codes],
    }
  }
  const publish = (): void => {
    revision++
    const report = snapshot()
    for (const subscriber of subscribers) {
      try {
        const pending = subscriber(report)
        if (pending) {
          const task = Promise.resolve(pending)
            .catch(() => {
              failures.add(CLEANUP_STEP.consumer)
            })
            .finally(() => {
              consumerTasks.delete(task)
              for (const wake of waiters) wake()
            })
          consumerTasks.add(task)
        }
      } catch {
        failures.add(CLEANUP_STEP.consumer)
      }
    }
    for (const wake of waiters) wake()
  }
  const settle = (presentation: Presentation): void => {
    if (!presentation.revoked || presentation.cleaning) return
    if (
      destroyed(presentation) &&
      !presentation.removers.length &&
      !presentation.tasks.size &&
      !presentation.failures.size
    ) {
      if (presentation.observer) {
        try {
          presentation.observer()
          presentation.observer = null
        } catch {
          presentation.failures.add(CLEANUP_STEP.listener)
        }
      }
      if (!presentation.failures.size) owned.delete(presentation)
    }
    publish()
  }
  const cleanup = (presentation: Presentation): void => {
    presentation.cleaning = true
    const step = (code: CleanupCode, action: () => void | Promise<void>): void => {
      if (presentation.completed.has(code) || presentation.tasks.has(code)) return
      try {
        const pending = action()
        if (pending) {
          const task = Promise.resolve(pending)
            .then(
              () => {
                presentation.completed.add(code)
                presentation.failures.delete(code)
              },
              () => {
                presentation.failures.add(code)
              }
            )
            .then(() => {
              presentation.tasks.delete(code)
              settle(presentation)
            })
          presentation.tasks.set(code, task)
        } else {
          presentation.completed.add(code)
          presentation.failures.delete(code)
        }
      } catch {
        presentation.failures.add(code)
      }
    }
    for (const remove of [...presentation.removers]) {
      try {
        remove()
        presentation.removers.splice(presentation.removers.indexOf(remove), 1)
      } catch {
        presentation.failures.add(CLEANUP_STEP.listener)
      }
    }
    if (!presentation.removers.length) presentation.failures.delete(CLEANUP_STEP.listener)
    if (presentation.view) {
      step(CLEANUP_STEP.hide, () => presentation.view!.setVisible(false))
      step(CLEANUP_STEP.remove, () => {
        if (!window.isDestroyed()) window.contentView.removeChildView(presentation.view!)
      })
      step(CLEANUP_STEP.close, () => {
        if (!destroyed(presentation))
          presentation.view!.webContents.close({ waitForBeforeUnload: false })
      })
    }
    if (presentation.session) {
      step(CLEANUP_STEP.request, () =>
        presentation.session!.webRequest.onBeforeRequest((_details, callback) =>
          callback({ cancel: true })
        )
      )
      step(CLEANUP_STEP.permissionCheck, () =>
        presentation.session!.setPermissionCheckHandler(() => false)
      )
      step(CLEANUP_STEP.permissionRequest, () =>
        presentation.session!.setPermissionRequestHandler((_contents, _permission, callback) =>
          callback(false)
        )
      )
      step(CLEANUP_STEP.connections, () => presentation.session!.closeAllConnections())
      step(CLEANUP_STEP.storage, () => presentation.session!.clearStorageData())
    }
    presentation.cleaning = false
    settle(presentation)
  }
  const destroy = (): void => {
    const previous = current
    current = null
    if (previous) {
      revokeId = randomUUID()
      clearTimeout(previous.timer)
      previous.prompt = null
      previous.requests.clear()
      previous.pending = false
      previous.revoked = true
    }
    for (const presentation of owned) if (presentation.revoked) cleanup(presentation)
  }
  const lock = (error?: VaultError): void => {
    options.vault.lock(error)
    if (disposed) destroy()
  }
  const cleanupReport = (): Promise<ProtectedCleanupReport> =>
    new Promise((resolve) => {
      const finish = (deadline = false): void => {
        clearTimeout(timer)
        waiters.delete(check)
        resolve(snapshot(deadline))
      }
      const check = (): void => {
        if (
          secretCustodyReady() ||
          [...owned]
            .filter((presentation) => presentation.revoked)
            .every((presentation) => presentation.failures.size && !presentation.tasks.size)
        )
          finish()
      }
      const timer = setTimeout(() => finish(true), SECRET_CLEANUP_LIMIT.reportMilliseconds)
      waiters.add(check)
      check()
    })
  const validPresentation = (presentation: Presentation, requireFocus: boolean): boolean => {
    if (current !== presentation || !eligible() || options.debug()) return false
    const contents = presentation.view?.webContents
    if (
      requireFocus &&
      (!contents ||
        contents.isDestroyed() ||
        contents.isCrashed() ||
        contents.getURL() !== presentation.entry ||
        !contents.isFocused())
    )
      return false
    try {
      assets()
      return true
    } catch {
      lock(VAULT_ERROR.assets)
      return false
    }
  }
  const publicSender = (event: IpcMainInvokeEvent): boolean =>
    eligible() &&
    event.sender === product &&
    event.senderFrame === product.mainFrame &&
    product.getURL() === rendererUrl
  const protectedSender = (event: IpcMainInvokeEvent): Presentation | null => {
    const presentation = current
    const contents = presentation?.view?.webContents
    if (
      !presentation ||
      !contents ||
      event.sender !== contents ||
      event.senderFrame !== contents.mainFrame ||
      !validPresentation(presentation, true)
    ) {
      if (presentation && options.debug()) lock(options.debug()!)
      return null
    }
    return presentation
  }
  const request = (
    presentation: Presentation,
    value: VaultRequest,
    cancelling = false
  ): boolean => {
    if (
      !presentation.prompt ||
      value.sessionId !== presentation.sessionId ||
      value.generation !== presentation.prompt.generation ||
      (presentation.pending && !cancelling) ||
      presentation.requests.has(value.requestId) ||
      presentation.requests.size >= VAULT_LIMIT.requests
    )
      return false
    presentation.requests.add(value.requestId)
    return true
  }
  const fixedError = (error: unknown): VaultError =>
    error instanceof Error && Object.values(VAULT_ERROR).includes(error.message as VaultError)
      ? (error.message as VaultError)
      : VAULT_ERROR.unavailable
  const open = async (intent: 'create' | 'unlock' | 'reset'): Promise<VaultReply> => {
    if (!eligible()) return REVOKED
    const debug = options.debug()
    if (debug) {
      lock(debug)
      return { ok: false, error: debug }
    }
    if (
      [...owned].filter((presentation) => !presentation.revoked).length >=
      SECRET_CLEANUP_LIMIT.protectedPresentations
    )
      return { ok: false, error: VAULT_ERROR.busy }
    if (!secretCustodyReady()) return { ok: false, error: VAULT_ERROR.unavailable }
    try {
      assets()
    } catch (error) {
      lock(fixedError(error))
      return { ok: false, error: fixedError(error) }
    }
    if (
      intent === 'reset' ||
      options.vault.status().state === VAULT_STATE.unlocked ||
      options.vault.status().state === VAULT_STATE.unlocking
    )
      lock()
    options.beforeOpen()
    const presentation: Presentation = {
      sessionId: randomUUID(),
      prompt: null,
      view: null,
      session: null,
      entry: '',
      requests: new Set(),
      pending: false,
      removers: [],
      revoked: false,
      cleaning: false,
      failures: new Set(),
      completed: new Set(),
      tasks: new Map(),
      observer: null,
      timer: setTimeout(() => {
        if (current === presentation) lock(VAULT_ERROR.revoked)
      }, VAULT_LIMIT.promptMilliseconds),
    }
    current = presentation
    owned.add(presentation)
    try {
      presentation.prompt = await options.vault.begin(intent, () =>
        validPresentation(presentation, false)
      )
      if (!validPresentation(presentation, false)) throw new Error(VAULT_ERROR.revoked)
      const resources = assets()
      const isolated = options.createSession()
      presentation.session = isolated
      owned.add(presentation)
      if (!validPresentation(presentation, false)) throw new Error(VAULT_ERROR.revoked)
      isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      isolated.setPermissionCheckHandler(() => false)
      isolated.webRequest.onBeforeRequest((details, callback) =>
        callback({
          cancel:
            presentation.revoked ||
            disposed ||
            details.resourceType === 'subFrame' ||
            !resources.resources.has(details.url),
        })
      )
      const view = options.createView({
        session: isolated,
        preload: resources.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        devTools: false,
      })
      presentation.view = view
      presentation.entry = resources.entry
      owned.add(presentation)
      if (!validPresentation(presentation, false)) throw new Error(VAULT_ERROR.revoked)
      const contents = view.webContents
      const observe = () => {
        presentation.failures.delete(CLEANUP_STEP.destroyed)
        settle(presentation)
      }
      contents.on('destroyed', observe)
      presentation.observer = () => contents.removeListener('destroyed', observe)
      contents.setWindowOpenHandler(() => DENY)
      const revoke = () => {
        if (current === presentation) lock(VAULT_ERROR.revoked)
      }
      for (const name of ['blur', 'render-process-gone', 'destroyed', 'devtools-opened'])
        listen(contents, name, revoke, presentation.removers)
      for (const name of [
        'will-navigate',
        'will-frame-navigate',
        'will-redirect',
        'will-attach-webview',
      ]) {
        listen(
          contents,
          name,
          (event: ElectronEvent) => {
            event.preventDefault()
            revoke()
          },
          presentation.removers
        )
      }
      listen(
        isolated,
        'will-download',
        (event: ElectronEvent) => {
          event.preventDefault()
          revoke()
        },
        presentation.removers
      )
      listen(
        contents,
        'did-start-navigation',
        (details: ElectronEvent<WebContentsDidStartNavigationEventParams>) => {
          if (details.url !== resources.entry || !details.isMainFrame) revoke()
        },
        presentation.removers
      )
      const resize = () => {
        const [width, height] = window.getContentSize()
        view.setBounds({ x: 0, y: 0, width, height })
      }
      listen(window, 'resize', resize, presentation.removers)
      resize()
      window.contentView.addChildView(view)
      view.setVisible(true)
      contents.focus()
      await contents.loadURL(resources.entry)
      if (!validPresentation(presentation, true)) throw new Error(VAULT_ERROR.revoked)
      return { ok: true, status: options.status() }
    } catch (error) {
      if (current === presentation) lock(fixedError(error))
      else if (presentation.revoked) cleanup(presentation)
      return { ok: false, error: fixedError(error) }
    }
  }
  options.ipc.handle(VAULT_CHANNEL.status, (event) =>
    publicSender(event)
      ? options.status()
      : { state: 'unavailable', generation: 0, error: VAULT_ERROR.revoked }
  )
  options.ipc.handle(VAULT_CHANNEL.metadata, (event) =>
    publicSender(event) ? options.vault.listMetadata() : null
  )
  options.ipc.handle(VAULT_CHANNEL.open, (event, value) => {
    const intent = parseVaultOpen(value)
    return publicSender(event) && intent ? open(intent) : REVOKED
  })
  options.ipc.handle(VAULT_CHANNEL.lock, (event) => {
    if (!publicSender(event)) return REVOKED
    lock()
    return { ok: true, status: options.status() }
  })
  options.ipc.handle(VAULT_CHANNEL.seed, (event) => {
    const presentation = protectedSender(event)
    if (!presentation?.prompt) return null
    return {
      sessionId: presentation.sessionId,
      generation: presentation.prompt.generation,
      intent: presentation.prompt.intent,
      ...options.preferences(),
      minimumCodepoints: VAULT_LIMIT.minimumCodepoints,
      passwordBytes: VAULT_LIMIT.passwordBytes,
    } satisfies VaultSeed
  })
  options.ipc.handle(VAULT_CHANNEL.submit, async (event, value) => {
    const presentation = protectedSender(event)
    const parsed = parseVaultSubmit(value)
    if (
      !presentation?.prompt ||
      !parsed ||
      !request(presentation, parsed) ||
      parsed.kind !== presentation.prompt.intent
    )
      return REVOKED
    presentation.pending = true
    const pending = options.vault.submit(
      presentation.prompt,
      parsed.password,
      parsed.kind === 'create' ? parsed.confirmation : undefined,
      () => validPresentation(presentation, true)
    )
    parsed.password = ''
    if (parsed.kind === 'create') parsed.confirmation = ''
    const reply = await pending
    if (current === presentation) {
      if (reply.ok && validPresentation(presentation, true)) {
        const generation = options.vault.status().generation
        destroy()
        if ((await cleanupReport()).status !== 'closed') {
          lock(VAULT_ERROR.unavailable)
          return { ok: false, error: VAULT_ERROR.unavailable }
        }
        if (!eligible() || options.debug() || generation !== options.vault.status().generation) {
          lock(options.debug() ?? VAULT_ERROR.revoked)
          return REVOKED
        }
        product.focus()
      } else presentation.pending = false
    }
    return reply
  })
  options.ipc.handle(VAULT_CHANNEL.reset, async (event, value) => {
    const presentation = protectedSender(event)
    const parsed = parseVaultReset(value)
    if (!presentation?.prompt || !parsed || !request(presentation, parsed)) return REVOKED
    presentation.pending = true
    const reply = await options.vault.reset(presentation.prompt, () =>
      validPresentation(presentation, true)
    )
    if (current === presentation) destroy()
    if (eligible()) product.focus()
    return reply
  })
  options.ipc.handle(VAULT_CHANNEL.cancel, (event, value) => {
    const presentation = protectedSender(event)
    const parsed = parseVaultCancel(value)
    if (!presentation || !parsed || !request(presentation, parsed, true)) return REVOKED
    lock()
    if (eligible()) product.focus()
    return { ok: true, status: options.status() }
  })
  removers.push(options.vault.onRevoke(destroy))
  for (const name of ['blur', 'hide', 'minimize', 'close', 'closed'])
    listen(window, name, () => lock())
  listen(window, 'focus', () => {
    if (eligible()) void options.vault.refresh()
  })
  for (const name of [
    'render-process-gone',
    'destroyed',
    'devtools-opened',
    'did-start-navigation',
  ])
    listen(product, name, () => lock())
  return {
    protectedContents: (): readonly WebContents[] =>
      [...owned].flatMap((presentation) =>
        presentation.view ? [presentation.view.webContents] : []
      ),
    secretCustodyReady,
    onCleanupReport(
      subscriber: (report: ProtectedCleanupReport) => void | Promise<void>
    ): () => void {
      subscribers.add(subscriber)
      return () => {
        subscribers.delete(subscriber)
      }
    },
    cleanupReport,
    lock,
    dispose(): void {
      if (disposed) {
        destroy()
        publish()
        return
      }
      disposed = true
      lock()
      for (const remove of [...removers]) {
        try {
          remove()
          removers.splice(removers.indexOf(remove), 1)
        } catch {
          failures.add(CLEANUP_STEP.listener)
        }
      }
      if (!removers.length) failures.delete(CLEANUP_STEP.listener)
      for (const channel of Object.values(VAULT_CHANNEL))
        if (channel !== VAULT_CHANNEL.changed) {
          try {
            options.ipc.removeHandler(channel)
          } catch {
            failures.add(CLEANUP_STEP.handler)
          }
        }
      publish()
    },
  }
}
