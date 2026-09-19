import { PASSWORD_MIN_LENGTH } from './account.ts'

export const CODE_LENGTH = 6

export const RESET_PASSWORD_DIALOG = {
  testId: 'account-reset-password-dialog',
  phoneTestId: 'account-reset-password-phone',
  codeTestId: 'account-reset-password-code',
  sendCodeTestId: 'account-reset-password-send-code',
  passwordTestId: 'account-reset-password-new',
  cancelTestId: 'account-reset-password-cancel',
  submitTestId: 'account-reset-password-submit',
  closeTestId: 'account-reset-password-close'
} as const

export interface ResetPasswordSubmitState {
  phoneValid: boolean
  code: string
  password: string
  busy: boolean
}

export function resetPasswordSubmitReady(state: ResetPasswordSubmitState): boolean {
  return (
    !state.busy
    && state.phoneValid
    && state.code.length === CODE_LENGTH
    && state.password.length >= PASSWORD_MIN_LENGTH
  )
}
