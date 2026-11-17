export async function saveBibtex(): Promise<{ kind: 'failed'; error: string }> {
  return { kind: 'failed', error: 'ui_export_not_authorized' }
}
