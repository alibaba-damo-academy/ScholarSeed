import {
  rendererPreferencesEqual,
  sanitizeRendererPreferences,
  type RendererPreferences,
} from './preferences.ts'
import {
  PreferenceDiagnostics,
  PREFERENCE_SUBMISSION_SOURCE,
  preferenceChanges,
  type PreferenceDiagnosticSink,
  type PreferenceSubmission,
  type PreferenceSubmissionSource,
} from './preference-diagnostics.ts'
import { PREFERENCE_SHUTDOWN_ERROR } from './quiescence.ts'

export interface PreferencePersistence {
  save: (
    value: RendererPreferences,
    submission: PreferenceSubmission
  ) => Promise<RendererPreferences>
  reconcile: () => Promise<RendererPreferences>
  apply: (value: RendererPreferences, project: () => RendererPreferences) => Promise<void>
  failed: () => void
  diagnostic?: PreferenceDiagnosticSink
}

/** Single writer for all renderer preferences. Pending patches never contain stale language projections. */
export class PreferenceWriter {
  private committed: RendererPreferences
  private acknowledgedPreferences: RendererPreferences
  private confirmations = new Map<
    number,
    { patch: Partial<RendererPreferences>; result?: boolean }
  >()
  private pending: Partial<RendererPreferences> = {}
  private retryPatch: Partial<RendererPreferences> = {}
  private needsReconciliation = false
  private running: Promise<void> | undefined
  private frozen = false
  private revision = 0
  private acknowledgedRevision = 0
  private readonly writerId = crypto.randomUUID()
  private pendingSources = new Set<PreferenceSubmissionSource>()
  private intentGeneration = 0
  private fieldIntents = new Map<
    keyof RendererPreferences,
    {
      source: PreferenceSubmissionSource
      generation: number
      value: RendererPreferences[keyof RendererPreferences]
    }
  >()

  constructor(
    initial: RendererPreferences,
    private readonly port: PreferencePersistence
  ) {
    this.committed = sanitizeRendererPreferences(initial, initial.language)
    this.acknowledgedPreferences = this.committed
  }

  submit(
    patch: Partial<RendererPreferences>,
    source: PreferenceSubmissionSource = PREFERENCE_SUBMISSION_SOURCE.explicit
  ): Promise<void> {
    if (this.frozen) return Promise.resolve()
    this.pendingSources.add(source)
    const generation = ++this.intentGeneration
    for (const key of Object.keys(patch) as (keyof RendererPreferences)[]) {
      delete this.retryPatch[key]
      this.fieldIntents.set(key, { source, generation, value: patch[key] })
    }
    this.pending = { ...this.pending, ...patch }
    return this.start()
  }

  async submitConfirmed(
    patch: Partial<RendererPreferences>,
    source: PreferenceSubmissionSource = PREFERENCE_SUBMISSION_SOURCE.explicit
  ): Promise<boolean> {
    if (this.frozen) return false
    const desired = sanitizeRendererPreferences(
      { ...this.committed, ...patch },
      this.committed.language
    )
    const normalized: Partial<RendererPreferences> = {}
    for (const key of Object.keys(patch) as (keyof RendererPreferences)[])
      Object.assign(normalized, { [key]: desired[key] })
    const generation = this.intentGeneration + 1
    const confirmation: { patch: Partial<RendererPreferences>; result?: boolean } = {
      patch: normalized,
    }
    this.confirmations.set(generation, confirmation)
    try {
      await this.submit(patch, source)
      while (confirmation.result === undefined && this.running) await this.running
      return confirmation.result === true
    } finally {
      this.confirmations.delete(generation)
    }
  }

  retry(): Promise<void> {
    if (this.frozen) return Promise.resolve()
    this.pendingSources.add(PREFERENCE_SUBMISSION_SOURCE.retry)
    const generation = ++this.intentGeneration
    for (const key of Object.keys(this.retryPatch) as (keyof RendererPreferences)[])
      if (!(key in this.pending))
        this.fieldIntents.set(key, {
          source: PREFERENCE_SUBMISSION_SOURCE.retry,
          generation,
          value: this.retryPatch[key],
        })
    this.pending = { ...this.retryPatch, ...this.pending }
    this.retryPatch = {}
    return this.start()
  }

  current(): RendererPreferences {
    return this.committed
  }

  isFrozen(): boolean {
    return this.frozen
  }

  resume(): void {
    this.frozen = false
  }

  async prepareShutdown(): Promise<{ writerId: string; acknowledgedRevision: number }> {
    this.frozen = true
    const createDiagnostics = (): PreferenceDiagnostics =>
      new PreferenceDiagnostics(
        'renderer',
        this.port.diagnostic,
        {
          writerId: this.writerId,
          submissionSources: [PREFERENCE_SUBMISSION_SOURCE.shutdown],
          changedFields: [],
          submittedRevision: this.revision,
        },
        this.acknowledgedRevision
      )
    const diagnostics = createDiagnostics()
    diagnostics.completed('freeze')
    await diagnostics.run('flush', async () => {
      while (this.running) await this.running
      if (Object.keys(this.retryPatch).length || this.needsReconciliation)
        throw new Error(PREFERENCE_SHUTDOWN_ERROR.unsaved)
    })
    createDiagnostics().completed('flush')
    return { writerId: this.writerId, acknowledgedRevision: this.acknowledgedRevision }
  }

