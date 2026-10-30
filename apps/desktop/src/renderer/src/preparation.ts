import type { RuntimePreparation } from './api'
import {
  RECONFIGURATION_POLL_MS,
  RECONFIGURATION_REQUEST_TIMEOUT_MS,
} from '../../reconfiguration.ts'

export const PREPARATION_SUPERSEDED_ERROR = 'runtime_preparation_superseded'
export const PREPARATION_INSTANCE_CHANGED_ERROR = 'runtime_preparation_instance_changed'
const PREPARATION_INVALID_RESPONSE_ERROR = 'runtime_preparation_invalid_response'
const PREPARATION_HOST_BUSY_ERROR = 'runtime_host_busy'
const PREPARATION_PENDING = 'accepted'
const HTTP_CLIENT_ERROR = 400
const HTTP_SERVER_ERROR = 500
const HTTP_NOT_FOUND = 404
const HTTP_CONFLICT = 409

export interface PreparationSnapshot {
  model: string
  serviceInstanceId: string | null
  draftGeneration: number
  homeSelectedProjectId: string | null
  activeSession: string | null
}

export interface PreparationContext {
  modelId: string
  serviceInstanceId: string
  draftGeneration: number
  projectId: string | null
  sessionId: string | null
}

interface PreparationRequest {
  requestId: string
  modelId: string
  serviceInstanceId: string
  persistDefault: boolean
}

interface PreparationDependencies {
  snapshot: () => PreparationSnapshot
  prepare: (request: PreparationRequest, signal: AbortSignal) => Promise<RuntimePreparation>
  read: (requestId: string, signal: AbortSignal) => Promise<RuntimePreparation>
  shared: (signal: AbortSignal) => Promise<{ service_instance_id: string }>
  publish: (operation: RuntimePreparation, context: PreparationContext) => void
  requestId?: () => string
  pause?: (signal: AbortSignal) => Promise<void>
}

interface PreparationJob {
  request: PreparationRequest
  context: PreparationContext
  promise: Promise<RuntimePreparation>
  resolve: (operation: RuntimePreparation) => void
  reject: (error: unknown) => void
  controller: AbortController
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('status' in error)) return undefined
  return typeof error.status === 'number' ? error.status : undefined
}

function fatalRequest(error: unknown): boolean {
  const status = errorStatus(error)
  return (
    status !== undefined &&
    status >= HTTP_CLIENT_ERROR &&
    status < HTTP_SERVER_ERROR &&
    !(
      status === HTTP_CONFLICT &&
      error instanceof Error &&
      error.message === PREPARATION_HOST_BUSY_ERROR
    )
  )
}

function requestSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(RECONFIGURATION_REQUEST_TIMEOUT_MS)])
}

function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const cleanup = (): void => signal.removeEventListener('abort', aborted)
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, RECONFIGURATION_POLL_MS)
    const aborted = (): void => {
      clearTimeout(timer)
      cleanup()
      reject(signal.reason)
    }
    signal.addEventListener('abort', aborted, { once: true })
  })
}

export function preparationContextMatches(
  snapshot: PreparationSnapshot,
  context: PreparationContext
): boolean {
  return (
    snapshot.model === context.modelId &&
    snapshot.serviceInstanceId === context.serviceInstanceId &&
    snapshot.draftGeneration === context.draftGeneration &&
    snapshot.homeSelectedProjectId === context.projectId &&
    snapshot.activeSession === context.sessionId
  )
}

function retainedContextMatches(
  snapshot: PreparationSnapshot,
  context: PreparationContext
): boolean {
  return preparationContextMatches(
    {
      ...snapshot,
      serviceInstanceId: snapshot.serviceInstanceId || context.serviceInstanceId,
    },
    context
  )
}

export function waitForPreparation(
  operation: Promise<RuntimePreparation>,
  signal: AbortSignal
): Promise<RuntimePreparation> {
  return new Promise((resolve, reject) => {
    const aborted = (): void => {
      signal.removeEventListener('abort', aborted)
      reject(new Error(PREPARATION_SUPERSEDED_ERROR))
    }
    operation.then(
      (result) => {
        signal.removeEventListener('abort', aborted)
        if (!signal.aborted) resolve(result)
      },
      (error) => {
        signal.removeEventListener('abort', aborted)
        if (!signal.aborted) reject(error)
      }
    )
    if (signal.aborted) aborted()
    else signal.addEventListener('abort', aborted, { once: true })
  })
}

export class RuntimePreparationController {
  private active: PreparationJob | null = null
  private queued: PreparationJob | null = null
  private disposed = false
  private selectionCount = 0
  private selectionTail: Promise<void> = Promise.resolve()
  private readonly lifetime = new AbortController()

  constructor(private readonly dependencies: PreparationDependencies) {}

