import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useApp } from '../../../store'
import { Pending } from '../../../shell/Pending'
import { fetchResourceContent } from '../../resources/api'

/** 最多渲染的行数，防止十万行 CSV 卡死渲染进程。 */
const MAX_ROWS = 500

/** xlsx 是二进制格式，与 csv 不是同一条解析路径。 */
const BINARY_SUFFIXES = ['.xlsx', '.xls']

/**
 * 解析 CSV/TSV 一行，支持双引号包裹与转义。
 *
 * 手写而非引第三方：只读预览用不到方言配置与流式解析，
 * 而 `split(',')` 会在带引号的字段上出错（实验数据里逗号很常见）。
 */
function parseRow(line: string, delimiter: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (quoted) {
      if (char === '"') {
        // 连续两个引号是一个字面量引号。
        if (line[i + 1] === '"') {
          cell += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        cell += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === delimiter) {
      cells.push(cell)
      cell = ''
    } else {
      cell += char
    }
  }
  cells.push(cell)
  return cells
}

/**
 * 表格只读预览（PRD「用户会使用 Excel 或在线表格记录实验数据…
 * 同时需要查看实验程序导出的 .csv 数据文件」）。
 *
 * csv/tsv 走真实解析并渲染；xlsx/xls 是压缩二进制，需要 SheetJS 一类的解包器，
 * 属独立依赖与复杂度，本期显式占位而不是渲染一堆乱码。
 */
export function TableViewer({
  path,
  project
}: {
  path: string
  project?: string | null
}): React.JSX.Element {
  const { act } = useApp()
  const { t } = useTranslation('workbench')
  const [rows, setRows] = useState<string[][] | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [truncated, setTruncated] = useState(false)

  const lower = path.toLowerCase()
  const binary = BINARY_SUFFIXES.some((suffix) => lower.endsWith(suffix))

  useEffect(() => {
    if (binary) return
    let cancelled = false
    setLoadState('loading')
    void fetchResourceContent(path, project).then((text) => {
      if (cancelled) return
      if (text === null) {
        setLoadState('error')
        return
      }
      const delimiter = lower.endsWith('.tsv') ? '\t' : ','
      const lines = text.split(/\r?\n/).filter((line) => line.length > 0)
      setTruncated(lines.length > MAX_ROWS)
      setRows(lines.slice(0, MAX_ROWS).map((line) => parseRow(line, delimiter)))
      setLoadState('ready')
    })
    return () => {
      cancelled = true
    }
  }, [path, project, binary, lower])

  if (binary) {
    return (
      <Pending
        feature={t('table.binaryTitle')}
        owner={t('table.owner')}
        detail={t('table.binaryHint')}
      />
    )
  }
  if (loadState === 'loading') return <div className="vds-viewer-empty">{t('table.loading', { path })}</div>
  if (loadState === 'error') {
    return <div className="vds-viewer-empty">{t('table.unavailable')}</div>
  }

  const [head, ...body] = rows ?? []

  return (
    <div className="vds-table-view" data-testid="table-viewer">
      <div className="vds-viewer-bar">
        <span className="vds-viewer-path">{path}</span>
        <span className="vds-viewer-meta">
          {truncated ? t('table.limited', { total: rows?.length ?? 0, limit: MAX_ROWS }) : t('table.rows', { total: rows?.length ?? 0 })}
        </span>
        <div className="vds-viewer-tools">
          <button
            type="button"
            className="vds-btn"
            data-testid="table-ask-ai"
            title={t('table.askHint')}
            onClick={() =>
              act.askAiFromPanel(t('table.analysisDraft', { path }))
            }
          >
            {t('table.ask')}
          </button>
        </div>
      </div>
      <div className="vds-table-body">
        <table>
          <thead>
            <tr>
              {(head ?? []).map((cell, index) => (
                <th key={`h-${index}`}>{cell}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, r) => (
              <tr key={`r-${r}`}>
                {row.map((cell, c) => (
                  <td key={`r-${r}c-${c}`}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
