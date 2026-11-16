import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
  type PaginationState,
} from '@tanstack/react-table'
import {
  Button,
  Checkbox,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui'
import {
  datasetTSV,
  validateDataset,
  type DataRow,
  type DataValue,
  type Dataset,
} from '../ui/statistics'
import { Tabulation } from './Tabulation'

const PAGE_SIZE = 20

export interface DataTableProps {
  paginate?: boolean
  framed?: boolean
  dataset: Dataset
  selected?: string[]
  onSelectionChange?: (ids: string[]) => void
  onCopy?: (text: string) => Promise<void>
  rowSelectionMode?: 'checkbox' | 'row'
  filterable?: boolean
  pageSize?: number
  hideSinglePage?: boolean
}

export function DataTable({
  paginate = true,
  framed = true,
  dataset,
  selected = [],
  onSelectionChange,
  onCopy,
  rowSelectionMode = 'checkbox',
  filterable = true,
  pageSize = PAGE_SIZE,
  hideSinglePage = false,
}: DataTableProps): React.JSX.Element {
  const { t } = useTranslation('conversation')
  validateDataset(dataset)
  const [sorting, setSorting] = useState<SortingState>([])
  const [filter, setFilter] = useState('')
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize })
  const rowSelection = useMemo(
    () => Object.fromEntries(selected.map((id) => [id, true])),
    [selected]
  )
  const columns = useMemo<ColumnDef<DataRow>[]>(
    () =>
      dataset.columns.map((column, index) => ({
        id: column.key,
        accessorFn: (row) => row.values[index],
        header: column.unit ? `${column.label} (${column.unit})` : column.label,
        cell: (context) => {
          const value = context.getValue<DataValue>()
          return value === null ? '—' : String(value)
        },
      })),
    [dataset.columns]
  )
  const table = useReactTable({
    columns,
    data: dataset.rows,
    getRowId: (row) => row.id,
    state: { sorting, globalFilter: filterable ? filter : '', rowSelection, pagination },
    onPaginationChange: setPagination,
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    onRowSelectionChange: (update) => {
      const next: RowSelectionState = typeof update === 'function' ? update(rowSelection) : update
      onSelectionChange?.(dataset.rows.filter((row) => next[row.id]).map((row) => row.id))
    },
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: paginate ? getPaginationRowModel() : undefined,
  })
  useEffect(() => {
    table.setPageSize(pageSize)
  }, [pageSize, table])
  return (
    <section
      className="grid min-w-0 gap-[var(--vds-space-2)] [&>*]:my-0"
      aria-label={t('dataTable.title')}
    >
      {filterable && (
        <Input
          label={t('dataTable.filter')}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      )}
      <Tabulation framed={framed} copyText={datasetTSV(dataset)} onCopy={onCopy}>
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {onSelectionChange && rowSelectionMode === 'checkbox' ? (
                  <TableHead>{t('dataTable.selection')}</TableHead>
                ) : null}
                {group.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    aria-sort={
                      header.column.getIsSorted() === 'asc'
                        ? 'ascending'
                        : header.column.getIsSorted() === 'desc'
                          ? 'descending'
                          : 'none'
                    }
                  >
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getIsSorted() === 'asc'
                        ? ' ↑'
                        : header.column.getIsSorted() === 'desc'
                          ? ' ↓'
                          : ''}
                    </Button>
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                data-selected={row.getIsSelected()}
                className={
                  onSelectionChange && rowSelectionMode === 'row'
                    ? 'cursor-pointer data-[selected=true]:bg-[var(--vds-brand-bg-light)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--vds-focus-brand)]'
                    : undefined
                }
                aria-selected={
                  onSelectionChange && rowSelectionMode === 'row' ? row.getIsSelected() : undefined
                }
                tabIndex={onSelectionChange && rowSelectionMode === 'row' ? 0 : undefined}
                onClick={
                  onSelectionChange && rowSelectionMode === 'row'
                    ? () => row.toggleSelected()
                    : undefined
                }
                onKeyDown={
                  onSelectionChange && rowSelectionMode === 'row'
                    ? (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          row.toggleSelected()
                        }
                      }
                    : undefined
                }
              >
                {onSelectionChange && rowSelectionMode === 'checkbox' ? (
                  <TableCell>
                    <Checkbox
                      aria-label={t('dataTable.selectRow', { id: row.id })}
                      checked={row.getIsSelected()}
                      onCheckedChange={() => row.toggleSelected()}
                    />
                  </TableCell>
                ) : null}
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Tabulation>
      {!table.getFilteredRowModel().rows.length ? <p>{t('dataTable.empty')}</p> : null}
      {paginate && (!hideSinglePage || table.getPageCount() > 1) && (
        <div className="flex flex-wrap items-center gap-[var(--vds-space-2)]">
          <Button
            size="sm"
            variant="ghost"
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
          >
            {t('dataTable.previous')}
          </Button>
          <span>
            {t('dataTable.page', {
              current: table.getState().pagination.pageIndex + 1,
              total: Math.max(1, table.getPageCount()),
            })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={!table.getCanNextPage()}
            onClick={() => table.nextPage()}
          >
            {t('dataTable.next')}
          </Button>
        </div>
      )}
    </section>
  )
}
