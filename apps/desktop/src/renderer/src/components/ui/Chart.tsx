import type * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  forwardRef,
  useEffect,
  useId,
  useMemo,
  useRef,
  type ComponentType,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { BarChart as OpenBarChart } from '@openuidev/react-ui/Charts/BarChart'
import { LineChart as OpenLineChart } from '@openuidev/react-ui/Charts/LineChart'
import { PieChart as OpenPieChart } from '@openuidev/react-ui/Charts/PieChart'
import { ThemeProvider } from '@openuidev/react-ui/ThemeProvider'
import { conversationTheme, useConversationMode } from '../../design/conversation'
import '@openuidev/react-ui/components.css'
import { init, type EChartsCoreOption } from 'echarts/core'

import { createFormatters } from '../../../../localization/format'
import { DEFAULT_LANGUAGE, LOCALES } from '../../../../localization/catalog'
import type { PreferenceLanguage } from '../../../../preferences'
import { cx } from './utils'
import { prepareChart, type ChartModel } from './statistics'
import { CHART_PALETTE } from './charting'

const EMPTY_CHART_DATA: ChartDatum[] = []
const OPENUI_CHART_KINDS = new Set<ChartModel['kind']>([
  'bar',
  'grouped-bar',
  'stacked-bar',
  'line',
  'pie',
  'donut',
])
const OPENUI_CATEGORY = 'category'
const CHART_KEYS = { previous: 'ArrowLeft', next: 'ArrowRight', select: 'Enter' } as const
const CHART_ARIA_LIMIT = 20
const CHART_VISIBLE_CATEGORIES = 8

const CHART_THEMES = { light: '', dark: '[data-theme="dark"]' } as const
const CHART_CLASS_NAME =
  'vds-chart @container min-w-0 w-[min(360px,100%)] rounded-[var(--vds-radius-4)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-chart-surface)] p-[var(--vds-space-3)]'
const CHART_CONTAINER_CLASS_NAME = [
  'vds-chart-container flex aspect-video w-full min-w-0 items-center justify-center text-[length:var(--vds-chart-font-size)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-chart-text)]',
  '[&_svg]:max-w-full [&_svg]:outline-none',
  '[&_text]:fill-[var(--vds-chart-text)] [&_text]:text-[length:var(--vds-chart-font-size)]',
  '[&_:is(.recharts-cartesian-grid_line,.recharts-curve.recharts-tooltip-cursor,.recharts-reference-line)]:stroke-[var(--vds-border-default)]',
  '[&_:is(.recharts-dot,.recharts-sector)]:stroke-transparent',
  '[&_:is(.recharts-layer,.recharts-sector,.recharts-surface)]:outline-none',
  '[&_:is(.recharts-radial-bar-background-sector,.recharts-rectangle.recharts-tooltip-cursor)]:fill-[var(--vds-surface-muted)]',
].join(' ')
const CHART_TOOLTIP_CLASS_NAME =
  'vds-chart-tooltip grid min-w-32 gap-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] border border-solid border-[color-mix(in_srgb,var(--vds-border-default)_50%,transparent)] bg-[var(--vds-chart-surface)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-chart-font-size)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-chart-text)] shadow-[var(--vds-shadow-2-center)]'
const CHART_TOOLTIP_LABEL_CLASS_NAME =
  'vds-chart-tooltip__label font-[var(--vds-chart-font-weight)] text-[var(--vds-chart-text)]'
const CHART_TOOLTIP_ITEMS_CLASS_NAME = 'vds-chart-tooltip__items grid gap-[var(--vds-space-2)]'
const CHART_TOOLTIP_ITEM_CLASS_NAME =
  'vds-chart-tooltip__item flex items-center gap-[var(--vds-space-2)]'
const CHART_TOOLTIP_ITEM_INDICATOR_CLASS_NAMES: Record<'dashed' | 'dot' | 'line', string> = {
  dashed: 'vds-chart-tooltip__item--dashed items-stretch',
  dot: 'vds-chart-tooltip__item--dot',
  line: 'vds-chart-tooltip__item--line items-stretch',
}
const CHART_TOOLTIP_INDICATOR_CLASS_NAME =
  'vds-chart-tooltip__indicator size-2.5 flex-none rounded-[2px] border border-solid border-[var(--vds-chart-indicator-color,currentColor)] bg-[var(--vds-chart-indicator-color,currentColor)]'
