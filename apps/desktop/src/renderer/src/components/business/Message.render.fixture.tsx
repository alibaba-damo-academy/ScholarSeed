import React from 'react'
import { createRoot } from 'react-dom/client'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import conversation from '../../../../localization/locales/zh/conversation.json'
import ui from '../../../../localization/locales/zh/ui.json'
import { Button, CopyButton } from '../ui'
import { MessageActions, UserMessageText } from './Message'
import { WebNavigationContext } from '../../contracts/navigation'
import { openWebPage } from '../../app/links'
import '../../styles.css'

const localization = createInstance()
await localization.init({ lng: 'zh', resources: { zh: { conversation, ui } } })
const params = new URLSearchParams(location.search)
const text = params.get('text') ?? ''

function Probe(): React.JSX.Element {
  const [copied, setCopied] = React.useState('')
  const [opened, setOpened] = React.useState('')
  window.scholarseed = {
    openExternal: async (_url: string): Promise<void> => {
      throw new Error('unexpected external navigation')
    },
  } as typeof window.scholarseed
  return (
    <I18nextProvider i18n={localization}>
      <WebNavigationContext.Provider
        value={(url) => {
          void openWebPage(url, {
            available: true,
            dispatch: async (command) => {
              setOpened(command.kind === 'open' ? (command.input ?? '') : '')
              return { ok: true, snapshot: { activeTabId: 'user-link-page' } } as never
            },
            reveal: () => {},
          })
        }}
      >
        <div data-testid="container" style={{ width: 360 }}>
          <div className="group/message" data-testid="historical">
            <UserMessageText text={text} />
            <MessageActions>
              <CopyButton
                data-testid="copy-first"
                value={text}
                writeText={async (value) => setCopied(value)}
              >
                Copy first
              </CopyButton>
            </MessageActions>
          </div>
          <div className="group/message" data-testid="latest">
            <p>Second reply</p>
            <MessageActions latest>
              <CopyButton value="Second reply" writeText={async (value) => setCopied(value)}>
                Copy second
              </CopyButton>
            </MessageActions>
          </div>
        </div>
        <Button data-testid="outside">Outside</Button>
        <output data-testid="copied">{copied}</output>
        <output data-testid="opened">{opened}</output>
      </WebNavigationContext.Provider>
    </I18nextProvider>
  )
}

createRoot(document.getElementById('root')!).render(<Probe />)
