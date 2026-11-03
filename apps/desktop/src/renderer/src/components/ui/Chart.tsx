import { useTranslation } from 'react-i18next'
import {
  forwardRef,
  useId,
  useMemo,
  type ComponentType,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from 'react'

import { createFormatters } from '../../../../localization/format'
import { DEFAULT_LANGUAGE, LOCALES } from '../../../../localization/catalog'
import type { PreferenceLanguage } from '../../../../preferences'
import { cx } from './utils'

const CHART_THEMES = { light: '', dark: '[data-theme="dark"]' } as const
const CHART_CLASS_NAME =
  'vds-chart w-[min(360px,100%)] rounded-[var(--vds-radius-4)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-3)]'
const CHART_BAR_CLASS_NAME = 'vds-chart__bar fill-[var(--vds-brand-6)]'
const CHART_LABEL_CLASS_NAME =
  'vds-chart__label fill-[var(--vds-text-secondary)] text-[length:var(--vds-font-body-lv1)]'
const CHART_CONTAINER_CLASS_NAME = [
  'vds-chart-container flex aspect-video w-full min-w-0 items-center justify-center text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-secondary)]',
  '[&_svg]:max-w-full [&_svg]:outline-none',
  '[&_:is(.recharts-cartesian-axis-tick_text)]:fill-[var(--vds-text-secondary)]',
  '[&_:is(.recharts-cartesian-grid_line,.recharts-curve.recharts-tooltip-cursor,.recharts-reference-line)]:stroke-[var(--vds-border-default)]',
  '[&_:is(.recharts-dot,.recharts-sector)]:stroke-transparent',
  '[&_:is(.recharts-layer,.recharts-sector,.recharts-surface)]:outline-none',
  '[&_:is(.recharts-radial-bar-background-sector,.recharts-rectangle.recharts-tooltip-cursor)]:fill-[var(--vds-surface-muted)]',
].join(' ')
const CHART_TOOLTIP_CLASS_NAME =
  'vds-chart-tooltip grid min-w-32 gap-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] border border-solid border-[color-mix(in_srgb,var(--vds-border-default)_50%,transparent)] bg-[var(--vds-bg-white-default)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-primary)] shadow-[var(--vds-shadow-2-center)]'
const CHART_TOOLTIP_LABEL_CLASS_NAME =
  'vds-chart-tooltip__label font-[var(--vds-fw-medium)] text-[var(--vds-text-primary)]'
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
  'vds-chart-tooltip__name min-w-0 flex-auto text-[var(--vds-text-secondary)]'
const CHART_TOOLTIP_VALUE_CLASS_NAME =
  'vds-chart-tooltip__value flex-none [font-family:var(--vds-font-code)] font-[var(--vds-fw-medium)] text-[var(--vds-text-primary)] tabular-nums'
const CHART_LEGEND_CLASS_NAME =
  'vds-chart-legend flex flex-wrap items-center justify-center gap-[var(--vds-space-4)] text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-secondary)]'
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
  data: ChartDatum[]
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

export function Chart({ className, data, ...props }: ChartProps): JSX.Element {
  const { t } = useTranslation('ui')
  const max = Math.max(...data.map((item) => item.value), 1)
  return (
    <div className={cx(CHART_CLASS_NAME, className)} {...props}>
      <svg aria-label={t('chart.label')} role="img" viewBox="0 0 320 160">
        {data.map((item, index) => {
          const height = (item.value / max) * 120
          const x = 40 + index * 70
          const y = 140 - height
          return (
            <g key={item.label}>
              <rect
                className={CHART_BAR_CLASS_NAME}
                height={height}
                rx="4"
                style={{ fill: item.color }}
                width="36"
                x={x}
                y={y}
              />
              <text className={CHART_LABEL_CLASS_NAME} textAnchor="middle" x={x + 18} y="154">
                {item.label}
              </text>
            </g>
          )
        })}
      </svg>
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

export function ChartStyle({ config, id }: ChartStyleProps): JSX.Element | null {
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

export function ChartTooltip({ children }: { children?: ReactNode }): JSX.Element {
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

export function ChartLegend({ children }: { children?: ReactNode }): JSX.Element {
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