const CHART_TOOLTIP_INDICATOR_VARIANT_CLASS_NAMES: Record<'dashed' | 'dot' | 'line', string> = {
  dashed: 'w-0 h-auto border-[1.5px] border-dashed bg-transparent',
  dot: '',
  line: 'w-1 h-auto',
}
const CHART_TOOLTIP_NAME_CLASS_NAME =
  'vds-chart-tooltip__name min-w-0 flex-auto text-[var(--vds-chart-text)]'
const CHART_TOOLTIP_VALUE_CLASS_NAME =
  'vds-chart-tooltip__value flex-none [font-family:var(--vds-font-code)] font-[var(--vds-chart-font-weight)] text-[var(--vds-chart-text)] tabular-nums'
const CHART_LEGEND_CLASS_NAME =
  'vds-chart-legend flex flex-wrap items-center justify-center gap-[var(--vds-space-4)] text-[length:var(--vds-chart-font-size)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-chart-text)]'
const CHART_LEGEND_VERTICAL_ALIGN_CLASS_NAMES: Record<'bottom' | 'top', string> = {
  bottom: 'vds-chart-legend--bottom pt-[var(--vds-space-3)]',
  top: 'vds-chart-legend--top pb-[var(--vds-space-3)]',
}
const CHART_LEGEND_ITEM_CLASS_NAME =
  'vds-chart-legend__item inline-flex items-center gap-[var(--vds-space-2)]'
const CHART_LEGEND_ICON_CLASS_NAME =
  'vds-chart-legend__icon size-2 flex-none rounded-[2px] bg-current'

export interface ChartDatum {
  label: string
  value: number
  color?: string
}

export interface ChartProps extends HTMLAttributes<HTMLDivElement> {
  data?: ChartDatum[]
  model?: ChartModel
  onRowSelect?: (ids: string[]) => void
}

export type ChartConfig = Record<
  string,
  {
    label?: ReactNode
    icon?: ComponentType
  } & (
    | { color?: string; theme?: never }
    | { color?: never; theme: Record<keyof typeof CHART_THEMES, string> }
  )
>

export interface ChartPayloadItem {
  color?: string
  dataKey?: string | number
  fill?: string
  name?: string | number
  payload?: Record<string, unknown>
  value?: number | string
}

export interface ChartContainerProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  config: ChartConfig
}

export interface ChartStyleProps {
  config: ChartConfig
  id: string
}

export interface ChartTooltipContentProps extends HTMLAttributes<HTMLDivElement> {
  active?: boolean
  color?: string
  formatter?: (
    value: ChartPayloadItem['value'],
    name: ChartPayloadItem['name'],
    item: ChartPayloadItem,
    index: number,
    payload: ChartPayloadItem[]
  ) => ReactNode
  hideIndicator?: boolean
  hideLabel?: boolean
  indicator?: 'dashed' | 'dot' | 'line'
  label?: ReactNode
  labelClassName?: string
  labelFormatter?: (value: ReactNode, payload: ChartPayloadItem[]) => ReactNode
  labelKey?: string
  nameKey?: string
  payload?: ChartPayloadItem[]
}

export interface ChartLegendContentProps extends HTMLAttributes<HTMLDivElement> {
  hideIcon?: boolean
  nameKey?: string
  payload?: ChartPayloadItem[]
  verticalAlign?: 'bottom' | 'top'
}

