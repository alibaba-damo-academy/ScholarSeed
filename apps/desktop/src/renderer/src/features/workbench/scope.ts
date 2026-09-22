export function resolveDocumentWorkspaceProject(
  selectedProjectId: string | null | undefined,
  assistantProjectId: string | null | undefined,
  explicitProjectId?: string | null
): string | null {
  if (explicitProjectId !== undefined) return explicitProjectId
  return selectedProjectId ?? assistantProjectId ?? null
}
