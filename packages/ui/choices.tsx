import type { CardState } from './contract'

const { React, Conversation, mount } = window.scholarseedUI

function Choices({ state }: { state: CardState }): React.JSX.Element {
  return <Conversation.Choices
    data={{ ...state.data, ...state.draft }}
    status={state.status}
    slot={state.slot}
    submit={window.plugin.submit}
  />
}

mount(state => <Choices state={state} />)
