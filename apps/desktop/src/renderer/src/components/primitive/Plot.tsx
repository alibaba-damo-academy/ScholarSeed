import React, { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Alert,
  AlertDescription,
  Chart,
  CopyButton,
  IconButton,
  captureChartSVG,
  type ChartExportRequest,
  type ChartExporter,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '../ui'
import { Check, Copy, Download } from 'lucide-react'
import { datasetTSV, prepareChart, type ChartModel, type Dataset } from '../ui/statistics'
import { DataTable } from './DataTable'
import { Code } from './Code'
import { CARD_HEADER, CARD_ACTIONS, CARD_TABS, CARD_TAB } from './utils'

export const PlotExportContext = createContext<ChartExporter | undefined>(undefined)
export const PlotCopyContext = createContext<ChartExporter | undefined>(undefined)

export interface PlotProps {
  model: ChartModel
  title?: string
  notes?: string
  sources?: string[]
  script?: string
  version?: string
  onExport?: ChartExporter
  selected?: string[]
  onSelectionChange?: (ids: string[]) => void
  onCopy?: (text: string) => Promise<void>
  framed?: boolean
}

export interface PlotFrameProps extends Omit<PlotProps, 'model'> {
  dataset: Dataset
  model?: ChartModel
  children: ReactNode
  summary?: ReactNode
}

export function PlotFrame({
  dataset,
  model,
  children,
  summary,
  title,
  notes,
  sources,
  script,
  version,
  onExport,
  selected = [],
  onSelectionChange,
  onCopy,
  framed = true,
}: PlotFrameProps): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const [showData, setShowData] = useState(false)
  const hostExport = useContext(PlotExportContext)
  const copyImage = useContext(PlotCopyContext)
  const exporter = model ? (onExport ?? hostExport) : undefined
  const figure = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLSpanElement>(null)
  const lastFigure = useRef<{ model: ChartModel; snapshot: ChartExportRequest | null }>(null)
  const captureFigure = (): ChartExportRequest | null =>
    figure.current ? captureChartSVG(figure.current, heading.current) : null
  const [exporting, setExporting] = useState(false)
  const exportingRef = useRef(false)
  const [exportMessage, setExportMessage] = useState('')
  const [exportFailed, setExportFailed] = useState(false)
  const exportSVG = async (): Promise<void> => {
    if (!model || !exporter || exportingRef.current) return
    exportingRef.current = true
    setExporting(true)
    setExportMessage('')
    setExportFailed(false)
    try {
      const snapshot = showData
        ? lastFigure.current?.model === model
          ? lastFigure.current.snapshot
          : null
        : captureFigure()
      if (!snapshot) throw new Error('plot_export_invalid')
      const result = await exporter(snapshot)
      if (!result.ok && !result.canceled) throw new Error(result.error)
      setExportMessage(t(result.canceled ? 'plot.exportCanceled' : 'plot.exportSuccess'))
    } catch {
      setExportFailed(true)
      setExportMessage(t('plot.exportFailed'))
    } finally {
      exportingRef.current = false
      setExporting(false)
    }
  }
  return (
    <div
      data-testid="conversation-plot"
      className="grid w-full min-w-0 max-w-[var(--vds-layout-reading-width)] gap-[var(--vds-space-2)]"
    >
      <Tabs
        value={showData ? 'data' : 'figure'}
        onValueChange={(value) => {
          if (value === 'data' && model && exporter && !showData) {
            lastFigure.current = { model, snapshot: captureFigure() }
          }
          setShowData(value === 'data')
        }}
        className={
          framed
            ? 'group/conversation-card !block min-w-0 overflow-hidden rounded-[var(--vds-radius-6)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-chart-surface)]'
            : 'group/conversation-card !block min-w-0 bg-[var(--vds-chart-surface)]'
        }
      >
        <div data-testid="plot-header" className={CARD_HEADER}>
          {title && framed ? (
            <span
              ref={heading}
              title={title}
              className="min-w-0 truncate font-[var(--vds-fw-regular)]"
            >
              {title}
            </span>
          ) : null}
          <div className={CARD_ACTIONS}>
            <TabsList className={CARD_TABS}>
              <TabsTrigger className={CARD_TAB} value="figure" aria-label={t('plot.figure')}>
                {t('plot.figureTab')}
              </TabsTrigger>
              <TabsTrigger className={CARD_TAB} value="data" aria-label={t('plot.data')}>
                {t('plot.dataTab')}
              </TabsTrigger>
            </TabsList>
            {(showData ? onCopy : model && copyImage) ? (
              <CopyButton
                key={showData ? 'data' : 'figure'}
                iconOnly
                icon={<Copy />}
                copiedIcon={<Check />}
                tooltip
                idleLabel={showData ? t('plot.copyData') : t('plot.copyImage')}
                value={showData ? datasetTSV(dataset) : undefined}
                writeText={showData ? onCopy : undefined}
                copy={
                  showData
                    ? undefined
                    : async () => {
                        const snapshot = captureFigure()
                        if (!snapshot || !copyImage || !(await copyImage(snapshot)).ok) {
                          throw new Error('plot_copy_failed')
                        }
                      }
                }
                size="xs"
                variant="ghostIcon"
              />
            ) : null}
            {exporter ? (
              <IconButton
                size="xs"
                variant="ghostIcon"
                icon={<Download />}
                label={t('plot.exportSVG')}
                aria-busy={exporting}
                aria-disabled={exporting}
                onClick={() => void exportSVG()}
              />
            ) : null}
          </div>
        </div>
        {exportMessage ? (
          <p
            role={exportFailed ? 'alert' : 'status'}
            className="m-0 px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]"
          >
            {exportMessage}
          </p>
        ) : null}
        <TabsContent
          value="data"
          className="min-w-0 text-[length:var(--vds-chart-font-size)] font-[var(--vds-chart-font-weight)] text-[var(--vds-chart-text)] [&_:is(th,td,button,p,span)]:!text-[length:var(--vds-chart-font-size)] [&_:is(th,td,button,p,span)]:!font-[var(--vds-chart-font-weight)] [&_:is(th,td,button,p,span)]:!text-[var(--vds-chart-text)]"
        >
          <DataTable
            framed={false}
            paginate={false}
            dataset={dataset}
            selected={selected}
            onSelectionChange={onSelectionChange}
            rowSelectionMode="row"
            filterable={false}
            onCopy={onCopy}
          />
        </TabsContent>
        <TabsContent ref={figure} value="figure" className="min-w-0 p-[var(--vds-space-3)]">
          {children}
        </TabsContent>
        {notes ? (
          <p
            data-testid="plot-notes"
            className="m-0 whitespace-pre-wrap border-t border-solid border-[var(--vds-border-default)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-chart-font-size)] font-[var(--vds-chart-font-weight)] text-[var(--vds-chart-text)]"
          >
            {notes}
          </p>
        ) : null}
      </Tabs>
      {onSelectionChange ? (
        <p
          role="status"
          className="m-0 text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]"
        >
          {t('plot.selected', { count: selected.length })}
        </p>
      ) : null}
      {summary}
      {sources?.length ? (
        <div className="whitespace-pre-wrap break-words text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]">
          {t('plot.sources')}: {sources.join('\n')}
        </div>
      ) : null}
      {script ? (
        <p className="break-all">
          {t('plot.script')}: {script}
        </p>
      ) : null}
      {version ? (
        <p className="break-all">
          {t('plot.version')}: {version}
        </p>
      ) : null}
    </div>
  )
}

