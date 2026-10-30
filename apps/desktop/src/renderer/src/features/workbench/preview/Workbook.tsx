import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type ExcelJS from 'exceljs'
import { useTranslation } from 'react-i18next'

import { Alert, Button } from '../../../components/ui'
import { cellText, rangeText, needsSourceReference, MAX_INLINE_SELECTION_CELLS, DEFAULT_ROW_HEIGHT, DEFAULT_COLUMN_WIDTH, ROW_HEADER_WIDTH } from './cells'
import type { PreviewSelection } from './selection'
import { loadWorkbook } from './spreadsheet'
import { cellStyle, cellTextStyle, mergeCellBorders, readWorkbookStyles, wrappedCellHeight, type WorkbookStyles } from './styles'
import { parseDrawings } from './drawing'
import { Drawing } from './Artwork'
import { Grid, type GridBounds, type GridModel, type GridPoint } from './Grid'
import type { GridViews } from './geometry'
import { Sheets } from './Sheets'
import { compileConditionalFormats, conditionalDecoration, readConditionalFormats, type ConditionalCell, type ConditionalRule } from './conditional'

interface Props {
  bytes: Uint8Array
  title: string
  zoom: number
  query: string
  searchStep: number
  onSearch: (result: { current: number; total: number }) => void
  onSelection: (selection: PreviewSelection | null) => void
}
const POINTS_TO_PIXELS = 4 / 3
const DEFAULT_WORKSHEET_ROW_POINTS = 15
const EXCEL_CHARACTER_WIDTH = 7

function mergeBounds(address: string): GridBounds {
  const points = address.split(':').map((point) => {
    const match = /^([A-Z]+)(\d+)$/.exec(point)
    if (!match) throw new Error('Invalid merged cell range')
    return { row: Number(match[2]), column: Array.from(match[1]).reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0) }
  })
  const end = points[1] ?? points[0]
  return { top: Math.min(points[0].row, end.row), bottom: Math.max(points[0].row, end.row), left: Math.min(points[0].column, end.column), right: Math.max(points[0].column, end.column) }
}

function Sheet({ sheet, styles, rules, views, onNavigate, ...props }: Props & { sheet: ExcelJS.Worksheet; styles: WorkbookStyles; rules: readonly ConditionalRule[]; views: GridViews; onNavigate: (name: string) => void }): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const drawings = useMemo(() => parseDrawings(props.bytes, sheet.name, styles), [props.bytes, sheet.name, styles])
  const rowCount = Math.max(sheet.rowCount, 1, ...drawings.flatMap((item) => [item.anchor.from?.row ?? 0, item.anchor.to?.row ?? 0]).map((index) => index + 1))
  const columnCount = Math.max(sheet.columnCount, 1, ...drawings.flatMap((item) => [item.anchor.from?.column ?? 0, item.anchor.to?.column ?? 0]).map((index) => index + 1))
  const showGridLines = sheet.views?.[0]?.showGridLines !== false
  const measurement = useMemo(() => document.createElement('canvas').getContext('2d'), [])
  const merges = useMemo(() => (sheet.model.merges ?? []).map(mergeBounds), [sheet])
  const conditional = useMemo(() => {
    const cells: ConditionalCell[] = []
    sheet.eachRow((row, rowNumber) => row.eachCell((cell, column) => {
      if (!cell.isMerged || cell.master.address === cell.address) cells.push({ row: rowNumber, column, value: cell.value })
    }))
    return compileConditionalFormats(rules, cells)
  }, [sheet, rules])
  const columnSize = useCallback((index: number): number => {
    const column = sheet.columns[index]
    return column?.hidden ? 0 : (column?.width ?? DEFAULT_COLUMN_WIDTH / EXCEL_CHARACTER_WIDTH) * EXCEL_CHARACTER_WIDTH
  }, [sheet])
  const columnPositions = useMemo(() => {
    const offsets = [0]
    for (let index = 0; index < columnCount; index++) offsets.push(offsets[index] + columnSize(index))
    return offsets
  }, [columnCount, columnSize])
  const rowSize = useCallback((index: number): number => {
    const row = sheet.findRow(index + 1)
    if (row?.hidden) return 0
    if (row?.height !== undefined) return row.height * POINTS_TO_PIXELS
    let height = (sheet.properties.defaultRowHeight ?? DEFAULT_WORKSHEET_ROW_POINTS) * POINTS_TO_PIXELS
    if (measurement) row?.eachCell((cell, column) => {
      if (cell.isMerged && cell.master.address !== cell.address) return
      const merge = merges.find((item) => item.top === index + 1 && item.left === column)
      if (merge && merge.bottom !== merge.top) return
      const width = columnPositions[merge?.right ?? column] - columnPositions[column - 1]
      if (width > 0) height = Math.max(height, wrappedCellHeight(cell, styles, width, measurement))
    })
    return height
  }, [sheet, measurement, merges, columnPositions, styles])
  const selectedText = useCallback((box: GridBounds): string => rangeText(Array.from({ length: box.bottom - box.top + 1 }, (_, row) => Array.from({ length: box.right - box.left + 1 }, (_, column) => {
    const cell = sheet.findRow(box.top + row)?.findCell(box.left + column)
    return cell?.isMerged && cell.master.address !== cell.address ? '' : cellText(cell?.value)
  }))), [sheet])
  const model = useMemo<GridModel>(() => ({
    id: `xlsx:${sheet.id}:${sheet.name}`,
    name: sheet.name,
    version: 0,
    rowCount,
    columnCount,
    merges,
    rowSize,
    columnSize,
    cell(row, column, scale) {
      const cell = sheet.getCell(row, column)
      if (cell.isMerged && cell.master.address !== cell.address) return null
      const merge = merges.find((item) => item.top === row && item.left === column)
      const styled = merge ? { font: cell.font, alignment: cell.alignment, fill: cell.fill, value: cell.value, border: mergeCellBorders(sheet, merge.top, merge.left, merge.bottom, merge.right) } : cell
      const text = cellText(cell.value)
      return { text, title: cell.formula ? `=${cell.formula}` : text, style: cellStyle(styled, styles, scale, showGridLines), textStyle: cellTextStyle(styled), decoration: conditionalDecoration(conditional, row, column, cell.value) }
    },
    selection(box) {
      let reference = (box.bottom - box.top + 1) * (box.right - box.left + 1) > MAX_INLINE_SELECTION_CELLS
      for (let row = box.top; row <= box.bottom && !reference; row++) {
        for (let column = box.left; column <= box.right; column++) {
          if (needsSourceReference(sheet.findRow(row)?.findCell(column)?.value)) { reference = true; break }
        }
      }
      return { reference, text: reference ? '' : selectedText(box) }
    },
    copy: selectedText,
    search(query, step) {
      const matches: GridPoint[] = []
      const needle = query.toLocaleLowerCase()
      if (needle) sheet.eachRow((row, rowNumber) => row.eachCell((cell, column) => {
        if (!row.hidden && !sheet.columns[column - 1]?.hidden && (!cell.isMerged || cell.master.address === cell.address) && cellText(cell.value).toLocaleLowerCase().includes(needle)) matches.push({ row: rowNumber, column })
      }))
      const index = matches.length ? ((step % matches.length) + matches.length) % matches.length : 0
      return { current: matches.length ? index + 1 : 0, total: matches.length, point: matches[index] }
    },
  }), [sheet, rowCount, columnCount, merges, rowSize, columnSize, styles, showGridLines, conditional, selectedText])
  const baseRows = useMemo(() => {
    const offsets = [0]
    for (let index = 0; index < rowCount; index++) offsets.push(offsets[index] + rowSize(index) * props.zoom / 100)
    return offsets
  }, [rowCount, rowSize, props.zoom])
  const baseColumns = useMemo(() => columnPositions.map(position => position * props.zoom / 100), [columnPositions, props.zoom])
  return <Grid {...props} model={model} views={views} paper={styles.theme[0]}
    overlay={(positions) => <Drawing items={drawings} columnOffsets={positions.columns} rowOffsets={positions.rows} baseColumnOffsets={baseColumns} baseRowOffsets={baseRows} zoom={props.zoom} origin={{ x: ROW_HEADER_WIDTH, y: DEFAULT_ROW_HEIGHT }} onNavigate={(target) => onNavigate(target.sheet)} />}
    empty={!sheet.actualRowCount && !drawings.length ? <div className="p-[var(--vds-space-4)] text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-secondary)]">{t('officePreview.emptySheet')}</div> : undefined}
  />
}

