export const CLIPBOARD_PASTE_CHANNEL = 'scholarseed:paste-clipboard'
export const CLIPBOARD_WRITE_CONTENT_CHANNEL = 'scholarseed:write-clipboard-content'
export const OFFICE_CLIPBOARD_ERROR = Object.freeze({ failed: 'clipboard_failed' } as const)

export interface ClipboardContentPayload {
  text: string
  html: string
}

export type ClipboardContentResult = { ok: true } | { ok: false; error: string }