function NativeChart({
  model,
  onRowSelect,
  className,
  ...props
}: ChartProps & { model: ChartModel }): React.JSX.Element {
  const { t } = useTranslation('ui')
  const mode = useConversationMode()
  const active = useRef(0)
  const labels = model.y.map((index) => {
    const column = model.dataset.columns[index]
    return column.unit ? `${column.label} (${column.unit})` : column.label || column.key
  })
  const data = model.dataset.rows.map((row) =>
    Object.fromEntries([
      [OPENUI_CATEGORY, String(row.values[model.x] ?? '')],
      ...model.y.map((index, position) => [labels[position], row.values[index] as number]),
    ])
  ) as Record<string, string | number>[]
  const selected = (_row: Record<string, string | number>, index: number): void => {
    const row = model.dataset.rows[index]
    if (row) onRowSelect?.([row.id])
  }
  const shared = {
    data,
    categoryKey: OPENUI_CATEGORY,
    height: 'var(--vds-chart-height)',
    onClick: selected,
  }
  const visualization =
    model.kind === 'line' ? (
      <OpenLineChart {...shared} />
    ) : model.kind === 'pie' || model.kind === 'donut' ? (
      <OpenPieChart {...shared} dataKey={labels[0]} variant={model.kind} />
    ) : (
      <OpenBarChart {...shared} variant={model.kind === 'stacked-bar' ? 'stacked' : 'grouped'} />
    )
  return (
    <ThemeProvider
      mode={mode}
      lightTheme={conversationTheme}
      darkTheme={conversationTheme}
      cssSelector="[data-openui-chart]"
    >
      <div data-openui-chart className={cx(CHART_CLASS_NAME, className)} {...props}>
        <div
          tabIndex={0}
          role="img"
          aria-label={t('chart.label')}
          aria-description={model.dataset.rows
            .slice(0, CHART_ARIA_LIMIT)
            .map((row) => row.values.join(', '))
            .join('; ')}
          onKeyDown={(event) => {
            const count = model.dataset.rows.length
            if (!count) return
            if (event.key === CHART_KEYS.next || event.key === CHART_KEYS.previous) {
              event.preventDefault()
              active.current =
                (active.current + (event.key === CHART_KEYS.next ? 1 : -1) + count) % count
            } else if (event.key === CHART_KEYS.select) {
              event.preventDefault()
              const row = model.dataset.rows[Math.min(active.current, count - 1)]
              onRowSelect?.([row.id])
            }
          }}
        >
          {visualization}
        </div>
      </div>
    </ThemeProvider>
  )
}

export function Chart(props: ChartProps): React.JSX.Element {
  const model = useMemo<ChartModel>(
    () =>
      props.model ?? {
        kind: 'bar',
        x: 0,
        y: [1],
        dataset: {
          columns: [
            { key: 'label', label: '' },
            { key: 'value', label: '' },
          ],
          rows: (props.data ?? EMPTY_CHART_DATA).map((item, index) => ({
            id: String(index),
            values: [item.label, item.value],
          })),
        },
      },
    [props.model, props.data]
  )
  prepareChart(model)
  const labels = model.y.map((index) => {
    const column = model.dataset.columns[index]
    return column.unit ? `${column.label} (${column.unit})` : column.label || column.key
  })
  const native =
    OPENUI_CHART_KINDS.has(model.kind) &&
    new Set(labels).size === labels.length &&
    !labels.includes(OPENUI_CATEGORY) &&
    model.dataset.rows.every((row) => model.y.every((index) => row.values[index] !== null))
  return native ? (
    <NativeChart {...props} model={model} />
  ) : (
    <ExtendedChart {...props} model={model} />
  )
}

