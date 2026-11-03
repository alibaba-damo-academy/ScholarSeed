import { randomUUID } from 'node:crypto'
import { PROJECT_NAME_MAX } from '../src/renderer/src/contracts/content.ts'
import type { ProjectRef } from '../src/renderer/src/contracts/content.ts'
import { PreviewFiles } from './files.ts'

const POLICY = { queuedMs: 25, runningMs: 250, maximumOperations: 128, maximumDirectoryPlans: 128 } as const
const HTTP = { badRequest: 400, notFound: 404, unavailable: 503 } as const
const ERROR = {
  unknown: 'content_operation_unknown', closed: 'content_operations_closed', capacity: 'content_operation_capacity',
  failed: 'content_operation_failed', simulatedFailure: 'preview_project_creation_failed',
  required: 'name_required', tooLong: 'name_too_long', unknownProject: 'unknown_project',
  description: 'invalid_description', pinned: 'invalid_pinned',
  currentArchive: 'cannot_archive_current_project', currentForget: 'cannot_forget_current_project',
} as const

export interface PreviewProject extends ProjectRef {
  created_at: number
  description?: string
  pinned?: boolean
}

export interface PreviewProjectRemoval { id: string; removed: true; files_kept: true }

interface ProjectOperation {
  operation: string
  state: 'queued' | 'running' | 'succeeded' | 'failed'
  result: PreviewProject | PreviewProjectRemoval | null
  error: string | null
}

export class PreviewProjectError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}

function normalizedName(value: unknown): string {
  return typeof value === 'string' ? value.trim().normalize('NFC') : ''
}

function nameError(name: string): string | null {
  return !name ? ERROR.required : [...name].length > PROJECT_NAME_MAX ? ERROR.tooLong : null
}

export class ProjectSimulation {
  private projects: PreviewProject[]
  private fileSystems = new Map<string, PreviewFiles>()
  private operations = new Map<string, ProjectOperation>()
  private directoryPlans = new Map<string, string>()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private closed = false
  private failNext: boolean

  constructor(private readonly root: string, seed: readonly PreviewProject[], creationPolicy?: 'fail-once') {
    this.projects = seed.map(project => ({ ...project }))
    for (const project of seed) this.fileSystems.set(project.id, new PreviewFiles())
    this.failNext = creationPolicy === 'fail-once'
  }

  all(): PreviewProject[] { return this.projects.map(project => ({ ...project })).sort((left, right) => right.created_at - left.created_at) }

  files(projectId: string): PreviewFiles {
    if (!this.projects.some(project => project.id === projectId)) throw new PreviewProjectError(HTTP.notFound, ERROR.unknownProject)
    const files = this.fileSystems.get(projectId)
    if (!files) throw new PreviewProjectError(HTTP.notFound, ERROR.unknownProject)
    return files
  }

  project(projectId: string): PreviewProject {
    const project = this.projects.find(project => project.id === projectId)
    if (!project) throw new PreviewProjectError(HTTP.badRequest, ERROR.unknownProject)
    return { ...project }
  }

  validateArchive(projectId: string, archived: boolean): PreviewProject {
    const project = this.project(projectId)
    if (archived && project.root === this.root) throw new PreviewProjectError(HTTP.badRequest, ERROR.currentArchive)
    return project
  }

  archive(projectId: string, archived: boolean): PreviewProject {
    this.validateArchive(projectId, archived)
    const index = this.projects.findIndex(project => project.id === projectId)
    const project = { ...this.projects[index], archived_at: archived ? this.projects[index].archived_at ?? Date.now() / 1000 : null }
    this.projects[index] = project
    return { ...project }
  }

  forget(projectId: string, before?: () => Promise<void>): string {
    return this.submit(async () => {
      const project = this.project(projectId)
      if (project.root === this.root) throw new PreviewProjectError(HTTP.badRequest, ERROR.currentForget)
      await before?.()
      if (this.closed) throw new PreviewProjectError(HTTP.unavailable, ERROR.closed)
      this.project(projectId)
      this.projects = this.projects.filter(project => project.id !== projectId)
      return { id: projectId, removed: true, files_kept: true }
    })
  }

