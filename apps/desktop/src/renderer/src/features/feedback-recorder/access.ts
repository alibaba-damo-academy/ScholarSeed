export function isFeedbackRecorderAvailable(
  internalEnabled: boolean,
  authenticated: boolean
): boolean {
  return internalEnabled && authenticated
}
