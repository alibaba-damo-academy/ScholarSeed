import { CsvModel, type CsvDialect, type CsvPatch, type CsvRange, type CsvWindow } from './model.ts'

const CSV_REQUEST_FAILED = 'csv_request_failed'

export type CsvCommand =
  | { command: 'open'; bytes: Uint8Array; revision: string; delimiter?: CsvDialect['delimiter'] }
  | { command: 'readWindow'; window: CsvWindow }
  | { command: 'getRange'; range: CsvRange; limits: { cells: number; chars: number } }
  | { command: 'edit'; patches: CsvPatch[] }
  | { command: 'paste'; row: number; column: number; text: string }
  | { command: 'copy'; range: CsvRange }
  | { command: 'undo' | 'redo' | 'serialize' | 'state' | 'close' }
  | { command: 'acknowledgeSaved'; version: number; revision: string }
  | {
      command: 'search'
      query: string
      after?: { row: number; column: number } | null
      backwards?: boolean
    }
export type CsvRequest = CsvCommand & {
  requestId: number
  identity: string
  expectedVersion?: number
}
export interface CsvResponse {
  requestId: number
  identity: string
  version: number
  ok: boolean
  value?: unknown
  error?: string
}

/** Queued commands obtain the acknowledged version when executed, not on keydown. */
export class CsvQueue {
  private tail: Promise<void> = Promise.resolve()
  private sequence = 0
  private closed = false
  version = 0
  constructor(
    readonly identity: string,
    private readonly dispatch: (request: CsvRequest) => Promise<CsvResponse>
  ) {}
  request(command: CsvCommand, expectedVersion?: number): Promise<CsvResponse> {
    const operation = this.tail.then(async () => {
      if (this.closed) throw new Error('csv_client_closed')
      const mutation = ['edit', 'paste', 'undo', 'redo', 'serialize'].includes(command.command)
      const request = {
        ...command,
        identity: this.identity,
        requestId: ++this.sequence,
        expectedVersion: expectedVersion ?? (mutation ? this.version : undefined),
      } as CsvRequest
      const response = await this.dispatch(request)
      if (response.identity !== this.identity) throw new Error('csv_identity_stale')
      if (!response.ok) throw new Error(response.error ?? 'csv_request_failed')
      this.version = Math.max(this.version, response.version)
      return response
    })
    this.tail = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }
  dispose(): void {
    this.closed = true
  }
}

/** Pure request owner is independently testable without a fake browser Worker. */
export class CsvProcessor {
  private model: CsvModel | null = null
  handle(request: CsvRequest): CsvResponse {
    try {
      if (request.command === 'open') {
        const next = new CsvModel(
          request.bytes,
          request.identity,
          request.delimiter,
          request.revision
        )
        this.model = next
        return {
          requestId: request.requestId,
          identity: request.identity,
          version: next.version,
          ok: true,
          value: next.state(),
        }
      }
      const model = this.model
      if (!model || request.identity !== model.identity) throw new Error('csv_identity_stale')
      if (
        request.expectedVersion !== undefined &&
        request.expectedVersion !== model.version &&
        request.command !== 'acknowledgeSaved'
      )
        throw new Error('csv_version_conflict')
      let value: unknown
      switch (request.command) {
        case 'readWindow':
          value = model.readWindow(request.window)
          break
        case 'getRange':
          value = model.getRange(request.range, request.limits)
          break
        case 'copy':
          value = model.copy(request.range)
          break
        case 'paste':
          if (request.expectedVersion === undefined) throw new Error('csv_version_required')
          value = model.paste(request.row, request.column, request.text, request.expectedVersion)
          break
        case 'edit':
          if (request.expectedVersion === undefined) throw new Error('csv_version_required')
          value = model.edit(request.patches, request.expectedVersion)
          break
        case 'undo':
        case 'redo':
          if (request.expectedVersion === undefined) throw new Error('csv_version_required')
          model[request.command](request.expectedVersion)
          value = model.state()
          break
        case 'serialize':
          value = model.serialize()
          break
        case 'state':
          value = model.state()
          break
        case 'acknowledgeSaved':
          value = model.acknowledgeSaved(request.version, request.revision)
          break
        case 'search':
          value = model.search(request.query, request.after, request.backwards)
          break
        case 'close':
          this.model = null
          value = null
          break
      }
      return {
        requestId: request.requestId,
        identity: request.identity,
        version: model.version,
        ok: true,
        value,
      }
    } catch (error) {
      return {
        requestId: request.requestId,
        identity: request.identity,
        version: this.model?.version ?? 0,
        ok: false,
        error: error instanceof Error ? error.message : CSV_REQUEST_FAILED,
      }
    }
  }
}
