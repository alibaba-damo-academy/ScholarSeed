export interface DisposableModel {
  dispose(): void
}

export function sweepModels<Model extends DisposableModel>(
  models: Map<string, Model>,
  activeSessionIds: ReadonlySet<string>
): void {
  for (const [sessionId, model] of models) {
    if (activeSessionIds.has(sessionId)) continue
    models.delete(sessionId)
    model.dispose()
  }
}
