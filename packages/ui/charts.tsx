import React, { createContext, useContext, type ReactNode } from 'react'
import { defineComponent, type DefinedComponent } from '@openuidev/react-lang'
import { z } from 'zod/v4'
import type { Dataset } from '../../apps/desktop/src/renderer/src/components/ui/statistics'

export interface ConversationChartProps {
  data: ChartData
  title?: string
  horizontal: boolean
  children: ReactNode
}
export const ConversationChartContext = createContext<React.ComponentType<ConversationChartProps> | null>(null)

export const CONVERSATION_CHARTS = [
  'BarChart', 'LineChart', 'AreaChart', 'HorizontalBarChart', 'ScatterChart',
  'PieChart', 'RadialChart', 'SingleStackedBarChart', 'RadarChart',
] as const

interface Series {
  category: string
  values: number[]
}
interface Point {
  x: number
  y: number
  z?: number
}
interface ScatterSeries {
  name: string
  points: (Point | { type: 'element'; props: Point })[]
}
interface ChartData {
  maximum?: number
  labels?: string[]
  values?: number[]
  series?: (Series | { type: 'element'; props: Series })[]
  datasets?: (ScatterSeries | { type: 'element'; props: ScatterSeries })[]
  xLabel?: string
  yLabel?: string
}

const PROGRESS_SCALE = 100
const RADIAL_GEOMETRY = { center: 50, radius: 40, width: 8, rotation: -90 } as const

export function radialProgress(values: number[], maximum: number): number[] {
  if (!Number.isFinite(maximum) || maximum <= 0 ||
      values.some(value => !Number.isFinite(value) || value < 0 || value > maximum))
    throw new Error('chart_radial_domain')
  return values.map(value => value / maximum * PROGRESS_SCALE)
}

function RadialProgress({ labels = [], values = [], maximum }: ChartData & { maximum: number }) {
  const percentages = radialProgress(values, maximum)
  return <div className="flex min-w-0 flex-wrap justify-center gap-[var(--vds-space-4)]">
    {values.map((value, index) => <div key={index} className="grid min-w-0 justify-items-center gap-[var(--vds-space-2)]">
      <svg viewBox={`0 0 ${PROGRESS_SCALE} ${PROGRESS_SCALE}`} role="img"
        aria-label={`${labels[index] ?? ''}: ${value} / ${maximum} (${percentages[index]}%)`}
        className="h-[var(--vds-chart-height)] max-w-full">
        <circle cx={RADIAL_GEOMETRY.center} cy={RADIAL_GEOMETRY.center} r={RADIAL_GEOMETRY.radius}
          fill="none" stroke="var(--vds-border-default)" strokeWidth={RADIAL_GEOMETRY.width} />
        <circle cx={RADIAL_GEOMETRY.center} cy={RADIAL_GEOMETRY.center} r={RADIAL_GEOMETRY.radius}
          fill="none" stroke="var(--vds-chart-series-1)" strokeWidth={RADIAL_GEOMETRY.width}
          pathLength={PROGRESS_SCALE} strokeDasharray={`${percentages[index]} ${PROGRESS_SCALE}`}
          transform={`rotate(${RADIAL_GEOMETRY.rotation} ${RADIAL_GEOMETRY.center} ${RADIAL_GEOMETRY.center})`} />
      </svg>
      <span>{labels[index]}: {value} / {maximum} ({Number(percentages[index].toFixed(1))}%)</span>
    </div>)}
  </div>
}

function unwrap<Value>(value: Value | { type: 'element'; props: Value }): Value {
  return value && typeof value === 'object' && 'type' in value && value.type === 'element' && 'props' in value
    ? value.props : value as Value
}

export function chartDataset(props: ChartData, labels: { category: string; value: string; series: string }, horizontal = false): Dataset {
  if (props.datasets) {
    const series = props.datasets.map(unwrap)
    const points = series.flatMap(item => item.points.map(point => ({ series: item.name, ...unwrap(point) })))
    const hasZ = points.some(point => point.z !== undefined)
    return {
      columns: [
        { key: 'series', label: labels.series },
        { key: 'x', label: props.xLabel || 'x' },
        { key: 'y', label: props.yLabel || 'y' },
        ...(hasZ ? [{ key: 'z', label: 'z' }] : []),
      ],
      rows: points.map((point, index) => ({ id: String(index),
        values: [point.series, point.x, point.y, ...(hasZ ? [point.z ?? null] : [])] })),
    }
  }
  const categories = props.labels ?? []
  const categoryLabel = horizontal ? props.yLabel : props.xLabel
  const valueLabel = horizontal ? props.xLabel : props.yLabel
  const series = props.series?.map(unwrap) ?? [{ category: valueLabel || labels.value, values: props.values ?? [] }]
  const count = Math.max(categories.length, ...series.map(item => item.values.length))
  return {
    columns: [{ key: 'category', label: categoryLabel || labels.category },
      ...series.map((item, index) => ({ key: `series-${index}`, label: item.category })),
      ...(props.maximum === undefined ? [] : [{ key: 'maximum', label: 'Maximum' }])],
    rows: Array.from({ length: count }, (_, index) => ({ id: String(index),
      values: [categories[index] ?? null, ...series.map(item => item.values[index] ?? null),
        ...(props.maximum === undefined ? [] : [props.maximum])] })),
  }
}

export function framedChart(definition: DefinedComponent<z.ZodObject>) {
  const Original = definition.component
  return defineComponent({
    name: definition.name,
    props: definition.props.extend({ title: z.string().optional(),
      ...(definition.name === 'RadialChart' ? { maximum: z.number().positive().optional() } : {}) }),
    description: `${definition.description} Optional title labels the shared figure/data and source-copy header.${definition.name === 'RadialChart' ? ' For fixed-target progress, supply maximum after title: RadialChart(labels, values, title, maximum); each arc and percentage uses that denominator, not the sum or largest value. Without maximum this is a relative category comparison, never absolute progress.' : ''}`,
    component: context => {
      const Frame = useContext(ConversationChartContext)
      const props = context.props as ChartData & { title?: string }
      const chart = definition.name === 'RadialChart' && props.maximum !== undefined
        ? <RadialProgress {...props} maximum={props.maximum} /> : <Original {...context} />
      if (!Frame) return chart
      return <Frame data={props} title={props.title} horizontal={definition.name === 'HorizontalBarChart'}>
        {chart}
      </Frame>
    },
  })
}
