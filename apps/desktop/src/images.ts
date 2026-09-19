/** User-initiated Office image acquisition; never accepts a filesystem path. */
export const OFFICE_IMAGE_CHANNEL = 'scholarseed:office-image'
export const OFFICE_IMAGE_BYTES_PER_MIB = 1024 * 1024
export const OFFICE_IMAGE_MAX_BYTES = 32 * OFFICE_IMAGE_BYTES_PER_MIB
export const OFFICE_IMAGE_MAX_PIXELS = 40_000_000
export const OFFICE_IMAGE_MEDIA_TYPE = 'image/png'
export type OfficeImageSource = 'file' | 'clipboard'
export type OfficeImageResult =
  | { status: 'image'; bytes: Uint8Array }
  | { status: 'text'; text: string }
  | { status: 'empty' | 'cancelled' }
  | ({ status: 'error' } & OfficeImageFailure)

export type OfficeImageErrorCode = 'pixel_limit' | 'byte_limit' | 'invalid_file' | 'unreadable' | 'unsupported_source' | 'clipboard_limit' | 'invalid_sender' | 'read_failed'
export interface OfficeImageFailure {
  code: OfficeImageErrorCode
  message?: string
  maxBytes?: number
  maxPixels?: number
}

export class OfficeImageError extends Error {
  constructor(readonly failure: OfficeImageFailure) {
    super(failure.message ?? failure.code)
    this.name = 'OfficeImageError'
  }
}
