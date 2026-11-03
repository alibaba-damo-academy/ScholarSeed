export type GridAxis = 'row' | 'column'
export interface GridDimensions {
  rows: ReadonlyMap<number, number>
  columns: ReadonlyMap<number, number>
}
export type GridViews = Map<string, GridDimensions>
export interface GridPositions {
  rows: number[]
  columns: number[]
}
export interface GridRectangle {
  top: number
  bottom: number
  left: number
  right: number
}

const MINIMUM_ROW_SIZE = 14
const MINIMUM_COLUMN_SIZE = 24
const MAXIMUM_VIEW_SIZE = 4096

/** View overrides never unhide source rows/columns or mutate authored dimensions. */
export function axisPositions(
  count: number,
  source: (index: number) => number,
  overrides: ReadonlyMap<number, number>,
  scale: number
): number[] {
  const positions = [0]
  for (let index = 0; index < count; index++) {
    const original = source(index)
    positions.push(
      positions[index] + (original === 0 ? 0 : (overrides.get(index) ?? original)) * scale
    )
  }
  return positions
}

export function positionIndex(positions: readonly number[], value: number): number {
  let low = 0
  let high = positions.length - 2
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (positions[middle + 1] <= value) low = middle + 1
    else high = middle
  }
  return low + 1
}

export function resizedSize(
  axis: GridAxis,
  initial: number,
  pointerDelta: number,
  scale: number
): number {
  return Math.min(
    MAXIMUM_VIEW_SIZE,
    Math.max(
      axis === 'row' ? MINIMUM_ROW_SIZE : MINIMUM_COLUMN_SIZE,
      initial + pointerDelta / scale
    )
  )
}

/** The same scaled coordinates position the selection, merged cells and CSV editor. */
export function rangeBox(
  positions: GridPositions,
  range: GridRectangle
): { left: number; top: number; width: number; height: number } {
  return {
    left: positions.columns[range.left - 1],
    top: positions.rows[range.top - 1],
    width: positions.columns[range.right] - positions.columns[range.left - 1],
    height: positions.rows[range.bottom] - positions.rows[range.top - 1],
  }
}
