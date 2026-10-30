import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { BROWSER_ERROR } from '../browser.ts'
import type {
  BrowserHistoryPage,
  BrowserHistoryQuery,
  BrowserSnapshot,
  BrowserVisit,
} from '../browser.ts'
import type { ChromiumBrowserRegistry, ChromiumHistoryEvent } from './chromiumregistry.ts'
import type { BrowserReadScope } from './grant.ts'
import { normalizeBrowserInput } from './navigation.ts'

import {
  HISTORY_FILE,
  HISTORY_SCHEMA_SQL,
  HISTORY_OBJECTS_SQL,
  decodeHistoryVisit,
  inspectHistorySchema,
} from './history-record.ts'
const HISTORY_PROOF_TTL_MS = 60_000
const MAX_HISTORY_PROOFS = 4096
const MAX_HISTORY_SEARCH_CHARS = 256
const MAX_HISTORY_INTENT_CHARS = 512
const MAX_HISTORY_OFFSET = 1000
const MAX_HISTORY_LIMIT = 20
const HISTORY_DRAIN_TIMEOUT_MS = 30_000
const MAX_CHROMIUM_HISTORY_TABS = 1024

export interface BrowserHistory {
  record(url: string, title: string, visitedAt?: number): string
  updateTitle(id: string, title: string): void
  query(query: BrowserHistoryQuery): BrowserHistoryPage
  get(id: string): BrowserVisit | null
  delete(id: string): boolean
  clear(options: { since?: number; origin?: string }): number
  revision(): number
  close(): void
}

export function createBrowserHistory(directory: string): BrowserHistory {
  mkdirSync(directory, { recursive: true })
  const database = new DatabaseSync(join(directory, HISTORY_FILE))
  try {
    inspectHistorySchema(database.prepare(HISTORY_OBJECTS_SQL).all())
    database.exec(HISTORY_SCHEMA_SQL)
  } catch (error) {
    database.close()
    throw error
  }
  const insert = database.prepare(
    'INSERT INTO browser_visits (id, url, origin, title, visited_at) VALUES (?, ?, ?, ?, ?)'
  )
  const titleUpdate = database.prepare('UPDATE browser_visits SET title = ? WHERE id = ?')
  const removeOne = database.prepare('DELETE FROM browser_visits WHERE id = ?')
  let revision = 0
  const changed = (): void => {
    revision += 1
  }
  return {
    record(url, title, visitedAt = Date.now()) {
      const id = randomUUID()
      insert.run(id, url, new URL(url).origin, title, visitedAt)
      changed()
      return id
    },
    updateTitle(id, title) {
      titleUpdate.run(title, id)
      changed()
    },
    query({ search = '', offset, limit }) {
      const filter = search.trim()
      const where = filter ? 'WHERE instr(lower(url || title), lower(?)) > 0' : ''
      const parameters = filter ? [filter] : []
      const total = database
        .prepare(`SELECT count(*) AS total FROM browser_visits ${where}`)
        .get(...parameters) as { total: number }
      const items = database
        .prepare(
          `SELECT id, url, origin, title, visited_at AS visitedAt FROM browser_visits ${where} ORDER BY visited_at DESC, id DESC LIMIT ? OFFSET ?`
        )
        .all(...parameters, limit, offset)
        .map(decodeHistoryVisit)
      return { items, total: total.total }
    },
    get(id) {
      const row = database
        .prepare(
          'SELECT id, url, origin, title, visited_at AS visitedAt FROM browser_visits WHERE id = ?'
        )
        .get(id)
      return row === undefined ? null : decodeHistoryVisit(row)
    },
    delete(id) {
      changed()
      return removeOne.run(id).changes > 0
    },
    clear({ since, origin }) {
      changed()
      const clauses = [
        since === undefined ? '' : 'visited_at >= ?',
        origin === undefined ? '' : 'origin = ?',
      ].filter(Boolean)
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      return Number(
        database
          .prepare(`DELETE FROM browser_visits ${where}`)
          .run(...(since === undefined ? [] : [since]), ...(origin === undefined ? [] : [origin]))
          .changes
      )
    },
    revision: () => revision,
    close() {
      database.close()
    },
  }
}

export interface ChromiumHistoryOwner {
  queryHistory(query: BrowserHistoryQuery): BrowserHistoryPage
  deleteHistory(id: string): Promise<boolean>
  clearHistory(options: { since?: number; origin?: string }): Promise<number>
  reopenHistory(id: string): Promise<BrowserSnapshot>
  beginClear(): Promise<void>
  endClear(): void
  dispose(): void
}

