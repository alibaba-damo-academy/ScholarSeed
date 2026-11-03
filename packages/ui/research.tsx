import type { CardState } from './contract'
import { cardPorts } from '../../apps/desktop/src/renderer/src/features/literature/ports'

const { React, Conversation, mount } = window.scholarseedUI
const views = {
  'display.literature-search': Conversation.Results,
  'preview.literature-results': Conversation.Details,
  'display.literature-references': Conversation.References,
  'display.literature-downloads': Conversation.Downloads,
  'display.literature-delivery': Conversation.Delivery,
} as const

function Research({ state }: { state: CardState }): React.JSX.Element {
  const View = views[state.slot as keyof typeof views]
  const context = state.data.context as { projectId?: string; projectName?: string } | undefined
  const ports = React.useMemo(() => cardPorts(async <Result,>(action: string, values: Record<string, unknown> = {}) =>
    await window.plugin.request(action, values) as Result, context ?? {}), [context?.projectId, context?.projectName])
  return <View content={state.data} cardId={state.slot} ports={ports} />
}

mount(state => <Research state={state} />)
