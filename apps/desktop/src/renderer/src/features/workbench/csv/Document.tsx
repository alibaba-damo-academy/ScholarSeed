import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Alert, Button, Textarea } from '../../../components/ui'
import {
  useSelectionActionContribution,
  type SelectionActionContribution,
  type SelectionReplacementRequest,
} from '../actions'
import {
  selectionFingerprint,
  selectionViewport,
  useDocumentWorkspace,
  useWorkspaceController,
  type DocumentViewKind,
} from '../workspace'
import {
  Grid,
  type GridBounds,
  type GridModel,
  type GridPoint,
  type GridSearch,
} from '../preview/Grid'
import {
  columnName,
  DEFAULT_ROW_HEIGHT,
  ROW_HEADER_WIDTH,
  MAX_INLINE_SELECTION_CELLS,
} from '../preview/cells'
import type { PreviewSelection } from '../preview/selection'
import { rangeBox, type GridPositions } from '../preview/geometry'
import { Sheets } from '../preview/Sheets'
import { CsvClient } from './client'
import { CSV_ENCODINGS, type CsvRangeResult, type CsvSearch, type CsvState } from './model'

interface Props {
  bytes: Uint8Array
  title: string
  revision: string
  tabId?: string
  sessionId?: string
  viewKind?: DocumentViewKind
}
interface Editor {
  point: GridPoint
  original: string
  value: string
}
interface WindowData {
  window: { row: number; column: number; rows: number; columns: number }
  cells: string[][]
}
interface SavedSnapshot {
  bytes: Uint8Array
  version: number
  revision: string
}
const CSV_COLUMN_WIDTH = 180
const CSV_ROW_HEIGHT = 24
const CSV_INITIAL_ROWS = 80
const CSV_INITIAL_COLUMNS = 24
const CSV_INLINE_CHARACTERS = 40_000
const CSV_INITIAL_ZOOM = 100
// Wire codes consumed by Selection's existing localized feedback mapping.
const REPLACEMENT_ERRORS = {
  stale: 'selection_changed',
  unsupported: 'unsupported',
  failed: 'replacement_failed',
} as const
function zeroBounds(box: GridBounds): { top: number; left: number; bottom: number; right: number } {
  return { top: box.top - 1, left: box.left - 1, bottom: box.bottom - 1, right: box.right - 1 }
}
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false
  return true
}
function CsvActions({
  tabId,
  contribution,
}: {
  tabId: string
  contribution: SelectionActionContribution
}): null {
  useSelectionActionContribution(tabId, contribution)
  return null
}