  private start(): Promise<void> {
    if (!this.running) {
      this.running = this.drain().finally(() => {
        this.running = undefined
        if (Object.keys(this.pending).length) void this.start()
      })
    }
    return this.running
  }

  private apply(value: RendererPreferences): Promise<void> {
    return this.port.apply(value, () => {
      const automatic: Partial<RendererPreferences> = {}
      for (const [key, intent] of this.fieldIntents)
        if (key !== 'language' && intent.source === PREFERENCE_SUBMISSION_SOURCE.automatic)
          Object.assign(automatic, { [key]: intent.value })
      return sanitizeRendererPreferences(
        { ...this.committed, ...automatic },
        this.committed.language
      )
    })
  }

  private retireIntents(patch: Partial<RendererPreferences>, generation: number): void {
    for (const key of Object.keys(patch) as (keyof RendererPreferences)[])
      if ((this.fieldIntents.get(key)?.generation ?? Infinity) <= generation)
        this.fieldIntents.delete(key)
  }

  private matches(value: RendererPreferences, patch: Partial<RendererPreferences>): boolean {
    return rendererPreferencesEqual(value, { ...value, ...patch })
  }

  private confirm(generation: number, value?: RendererPreferences): void {
    for (const [requested, confirmation] of this.confirmations)
      if (requested <= generation && confirmation.result === undefined)
        confirmation.result =
          value !== undefined &&
          this.matches(value, confirmation.patch) &&
          this.matches(this.acknowledgedPreferences, confirmation.patch)
  }

  private async drain(): Promise<void> {
    while (Object.keys(this.pending).length) {
      let diagnostics = new PreferenceDiagnostics('renderer', this.port.diagnostic)
      if (this.needsReconciliation) {
        try {
          const authoritative = await diagnostics.run('reconcile', () => this.port.reconcile())
          this.committed = authoritative
          await diagnostics.run('reconcile-apply', () => this.apply(authoritative))
          this.needsReconciliation = false
          diagnostics.completed('reconcile')
        } catch {
          this.retryPatch = { ...this.retryPatch, ...this.pending }
          this.pending = {}
          this.fieldIntents.clear()
          this.confirm(this.intentGeneration)
          this.port.failed()
          return
        }
      }
      const patch = this.pending
      const generation = this.intentGeneration
      for (const key of Object.keys(patch) as (keyof RendererPreferences)[])
        delete this.retryPatch[key]
      this.pending = {}
      const submissionSources = [...this.pendingSources]
      this.pendingSources.clear()
      const desired = sanitizeRendererPreferences(
        { ...this.committed, ...patch },
        this.committed.language
      )
      const needsAcknowledgement = [...this.confirmations].some(
        ([requested, confirmation]) =>
          requested <= generation &&
          confirmation.result === undefined &&
          this.matches(desired, confirmation.patch) &&
          !this.matches(this.acknowledgedPreferences, confirmation.patch)
      )
      if (rendererPreferencesEqual(desired, this.committed) && !needsAcknowledgement) {
        this.retireIntents(patch, generation)
        this.confirm(generation, this.committed)
        continue
      }
      const submission: PreferenceSubmission = {
        writerId: this.writerId,
        submissionSources,
        changedFields: preferenceChanges(this.committed, desired),
        submittedRevision: ++this.revision,
      }
      diagnostics = new PreferenceDiagnostics(
        'renderer',
        this.port.diagnostic,
        submission,
        this.acknowledgedRevision
      )
      diagnostics.completed('submit')
      try {
        const saved = await diagnostics.run('save', () => this.port.save(desired, submission))
        this.acknowledgedRevision = submission.submittedRevision
        diagnostics.acknowledge(this.acknowledgedRevision)
        this.acknowledgedPreferences = saved
        this.committed = saved
        this.retireIntents(patch, generation)
        await diagnostics.run('apply', () => this.apply(saved))
        this.confirm(generation, saved)
        diagnostics.completed('save')
        for (const key of Object.keys(patch) as (keyof RendererPreferences)[])
          delete this.retryPatch[key]
      } catch {
        this.confirm(generation)
        this.retireIntents(patch, generation)
        // Preserve the failed intent, but never spin on a failing disk or IPC.
        this.needsReconciliation = true
        this.retryPatch = { ...this.retryPatch, ...patch }
        try {
          const authoritative = await diagnostics.run('reconcile', () => this.port.reconcile())
          this.committed = authoritative
          await diagnostics.run('reconcile-apply', () => this.apply(authoritative))
          this.needsReconciliation = false
          diagnostics.completed('reconcile')
        } catch {
          // Failed reconciliation is still a failed synchronization, not a successful read.
        }
        this.port.failed()
      }
    }
  }
}