export function createChromiumHistoryOwner(
  history: BrowserHistory,
  registry: Pick<ChromiumBrowserRegistry, 'onHistoryEvent' | 'dispatch'>,
  authority: Pick<HistoryAgentAuthority, 'beginClear' | 'endClear'>
): ChromiumHistoryOwner {
  const tabs = new Map<
    string,
    { sequence: number; visit?: { id: string; url: string; title: string; pendingTitle?: string } }
  >()
  const pendingReopens = new Set<Promise<BrowserSnapshot>>()
  let disposed = false
  let clearing = false
  let draining = false
  let authorityHeld = false
  let clearSelection: { since?: number; origin?: string } | null = null
  const reconcileVisits = (): void => {
    try {
      for (const tab of tabs.values()) {
        const visit = tab.visit
        if (!visit) continue
        if (history.get(visit.id)?.url !== visit.url) {
          tab.visit = undefined
          continue
        }
        if (visit.pendingTitle !== undefined && visit.pendingTitle !== visit.title) {
          history.updateTitle(visit.id, visit.pendingTitle)
          visit.title = visit.pendingTitle
        }
        visit.pendingTitle = undefined
      }
    } catch (error) {
      for (const tab of tabs.values()) tab.visit = undefined
      throw error
    }
  }
  const onHistoryEvent = (event: ChromiumHistoryEvent): void => {
    if (disposed) return
    if (event.kind === 'closed') {
      tabs.delete(event.tabId)
      return
    }
    let tab = tabs.get(event.tabId)
    if (!tab && event.kind === 'visit') {
      if (tabs.size >= MAX_CHROMIUM_HISTORY_TABS)
        throw new Error('Chromium history tab capacity exhausted')
      tab = { sequence: 0 }
      tabs.set(event.tabId, tab)
    }
    if (!tab) return
    if (event.kind === 'visit') {
      if (!Number.isSafeInteger(event.visitSequence) || event.visitSequence <= tab.sequence) return
      tab.sequence = event.visitSequence
      tab.visit = undefined
      const visitedAt = Date.now()
      if (
        clearing &&
        (!clearSelection ||
          ((clearSelection.since === undefined || visitedAt >= clearSelection.since) &&
            (clearSelection.origin === undefined ||
              new URL(event.url).origin === clearSelection.origin)))
      )
        return
      const id = history.record(event.url, event.title, visitedAt)
      tab.visit = { id, url: event.url, title: event.title }
      return
    }
    const visit = tab.visit
    if (!visit || event.visitSequence !== tab.sequence || event.url !== visit.url) return
    if (clearing) {
      visit.pendingTitle = event.title
      return
    }
    if (event.title === visit.title) return
    if (history.get(visit.id)?.url !== visit.url) {
      tab.visit = undefined
      return
    }
    history.updateTitle(visit.id, event.title)
    visit.title = event.title
  }
  const unsubscribe = registry.onHistoryEvent(onHistoryEvent)
  const owner: ChromiumHistoryOwner = {
    queryHistory(query) {
      if (disposed) throw new Error('Chromium history owner is closed')
      if (clearing) throw new Error('history_clearing')
      return history.query(query)
    },
    async deleteHistory(id) {
      await owner.beginClear()
      try {
        return history.delete(id)
      } finally {
        owner.endClear()
      }
    },
    async clearHistory(options) {
      if (disposed) throw new Error('Chromium history owner is closed')
      if (clearing) throw new Error('history_clearing')
      clearSelection = options
      try {
        await owner.beginClear()
        try {
          return history.clear(options)
        } finally {
          owner.endClear()
        }
      } finally {
        clearSelection = null
      }
    },
    async reopenHistory(id) {
      if (disposed) throw new Error('Chromium history owner is closed')
      if (clearing) throw new Error('history_clearing')
      const visit = history.get(id)
      if (!visit) throw new Error(BROWSER_ERROR.targetClosed)
      const url = normalizeBrowserInput(visit.url)
      const pending = registry.dispatch({ kind: 'open', input: url.href })
      pendingReopens.add(pending)
      void pending.then(
        () => pendingReopens.delete(pending),
        () => pendingReopens.delete(pending)
      )
      return pending
    },
    async beginClear() {
      if (disposed) throw new Error('Chromium history owner is closed')
      if (clearing) throw new Error('history_clearing')
      clearing = true
      draining = true
      try {
        let authorityDrain: Promise<void>
        try {
          authorityDrain = authority.beginClear()
        } catch (error) {
          authorityDrain = Promise.reject(error)
        }
        const authorityResult = authorityDrain.then(
          () => ({ ok: true as const }),
          (error) => ({ ok: false as const, error })
        )
        if (pendingReopens.size) await Promise.allSettled([...pendingReopens])
        const result = await authorityResult
        if (!result.ok) throw result.error
      } catch (error) {
        const conflict = error instanceof Error && error.message === 'history_clearing'
        try {
          reconcileVisits()
        } catch (reconcileError) {
          throw new AggregateError(
            [error, reconcileError],
            'Chromium history clear and title reconciliation failed'
          )
        } finally {
          draining = false
          clearing = false
          if (!conflict) authority.endClear()
        }
        throw error
      }
      draining = false
      authorityHeld = true
      if (disposed) {
        authorityHeld = false
        authority.endClear()
        clearing = false
        throw new Error('Chromium history owner is closed')
      }
    },
    endClear() {
      if (!clearing) return
      if (draining) throw new Error('history_busy')
      try {
        reconcileVisits()
      } finally {
        clearing = false
        if (authorityHeld) {
          authorityHeld = false
          authority.endClear()
        }
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      tabs.clear()
      if (authorityHeld) {
        authorityHeld = false
        clearing = false
        authority.endClear()
      }
    },
  }
  return owner
}

export interface HistoryAgentProof {
  proofId: string
  requestId: string
  scope: BrowserReadScope
  search: string
  offset: number
  limit: number
  intent: string
  queryDigest: string
  historyRevision: number
  policyRevision: number
  expiresAt: number
}

export interface HistoryAgentAuthority {
  prepare(input: {
    scope: BrowserReadScope
    requestId: string
    search: string
    offset: number
    limit: number
    intent: string
  }): HistoryAgentProof
  proof(requestId: string, proofId: string): HistoryAgentProof
  grant(input: {
    scope: BrowserReadScope
    requestId: string
    proofId: string
    queryDigest: string
    historyRevision: number
    expiresAt: number
  }): void
  execute(input: {
    scope: BrowserReadScope
    requestId: string
    proofId: string
    owner: object
    signal?: AbortSignal
  }): BrowserHistoryPage
  watchOwner(owner: object, exited: Promise<unknown>): void
  cancel(input: { scope: BrowserReadScope; requestId: string; proofId?: string }): void
  complete(input: { scope: BrowserReadScope; requestId: string; proofId: string }): void
  waitForLeases(scope?: BrowserReadScope, signal?: AbortSignal): Promise<void>
  beginClear(): Promise<void>
  endClear(): void
  revokeScope(scope: BrowserReadScope): void
  revokeAll(): void
}

function sameScope(left: BrowserReadScope, right: BrowserReadScope): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.instanceId === right.instanceId &&
    left.productTurnId === right.productTurnId &&
    left.turnId === right.turnId &&
    left.generation === right.generation &&
    left.interruptGeneration === right.interruptGeneration &&
    left.lifecycleEpoch === right.lifecycleEpoch
  )
}

