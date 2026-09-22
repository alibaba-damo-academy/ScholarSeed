export const COMPOSER_FOCUS_EVENT = 'scholarseed:composer-focus'
export const FILE_REF_KIND = 'file'

export interface ComposerFocusDetail {
  selectionStart?: number
  selectionEnd?: number
}

export function focusComposer(detail?: ComposerFocusDetail): void {
  window.dispatchEvent(new CustomEvent<ComposerFocusDetail>(COMPOSER_FOCUS_EVENT, { detail }))
}
