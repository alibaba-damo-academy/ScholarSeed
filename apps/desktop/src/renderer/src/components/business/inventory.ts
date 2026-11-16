/** Fence inventory reads so a superseded response cannot overwrite newer state. */
export interface InventoryRevision {
  next: () => number
  current: (ticket: number) => boolean
}

export function inventoryRevision(): InventoryRevision {
  let revision = 0
  return { next: () => ++revision, current: (ticket) => ticket === revision }
}

export async function reconcileInventory<T>(
  revision: InventoryRevision,
  read: () => Promise<T | null>,
  apply: (value: T) => void | Promise<void>,
  failed?: () => void
): Promise<void> {
  const ticket = revision.next()
  const value = await read()
  if (!revision.current(ticket)) return
  if (value === null) {
    failed?.()
    return
  }
  await apply(value)
}