function ExtendedChart({
  className,
  data = EMPTY_CHART_DATA,
  model,
  onRowSelect,
  ...props
}: ChartProps): React.JSX.Element {
  const { t } = useTranslation('ui')
  const container = useRef<HTMLDivElement>(null)
  const selection = useRef(onRowSelect)
  selection.current = onRowSelect
  const resolvedModel = useMemo<ChartModel>(
    () =>
      model ?? {
        kind: 'bar',
        x: 0,
        y: [1],
        dataset: {
          columns: [
            { key: 'label', label: '' },
            { key: 'value', label: '' },
          ],
          rows: data.map((item, index) => ({
            id: String(index),
            values: [item.label, item.value],
          })),
        },
      },
    [data, model]
  )
  const prepared = useMemo(
    () => prepareChart(resolvedModel, { frequency: t('chart.frequency') }),
    [resolvedModel, t]
  )
  const description = resolvedModel.dataset.rows
    .slice(0, CHART_ARIA_LIMIT)
    .map((row) =>
      row.values
        .map(
          (value, index) =>
            `${resolvedModel.dataset.columns[index].label}: ${value === null ? t('chart.missingValue') : value}`
        )
        .join(', ')
    )
    .join('; ')
  const remaining = resolvedModel.dataset.rows.length - CHART_ARIA_LIMIT
  const serialized = JSON.stringify({
    ...prepared,
    description: `${description}${remaining > 0 ? t('chart.remainingRows', { count: remaining }) : ''}`,
  })
  useEffect(() => {
    const element = container.current
    if (!element) return
    const current = JSON.parse(serialized) as ReturnType<typeof prepareChart> & {
      description: string
    }
    const instance = init(element, undefined, { renderer: 'svg' })
    const draw = (initial = false): void => {
      const styles = getComputedStyle(element)
      const color = styles.color
      const muted = styles.getPropertyValue('--vds-chart-text').trim()
      const border = styles.getPropertyValue('--vds-border-default').trim()
      const fontSize = parseFloat(styles.getPropertyValue('--vds-chart-font-size'))
      const fontWeight = parseFloat(styles.getPropertyValue('--vds-chart-font-weight'))
      const gap = parseFloat(styles.getPropertyValue('--vds-space-3'))
      const labelWidth = Math.max(
        gap,
        element.clientWidth /
          Math.min(resolvedModel.dataset.rows.length || 1, CHART_VISIBLE_CATEGORIES) -
          gap
      )
      const zoom = resolvedModel.dataset.rows.length > CHART_VISIBLE_CATEGORIES
      const palette = CHART_PALETTE.map((token) => styles.getPropertyValue(token).trim()).filter(
        Boolean
      )
      instance.setOption(
        {
          ...(initial ? current.option : {}),
          aria: { enabled: true, label: { description: current.description } },
          color: palette.length ? palette : [color],
          textStyle: { color: muted, fontSize, fontWeight, fontFamily: styles.fontFamily },
          backgroundColor: 'transparent',
          tooltip: {
            ...(initial ? current.option.tooltip : {}),
            backgroundColor: styles.getPropertyValue('--vds-chart-surface').trim(),
            borderColor: border,
            textStyle: { color: muted, fontSize, fontWeight, fontFamily: styles.fontFamily },
          },
          legend: {
            ...(initial ? current.option.legend : {}),
            left: 0,
            right: 0,
            textStyle: { color: muted, fontSize, fontWeight },
            pageTextStyle: { color: muted, fontSize, fontWeight },
          },
          ...('visualMap' in current.option
            ? {
                visualMap: {
                  ...(initial ? current.option.visualMap : {}),
                  textStyle: { color: muted, fontSize, fontWeight },
                  inRange: {
                    color: [
                      '--vds-chart-heat-low',
                      '--vds-chart-heat-mid',
                      '--vds-chart-heat-high',
                    ].map((token) => styles.getPropertyValue(token).trim()),
                  },
                },
              }
            : {}),
          ...('xAxis' in current.option
            ? {
                grid: {
                  left: gap,
                  right: gap,
                  top: gap * 4,
                  bottom: gap * (zoom || 'visualMap' in current.option ? 7 : 4),
                  containLabel: true,
                },
                xAxis: {
                  ...(initial ? current.option.xAxis : {}),
                  nameLocation: 'middle',
                  nameGap: gap * 3,
                  nameTextStyle: {
                    color: muted,
                    fontSize,
                    fontWeight,
                    width: element.clientWidth - gap * 2,
                    overflow: 'truncate',
                  },
                  axisLabel: {
                    color: muted,
                    fontSize,
                    fontWeight,
                    width: labelWidth,
                    overflow: 'truncate',
                    hideOverlap: true,
                  },
                  axisLine: { lineStyle: { color: border } },
                  splitLine: { lineStyle: { color: border, type: 'dashed' } },
                  axisPointer: { label: { color: muted, fontSize } },
                },
                yAxis: {
                  ...(initial ? current.option.yAxis : {}),
                  nameTextStyle: { color: muted, fontSize, fontWeight },
                  axisLabel: { color: muted, fontSize, fontWeight },
                  axisLine: { lineStyle: { color: border } },
                  splitLine: { lineStyle: { color: border, type: 'dashed' } },
                  axisPointer: { label: { color: muted, fontSize } },
                },
              }
            : {}),
          ...('dataZoom' in current.option
            ? {
                dataZoom: [
                  { type: 'inside' },
                  {
                    type: 'slider',
                    show: zoom,
                    bottom: 0,
                    textStyle: { color: muted, fontSize },
                    borderColor: border,
                    backgroundColor: styles.getPropertyValue('--vds-chart-surface').trim(),
                    fillerColor: styles.getPropertyValue('--vds-chart-zoom-fill').trim(),
                    dataBackground: {
                      lineStyle: { color: border },
                      areaStyle: { color: border },
                    },
                    selectedDataBackground: {
                      lineStyle: { color: palette[0] },
                      areaStyle: { color: palette[0] },
                    },
                    handleStyle: { color: palette[0], borderColor: palette[0] },
                    moveHandleStyle: { color: palette[0] },
                    emphasis: {
                      handleStyle: { color: palette[0] },
                      moveHandleStyle: { color: palette[0] },
                    },
                  },
                ],
              }
            : {}),
          series: current.option.series.map((series) => ({
            ...(initial ? series : {}),
            type: series.type,
            label: { color: muted, fontSize, fontWeight },
            emphasis: { label: { color: muted, fontSize, fontWeight } },
            ...(series.type === 'boxplot'
              ? {
                  itemStyle: {
                    color: styles.getPropertyValue('--vds-chart-surface').trim(),
                    borderColor: palette[0],
                  },
                }
              : {}),
            ...(series.type === 'bar'
              ? { barMaxWidth: parseFloat(styles.getPropertyValue('--vds-chart-bar-max-width')) }
              : {}),
            ...(series.type === 'pie'
              ? {
                  label: {
                    color: muted,
                    fontSize,
                    fontWeight,
                    width: element.clientWidth / 5,
                    overflow: 'truncate',
                  },
                }
              : {}),
          })),
        } as EChartsCoreOption,
        initial
      )
    }
    draw(true)
    const resize = new ResizeObserver(() => {
      if (element.clientWidth) {
        instance.resize()
        draw()
      }
    })
    resize.observe(element)
    const theme = new MutationObserver(() => draw())
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    })
    instance.on('click', (event: { dataIndex?: number }) => {
      if (event.dataIndex !== undefined) selection.current?.(current.members[event.dataIndex] ?? [])
    })
    let active = 0
    const keydown = (event: KeyboardEvent): void => {
      if (!current.members.length) return
      if (event.key === CHART_KEYS.previous || event.key === CHART_KEYS.next) {
        event.preventDefault()
        active =
          (active + (event.key === CHART_KEYS.next ? 1 : -1) + current.members.length) %
          current.members.length
        instance.dispatchAction({ type: 'downplay' })
        instance.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: active })
        instance.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: active })
      } else if (event.key === CHART_KEYS.select) {
        event.preventDefault()
        selection.current?.(current.members[active])
      }
    }
    element.addEventListener('keydown', keydown)
    return () => {
      resize.disconnect()
      theme.disconnect()
      element.removeEventListener('keydown', keydown)
      instance.dispose()
    }
  }, [serialized, resolvedModel.dataset.rows.length])
  return (
    <div className={cx(CHART_CLASS_NAME, className)} {...props}>
      <div
        ref={container}
        tabIndex={0}
        role="img"
        aria-label={t('chart.label')}
        className="h-[var(--vds-chart-height)] w-full text-[length:var(--vds-chart-font-size)] text-[var(--vds-chart-text)]"
      />
    </div>
  )
}

