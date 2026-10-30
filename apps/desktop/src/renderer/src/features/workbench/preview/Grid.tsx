import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'

import { writeClipboard } from '../../../components/primitive/clipboard'
import { columnName, DEFAULT_ROW_HEIGHT, ROW_HEADER_WIDTH, GRID_OVERSCAN } from './cells'
import type { ConditionalDecoration } from './conditional'
import type { PreviewSelection } from './selection'
import { axisPositions, positionIndex, rangeBox, resizedSize, type GridAxis, type GridPositions, type GridViews } from './geometry'

export interface GridPoint { row: number; column: number }
export interface GridBounds { top: number; bottom: number; left: number; right: number }
interface CellRange { start: GridPoint; end: GridPoint }
type CellPoint = GridPoint
type CellBounds = GridBounds
export interface GridSelection { text: string; reference?: boolean; range?: string }
export interface GridSearch { total: number; current: number; point?: GridPoint }
export interface GridCell { text: string; title?: string; style?: React.CSSProperties; textStyle?: React.CSSProperties; decoration?: ConditionalDecoration }
export interface GridModel {
  id: string
  name: string
  version: number
  /** CSV edits do not change fixed row/column sizes; avoid rebuilding all offsets. */
  geometryVersion?: number
  rowCount: number
  columnCount: number
  merges: readonly GridBounds[]
  rowSize(index: number): number
  columnSize(index: number): number
  cell(row: number, column: number, scale: number): GridCell | null
  selection(bounds: GridBounds): GridSelection | Promise<GridSelection>
  copy?(bounds: GridBounds): string | Promise<string>
  search(query: string, step: number): GridSearch | Promise<GridSearch>
  window?(bounds: GridBounds): void
}
export interface GridProps {
  model: GridModel
  title: string
  zoom: number
  onSelection(selection: PreviewSelection | null): void
  onSearch(result: { total: number; current: number }): void
  query: string
  searchStep: number
  testId?: string
  paper?: string
  overlay?(positions: GridPositions): React.ReactNode
  editable?: { begin(point: GridPoint, initial?: string): void; paste(point: GridPoint, text: string): void; undo(): void; redo(): void }
  editor?(positions: GridPositions): React.ReactNode
  views?: GridViews
  empty?: React.ReactNode
  onError?(error: unknown): void
}
const AUTOSCROLL_DISTANCE = 160
const AUTOSCROLL_SPEED = 20
const RESIZE_KEY_STEP = 10
const EMPTY_DIMENSIONS = { rows: new Map<number, number>(), columns: new Map<number, number>() }
function isEditor(target: EventTarget): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('input, textarea, [contenteditable="true"]'))
}

function bounds(range: CellRange): CellBounds {
  return { top: Math.min(range.start.row, range.end.row), bottom: Math.max(range.start.row, range.end.row), left: Math.min(range.start.column, range.end.column), right: Math.max(range.start.column, range.end.column) }
}

