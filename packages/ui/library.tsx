import React from 'react'
import { createLibrary, defineComponent } from '@openuidev/react-lang'
import { MarkDownRenderer, openuiLibrary } from '@openuidev/react-ui'
import { z } from 'zod/v4'
import { OPENUI_ROOT, OPENUI_REGISTRY } from './document'
import { CONVERSATION_CHARTS, framedChart } from './charts'

export const CONVERSATION_COMPONENT_GROUPS = [
  { name: '正文与富内容', components: ['TextContent', 'Tag', 'TagBlock'] },
  { name: '图表', components: ['Table', 'Col', 'BarChart', 'LineChart', 'AreaChart', 'HorizontalBarChart',
    'ScatterChart', 'ScatterSeries', 'Point', 'Series', 'PieChart', 'RadialChart', 'SingleStackedBarChart', 'Slice', 'RadarChart'] },
] as const

export const CONVERSATION_AUXILIARY_COMPONENTS = ['Col', 'Series', 'ScatterSeries', 'Point', 'Slice'] as const
export const CONVERSATION_COMPONENT_ALIASES = {
  GroupedBarChart: { component: 'BarChart', variant: 'grouped' },
  StackedBarChart: { component: 'BarChart', variant: 'stacked' },
  DonutChart: { component: 'PieChart', variant: 'donut' },
} as const

const Conversation = defineComponent({
  name: OPENUI_ROOT,
  props: z.object({ children: z.array(z.unknown()) }),
  description: 'A natural conversation answer: narrative, relevant components, then interpretation. No outer card or independent scroll area.',
  component: ({ props, renderNode }) => (
    <div className="grid min-w-0 gap-[var(--vds-conversation-block-gap)]">{renderNode(props.children)}</div>
  ),
})

const TextContent = defineComponent({
  name: 'TextContent',
  props: openuiLibrary.components.TextContent.props,
  description: 'Narrative Markdown, including fenced code and section breaks. Links and images remain literal; source and artifact navigation stay in native product flows.',
  component: ({ props }) => <MarkDownRenderer textMarkdown={String(props.text ?? '')} variant="clear"
    options={{ components: {
      a: ({ children }) => <span>{children}</span>,
      img: ({ alt }) => <span>{alt}</span>,
    }, urlTransform: () => '' }} />,
})

export function createConversationLibrary() {
  const components = CONVERSATION_COMPONENT_GROUPS.flatMap(group => [...group.components]).map(name => {
    if (name === TextContent.name) return TextContent
    const definition = openuiLibrary.components[name]
    if (!definition) throw new Error(`openui_component_missing:${name}`)
    return CONVERSATION_CHARTS.some(chart => chart === name) ? framedChart(definition) : definition
  })
  const library = createLibrary({
    id: OPENUI_REGISTRY,
    root: OPENUI_ROOT,
    componentGroups: CONVERSATION_COMPONENT_GROUPS.map(group => ({ name: group.name, components: [...group.components] })),
    components: [Conversation, ...components],
    actions: [],
  })
  library.prompt = (options = {}) => {
    if (options.toolCalls || options.bindings || options.builtinFunctions || options.tools?.length)
      throw new Error('openui_capability_unavailable')
    const spec = library.toSpec()
    return [
      'Generate OpenUI Lang, not JavaScript, JSX, HTML or a chat protocol. Use root = Conversation([...]).',
      'Only literal data and declared display components are admitted. No actions, external resource URLs, queries, mutations, reactive variables, regular expressions or arbitrary tools.',
      'Compose natural explanation, relevant components, then interpretation. Do not add a web page shell, nested cards or extra vertical scroll owners.',
      'User input, execution progress, confirmation, clarification and error recovery belong to existing native product flows, not generated conversation components.',
      'Registered components (positional arguments):',
      ...Object.values(spec.components).map(component => `${component.signature}${component.description ? ` — ${component.description}` : ''}`),
      ...(options.additionalRules ?? []),
    ].join('\n')
  }
  return library
}

export const conversationLibrary = createConversationLibrary()
