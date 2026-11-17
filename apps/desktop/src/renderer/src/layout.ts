export interface LayoutParticipant {
  prepare?(): void
  measure(): (() => void) | void
}

export function createLayoutCoordinator(
  request: (callback: () => void) => number,
  cancel: (frame: number) => void
) {
  const participants = new Set<LayoutParticipant>()
  let frame: number | undefined
  let revision = 0
  const flush = (): void => {
    frame = undefined
    revision += 1
    const current = [...participants]
    const commits: { participant: LayoutParticipant; commit: () => void }[] = []
    for (const participant of current) if (participants.has(participant)) participant.prepare?.()
    for (const participant of current) {
      if (!participants.has(participant)) continue
      const commit = participant.measure()
      if (commit) commits.push({ participant, commit })
    }
    for (const { participant, commit } of commits) if (participants.has(participant)) commit()
  }
  const invalidate = (): void => {
    if (frame === undefined) frame = request(flush)
  }
  return {
    get revision(): number {
      return revision
    },
    register(participant: LayoutParticipant) {
      participants.add(participant)
      invalidate()
      return {
        invalidate,
        dispose(): void {
          participants.delete(participant)
          if (!participants.size && frame !== undefined) {
            cancel(frame)
            frame = undefined
          }
        },
      }
    },
  }
}

export const layoutCoordinator = createLayoutCoordinator(
  (callback) => window.requestAnimationFrame(callback),
  (frame) => window.cancelAnimationFrame(frame)
)