export function Grid(props: GridProps): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const { model, query, searchStep, onSearch, onSelection } = props
  const modelRef = useRef(model)
  modelRef.current = model
  const onErrorRef = useRef(props.onError)
  onErrorRef.current = props.onError
  const scroll = useRef<HTMLDivElement>(null)
  const rangeRef = useRef<CellRange | null>(null)
  const rawRange = useRef<CellRange | null>(null)
  const drag = useRef<{ x: number; y: number; pointerId: number } | null>(null)
  const [range, setRange] = useState<CellRange | null>(null)
  const localViews = useRef<GridViews>(new Map())
  const views = props.views ?? localViews.current
  const [view, setView] = useState(() => ({ id: model.id, dimensions: views.get(model.id) ?? EMPTY_DIMENSIONS, version: 0 }))
  const dimensions = view.id === model.id ? view.dimensions : views.get(model.id) ?? EMPTY_DIMENSIONS
  const resizing = useRef<{ axis: GridAxis; index: number; initial: number; start: number; pointerId: number; size: number; edge: number } | null>(null)
  const [guide, setGuide] = useState<{ axis: GridAxis; position: number } | null>(null)
  const resizeSelection = useRef(false)
  const publication = useRef(0)
  const previousSearch = useRef<string | null>(null)
  const cancelPublication = useCallback((): void => { publication.current++ }, [])
  const clearSelection = useCallback((): void => {
    publication.current++
    window.getSelection()?.removeAllRanges()
    onSelection(null)
  }, [onSelection])
  const scale = props.zoom / 100
  const rowCount = Math.max(model.rowCount, 1)
  const columnCount = Math.max(model.columnCount, 1)
  const geometryVersion = model.geometryVersion ?? model.version
  const geometry = useMemo(() => ({ id: model.id, version: geometryVersion, merges: modelRef.current.merges, rowSize: modelRef.current.rowSize, columnSize: modelRef.current.columnSize }), [model.id, geometryVersion])
  const merges = geometry.merges
  const positions = useMemo(() => {
    return { rows: axisPositions(rowCount, geometry.rowSize, dimensions.rows, scale), columns: axisPositions(columnCount, geometry.columnSize, dimensions.columns, scale) }
  }, [rowCount, columnCount, geometry, scale, dimensions])
  const rowSize = useCallback((index: number) => positions.rows[index + 1] - positions.rows[index], [positions])
  const columnSize = useCallback((index: number) => positions.columns[index + 1] - positions.columns[index], [positions])
  const rows = useVirtualizer({ count: rowCount, getScrollElement: () => scroll.current, estimateSize: rowSize, overscan: GRID_OVERSCAN })
  const columns = useVirtualizer({ horizontal: true, count: columnCount, getScrollElement: () => scroll.current, estimateSize: columnSize, overscan: GRID_OVERSCAN })
  const updateRange = useCallback((next: CellRange): void => {
    window.getSelection()?.removeAllRanges()
    publication.current++
    rawRange.current = next
    let box = bounds(next)
    // A selection intersecting a merged cell includes its authoritative master.
    for (let changed = true; changed;) {
      changed = false
      for (const merge of merges) {
        if (merge.right < box.left || merge.left > box.right || merge.bottom < box.top || merge.top > box.bottom) continue
        const expanded = { top: Math.min(box.top, merge.top), bottom: Math.max(box.bottom, merge.bottom), left: Math.min(box.left, merge.left), right: Math.max(box.right, merge.right) }
        if (Object.keys(box).some((key) => box[key as keyof CellBounds] !== expanded[key as keyof CellBounds])) { box = expanded; changed = true }
      }
    }
    const normalized = { start: { row: box.top, column: box.left }, end: { row: box.bottom, column: box.right } }
    rangeRef.current = normalized; setRange(normalized)
  }, [merges])
  const publish = (rect: DOMRect): void => {
    const selected = rangeRef.current
    if (!selected) return
    const box = bounds(selected)
    const snapshot = modelRef.current
    const generation = ++publication.current
    const accept = (result: GridSelection): void => {
      if (generation !== publication.current || snapshot.id !== modelRef.current.id || snapshot.version !== modelRef.current.version) return
      const address = result.range ?? `${columnName(box.left)}${box.top}:${columnName(box.right)}${box.bottom}`
      const text = result.reference ? `${props.title} · ${snapshot.name}!${address}` : result.text
      onSelection(text ? { text, locator: { kind: 'calc', sheet: snapshot.name, range: address, ...(result.reference ? { content_mode: 'reference' as const } : {}) }, rect } : null)
    }
    const result = snapshot.selection(box)
    if (result instanceof Promise) void result.then(accept).catch((error) => { if (generation === publication.current) { onSelection(null); onErrorRef.current?.(error) } })
    else accept(result)
  }
  const publishKeyboard = (point: CellPoint): void => {
    const element = scroll.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const x = Math.max(rect.left + 1, Math.min(rect.right - 2, rect.left + ROW_HEADER_WIDTH + positions.columns[point.column] - element.scrollLeft))
    const y = Math.max(rect.top + 1, Math.min(rect.bottom - 2, rect.top + DEFAULT_ROW_HEIGHT + positions.rows[point.row] - element.scrollTop))
    publish(new DOMRect(x, y, 1, 1))
  }
  const dragHandlers = useRef({ updateRange, publish, publishKeyboard, positions })
  dragHandlers.current = { updateRange, publish, publishKeyboard, positions }
  useEffect(() => {
    if (!resizeSelection.current) return
    resizeSelection.current = false
    if (rawRange.current) dragHandlers.current.publishKeyboard(rawRange.current.end)
  }, [view])
  const finishResize = (commit: boolean): void => {
    const current = resizing.current
    if (!current) return
    resizing.current = null
    setGuide(null)
    if (scroll.current?.hasPointerCapture(current.pointerId)) scroll.current.releasePointerCapture(current.pointerId)
    if (!commit) {
      if (rawRange.current) dragHandlers.current.publishKeyboard(rawRange.current.end)
      return
    }
    const previous = views.get(model.id) ?? EMPTY_DIMENSIONS
    const key = current.axis === 'row' ? 'rows' : 'columns'
    const next = { ...previous, [key]: new Map(previous[key]).set(current.index, current.size) }
    views.set(model.id, next)
    resizeSelection.current = true
    setView(currentView => ({ id: model.id, dimensions: next, version: currentView.version + 1 }))
  }
  useEffect(() => {
    const cancel = (): void => {
      const current = resizing.current
      resizing.current = null
      setGuide(null)
      if (current && scroll.current?.hasPointerCapture(current.pointerId)) scroll.current.releasePointerCapture(current.pointerId)
    }
    window.addEventListener('blur', cancel)
    return () => { cancel(); window.removeEventListener('blur', cancel) }
  }, [model.id])
  const resizeHandle = (axis: GridAxis, index: number): React.JSX.Element => {
    const size = (axis === 'row' ? rowSize(index) : columnSize(index)) / scale
    return <div role="separator" tabIndex={0} aria-orientation={axis === 'column' ? 'vertical' : 'horizontal'}
      aria-label={axis === 'column' ? t('officePreview.resizeColumn', { column: columnName(index + 1) }) : t('officePreview.resizeRow', { row: index + 1 })}
      aria-valuenow={Math.round(size)} data-resize-axis={axis} data-resize-index={index + 1}
      className={axis === 'column' ? 'absolute inset-y-0 right-0 z-[var(--vds-z-local-control)] w-[var(--vds-spreadsheet-resize-hit)] cursor-col-resize touch-none outline-none focus-visible:bg-[var(--vds-spreadsheet-selection-border)]' : 'absolute inset-x-0 bottom-0 z-[var(--vds-z-local-control)] h-[var(--vds-spreadsheet-resize-hit)] cursor-row-resize touch-none outline-none focus-visible:bg-[var(--vds-spreadsheet-selection-border)]'}
      onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
      onPointerDown={event => {
        if (event.button !== 0 || !scroll.current) return
        event.preventDefault(); event.stopPropagation()
        clearSelection(); scroll.current.focus()
        const edge = axis === 'column' ? positions.columns[index + 1] + ROW_HEADER_WIDTH : positions.rows[index + 1] + DEFAULT_ROW_HEIGHT
        resizing.current = { axis, index, initial: size, size, start: axis === 'column' ? event.clientX : event.clientY, edge, pointerId: event.pointerId }
        setGuide({ axis, position: edge })
        scroll.current.setPointerCapture(event.pointerId)
      }}
      onKeyDown={event => {
        if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); return }
        const backward = axis === 'column' ? 'ArrowLeft' : 'ArrowUp'
        const forward = axis === 'column' ? 'ArrowRight' : 'ArrowDown'
        if (event.key !== backward && event.key !== forward) return
        event.preventDefault(); event.stopPropagation(); clearSelection()
        const previous = views.get(model.id) ?? EMPTY_DIMENSIONS
        const key = axis === 'row' ? 'rows' : 'columns'
        const next = { ...previous, [key]: new Map(previous[key]).set(index, resizedSize(axis, size, event.key === forward ? RESIZE_KEY_STEP : -RESIZE_KEY_STEP, 1)) }
        views.set(model.id, next)
        resizeSelection.current = true
        setView(currentView => ({ id: model.id, dimensions: next, version: currentView.version + 1 }))
      }}
    />
  }
  useEffect(() => {
    let frame = 0
    const host = scroll.current
    if (!host) return
    const moveSelection = (): void => {
      const element = scroll.current
      const point = drag.current
      const initial = rawRange.current
      if (!element || !point || !initial) return
      const rect = element.getBoundingClientRect()
      const x = Math.max(rect.left, Math.min(rect.right - 1, point.x))
      const y = Math.max(rect.top, Math.min(rect.bottom - 1, point.y))
      const geometry = dragHandlers.current.positions
      dragHandlers.current.updateRange({ start: initial.start, end: {
        row: positionIndex(geometry.rows, element.scrollTop + y - rect.top - DEFAULT_ROW_HEIGHT),
        column: positionIndex(geometry.columns, element.scrollLeft + x - rect.left - ROW_HEADER_WIDTH)
      } })
    }
    const tick = (): void => {
      frame = 0
      const element = scroll.current
      const point = drag.current
      if (!element || !point) return
      const rect = element.getBoundingClientRect()
      // office/autoscroll's overflow-distance rule, applied to a native scroll host.
      const velocity = (value: number, start: number, end: number): number => {
        const overflow = value < start ? value - start : value > end ? value - end : 0
        return Math.sign(overflow) * Math.min(Math.abs(overflow) / AUTOSCROLL_DISTANCE, 1) * AUTOSCROLL_SPEED
      }
      const x = velocity(point.x, rect.left, rect.right)
      const y = velocity(point.y, rect.top, rect.bottom)
      if (!x && !y) return
      element.scrollLeft += x; element.scrollTop += y
      moveSelection()
      frame = requestAnimationFrame(tick)
    }
    const move = (event: PointerEvent): void => {
      if (!drag.current || event.pointerId !== drag.current.pointerId) return
      drag.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
      moveSelection()
      if (!frame) frame = requestAnimationFrame(tick)
    }
    const stop = (event?: PointerEvent): void => {
      if (!drag.current || (event && event.pointerId !== drag.current.pointerId)) return
      const element = scroll.current
      const pointerId = drag.current.pointerId
      const point = event?.type === 'pointerup' ? { x: event.clientX, y: event.clientY } : drag.current
      drag.current = { ...point, pointerId }
      moveSelection()
      drag.current = null
      cancelAnimationFrame(frame); frame = 0
      if (host.hasPointerCapture(pointerId)) host.releasePointerCapture(pointerId)
      if (element) {
        const rect = element.getBoundingClientRect()
        const x = Math.max(rect.left, Math.min(rect.right - 2, point.x))
        const y = Math.max(rect.top, Math.min(rect.bottom - 2, point.y))
        dragHandlers.current.publish(new DOMRect(x, y, 1, 1))
      }
    }
    const blur = (): void => stop()
    host.addEventListener('pointermove', move)
    host.addEventListener('pointerup', stop)
    host.addEventListener('pointercancel', stop)
    host.addEventListener('lostpointercapture', stop)
    window.addEventListener('blur', blur)
    return () => {
      cancelPublication()
      cancelAnimationFrame(frame)
      const pointerId = drag.current?.pointerId
      drag.current = null
      host.removeEventListener('pointermove', move)
      host.removeEventListener('pointerup', stop)
      host.removeEventListener('pointercancel', stop)
      host.removeEventListener('lostpointercapture', stop)
      if (pointerId !== undefined && host.hasPointerCapture(pointerId)) host.releasePointerCapture(pointerId)
      window.removeEventListener('blur', blur)
    }
  }, [model.id, cancelPublication])
  useEffect(() => { rows.measure(); columns.measure() }, [positions, rows, columns])
  useEffect(() => {
    let active = true
    if (query || previousSearch.current !== query) clearSelection()
    previousSearch.current = query
    const accept = (result: GridSearch): void => {
      if (!active) return
      onSearch({ current: result.current, total: result.total })
      if (result.point) {
        updateRange({ start: result.point, end: result.point })
        rows.scrollToIndex(result.point.row - 1, { align: 'center' })
        columns.scrollToIndex(result.point.column - 1, { align: 'center' })
      }
    }
    const result = modelRef.current.search(query, searchStep)
    if (result instanceof Promise) void result.then(accept).catch((error) => { if (active) { onSearch({ current: 0, total: 0 }); onErrorRef.current?.(error) } })
    else accept(result)
    return () => { active = false }
  }, [model.id, model.version, query, searchStep, onSearch, updateRange, rows, columns, clearSelection])
  const selected = range ? bounds(range) : null
  const anchor = rawRange.current?.start
  const activeBounds = anchor ? merges.find(merge => anchor.row >= merge.top && anchor.row <= merge.bottom && anchor.column >= merge.left && anchor.column <= merge.right) ?? { top: anchor.row, bottom: anchor.row, left: anchor.column, right: anchor.column } : null
  const rowItems = new Map(rows.getVirtualItems().map((item) => [item.index, item]))
  const columnItems = new Map(columns.getVirtualItems().map((item) => [item.index, item]))
  const extraRows = new Set<number>()
  const extraColumns = new Set<number>()
  for (const merge of merges) {
    if (rows.getVirtualItems().some((item) => item.index + 1 >= merge.top && item.index + 1 <= merge.bottom)
      && columns.getVirtualItems().some((item) => item.index + 1 >= merge.left && item.index + 1 <= merge.right)) {
      extraRows.add(merge.top - 1); extraColumns.add(merge.left - 1)
    }
  }
  const renderedRows = Array.from(new Set([...rowItems.keys(), ...extraRows])).map((index) => ({ index, start: positions.rows[index], size: positions.rows[index + 1] - positions.rows[index] }))
  const renderedColumns = Array.from(new Set([...columnItems.keys(), ...extraColumns])).map((index) => ({ index, start: positions.columns[index], size: positions.columns[index + 1] - positions.columns[index] }))
  const top = rows.getVirtualItems()[0]?.index ?? 0
  const bottom = rows.getVirtualItems().at(-1)?.index ?? 0
  const left = columns.getVirtualItems()[0]?.index ?? 0
  const right = columns.getVirtualItems().at(-1)?.index ?? 0
  useEffect(() => { modelRef.current.window?.({ top: top + 1, bottom: bottom + 1, left: left + 1, right: right + 1 }) }, [model.id, model.version, top, bottom, left, right])
  return <div
    ref={scroll}
    role="grid"
    aria-label={model.name}
    aria-rowcount={rowCount}
    aria-colcount={columnCount}
    tabIndex={0}
    className="relative min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-[var(--vds-border-default)]"
    data-testid={props.testId ?? 'office-workbook-grid'}
    onPointerMove={event => {
      const current = resizing.current
      if (!current || current.pointerId !== event.pointerId) return
      const delta = (current.axis === 'column' ? event.clientX : event.clientY) - current.start
      current.size = resizedSize(current.axis, current.initial, delta, scale)
      setGuide({ axis: current.axis, position: current.edge + (current.size - current.initial) * scale })
    }}
    onPointerUp={event => { if (resizing.current?.pointerId === event.pointerId) finishResize(true) }}
    onPointerCancel={() => finishResize(false)}
    onLostPointerCapture={() => finishResize(false)}
    onDoubleClick={(event) => {
      if (!props.editable || isEditor(event.target) || !scroll.current || (event.target as HTMLElement).closest('[role="separator"], [role="rowheader"], [role="columnheader"]')) return
      const host = scroll.current
      const rect = host.getBoundingClientRect()
      const x = event.clientX - rect.left + host.scrollLeft - ROW_HEADER_WIDTH
      const y = event.clientY - rect.top + host.scrollTop - DEFAULT_ROW_HEIGHT
      if (x < 0 || y < 0) return
      clearSelection()
      props.editable.begin({ row: positionIndex(positions.rows, y), column: positionIndex(positions.columns, x) })
    }}
    onCopy={(event) => {
      if (isEditor(event.target) || !rangeRef.current) return
      const box = bounds(rangeRef.current)
      event.preventDefault()
      const result = modelRef.current.copy?.(box) ?? modelRef.current.selection(box)
      const text = (value: string | GridSelection) => typeof value === 'string' ? value : value.text
      if (result instanceof Promise) void result.then((value) => writeClipboard(text(value))).catch((error) => onErrorRef.current?.(error))
      else event.clipboardData.setData('text/plain', text(result))
    }}
    onPaste={(event) => {
      if (isEditor(event.target) || !props.editable) return
      event.preventDefault()
      const box = rangeRef.current ? bounds(rangeRef.current) : null
      props.editable.paste({ row: box?.top ?? 1, column: box?.left ?? 1 }, event.clipboardData.getData('text/plain'))
    }}
    onKeyDown={(event) => {
      if (isEditor(event.target)) return
      if (resizing.current && event.key === 'Escape') { event.preventDefault(); finishResize(false); return }
      if ((event.target as HTMLElement).closest('[role="separator"]')) return
      if (event.key === 'Escape') {
        event.preventDefault()
        clearSelection()
        rawRange.current = null; rangeRef.current = null; setRange(null)
        return
      }
      const current = rawRange.current?.end ?? { row: 1, column: 1 }
      if (props.editable && (event.metaKey || event.ctrlKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault()
        if (event.key.toLowerCase() === 'y' || event.shiftKey) props.editable.redo()
        else props.editable.undo()
        return
      }
      if (props.editable && !event.metaKey && !event.ctrlKey && !event.altKey && (['F2', 'Enter'].includes(event.key) || event.key.length === 1)) {
        event.preventDefault()
        clearSelection()
        props.editable.begin(current, event.key.length === 1 ? event.key : undefined)
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault(); updateRange({ start: { row: 1, column: 1 }, end: { row: rowCount, column: columnCount } }); publishKeyboard({ row: rowCount, column: columnCount }); return
      }
      const moves: Record<string, CellPoint> = { ArrowUp: { row: -1, column: 0 }, ArrowDown: { row: 1, column: 0 }, ArrowLeft: { row: 0, column: -1 }, ArrowRight: { row: 0, column: 1 } }
      const move = moves[event.key]
      if (!move) return
      event.preventDefault()
      const end = { row: Math.max(1, Math.min(rowCount, current.row + move.row)), column: Math.max(1, Math.min(columnCount, current.column + move.column)) }
      if (!event.shiftKey) {
        const merge = merges.find((item) => current.row >= item.top && current.row <= item.bottom && current.column >= item.left && current.column <= item.right)
        if (merge) {
          if (move.row) end.row = Math.max(1, Math.min(rowCount, move.row > 0 ? merge.bottom + 1 : merge.top - 1))
          if (move.column) end.column = Math.max(1, Math.min(columnCount, move.column > 0 ? merge.right + 1 : merge.left - 1))
        }
      }
      while (move.row && model.rowSize(end.row - 1) === 0 && end.row + move.row >= 1 && end.row + move.row <= rowCount) end.row += move.row
      while (move.column && model.columnSize(end.column - 1) === 0 && end.column + move.column >= 1 && end.column + move.column <= columnCount) end.column += move.column
      updateRange({ start: event.shiftKey && rawRange.current ? rawRange.current.start : end, end })
      rows.scrollToIndex(end.row - 1)
      columns.scrollToIndex(end.column - 1)
      publishKeyboard(end)
    }}
  >
    {/* All dimensions and colors below come from workbook cells and the user's zoom. */}
    <div className="relative min-h-full min-w-full bg-[var(--office-document-paper)]" style={{ height: rows.getTotalSize() + DEFAULT_ROW_HEIGHT, width: columns.getTotalSize() + ROW_HEADER_WIDTH, '--office-document-paper': props.paper ?? 'var(--vds-bg-container)'  } as React.CSSProperties}>
      <div className="sticky top-0 z-[var(--vds-z-local-top)] bg-[var(--vds-spreadsheet-header-background)]" style={{ height: DEFAULT_ROW_HEIGHT }}>
        {columns.getVirtualItems().filter(column => column.size > 0).map(column => <div key={`header-${column.index}`} role="columnheader" aria-label={columnName(column.index + 1)} data-highlighted={Boolean(selected && column.index + 1 >= selected.left && column.index + 1 <= selected.right)}
          className="absolute top-0 flex items-center justify-center border-b border-r border-[var(--vds-spreadsheet-header-border)] bg-[var(--vds-spreadsheet-header-background)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-primary)] data-[highlighted=true]:bg-[var(--vds-spreadsheet-header-selected)] data-[highlighted=true]:[font-weight:var(--vds-fw-semibold)] data-[highlighted=true]:text-[var(--vds-spreadsheet-header-foreground)]"
          style={{ left: positions.columns[column.index] + ROW_HEADER_WIDTH, width: columnSize(column.index), height: DEFAULT_ROW_HEIGHT }} onClick={event => { scroll.current?.focus(); updateRange({ start: { row: 1, column: column.index + 1 }, end: { row: rowCount, column: column.index + 1 } }); publish(event.currentTarget.getBoundingClientRect()) }}>
          {columnName(column.index + 1)}{resizeHandle('column', column.index)}
        </div>)}
        <div aria-hidden="true" className="sticky left-0 z-[var(--vds-z-local-control)] h-full border-b border-r border-[var(--vds-spreadsheet-header-border)] bg-[var(--vds-spreadsheet-header-background)]" style={{ width: ROW_HEADER_WIDTH }} />
      </div>
      {renderedRows.map((row) => <div key={row.index} role="row" aria-rowindex={row.index + 1}>
        {row.size > 0 && <div className="sticky left-0 z-[var(--vds-z-local-control)] h-0" style={{ width: ROW_HEADER_WIDTH }}><div role="rowheader" aria-label={String(row.index + 1)} data-highlighted={Boolean(selected && row.index + 1 >= selected.top && row.index + 1 <= selected.bottom)}
          className="absolute left-0 flex items-center justify-center border-b border-r border-[var(--vds-spreadsheet-header-border)] bg-[var(--vds-spreadsheet-header-background)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-primary)] data-[highlighted=true]:bg-[var(--vds-spreadsheet-header-selected)] data-[highlighted=true]:[font-weight:var(--vds-fw-semibold)] data-[highlighted=true]:text-[var(--vds-spreadsheet-header-foreground)]"
          style={{ top: row.start, width: ROW_HEADER_WIDTH, height: row.size }} onClick={event => { scroll.current?.focus(); updateRange({ start: { row: row.index + 1, column: 1 }, end: { row: row.index + 1, column: columnCount } }); publish(event.currentTarget.getBoundingClientRect()) }}>
          {row.index + 1}{resizeHandle('row', row.index)}
        </div></div>}
        {renderedColumns.map((column) => {
          const point = { row: row.index + 1, column: column.index + 1 }
          const cell = model.cell(point.row, point.column, scale)
          if (!cell) return null
          const merge = merges.find((item) => item.top === point.row && item.left === point.column)
          const width = merge ? positions.columns[merge.right] - column.start : column.size
          const height = merge ? positions.rows[merge.bottom] - row.start : row.size
          if (!width || !height) return null
          const active = selected && point.row >= selected.top && point.row <= selected.bottom && point.column >= selected.left && point.column <= selected.right
          const decoration = cell.decoration
          return <div key={column.index} role="gridcell" aria-colindex={point.column} aria-selected={Boolean(active)} data-cell={`${columnName(point.column)}${point.row}`} title={cell.title ?? cell.text}
            className="absolute select-none overflow-hidden"
            data-selected={Boolean(active)}
            style={{ ...cell.style, ...(decoration?.background ? { backgroundColor: decoration.background } : {}), left: column.start + ROW_HEADER_WIDTH, top: row.start + DEFAULT_ROW_HEIGHT, width, height }}
            onPointerDown={(event) => {
              if (event.button !== 0 || !scroll.current) return
              clearSelection()
              event.preventDefault(); scroll.current.focus()
              updateRange({ start: event.shiftKey && rawRange.current ? rawRange.current.start : point, end: point })
              drag.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
              // Capture on the stable grid, never a cell removed by virtual scrolling.
              scroll.current.setPointerCapture(event.pointerId)
            }}
          >
            {decoration?.bar && <span aria-hidden="true" data-conditional-bar={decoration.bar.fraction} className="pointer-events-none absolute inset-y-0 left-0 bg-[var(--office-conditional-color)] bg-gradient-to-r from-[var(--office-conditional-color)] to-[var(--office-document-paper)]" style={{ width: `${decoration.bar.fraction * 100}%`, '--office-conditional-color': decoration.bar.color } as React.CSSProperties} />}
            <span className="relative" style={cell.textStyle}>
              {/* Document glyph dimensions follow the authored cell font and zoom. */}
              {decoration?.icon && <img aria-hidden="true" alt="" data-conditional-icon={decoration.icon.asset.id} src={decoration.icon.asset.dataUrl} className="pointer-events-none float-left h-[length:var(--office-conditional-icon-size)] w-[length:var(--office-conditional-icon-size)]" style={{ '--office-conditional-icon-size': typeof cell.style?.fontSize === 'number' ? `${cell.style.fontSize}px` : cell.style?.fontSize ?? 'var(--vds-font-body-lv1)' } as React.CSSProperties} />}
              <span className={decoration?.showValue === false ? 'hidden' : undefined}>{cell.text}</span>
            </span>
            {active && !(activeBounds && point.row >= activeBounds.top && point.row <= activeBounds.bottom && point.column >= activeBounds.left && point.column <= activeBounds.right) && <span aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[var(--vds-spreadsheet-selection-fill)]" />}
          </div>
        })}
      </div>)}
      {props.overlay?.(positions)}
      {selected && <div aria-hidden="true" data-testid="grid-selection-outline" className="pointer-events-none absolute z-[var(--vds-z-local-raised)] border-2 border-[var(--vds-spreadsheet-selection-border)]" style={{ ...rangeBox(positions, selected), left: positions.columns[selected.left - 1] + ROW_HEADER_WIDTH, top: positions.rows[selected.top - 1] + DEFAULT_ROW_HEIGHT }} />}
      {selected && activeBounds && <div aria-hidden="true" data-testid="grid-active-cell" className="pointer-events-none absolute z-[var(--vds-z-local-raised)] border-2 border-[var(--vds-spreadsheet-selection-border)]" style={{ ...rangeBox(positions, activeBounds), left: positions.columns[activeBounds.left - 1] + ROW_HEADER_WIDTH, top: positions.rows[activeBounds.top - 1] + DEFAULT_ROW_HEIGHT }} />}
      {guide && <div aria-hidden="true" data-testid="grid-resize-guide" className={guide.axis === 'column' ? 'pointer-events-none absolute inset-y-0 z-[var(--vds-z-local-control)] border-l border-dashed border-[var(--vds-spreadsheet-selection-border)]' : 'pointer-events-none absolute inset-x-0 z-[var(--vds-z-local-control)] border-t border-dashed border-[var(--vds-spreadsheet-selection-border)]'} style={guide.axis === 'column' ? { left: guide.position } : { top: guide.position }} />}
      {props.editor?.(positions)}
    </div>
    {props.empty}

  </div>
}