  prepare(modelId: string, persistDefault = false): Promise<RuntimePreparation> {
    if (this.disposed) return Promise.reject(new Error(PREPARATION_SUPERSEDED_ERROR))
    const snapshot = this.dependencies.snapshot()
    if (!snapshot.serviceInstanceId)
      return Promise.reject(new Error(PREPARATION_INSTANCE_CHANGED_ERROR))
    const context: PreparationContext = {
      modelId,
      serviceInstanceId: snapshot.serviceInstanceId,
      draftGeneration: snapshot.draftGeneration,
      projectId: snapshot.homeSelectedProjectId,
      sessionId: snapshot.activeSession,
    }
    for (const job of [this.active, this.queued]) {
      if (
        job &&
        preparationContextMatches(snapshot, job.context) &&
        job.request.modelId === modelId &&
        (!persistDefault || job.request.persistDefault)
      ) {
        if (job === this.active && this.queued) {
          this.queued.reject(new Error(PREPARATION_SUPERSEDED_ERROR))
          this.queued = null
        }
        return job.promise
      }
    }
    this.queued?.reject(new Error(PREPARATION_SUPERSEDED_ERROR))
    let resolve: PreparationJob['resolve'] = () => undefined
    let reject: PreparationJob['reject'] = () => undefined
    const promise = new Promise<RuntimePreparation>((completed, failed) => {
      resolve = completed
      reject = failed
    })
    this.queued = {
      context,
      request: {
        modelId,
        persistDefault,
        serviceInstanceId: context.serviceInstanceId,
        requestId: this.dependencies.requestId?.() ?? crypto.randomUUID(),
      },
      promise,
      resolve,
      reject,
      controller: new AbortController(),
    }
    this.start()
    return promise
  }

  reconcile(): void {
    const snapshot = this.dependencies.snapshot()
    if (
      this.active &&
      snapshot.serviceInstanceId &&
      snapshot.serviceInstanceId !== this.active.context.serviceInstanceId
    ) {
      this.active.controller.abort(new Error(PREPARATION_INSTANCE_CHANGED_ERROR))
    }
    if (this.queued && !retainedContextMatches(snapshot, this.queued.context)) {
      this.queued.reject(new Error(PREPARATION_SUPERSEDED_ERROR))
      this.queued = null
    }
    this.start()
  }

  runSelection<Value>(writer: () => Promise<Value>): Promise<Value> {
    if (this.disposed) return Promise.reject(new Error(PREPARATION_SUPERSEDED_ERROR))
    this.reconcile()
    const previous = this.selectionTail
    const preparation = this.active?.promise
    this.selectionCount += 1
    const operation = (async () => {
      await previous
      await preparation
      while (!this.dependencies.snapshot().serviceInstanceId) {
        if (this.disposed) throw new Error(PREPARATION_SUPERSEDED_ERROR)
        await (this.dependencies.pause ?? pause)(this.lifetime.signal)
      }
      if (this.disposed) throw new Error(PREPARATION_SUPERSEDED_ERROR)
      return writer()
    })()
    this.selectionTail = operation.then(
      () => undefined,
      () => undefined
    )
    void this.selectionTail.then(() => {
      this.selectionCount -= 1
      this.start()
    })
    return operation
  }

  dispose(): void {
    this.disposed = true
    this.lifetime.abort(new Error(PREPARATION_SUPERSEDED_ERROR))
    this.active?.controller.abort(new Error(PREPARATION_SUPERSEDED_ERROR))
    this.queued?.reject(new Error(PREPARATION_SUPERSEDED_ERROR))
    this.queued = null
  }

  private start(): void {
    if (this.active || !this.queued || this.disposed || this.selectionCount > 0) return
    const job = this.queued
    const snapshot = this.dependencies.snapshot()
    if (!retainedContextMatches(snapshot, job.context)) {
      this.queued = null
      job.reject(new Error(PREPARATION_SUPERSEDED_ERROR))
      return
    }
    if (!snapshot.serviceInstanceId) return
    this.queued = null
    this.active = job
    void (async () => {
      try {
        job.resolve(await this.run(job))
      } catch (error) {
        job.reject(error)
      } finally {
        this.active = null
        this.start()
      }
    })()
  }

  private async run(job: PreparationJob): Promise<RuntimePreparation> {
    const signal = job.controller.signal
    let query = false
    while (true) {
      if (signal.aborted) throw signal.reason
      const instance = this.dependencies.snapshot().serviceInstanceId
      if (instance && instance !== job.context.serviceInstanceId) {
        throw new Error(PREPARATION_INSTANCE_CHANGED_ERROR)
      }
      if (!instance) query = true
      try {
        const operation = query
          ? await this.dependencies.read(job.request.requestId, requestSignal(signal))
          : await this.dependencies.prepare(job.request, requestSignal(signal))
        if (signal.aborted) throw signal.reason
        if (
          operation.request_id !== job.request.requestId ||
          operation.model_id !== job.context.modelId ||
          operation.session_id !== null ||
          !operation.service_instance_id
        )
          throw new Error(PREPARATION_INVALID_RESPONSE_ERROR)
        if (operation.service_instance_id !== job.context.serviceInstanceId) {
          throw new Error(PREPARATION_INSTANCE_CHANGED_ERROR)
        }
        if (preparationContextMatches(this.dependencies.snapshot(), job.context)) {
          this.dependencies.publish(operation, job.context)
        }
        if (operation.state !== PREPARATION_PENDING) return operation
        query = true
      } catch (error) {
        if (signal.aborted) throw signal.reason
        if (error instanceof Error && error.message === PREPARATION_INSTANCE_CHANGED_ERROR)
          throw error
        if (query && errorStatus(error) === HTTP_NOT_FOUND) {
          const current = await this.dependencies.shared(requestSignal(signal)).catch(() => null)
          if (
            current?.service_instance_id &&
            current.service_instance_id !== job.context.serviceInstanceId
          ) {
            throw new Error(PREPARATION_INSTANCE_CHANGED_ERROR)
          }
          query =
            current === null ||
            current.service_instance_id !== job.context.serviceInstanceId ||
            this.dependencies.snapshot().serviceInstanceId !== job.context.serviceInstanceId
        } else {
          if (!query && fatalRequest(error)) throw error
          query = true
        }
      }
      await (this.dependencies.pause ?? pause)(signal)
    }
  }
}
