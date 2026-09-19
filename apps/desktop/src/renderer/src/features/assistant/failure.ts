import type { AssistantFailure } from '../../contracts/assistant.ts'

const REQUEST_FAILED = 'request_failed' as const

/** Preserve upstream diagnostics; only locally manufactured failures receive provenance. */
export function assistantRequestFailure(error: unknown): AssistantFailure & { error: string } {
  if (error instanceof AssistantRequestError) return { error: error.message, applicationFailure: error.applicationFailure }
  if (error instanceof Error) return { error: error.message }
  return {
    error: REQUEST_FAILED,
    applicationFailure: { code: REQUEST_FAILED, ...(error == null ? {} : { detail: String(error) }) }
  }
}

/** Application codes are not diagnostic prose. Unknown upstream strings remain unchanged. */
export function assistantFailureDetail(failure: AssistantFailure): string | undefined {
  return failure.applicationFailure ? failure.applicationFailure.detail : failure.error
}

export class AssistantRequestError extends Error {
  readonly applicationFailure = { code: REQUEST_FAILED }
  constructor() {
    super(REQUEST_FAILED)
    this.name = 'AssistantRequestError'
  }
}
