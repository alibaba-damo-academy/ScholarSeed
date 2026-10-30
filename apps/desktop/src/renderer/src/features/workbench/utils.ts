export function showUnsavedIndicator(dirty: boolean, autoSave: boolean): boolean {
  return dirty && !autoSave
}