export function Workbook(props: Props): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const [book, setBook] = useState<ExcelJS.Workbook | null>(null)
  const [styles, setStyles] = useState<WorkbookStyles | null>(null)
  const [formats, setFormats] = useState<ReadonlyMap<string, readonly ConditionalRule[]>>(new Map())
  const [failed, setFailed] = useState(false)
  const [selectedSheet, setSelectedSheet] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const [views, setViews] = useState<GridViews>(() => new Map())
  useEffect(() => {
    let active = true
    setBook(null)
    setViews(new Map())
    setStyles(null)
    setFailed(false)
    setSelectedSheet(0)
    void loadWorkbook(props.bytes).then(
      (workbook) => {
        if (active) {
          const context = readWorkbookStyles(props.bytes)
          setStyles(context)
          setFormats(readConditionalFormats(props.bytes, context))
          setBook(workbook)
        }
      },
      () => {
        if (active) setFailed(true)
      }
    ).catch(() => { if (active) setFailed(true) })
    return () => {
      active = false
    }
  }, [props.bytes, attempt])
  const sheets = useMemo(
    () => book?.worksheets.filter((sheet) => sheet.state === 'visible') ?? [],
    [book]
  )
  if (failed)
    return (
      <div className="p-[var(--vds-space-4)]">
        <Alert tone="warning" title={t('officePreview.failed')} />
        <Button onClick={() => setAttempt((value) => value + 1)}>{t('officePreview.retry')}</Button>
      </div>
    )
  if (!book || !styles)
    return (
      <div className="p-[var(--vds-space-4)] text-[length:var(--vds-font-body-lv2)]">
        {t('officePreview.loading')}
      </div>
    )
  return (
    <>
      {!sheets.length && (
        <div className="p-[var(--vds-space-4)] text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-secondary)]">
          {t('officePreview.emptySheet')}
        </div>
      )}
      {sheets[selectedSheet] && (
        <Sheet key={sheets[selectedSheet].id} {...props} sheet={sheets[selectedSheet]} views={views} styles={styles} rules={formats.get(sheets[selectedSheet].name) ?? []} onNavigate={(name) => {
          const index = sheets.findIndex((sheet) => sheet.name === name)
          if (index < 0) return
          setSelectedSheet(index)
          props.onSelection(null)
        }} />
      )}
      {!!sheets.length && <Sheets names={sheets.map(sheet => sheet.name)} selected={sheets[selectedSheet]?.name ?? sheets[0].name} onSelect={name => {
        const index = sheets.findIndex(sheet => sheet.name === name)
        if (index < 0) return
        setSelectedSheet(index)
        props.onSelection(null)
      }} />}
    </>
  )
}
