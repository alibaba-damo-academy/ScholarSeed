import type { BrowserOverlayBridge, BrowserOverlayEvent, BrowserOverlayModel } from '../../../../overlay.ts'

export function createSuggestions(bridge: BrowserOverlayBridge) {
  let revision = 0
  let generation = 0
  let current: BrowserOverlayModel | null = null
  let targets = new Map<string, string>()
  let seedError: unknown
  const seeded = bridge.seed().then(value => { revision = value }, error => { seedError = error })
  const invalidate = (): void => { generation += 1; current = null; targets.clear() }
  return {
    invalidate,
    current: () => current,
    async publish(model: Omit<BrowserOverlayModel, 'revision'>, urls: Map<string, string>) {
      invalidate()
      const requested = generation
      await seeded
      if (requested !== generation) return
      if (seedError) throw seedError
      current = { ...model, revision: ++revision }
      targets = new Map(urls)
      const reply = await bridge.publish(current)
      if (!reply.ok && requested === generation) { invalidate(); throw new Error(reply.error) }
    },
    select(event: BrowserOverlayEvent): string | null {
      if (event.kind !== 'select' || event.revision !== current?.revision) return null
      return targets.get(event.itemId) ?? null
    },
    accepts(event: BrowserOverlayEvent): boolean { return event.revision === current?.revision },
    dismiss() { invalidate(); return bridge.dismiss() },
    dismissSync() { invalidate(); bridge.dismissSync() },
    async focus() {
      const reply = await bridge.focus()
      if (!reply.ok) throw new Error(reply.error)
    }
  }
}
