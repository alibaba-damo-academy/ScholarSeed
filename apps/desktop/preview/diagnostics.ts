export const PREVIEW_DIAGNOSTIC_LIMIT = 100

export interface PreviewRequestDiagnostic {
  sequence: number
  method: string
  path: string
  status: number
  durationMs: number
  outcome: 'completed' | 'aborted'
}

export interface PreviewDiagnosticSnapshot {
  readonly requests: readonly PreviewRequestDiagnostic[]
  readonly events: readonly { session_id: string; seq: number; type: string; turn_id?: string }[]
  readonly files: readonly { epoch: string; seq: number; project_id: string; kind: string; path: string; previous_path: string | null }[]
}

export class PreviewDiagnostics {
  private records: PreviewRequestDiagnostic[] = []
  private sequence = 0

  record(value: Omit<PreviewRequestDiagnostic, 'sequence'>): void {
    this.sequence += 1
    this.records.push({
      sequence: this.sequence,
      method: value.method,
      path: value.path.split(/[?#]/, 1)[0],
      status: value.status,
      durationMs: value.durationMs,
      outcome: value.outcome,
    })
    if (this.records.length > PREVIEW_DIAGNOSTIC_LIMIT) this.records.shift()
  }

  snapshot(): PreviewRequestDiagnostic[] {
    return this.records.map(record => ({ ...record }))
  }
}