  directory(value: unknown): string {
    const name = normalizedName(value)
    const existing = this.directoryPlans.get(name)
    if (existing) return existing
    const directory = `${this.root}/project-${randomUUID()}`
    this.rememberDirectory(name, directory)
    return directory
  }

  private rememberDirectory(name: string, directory: string): void {
    if (this.directoryPlans.size >= POLICY.maximumDirectoryPlans && !this.directoryPlans.has(name)) this.directoryPlans.delete(this.directoryPlans.keys().next().value!)
    this.directoryPlans.set(name, directory)
  }

  private schedule(action: () => void, milliseconds: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (!this.closed) action()
    }, milliseconds)
    this.timers.add(timer)
  }

  private submit(effect: () => Promise<PreviewProject | PreviewProjectRemoval>): string {
    if (this.closed) throw new PreviewProjectError(HTTP.unavailable, ERROR.closed)
    if (this.operations.size >= POLICY.maximumOperations) {
      const terminal = [...this.operations].find(([, operation]) => operation.state === 'succeeded' || operation.state === 'failed')
      if (!terminal) throw new PreviewProjectError(HTTP.unavailable, ERROR.capacity)
      this.operations.delete(terminal[0])
    }
    const identity = randomUUID().replace(/-/g, '')
    const operation: ProjectOperation = { operation: identity, state: 'queued', result: null, error: null }
    this.operations.set(identity, operation)
    this.schedule(() => {
      operation.state = 'running'
      this.schedule(() => { void (async () => {
        try {
          const result = await effect()
          if (this.closed) return
          operation.result = { ...result }
          operation.state = 'succeeded'
        } catch (error) {
          if (this.closed) return
          operation.error = error instanceof PreviewProjectError ? error.code : error instanceof Error ? error.message : ERROR.failed
          operation.state = 'failed'
        }
      })()
      }, POLICY.runningMs)
    }, POLICY.queuedMs)
    return identity
  }

  create(value: unknown): string {
    const name = normalizedName(value)
    const directory = this.directory(name)
    this.directoryPlans.delete(name)
    return this.submit(async () => {
      try {
        const invalid = nameError(name)
        if (invalid) throw new PreviewProjectError(HTTP.badRequest, invalid)
        if (this.failNext) { this.failNext = false; throw new PreviewProjectError(HTTP.badRequest, ERROR.simulatedFailure) }
        const files = new PreviewFiles()
        for (const entry of files.manifest()) files.delete(entry.path)
        const project: PreviewProject = { id: randomUUID(), name, root: directory, layout: 'managed', available: true, created_at: Date.now() / 1000 }
        this.projects.push(project)
        this.fileSystems.set(project.id, files)
        return project
      } catch (error) { this.rememberDirectory(name, directory); throw error }
    })
  }

  operation(identity: string): ProjectOperation {
    const operation = this.operations.get(identity)
    if (!operation) throw new PreviewProjectError(HTTP.notFound, ERROR.unknown)
    return { ...operation, result: operation.result ? { ...operation.result } : null }
  }

  patch(body: Record<string, unknown>): PreviewProject {
    const index = this.projects.findIndex(project => project.id === body.id)
    if (index < 0) throw new PreviewProjectError(HTTP.badRequest, ERROR.unknownProject)
    const name = normalizedName(body.name)
    const invalid = nameError(name)
    if (invalid) throw new PreviewProjectError(HTTP.badRequest, invalid)
    if (body.description !== undefined && typeof body.description !== 'string') throw new PreviewProjectError(HTTP.badRequest, ERROR.description)
    if (body.pinned !== undefined && typeof body.pinned !== 'boolean') throw new PreviewProjectError(HTTP.badRequest, ERROR.pinned)
    const project: PreviewProject = { ...this.projects[index], name,
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      ...(typeof body.pinned === 'boolean' ? { pinned: body.pinned } : {}) }
    this.projects[index] = project
    return { ...project }
  }

  dispose(): void {
    this.closed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.operations.clear()
    this.directoryPlans.clear()
  }
}