/** CSV keeps its mutable worker model inside the existing document session/save contract. */
export function CsvDocument(props: Props): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const workspace = useDocumentWorkspace()
  const controller = useWorkspaceController()
  const session = props.sessionId ? workspace.sessions[props.sessionId] : undefined
  const owner = props.sessionId || `${props.title}:${props.revision}`
  const root = useRef<HTMLDivElement>(null)
  const client = useRef<CsvClient | null>(null)
  const source = useRef<{ owner: string; bytes: Uint8Array } | null>(null)
  const saved = useRef(new Map<number, SavedSnapshot>())
  const generation = useRef(0)
  const editGeneration = useRef(0)
  const [state, setState] = useState<CsvState | null>(null)
  const editable = Boolean(
    session?.capabilities.can_edit &&
    props.viewKind === 'edit' &&
    state?.sourceEncoding === CSV_ENCODINGS.utf8
  )
  const [data, setData] = useState<WindowData | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [editor, setEditor] = useState<Editor | null>(null)
  const editorRef = useRef<Editor | null>(null)
  const mutationFailure = useRef(false)
  // Relocation/restoration can provide unsaved session bytes as the new model base.
  const initialDraft = useRef(false)
  const searchCursor = useRef<{
    query: string
    step: number
    version: number
    point: CsvSearch['current']
    index: number
  } | null>(null)
  const reportError = useCallback((error: unknown): void => {
    console.warn('CSV document operation failed', error)
    setFailure(error instanceof Error ? error.message : 'csv_request_failed')
  }, [])
  const markDirty = useCallback((): void => {
    if (props.sessionId) controller.setExternalDirty(props.sessionId, true)
  }, [controller, props.sessionId])

  useEffect(() => {
    const current = client.current
    if (source.current?.owner === owner && current) {
      const snapshot = [...saved.current.values()].find((item) =>
        equalBytes(item.bytes, props.bytes)
      )
      if (snapshot) {
        source.current.bytes = props.bytes
        // Workspace publishes serialized bytes before HTTP finishes. Preserve the
        // model during that stage; only a new revision acknowledges persistence.
        if (snapshot.revision === props.revision) return
        initialDraft.current = false
        void current
          .request({
            command: 'acknowledgeSaved',
            version: snapshot.version,
            revision: props.revision,
          })
          .catch((error) => {
            if (client.current === current) reportError(error)
          })
        for (const version of saved.current.keys())
          if (version <= snapshot.version) saved.current.delete(version)
        return
      }
      if (source.current.bytes === props.bytes) return
    }
    current?.dispose()
    generation.current++
    editGeneration.current++
    saved.current.clear()
    source.current = { owner, bytes: props.bytes }
    setFailure(null)
    setState(null)
    setData(null)
    setEditor(null)
    editorRef.current = null
    mutationFailure.current = false
    searchCursor.current = null
    initialDraft.current = Boolean(
      props.sessionId && controller.getSnapshot().sessions[props.sessionId]?.dirty
    )
    const instance = new CsvClient(owner, (next) => {
      if (client.current !== instance) return
      setState(next)
      if (props.sessionId) {
        const live = controller.getSnapshot().sessions[props.sessionId]
        const activeEditor = editorRef.current
        const dirty =
          next.dirty ||
          initialDraft.current ||
          Boolean(activeEditor && activeEditor.value !== activeEditor.original)
        if (live && live.dirty !== dirty) controller.setExternalDirty(props.sessionId, dirty)
      }
    })
    client.current = instance
    void instance
      .request({ command: 'open', bytes: props.bytes, revision: props.revision })
      .then(() =>
        instance.request({
          command: 'readWindow',
          window: { row: 0, column: 0, rows: CSV_INITIAL_ROWS, columns: CSV_INITIAL_COLUMNS },
        })
      )
      .then(
        (response) => {
          if (client.current === instance && instance.current(response))
            setData(response.value as WindowData)
        },
        (error) => {
          if (client.current === instance) reportError(error)
        }
      )
  }, [owner, props.bytes, props.revision, props.sessionId, controller, attempt, reportError])
  useEffect(
    () => () => {
      generation.current++
      client.current?.dispose()
      client.current = null
    },
    []
  )

  const commitEditor = useCallback(async (): Promise<void> => {
    const active = editorRef.current
    if (!active) return
    editorRef.current = null
    setEditor(null)
    if (!client.current) return
    if (active.value === active.original) {
      await client.current.request({ command: 'state' })
      return
    }
    const instance = client.current
    markDirty()
    try {
      await instance.request({
        command: 'edit',
        patches: [
          { row: active.point.row - 1, column: active.point.column - 1, value: active.value },
        ],
      })
      if (client.current === instance) mutationFailure.current = false
    } catch (error) {
      if (client.current === instance) {
        mutationFailure.current = true
        reportError(error)
        throw error
      }
    }
  }, [markDirty, reportError])
  const commitRef = useRef(commitEditor)
  commitRef.current = commitEditor
  useEffect(() => {
    if (!editable || !props.sessionId) return
    return controller.registerSaveDelegate(props.sessionId, {
      prepare: () => {
        void commitRef.current().catch(() => undefined)
      },
      beforeSave: async () => {
        await commitRef.current()
        await client.current?.request({ command: 'state' })
      },
      serialize: async () => {
        const instance = client.current
        if (!instance || mutationFailure.current) return null
        try {
          await commitRef.current()
          if (client.current !== instance) return null
          const response = await instance.request({ command: 'serialize' })
          const snapshot = response.value as { bytes: Uint8Array; version: number }
          const live = controller.getSnapshot().sessions[props.sessionId!]
          saved.current.set(snapshot.version, { ...snapshot, revision: live.revision })
          return snapshot.bytes
        } catch (error) {
          if (client.current === instance) reportError(error)
          return null
        }
      },
    })
  }, [editable, props.sessionId, controller, reportError])

  const begin = useCallback(
    (point: GridPoint, initial?: string): void => {
      if (!editable || !client.current) return
      const instance = client.current,
        request = ++editGeneration.current
      void commitRef
        .current()
        .then(() =>
          instance.request({
            command: 'getRange',
            range: zeroBounds({
              top: point.row,
              bottom: point.row,
              left: point.column,
              right: point.column,
            }),
            limits: { cells: 1, chars: Number.MAX_SAFE_INTEGER },
          })
        )
        .then(
          (response) => {
            if (instance !== client.current || request !== editGeneration.current) return
            const original = (response.value as CsvRangeResult).text ?? ''
            const next = { point, original, value: initial ?? original }
            editorRef.current = next
            setEditor(next)
            if (next.value !== original) markDirty()
          },
          (error) => {
            if (client.current === instance && request === editGeneration.current)
              reportError(error)
          }
        )
    },
    [editable, markDirty, reportError]
  )
  const mutate = useCallback(
    (command: 'undo' | 'redo'): void => {
      if (!client.current || !editable) return
      const instance = client.current
      markDirty()
      void commitRef
        .current()
        .then(() => instance.request({ command }))
        .then(
          () => {
            if (client.current === instance) mutationFailure.current = false
          },
          (error) => {
            if (client.current === instance) {
              mutationFailure.current = true
              reportError(error)
            }
          }
        )
    },
    [editable, markDirty, reportError]
  )
  const paste = useCallback(
    (point: GridPoint, text: string): void => {
      if (!client.current || !editable) return
      const instance = client.current
      markDirty()
      void commitRef
        .current()
        .then(() =>
          instance.request({ command: 'paste', row: point.row - 1, column: point.column - 1, text })
        )
        .then(
          () => {
            if (client.current === instance) mutationFailure.current = false
          },
          (error) => {
            if (client.current === instance) {
              mutationFailure.current = true
              reportError(error)
            }
          }
        )
    },
    [editable, markDirty, reportError]
  )
  const onSelection = useCallback(
    (selected: PreviewSelection | null): void => {
      if (!props.tabId) return
      const live = controller.getSnapshot()
      const tab = live.tabs[props.tabId]
      const document = tab ? live.sessions[tab.sessionId] : undefined
      if (!document || document.id !== props.sessionId) return
      const bounds = root.current?.getBoundingClientRect()
      const point =
        selected && bounds
          ? {
              x: Math.max(bounds.left + 1, Math.min(bounds.right - 1, selected.rect.right)),
              y: Math.max(bounds.top + 1, Math.min(bounds.bottom - 1, selected.rect.bottom)),
            }
          : undefined
      controller.setSelection(
        props.tabId,
        selected
          ? {
              document_id: document.documentId,
              document_session_id: document.id,
              revision: document.revision,
              status: 'exact',
              text: selected.text,
              locator: selected.locator,
            }
          : null,
        selected ? selectionViewport(selected.rect, point) : undefined
      )
    },
    [controller, props.tabId, props.sessionId]
  )

  const replacement = useMemo(
    () => ({
      id: 'csv-replacement',
      order: 300,
      actions: null,
      expanded: false,
      replaceSelection: editable
        ? async (request: SelectionReplacementRequest) => {
            const live = props.sessionId
              ? controller.getSnapshot().sessions[props.sessionId]
              : undefined
            if (
              !live ||
              !client.current ||
              !live.selection ||
              live.changeVersion !== request.expectedChangeVersion ||
              selectionFingerprint(live.selection) !== request.expectedFingerprint ||
              request.selection.locator.kind !== 'calc'
            )
              return { ok: false as const, error: REPLACEMENT_ERRORS.stale }
            const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(request.selection.locator.range)
            if (!match) return { ok: false as const, error: REPLACEMENT_ERRORS.unsupported }
            const column =
              [...match[1]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1
            const instance = client.current
            try {
              markDirty()
              if (match[1] === match[3] && match[2] === match[4])
                await instance.request({
                  command: 'edit',
                  patches: [{ row: Number(match[2]) - 1, column, value: request.replacement }],
                })
              else
                await instance.request({
                  command: 'paste',
                  row: Number(match[2]) - 1,
                  column,
                  text: request.replacement,
                })
              return client.current === instance
                ? { ok: true as const }
                : { ok: false as const, error: REPLACEMENT_ERRORS.stale }
            } catch (error) {
              if (client.current === instance) reportError(error)
              return { ok: false as const, error: REPLACEMENT_ERRORS.failed }
            }
          }
        : undefined,
    }),
    [editable, controller, props.sessionId, markDirty, reportError]
  )

  const model = useMemo<GridModel | null>(
    () =>
      // A snapshot revision changes owner before the source effect replaces its
      // Worker. Never mount a new Grid with the previous owner's state: it would
      // enqueue reads on a Worker that is being disposed in the same commit.
      state && state.identity === owner && data
        ? {
            id: owner,
            name: props.title.replace(/\.csv$/i, '') || props.title,
            version: state.version,
            geometryVersion: 0,
            rowCount: state.rowCount,
            columnCount: state.columnCount,
            merges: [],
            rowSize: () => CSV_ROW_HEIGHT,
            columnSize: () => CSV_COLUMN_WIDTH,
            cell: (row, column, scale) => ({
              text: data.cells[row - 1 - data.window.row]?.[column - 1 - data.window.column] ?? '',
              style: {
                color: 'var(--vds-text-primary)',
                backgroundColor: 'var(--vds-bg-component)',
                borderRight: '1px solid var(--vds-border-default)',
                borderBottom: '1px solid var(--vds-border-default)',
                padding: '0 var(--vds-space-2)',
                whiteSpace: 'nowrap',
                lineHeight: 'normal',
                fontSize: `calc(var(--vds-font-body-lv1) * ${scale})`,
              },
            }),
            window: (box) => {
              const instance = client.current,
                request = ++generation.current
              if (!instance) return
              void instance
                .request({
                  command: 'readWindow',
                  window: {
                    row: box.top - 1,
                    column: box.left - 1,
                    rows: box.bottom - box.top + 1,
                    columns: box.right - box.left + 1,
                  },
                })
                .then(
                  (response) => {
                    if (
                      request === generation.current &&
                      client.current === instance &&
                      instance.current(response)
                    )
                      setData(response.value as WindowData)
                  },
                  (error) => {
                    if (client.current === instance && request === generation.current)
                      reportError(error)
                  }
                )
            },
            selection: async (box) => {
              const response = await client.current!.request({
                command: 'getRange',
                range: zeroBounds(box),
                limits: { cells: MAX_INLINE_SELECTION_CELLS, chars: CSV_INLINE_CHARACTERS },
              })
              const result = response.value as CsvRangeResult
              const address = `${columnName(result.range.left + 1)}${result.range.top + 1}:${columnName(result.range.right + 1)}${result.range.bottom + 1}`
              return {
                text:
                  result.mode === 'reference'
                    ? `${props.title} · ${props.title.replace(/\.csv$/i, '')}!${address}`
                    : (result.text ?? ''),
                reference: result.mode === 'reference',
                range: address,
              }
            },
            copy: async (box) =>
              (
                (await client.current!.request({ command: 'copy', range: zeroBounds(box) }))
                  .value as { text: string }
              ).text,
            search: async (text, step): Promise<GridSearch> => {
              const instance = client.current!
              const previous = searchCursor.current
              const continued =
                previous && previous.query === text && previous.version === state.version
              const response = await instance.request({
                command: 'search',
                query: text,
                after: continued ? previous.point : null,
                backwards: continued ? step < previous.step : step < 0,
              })
              const result = response.value as CsvSearch
              const index = !result.total
                ? 0
                : continued
                  ? (((previous.index + Math.sign(step - previous.step)) % result.total) +
                      result.total) %
                    result.total
                  : step < 0
                    ? result.total - 1
                    : 0
              searchCursor.current = {
                query: text,
                step,
                version: state.version,
                point: result.current,
                index,
              }
              return {
                total: result.total,
                current: result.total ? index + 1 : 0,
                ...(result.current
                  ? { point: { row: result.current.row + 1, column: result.current.column + 1 } }
                  : {}),
              }
            },
          }
        : null,
    [state, data, owner, props.title, reportError]
  )
  const editorElement = (positions: GridPositions): React.ReactNode =>
    editor && (
      <div
        className="absolute z-[var(--vds-z-local-control)] bg-[var(--vds-bg-component)]"
        style={{
          left: positions.columns[editor.point.column - 1] + ROW_HEADER_WIDTH,
          top: positions.rows[editor.point.row - 1] + DEFAULT_ROW_HEIGHT,
          width: rangeBox(positions, {
            top: editor.point.row,
            bottom: editor.point.row,
            left: editor.point.column,
            right: editor.point.column,
          }).width,
          minHeight: positions.rows[editor.point.row] - positions.rows[editor.point.row - 1],
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onCopy={(event) => event.stopPropagation()}
        onPaste={(event) => event.stopPropagation()}
      >
        <Textarea
          autoFocus
          data-testid="csv-cell-editor"
          aria-label={t('csv.editCell', {
            cell: `${columnName(editor.point.column)}${editor.point.row}`,
          })}
          value={editor.value}
          rows={Math.max(1, editor.value.split('\n').length)}
          className="min-h-0 resize-none rounded-none px-[var(--vds-space-2)] py-0"
          onFocus={(event) => {
            if (editor.value === editor.original) event.currentTarget.select()
          }}
          onChange={(event) => {
            const next = { ...editor, value: event.target.value }
            editorRef.current = next
            setEditor(next)
            markDirty()
          }}
          onBlur={() => {
            void commitRef.current().catch(() => undefined)
          }}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Escape') {
              event.preventDefault()
              editGeneration.current++
              editorRef.current = null
              setEditor(null)
              const instance = client.current
              void instance?.request({ command: 'state' }).catch((error) => {
                if (client.current === instance) reportError(error)
              })
              root.current?.querySelector<HTMLElement>('[data-testid="csv-grid"]')?.focus()
            } else if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
              event.preventDefault()
              void commitRef.current().then(
                () => root.current?.querySelector<HTMLElement>('[data-testid="csv-grid"]')?.focus(),
                () => undefined
              )
            } else if (
              (event.metaKey || event.ctrlKey) &&
              event.key.toLowerCase() === 's' &&
              props.sessionId
            ) {
              event.preventDefault()
              void controller.save(props.sessionId)
            }
          }}
        />
      </div>
    )
  return (
    <div
      ref={root}
      className="flex h-full min-h-0 flex-1 flex-col"
      data-testid="csv-document"
      data-document-revision={props.revision}
      data-document-ready={Boolean(model)}
    >
      {props.tabId && <CsvActions tabId={props.tabId} contribution={replacement} />}
      {state?.sourceEncoding === CSV_ENCODINGS.gbk && (
        <Alert tone="info" title={t('csv.gbkReadonly')} />
      )}
      {failure && (
        <Alert
          tone="warning"
          title={model ? t('csv.failed') : t('csv.openFailed')}
          description={
            failure === 'csv_encoding_invalid'
              ? t('csv.encodingInvalid')
              : failure === 'csv_quotes_invalid'
                ? t('csv.quotesInvalid')
                : undefined
          }
        />
      )}
      {!model ? (
        <div className="p-[var(--vds-space-4)]">
          {failure ? (
            <Button
              onClick={() => {
                source.current = null
                setAttempt((value) => value + 1)
              }}
            >
              {t('officePreview.retry')}
            </Button>
          ) : (
            t('officePreview.loading')
          )}
        </div>
      ) : (
        <Grid
          model={model}
          title={props.title}
          zoom={CSV_INITIAL_ZOOM}
          query=""
          searchStep={0}
          onSearch={() => undefined}
          onSelection={onSelection}
          onError={reportError}
          testId="csv-grid"
          editable={
            editable
              ? { begin, paste, undo: () => mutate('undo'), redo: () => mutate('redo') }
              : undefined
          }
          editor={editorElement}
        />
      )}
      {model && <Sheets names={[model.name]} selected={model.name} onSelect={() => undefined} />}
    </div>
  )
}
