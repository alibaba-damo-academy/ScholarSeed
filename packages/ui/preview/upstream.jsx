import React from 'react'
import { useTranslation } from 'react-i18next'
import { createLibrary, defineComponent, Renderer } from '@openuidev/react-lang'
import { openuiLibrary, ThemeProvider } from '@openuidev/react-ui'
import { jsonToOpenUI } from '@openuidev/lang-core'
import { z } from 'zod/v4'
import { nativeEntries } from './native.mjs'
import { generate } from './schema.mjs'
import { createUpstreamExamples } from './samples/upstream.mjs'
import { conversationTheme, useConversationMode } from '../../../apps/desktop/src/renderer/src/design/conversation'
import sampleImage from '../../../apps/desktop/src/renderer/src/assets/banner2.webp'
import { Button } from '../controls'
import { Canvas } from '../../../apps/desktop/src/renderer/src/components/primitive/Canvas'

const ROOT = 'OpenUIPreview'
const Wrapper = defineComponent({
  name: ROOT,
  props: z.object({ children: z.array(z.unknown()) }),
  component: ({ props, renderNode }) => <div className="grid min-w-0 gap-[var(--vds-space-4)]">{renderNode(props.children)}</div>,
})

export const upstreamLibrary = createLibrary({
  id: 'openui-inspection', root: ROOT,
  components: [Wrapper, ...Object.values(openuiLibrary.components)],
  componentGroups: openuiLibrary.componentGroups,
  actions: [],
})

function initialData(value) {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(initialData)
  const result = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, initialData(child)]))
  for (const key of ['src', 'bgImageSrc']) if (key in result) result[key] = sampleImage
  if (result.typeName === 'DatePicker') result.props.value = '2026-01-15'
  return result
}

export const upstreamExamples = createUpstreamExamples(sampleImage)

export const upstreamEntries = nativeEntries(upstreamLibrary, []).map(entry => {
  if (upstreamExamples[entry.name]) return { ...entry, initial: upstreamExamples[entry.name][0].data }
  const initial = initialData(generate(entry.schema, entry.name, {}))
  if (entry.name === 'DatePicker') initial.value = '2026-01-15'
  if (entry.name === 'CardHeader') Object.assign(initial, { title: 'OpenUI', subtitle: 'Component inspection' })
  if (entry.name === 'TextCallout') Object.assign(initial, { title: 'OpenUI', description: 'Component inspection' })
  if (entry.name === 'InlineHeader') Object.assign(initial, { heading: 'OpenUI', description: 'Component inspection' })
  if (entry.name === 'Icon') initial.name = 'circle-check'
  for (const key of ['fields', 'rows', 'items']) {
    if (Array.isArray(initial[key]) && !initial[key].length && entry.schema.properties[key]?.items)
      initial[key] = Array.from({ length: 3 }, (_, index) => initialData(generate(entry.schema.properties[key].items, `${entry.name}:${index}`, {})))
  }
  if (entry.name === 'CodeBlock') Object.assign(initial, { language: 'javascript', codeString: 'console.log("OpenUI")' })
  if (entry.name === 'Image') initial.src = sampleImage
  return { ...entry, initial }
})
const element = (typeName, props) => ({ type: 'element', typeName, props, partial: false })
const sample = name => structuredClone(upstreamEntries.find(entry => entry.name === name).initial)
const PARENTS = {
  Col: ['Table', 'columns'], Series: ['BarChart', 'series'],
  ScatterSeries: ['ScatterChart', 'datasets'], Point: ['ScatterSeries', 'points'],
  SelectItem: ['Select', 'items'], CheckBoxItem: ['CheckBoxGroup', 'items'],
  RadioItem: ['RadioGroup', 'items'], SwitchItem: ['SwitchGroup', 'items'],
  ChipItem: ['Chips', 'items'], OptionCard: ['OptionCards', 'items'],
  TabItem: ['Tabs', 'items'], AccordionItem: ['Accordion', 'items'], StepsItem: ['Steps', 'items'],
  ListItem: ['ListBlock', 'items'],
  SnippetCardItem: ['SnippetCardBlock', 'items'], OverviewCardItem: ['OverviewCardBlock', 'items'],
  ContextCardItem: ['ContextCardBlock', 'items'], CompositeCardItem: ['CompositeCardBlock', 'items'],
  VisualCardItem: ['VisualCardBlock', 'items'],
}

export function upstreamTree(name, data) {
  let node = name === 'Slice' ? element('PieChart', { labels: [data.category, '其他样本'], values: [data.value, 100 - data.value] }) : element(name, data)
  if (name === 'Separator') node = element('Stack', {
    direction: data.orientation === 'vertical' ? 'row' : 'column', gap: 'm', align: 'stretch',
    children: [element('TextContent', { text: '研究结论' }), node, element('TextContent', { text: '证据与适用边界' })],
  })
  let owner = name
  while (PARENTS[owner]) {
    const [parent, property] = PARENTS[owner]
    const props = sample(parent)
    const children = props[property]
    const index = Math.max(0, children.findIndex(child => ['value', 'name', 'id', 'label'].some(key =>
      child.props?.[key] !== undefined && child.props[key] === node.props[key])))
    props[property] = children.length ? children.map((child, position) => position === index ? node : child) : [node]
    node = element(parent, props)
    owner = parent
  }
  return element(ROOT, { children: [node] })
}

function UpstreamRender({ name, data, onAction, surface }) {
  const { t } = useTranslation('official')
  const mode = useConversationMode()
  const [modalRevision, setModalRevision] = React.useState(0)
  const source = React.useMemo(() => jsonToOpenUI(upstreamTree(name, name === 'Modal' ? { ...data, open: modalRevision > 0 || data.open } : data), upstreamLibrary), [name, data, modalRevision])
  const content = <>
    {name === 'Modal' && <Button onClick={() => setModalRevision(current => current + 1)}>{t('upstream.openModal')}</Button>}
    <Renderer key={modalRevision} response={source} library={upstreamLibrary} publishObservability={false}
      onAction={(...values) => onAction(JSON.stringify(values))} />
  </>
  return <ThemeProvider mode={mode} lightTheme={conversationTheme} darkTheme={conversationTheme} cssSelector="[data-upstream-preview]">
    <div data-upstream-preview data-component={name} data-surface={surface}>
      {surface === 'canvas' ? <Canvas title={t('upstream.canvasTitle', { name })}>{content}</Canvas> : content}
    </div>
  </ThemeProvider>
}

export const upstreamCollection = {
  entries: upstreamEntries,
  examples: upstreamExamples,
  canvas: true,
  storageKey: 'scholarseed.ui.upstream-preview.v1',
  render: UpstreamRender,
}