export const ChartContainer = forwardRef<HTMLDivElement, ChartContainerProps>(
  ({ children, className, config, id, ...props }, ref) => {
    const uniqueId = useId()
    const chartId = `chart-${id || uniqueId.replace(/:/g, '')}`

    return (
      <div
        className={cx(CHART_CONTAINER_CLASS_NAME, className)}
        data-chart={chartId}
        ref={ref}
        {...props}
      >
        <ChartStyle config={config} id={chartId} />
        {children}
      </div>
    )
  }
)

ChartContainer.displayName = 'Chart'

export function ChartStyle({ config, id }: ChartStyleProps): React.JSX.Element | null {
  const colorConfig = Object.entries(config).filter(
    ([, itemConfig]) => itemConfig.theme || itemConfig.color
  )
  if (!colorConfig.length) return null

  return (
    <style
      dangerouslySetInnerHTML={{
        __html: Object.entries(CHART_THEMES)
          .map(([theme, prefix]) => {
            const variables = colorConfig
              .map(([key, itemConfig]) => {
                const color =
                  itemConfig.theme?.[theme as keyof typeof itemConfig.theme] || itemConfig.color
                return color ? `  --color-${key}: ${color};` : null
              })
              .filter(Boolean)
              .join('\n')
            return `${prefix} [data-chart=${id}] {\n${variables}\n}`
          })
          .join('\n'),
      }}
    />
  )
}

export function ChartTooltip({ children }: { children?: ReactNode }): React.JSX.Element {
  return <>{children}</>
}

