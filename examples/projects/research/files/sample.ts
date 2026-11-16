export type SyntheticEntry = {
  label: string
  quantity: number
}

export const firstBoundary = 'CODE-BEGIN-ALPHA'

export const entries: SyntheticEntry[] = [
  { label: 'CODE-NEEDLE', quantity: 2 },
  { label: 'violet', quantity: 5 },
]

export function sumQuantities(values: SyntheticEntry[]): number {
  return values.reduce((total, entry) => total + entry.quantity, 0)
}

export const secondTarget = 'CODE-NEEDLE'

export const lastBoundary = 'CODE-END-OMEGA'
