import { commandsCtx, EditorViewReady } from '@milkdown/kit/core'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import {
  addColAfterCommand,
  addColBeforeCommand
} from '@milkdown/kit/preset/gfm'
import type { Node } from '@milkdown/kit/prose/model'
import type { Command, Transaction } from '@milkdown/kit/prose/state'
import { TableMap, selectedRect } from '@milkdown/kit/prose/tables'

type ColumnSide = 'after' | 'before'

interface CellStyle {
  alignment: unknown
  colwidth: unknown
}

function referenceStyles(table: Node, map: TableMap, column: number): CellStyle[] {
  return Array.from({ length: map.height }, (_, row) => {
    const cell = table.nodeAt(map.positionAt(row, column, table))
    return {
      alignment: cell?.attrs.alignment,
      colwidth: Array.isArray(cell?.attrs.colwidth) ? [...cell.attrs.colwidth] : cell?.attrs.colwidth
    }
  })
}

function inheritInsertedColumn(
  transaction: Transaction,
  tablePosition: number,
  column: number,
  styles: CellStyle[]
): void {
  const table = transaction.doc.nodeAt(tablePosition)
  if (!table) return
  const map = TableMap.get(table)
  styles.forEach((style, row) => {
    const relative = map.positionAt(row, column, table)
    const position = tablePosition + 1 + relative
    const cell = transaction.doc.nodeAt(position)
    if (!cell) return
    transaction.setNodeMarkup(position, undefined, {
      ...cell.attrs,
      alignment: style.alignment ?? cell.attrs.alignment,
      colwidth: style.colwidth ?? cell.attrs.colwidth
    })
  })
}

function withAdjacentColumnStyle(command: () => Command, side: ColumnSide): Command {
  return (state, dispatch, view) => {
    if (!dispatch) return command()(state, undefined, view)
    const rect = selectedRect(state)
    const insertedColumn = side === 'before' ? rect.left : rect.right
    const referenceColumn = side === 'before' ? rect.left : rect.right - 1
    const styles = referenceStyles(rect.table, rect.map, referenceColumn)
    const tablePosition = rect.tableStart - 1
    return command()(state, (transaction) => {
      inheritInsertedColumn(transaction, tablePosition, insertedColumn, styles)
      dispatch(transaction)
    }, view)
  }
}

/** Preserve the native table UI while strengthening its column insertion commands. */
export const tableColumnInheritancePlugin: MilkdownPlugin = (ctx) => async () => {
  await ctx.wait(EditorViewReady)
  const commands = ctx.get(commandsCtx)
  const before = commands.get(addColBeforeCommand.key)
  const after = commands.get(addColAfterCommand.key)
  commands.remove(addColBeforeCommand.key)
  commands.remove(addColAfterCommand.key)
  commands.create(addColBeforeCommand.key, () => withAdjacentColumnStyle(before, 'before'))
  commands.create(addColAfterCommand.key, () => withAdjacentColumnStyle(after, 'after'))
  return () => {
    commands.remove(addColBeforeCommand.key)
    commands.remove(addColAfterCommand.key)
    commands.create(addColBeforeCommand.key, before)
    commands.create(addColAfterCommand.key, after)
  }
}
