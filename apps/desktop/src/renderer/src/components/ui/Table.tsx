import type { TableHTMLAttributes, HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react'
import { forwardRef } from 'react'

import { tableClassName, tableStyleClassName, type TableDensity } from './classes'
import { cx } from './utils'

const TABLE_HEADER_CLASS_NAME = 'vds-table__header text-[var(--vds-text-secondary)]'
const TABLE_BODY_CLASS_NAME = 'vds-table__body [&_.vds-table__row:hover]:bg-[var(--vds-surface-hover)]'
const TABLE_FOOTER_CLASS_NAME =
  'vds-table__footer [border-top:var(--vds-border-width-1)_solid_var(--vds-border-default)] bg-[var(--vds-surface-muted)] text-[var(--vds-text-primary)] [font-weight:var(--vds-fw-medium)]'
const TABLE_ROW_CLASS_NAME = 'vds-table__row [border-bottom:var(--vds-border-width-1)_solid_var(--vds-border-default)]'
const TABLE_CELL_CLASS_NAME =
  '[padding:var(--vds-table-cell-padding-y)_var(--vds-table-cell-padding-x)] text-left align-middle group-[.vds-table--compact]:[padding:var(--vds-table-cell-compact-padding-y)_var(--vds-table-cell-padding-x)]'
const TABLE_HEAD_CLASS_NAME = `vds-table__head ${TABLE_CELL_CLASS_NAME} [font-weight:var(--vds-fw-medium)]`
const TABLE_DATA_CELL_CLASS_NAME = `vds-table__cell ${TABLE_CELL_CLASS_NAME}`
const TABLE_CAPTION_CLASS_NAME =
  'vds-table__caption [padding:var(--vds-space-2)_0] text-left [caption-side:bottom] text-[var(--vds-text-secondary)]'

export interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  density?: TableDensity
}

export const Table = forwardRef<HTMLTableElement, TableProps>(
  ({ className, density = 'comfortable', ...props }, ref) => (
    <table className={cx(tableClassName({ className, density }), tableStyleClassName())} ref={ref} {...props} />
  )
)

Table.displayName = 'Table'

export const TableHeader = forwardRef<HTMLTableSectionElement, HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <thead className={cx(TABLE_HEADER_CLASS_NAME, className)} ref={ref} {...props} />
)

TableHeader.displayName = 'TableHeader'

export const TableBody = forwardRef<HTMLTableSectionElement, HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <tbody className={cx(TABLE_BODY_CLASS_NAME, className)} ref={ref} {...props} />
)

TableBody.displayName = 'TableBody'

export const TableFooter = forwardRef<HTMLTableSectionElement, HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <tfoot className={cx(TABLE_FOOTER_CLASS_NAME, className)} ref={ref} {...props} />
)

TableFooter.displayName = 'TableFooter'

export const TableRow = forwardRef<HTMLTableRowElement, HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => <tr className={cx(TABLE_ROW_CLASS_NAME, className)} ref={ref} {...props} />
)

TableRow.displayName = 'TableRow'

export const TableHead = forwardRef<HTMLTableCellElement, ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, scope = 'col', ...props }, ref) => (
    <th className={cx(TABLE_HEAD_CLASS_NAME, className)} ref={ref} scope={scope} {...props} />
  )
)

TableHead.displayName = 'TableHead'

export const TableCell = forwardRef<HTMLTableCellElement, TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => <td className={cx(TABLE_DATA_CELL_CLASS_NAME, className)} ref={ref} {...props} />
)

TableCell.displayName = 'TableCell'

export const TableCaption = forwardRef<HTMLTableCaptionElement, HTMLAttributes<HTMLTableCaptionElement>>(
  ({ className, ...props }, ref) => <caption className={cx(TABLE_CAPTION_CLASS_NAME, className)} ref={ref} {...props} />
)

TableCaption.displayName = 'TableCaption'
