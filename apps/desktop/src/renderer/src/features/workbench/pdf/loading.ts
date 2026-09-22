export const PDF_LOAD_FAILURE_KIND = {
  encrypted: 'encrypted',
  unknown: 'unknown'
} as const

export type PdfLoadFailure =
  | { kind: typeof PDF_LOAD_FAILURE_KIND.encrypted }
  | { kind: typeof PDF_LOAD_FAILURE_KIND.unknown; detail: string }

export class EncryptedPdfError extends Error {
  constructor() {
    super('Encrypted PDF documents require an external application')
    this.name = 'EncryptedPdfError'
  }
}

export function classifyPdfLoadFailure(error: unknown): PdfLoadFailure {
  return error instanceof EncryptedPdfError || (error instanceof Error && error.name === 'PasswordException')
    ? { kind: PDF_LOAD_FAILURE_KIND.encrypted }
    : {
        kind: PDF_LOAD_FAILURE_KIND.unknown,
        detail: error instanceof Error ? error.message : String(error)
      }
}