export function createHistoryAgentAuthority(
  history: BrowserHistory,
  agentUseRevision: () => number | null
): HistoryAgentAuthority {
  const proofs = new Map<string, { proof: HistoryAgentProof; granted: boolean }>()
  const leases = new Map<string, { scope: BrowserReadScope; proofId: string; owner: object }>()
  const watchedOwners = new WeakSet<object>()
  const endedOwners = new WeakSet<object>()
  const waiters = new Set<{ scope?: BrowserReadScope; resolve(): void }>()
  let clearing = false
  const leaseExists = (scope?: BrowserReadScope): boolean =>
    [...leases.values()].some((lease) => !scope || sameScope(lease.scope, scope))
  const notifyWaiters = (): void => {
    for (const waiter of waiters) {
      if (leaseExists(waiter.scope)) continue
      waiters.delete(waiter)
      waiter.resolve()
    }
  }
  const availableRevision = (): number => {
    const revision = agentUseRevision()
    if (revision === null || !Number.isSafeInteger(revision) || revision < 0)
      throw new Error('browser_unavailable')
    return revision
  }
  const current = (
    requestId: string,
    proofId: string
  ): { proof: HistoryAgentProof; granted: boolean } => {
    const record = proofs.get(requestId)
    if (!record || record.proof.proofId !== proofId) throw new Error('approval_required')
    if (record.proof.expiresAt <= Date.now()) {
      proofs.delete(requestId)
      throw new Error('request_expired')
    }
    if (record.proof.historyRevision !== history.revision()) {
      proofs.delete(requestId)
      throw new Error('history_changed')
    }
    if (record.proof.policyRevision !== availableRevision()) {
      proofs.delete(requestId)
      throw new Error('browser_unavailable')
    }
    return record
  }
  return {
    prepare(input) {
      if (clearing) throw new Error('history_clearing')
      const policyRevision = availableRevision()
      if (
        !input.requestId ||
        !input.search.trim() ||
        input.search.length > MAX_HISTORY_SEARCH_CHARS ||
        !input.intent.trim() ||
        input.intent.length > MAX_HISTORY_INTENT_CHARS ||
        !Number.isSafeInteger(input.offset) ||
        input.offset < 0 ||
        input.offset > MAX_HISTORY_OFFSET ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > MAX_HISTORY_LIMIT
      ) {
        throw new Error('invalid_request')
      }
      for (const [requestId, record] of proofs)
        if (record.proof.expiresAt <= Date.now()) proofs.delete(requestId)
      if (proofs.has(input.requestId)) throw new Error('request_id_conflict')
      if (proofs.size >= MAX_HISTORY_PROOFS) throw new Error('request_capacity_exhausted')
      const queryDigest = createHash('sha256')
        .update(JSON.stringify([input.search, input.offset, input.limit, input.intent]))
        .digest('hex')
      const proof: HistoryAgentProof = {
        ...input,
        scope: { ...input.scope },
        proofId: randomUUID(),
        queryDigest,
        historyRevision: history.revision(),
        policyRevision,
        expiresAt: Date.now() + HISTORY_PROOF_TTL_MS,
      }
      proofs.set(input.requestId, { proof, granted: false })
      return { ...proof, scope: { ...proof.scope } }
    },
    proof(requestId, proofId) {
      const record = current(requestId, proofId)
      return { ...record.proof, scope: { ...record.proof.scope } }
    },
    grant(input) {
      if (clearing) throw new Error('history_clearing')
      const record = current(input.requestId, input.proofId)
      if (!sameScope(record.proof.scope, input.scope)) throw new Error('stale_scope')
      if (
        record.proof.queryDigest !== input.queryDigest ||
        record.proof.historyRevision !== input.historyRevision ||
        record.proof.expiresAt !== input.expiresAt ||
        record.granted
      )
        throw new Error('approval_required')
      record.granted = true
    },
    execute(input) {
      if (clearing) throw new Error('history_clearing')
      if (!watchedOwners.has(input.owner) || endedOwners.has(input.owner))
        throw new Error('browser_unavailable')
      const record = current(input.requestId, input.proofId)
      if (!record.granted) throw new Error('approval_required')
      proofs.delete(input.requestId)
      if (!sameScope(record.proof.scope, input.scope)) throw new Error('stale_scope')
      if (input.signal?.aborted) throw new Error('request_expired')
      const page = history.query({
        search: record.proof.search,
        offset: record.proof.offset,
        limit: record.proof.limit,
      })
      if (
        input.signal?.aborted ||
        history.revision() !== record.proof.historyRevision ||
        availableRevision() !== record.proof.policyRevision
      )
        throw new Error('history_changed')
      leases.set(input.requestId, {
        scope: { ...input.scope },
        proofId: input.proofId,
        owner: input.owner,
      })
      return page
    },
    watchOwner(owner, exited) {
      if (watchedOwners.has(owner)) return
      watchedOwners.add(owner)
      void exited.then(() => {
        endedOwners.add(owner)
        for (const [requestId, lease] of leases) if (lease.owner === owner) leases.delete(requestId)
        notifyWaiters()
      })
    },
    cancel(input) {
      const record = proofs.get(input.requestId)
      if (record && sameScope(record.proof.scope, input.scope)) proofs.delete(input.requestId)
      const lease = leases.get(input.requestId)
      if (lease && input.proofId === lease.proofId && sameScope(lease.scope, input.scope)) {
        leases.delete(input.requestId)
        notifyWaiters()
      }
    },
    complete(input) {
      const lease = leases.get(input.requestId)
      if (!lease || lease.proofId !== input.proofId || !sameScope(lease.scope, input.scope)) {
        throw new Error('approval_required')
      }
      leases.delete(input.requestId)
      notifyWaiters()
    },
    waitForLeases(scope, signal) {
      if (!leaseExists(scope)) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const waiter = {
          scope,
          resolve: () => {
            signal?.removeEventListener('abort', abort)
            resolve()
          },
        }
        const abort = (): void => {
          waiters.delete(waiter)
          reject(new Error('request_expired'))
        }
        if (signal?.aborted) {
          abort()
          return
        }
        waiters.add(waiter)
        signal?.addEventListener('abort', abort, { once: true })
      })
    },
    async beginClear() {
      if (clearing) throw new Error('history_clearing')
      clearing = true
      proofs.clear()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), HISTORY_DRAIN_TIMEOUT_MS)
      try {
        await this.waitForLeases(undefined, controller.signal)
      } catch {
        throw new Error('history_busy')
      } finally {
        clearTimeout(timer)
      }
    },
    endClear() {
      clearing = false
    },
    revokeScope(scope) {
      for (const [requestId, record] of proofs)
        if (sameScope(record.proof.scope, scope)) proofs.delete(requestId)
    },
    revokeAll() {
      proofs.clear()
    },
  }
}
