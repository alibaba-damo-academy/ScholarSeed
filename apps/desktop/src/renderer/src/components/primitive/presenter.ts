import { MENU_ERROR, MENU_LIMIT, menuActions, sameMenuTarget } from '../../../../menu.ts'
import type {
  MenuAck,
  MenuActionResult,
  MenuBridge,
  MenuDismissReason,
  MenuEvent,
  MenuModel,
  MenuSeed,
  MenuSeedRequest,
  MenuSurface,
} from '../../../../menu.ts'

export type MenuPresentationModel = Omit<
  MenuModel,
  'sessionId' | 'revision' | 'surface' | 'anchor' | 'target'
> & { request: MenuSeedRequest }
export interface MenuPresenter {
  open(
    surface: MenuSurface,
    anchor: MenuModel['anchor'],
    model: MenuPresentationModel
  ): Promise<void>
  update(model: MenuPresentationModel): Promise<void>
  dismiss(reason: MenuDismissReason): Promise<void>
  dispose(): void
  current(): MenuModel | null
  subscribe(callback: (model: MenuModel | null, reason?: MenuDismissReason) => void): () => void
  subscribeAction(
    callback: (event: Extract<MenuEvent, { kind: 'action' }>, model: MenuModel) => void
  ): () => void
  subscribeResult(callback: (result: MenuActionResult) => void): () => void
}

const sameAck = (left: MenuAck | null, right: MenuAck): boolean =>
  left?.sessionId === right.sessionId && left.revision === right.revision

function createCoordinator(bridge: MenuBridge): MenuPresenter {
  let generation = 0
  let disposed = false
  let model: MenuModel | null = null
  let painted: MenuModel | null = null
  let closing: MenuModel | null = null
  let closingTimer: ReturnType<typeof setTimeout> | undefined
  const requests = new Set<string>()
  const subscribers = new Set<(model: MenuModel | null, reason?: MenuDismissReason) => void>()
  const actions = new Set<
    (event: Extract<MenuEvent, { kind: 'action' }>, model: MenuModel) => void
  >()
  const results = new Set<(result: MenuActionResult) => void>()
  const clearClosing = (): void => {
    clearTimeout(closingTimer)
    closingTimer = undefined
    closing = null
  }
  const notify = (reason?: MenuDismissReason): void =>
    subscribers.forEach((callback) => callback(painted, reason))
  const invalidate = (reason: MenuDismissReason): void => {
    generation += 1
    model = null
    painted = null
    clearClosing()
    requests.clear()
    notify(reason)
  }
  const revoked = bridge.subscribeRevoked((event) => {
    if (!sameAck(model, event)) return
    const previous = painted
    invalidate(event.reason)
    if (event.reason === 'action' && previous && sameAck(previous, event)) {
      closing = previous
      closingTimer = setTimeout(clearClosing, MENU_LIMIT.resultLeaseTimeout)
      closingTimer.unref?.()
    }
  })
  const events = bridge.subscribe((event) => {
    if (disposed || event.kind !== 'action') return
    const approved = sameAck(closing, event) ? closing : sameAck(painted, event) ? painted : null
    if (!approved || requests.has(event.requestId)) return
    const item = menuActions(approved.items).find(
      (item) =>
        item.actionId === event.actionId &&
        !item.disabled &&
        JSON.stringify(item.value) === JSON.stringify(event.value)
    )
    if (!item) return
    clearClosing()
    requests.add(event.requestId)
    actions.forEach((callback) => callback(event, approved))
  })
  const completed = bridge.subscribeResult((result) => {
    if (disposed || requests.has(result.requestId)) return
    const approved = sameAck(closing, result) ? closing : sameAck(painted, result) ? painted : null
    if (
      !approved ||
      !menuActions(approved.items).some(
        (item) => item.actionId === result.actionId && !item.disabled
      )
    )
      return
    clearClosing()
    requests.add(result.requestId)
    results.forEach((callback) => callback(result))
  })
  const publish = async (next: MenuModel, requested: number): Promise<void> => {
    model = next
    let reply: Awaited<ReturnType<MenuBridge['publish']>>
    try {
      reply = await bridge.publish(next)
    } catch (error) {
      if (disposed || requested !== generation || !sameAck(model, next)) return
      invalidate('invalid')
      await bridge.dismiss('invalid')
      throw error
    }
    if (disposed || requested !== generation || !sameAck(model, next)) return
    if (!reply.ok || !sameAck(next, reply.ack)) {
      invalidate('invalid')
      await bridge.dismiss('invalid')
      throw new Error(reply.ok ? MENU_ERROR.invalid : reply.error)
    }
    painted = next
    notify()
  }
  return {
    current: () => painted,
    subscribe(callback) {
      subscribers.add(callback)
      return () => {
        subscribers.delete(callback)
      }
    },
    subscribeAction(callback) {
      actions.add(callback)
      return () => {
        actions.delete(callback)
      }
    },
    subscribeResult(callback) {
      results.add(callback)
      return () => {
        results.delete(callback)
      }
    },
    async open(surface, anchor, input) {
      if (disposed || input.request.surface !== surface) throw new Error(MENU_ERROR.invalid)
      invalidate('replaced')
      const requested = generation
      let seed: MenuSeed
      try {
        const reply = await bridge.seed(input.request)
        if (!reply.ok) throw new Error(reply.error)
        seed = reply.seed
      } catch (error) {
        if (disposed || requested !== generation) return
        invalidate('invalid')
        await bridge.dismiss('invalid')
        throw error
      }
      if (disposed || requested !== generation) return
      const { request: _request, ...presentation } = input
      await publish({ ...presentation, ...seed, surface, anchor }, requested)
    },
    async update(input) {
      if (!model || disposed) return
      const requested = generation
      const previous = model
      const { request, ...presentation } = input
      if (
        request.surface !== previous.surface ||
        (request.surface === 'browser-menu' &&
          request.tabId !== (previous.target.kind === 'browser' ? previous.target.tabId : null)) ||
        (request.surface === 'account-menu' &&
          (previous.target.kind !== 'account' ||
            request.identityRevision !== previous.target.identityRevision)) ||
        (request.surface === 'browser-find' &&
          !sameMenuTarget(previous.target, { kind: 'browser', ...request.target }))
      ) {
        invalidate('target')
        await bridge.dismiss('target')
        return
      }
      const next = { ...previous, ...presentation, revision: previous.revision + 1 }
      if (!sameMenuTarget(previous.target, next.target)) return
      await publish(next, requested)
    },
    async dismiss(reason) {
      invalidate(reason)
      await bridge.dismiss(reason)
    },
    dispose() {
      if (disposed) return
      disposed = true
      invalidate('dispose')
      revoked()
      events()
      completed()
      subscribers.clear()
      actions.clear()
      results.clear()
      void bridge.dismiss('dispose').catch((error) => console.error('Menu disposal failed', error))
    },
  }
}

