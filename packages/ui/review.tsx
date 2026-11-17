import type { CardState } from './contract'

const { React, Conversation, createLiteraturePorts, mount } = window.scholarseedUI

function Review({ state }: { state: CardState }): React.JSX.Element {
  const context = state.data.context as { projectId?: string; projectName?: string } | undefined
  const ports = React.useMemo(() => createLiteraturePorts((action, values) =>
    window.plugin.request(action, values), context ?? {}), [context?.projectId, context?.projectName])
  return <Conversation.Review content={state.data} ports={ports} />
}

mount(state => <Review state={state} />)