export function Plot({
  model,
  selected = [],
  onSelectionChange,
  ...props
}: PlotProps): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const invalid = useMemo(() => {
    try {
      prepareChart(model)
      return false
    } catch {
      return true
    }
  }, [model])
  if (invalid)
    return (
      <>
        <Alert tone="error">
          <AlertDescription>{t('plot.invalid')}</AlertDescription>
        </Alert>
        <Code code={JSON.stringify(model, null, 2)} language="json" onCopy={props.onCopy} />
      </>
    )
  return (
    <PlotFrame
      {...props}
      model={model}
      dataset={model.dataset}
      selected={selected}
      onSelectionChange={onSelectionChange}
      summary={
        model.kind === 'histogram' ? (
          <p>
            {t('plot.bins', {
              count: model.bins ?? Math.max(1, Math.ceil(Math.sqrt(model.dataset.rows.length))),
            })}
          </p>
        ) : undefined
      }
    >
      <Chart
        className="!w-full !border-0 !bg-transparent !p-0"
        model={model}
        onRowSelect={
          onSelectionChange
            ? (ids) => onSelectionChange([...new Set([...selected, ...ids])])
            : undefined
        }
      />
    </PlotFrame>
  )
}

type TypedPlotProps = Omit<PlotProps, 'model'> & { model: Omit<ChartModel, 'kind'> }
export function BarChart(props: TypedPlotProps): React.JSX.Element {
  return <Plot {...props} model={{ ...props.model, kind: 'bar' }} />
}
export function GroupedBarChart(props: TypedPlotProps): React.JSX.Element {
  return <Plot {...props} model={{ ...props.model, kind: 'grouped-bar' }} />
}
export function StackedBarChart(props: TypedPlotProps): React.JSX.Element {
  return <Plot {...props} model={{ ...props.model, kind: 'stacked-bar' }} />
}
export function LineChart(props: TypedPlotProps): React.JSX.Element {
  return <Plot {...props} model={{ ...props.model, kind: 'line' }} />
}
export function ScatterChart(props: TypedPlotProps): React.JSX.Element {
  return <Plot {...props} model={{ ...props.model, kind: 'scatter' }} />
}
export function PieChart(props: TypedPlotProps): React.JSX.Element {
  return <Plot {...props} model={{ ...props.model, kind: 'pie' }} />
}
export function DonutChart(props: TypedPlotProps): React.JSX.Element {
  return <Plot {...props} model={{ ...props.model, kind: 'donut' }} />
}
export function Histogram(props: TypedPlotProps): React.JSX.Element {
  return <Plot {...props} model={{ ...props.model, kind: 'histogram' }} />
}
export function BoxPlot(props: TypedPlotProps): React.JSX.Element {
  return <Plot {...props} model={{ ...props.model, kind: 'boxplot' }} />
}
export function Heatmap(props: TypedPlotProps): React.JSX.Element {
  return <Plot {...props} model={{ ...props.model, kind: 'heatmap' }} />
}