interface SharedPresentation {
  coordinator: MenuPresenter
  owner: symbol | null
  replaced: (() => void) | null
}
const presentations = new WeakMap<MenuBridge, SharedPresentation>()

export function createMenuPresenter(
  bridge: MenuBridge,
  surface: MenuSurface = 'browser-menu'
): MenuPresenter {
  let shared = presentations.get(bridge)
  if (!shared) {
    shared = { coordinator: createCoordinator(bridge), owner: null, replaced: null }
    presentations.set(bridge, shared)
  }
  const presentation = shared
  const token = Symbol(surface)
  const subscribers = new Set<(model: MenuModel | null, reason?: MenuDismissReason) => void>()
  const removers = new Set<() => void>()
  const owned = (): boolean => presentation.owner === token
  const subscribe = <Arguments extends unknown[]>(
    register: (callback: (...args: Arguments) => void) => () => void,
    callback: (...args: Arguments) => void
  ): (() => void) => {
    const remove = register((...args: Arguments) => {
      if (owned()) callback(...args)
    })
    const release = (): void => {
      remove()
      removers.delete(release)
    }
    removers.add(release)
    return release
  }
  return {
    current: () => (owned() ? presentation.coordinator.current() : null),
    subscribe(callback) {
      subscribers.add(callback)
      const remove = subscribe(presentation.coordinator.subscribe, callback)
      return () => {
        subscribers.delete(callback)
        remove()
      }
    },
    subscribeAction: (callback) => subscribe(presentation.coordinator.subscribeAction, callback),
    subscribeResult: (callback) => subscribe(presentation.coordinator.subscribeResult, callback),
    async open(requestedSurface, anchor, model) {
      if (requestedSurface !== surface) throw new Error(MENU_ERROR.invalid)
      if (!owned()) presentation.replaced?.()
      presentation.owner = null
      const opened = presentation.coordinator.open(surface, anchor, model)
      presentation.owner = token
      presentation.replaced = () => subscribers.forEach((callback) => callback(null, 'replaced'))
      await opened
    },
    update: async (model) => {
      if (owned()) await presentation.coordinator.update(model)
    },
    dismiss: async (reason) => {
      if (owned()) await presentation.coordinator.dismiss(reason)
    },
    dispose() {
      if (owned()) {
        void presentation.coordinator
          .dismiss('dispose')
          .catch((error) => console.error('Menu disposal failed', error))
        presentation.owner = null
        presentation.replaced = null
      }
      for (const remove of [...removers]) remove()
      subscribers.clear()
    },
  }
}
