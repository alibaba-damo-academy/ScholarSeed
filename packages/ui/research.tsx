import type { CardState } from './contract'

const { React, Conversation, createLiteraturePorts, mount } = window.scholarseedUI
const views = {
  'display.literature-search': Conversation.Results,
  'preview.literature-results': Conversation.Details,
} as const

function Research({ state }: { state: CardState }): React.JSX.Element {
  const View = views[state.slot as keyof typeof views]
  const context = state.data.context as { projectId?: string; projectName?: string } | undefined
  const ports = React.useMemo(() => createLiteraturePorts((action, values) =>
    window.plugin.request(action, values), context ?? {}), [context?.projectId, context?.projectName])
  return <View content={state.data} cardId={state.slot} ports={ports} />
}

mount(state => <Research state={state} />)