export const ChartTooltipContent = forwardRef<HTMLDivElement, ChartTooltipContentProps>(
  (
    {
      active,
      className,
      color,
      formatter,
      hideIndicator = false,
      hideLabel = false,
      indicator = 'dot',
      label,
      labelClassName,
      labelFormatter,
      labelKey,
      nameKey,
      payload,
      ...props
    },
    ref
  ) => {
    const { i18n } = useTranslation('ui')
    const language = i18n.resolvedLanguage ?? DEFAULT_LANGUAGE
    const format = createFormatters(
      Object.prototype.hasOwnProperty.call(LOCALES, language)
        ? (language as PreferenceLanguage)
        : DEFAULT_LANGUAGE
    )
    const items = payload ?? []
    const tooltipLabel = useMemo(() => {
      if (hideLabel || !items.length) return null
      const value = labelKey ? getPayloadValue(items[0], labelKey) : label
      const resolvedLabel = labelFormatter ? labelFormatter(value, items) : value
      return resolvedLabel ? (
        <div className={cx(CHART_TOOLTIP_LABEL_CLASS_NAME, labelClassName)}>{resolvedLabel}</div>
      ) : null
    }, [hideLabel, items, label, labelClassName, labelFormatter, labelKey])

    if (!active || !items.length) return null

    return (
      <div className={cx(CHART_TOOLTIP_CLASS_NAME, className)} ref={ref} {...props}>
        {tooltipLabel}
        <div className={CHART_TOOLTIP_ITEMS_CLASS_NAME}>
          {items.map((item, index) => {
            const name = nameKey ? getPayloadValue(item, nameKey) : item.name
            const itemColor = color || item.fill || item.color
            return (
              <div
                className={cx(
                  CHART_TOOLTIP_ITEM_CLASS_NAME,
                  CHART_TOOLTIP_ITEM_INDICATOR_CLASS_NAMES[indicator]
                )}
                key={`${String(item.dataKey ?? name ?? index)}`}
              >
                {formatter ? (
                  formatter(item.value, item.name, item, index, items)
                ) : (
                  <>
                    {!hideIndicator ? (
                      <span
                        className={cx(
                          CHART_TOOLTIP_INDICATOR_CLASS_NAME,
                          CHART_TOOLTIP_INDICATOR_VARIANT_CLASS_NAMES[indicator]
                        )}
                        style={{ '--vds-chart-indicator-color': itemColor } as CSSProperties}
                      />
                    ) : null}
                    <span className={CHART_TOOLTIP_NAME_CLASS_NAME}>{name}</span>
                    {item.value === undefined ? null : (
                      <span className={CHART_TOOLTIP_VALUE_CLASS_NAME}>
                        {typeof item.value === 'number' ? format.number(item.value) : item.value}
                      </span>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
  }
)

ChartTooltipContent.displayName = 'ChartTooltip'

export function ChartLegend({ children }: { children?: ReactNode }): React.JSX.Element {
  return <>{children}</>
}

export const ChartLegendContent = forwardRef<HTMLDivElement, ChartLegendContentProps>(
  ({ className, hideIcon = false, nameKey, payload, verticalAlign = 'bottom', ...props }, ref) => {
    const items = payload ?? []
    if (!items.length) return null

    return (
      <div
        className={cx(
          CHART_LEGEND_CLASS_NAME,
          CHART_LEGEND_VERTICAL_ALIGN_CLASS_NAMES[verticalAlign],
          className
        )}
        ref={ref}
        {...props}
      >
        {items.map((item, index) => {
          const name = nameKey ? getPayloadValue(item, nameKey) : item.value
          return (
            <div
              className={CHART_LEGEND_ITEM_CLASS_NAME}
              key={`${String(item.dataKey ?? name ?? index)}`}
            >
              {!hideIcon ? (
                <span
                  className={CHART_LEGEND_ICON_CLASS_NAME}
                  style={{ backgroundColor: item.color || item.fill }}
                />
              ) : null}
              <span>{name}</span>
            </div>
          )
        })}
      </div>
    )
  }
)

ChartLegendContent.displayName = 'ChartLegend'

function getPayloadValue(item: ChartPayloadItem, key: string): ReactNode {
  const ownValue = item[key as keyof ChartPayloadItem]
  if (typeof ownValue === 'string' || typeof ownValue === 'number') return ownValue
  const payloadValue = item.payload?.[key]
  if (typeof payloadValue === 'string' || typeof payloadValue === 'number') return payloadValue
  return item.name
}
