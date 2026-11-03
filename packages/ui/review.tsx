import type { CardState } from './contract'
import type { ChoiceData } from '../../apps/desktop/src/renderer/src/features/literature/Choices'
import { cardPorts } from '../../apps/desktop/src/renderer/src/features/literature/ports'

const { React, Conversation, mount } = window.scholarseedUI
const OUTLINE_SLOT = 'literature.outline'

function Review({ state }: { state: CardState }): React.JSX.Element {
  const context = state.data.context as { projectId?: string; projectName?: string } | undefined
  const ports = React.useMemo(() => cardPorts(async <Result,>(action: string, values: Record<string, unknown> = {}) =>
    await window.plugin.request(action, values) as Result, context ?? {}), [context?.projectId, context?.projectName])
  return <>
    <Conversation.Review content={state.data} ports={ports} />
    {state.slot === OUTLINE_SLOT && <Conversation.Choices
      data={{ ...state.data, ...state.draft } as ChoiceData}
      status={state.status}
      slot={state.slot}
      submit={window.plugin.submit}
    />}
  </>
}

mount(state => <Review state={state} />)
