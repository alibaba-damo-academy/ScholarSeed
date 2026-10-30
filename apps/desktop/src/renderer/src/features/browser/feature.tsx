import { useEffect, useRef } from 'react'
import type { FeatureModule } from '../../contracts/features'
import { Browser } from './Browser'
import { useApp } from '../../store'
import { subscribeBrowserReveal } from './reveal'

function BrowserNavigation(): null {
  const { state, act } = useApp()
  const current = useRef({ state, act })
  current.current = { state, act }
  useEffect(() => subscribeBrowserReveal(window.scholarseed.browser,
    () => current.current.state.aiPanel.sessionId,
    () => current.current.act.openWorkbenchView('browser', { preserveProject: true })), [])
  return null
}

function BrowserViewer(): React.JSX.Element {
  const { act } = useApp()
  return <Browser onSettings={section => act.openSettings('browser', section)} />
}

export function browserFeature(): FeatureModule {
  return {
    id: 'browser',
    viewerPlugins: [{ kind: 'browser', render: () => <BrowserViewer /> }],
    globalSurfaces: [{ id: 'browser-navigation', render: () => <BrowserNavigation /> }],
  }
}
