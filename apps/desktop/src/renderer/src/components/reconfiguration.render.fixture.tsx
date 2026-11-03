import React from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../../localization/engine'
import { resources } from '../../../localization/resources'
import '../browser'
import '../styles.css'
import { Reconfigure } from './business/Reconfigure'
import { Button } from './ui'

const localization = createLocalization('zh', resources, { report: () => undefined })

function Fixture(): React.JSX.Element {
  const [mounted, setMounted] = React.useState(true)
  const [model, setModel] = React.useState('fixture-model')
  const [session, setSession] = React.useState('c'.repeat(32))
  const [revision, setRevision] = React.useState(0)
  return <>
    <Button onClick={() => setMounted(!mounted)}>Toggle fixture</Button>
    <Button onClick={() => setModel('second-model')}>Change model</Button>
    <Button onClick={() => setSession('d'.repeat(32))}>Change session</Button>
    <Button onClick={() => setRevision(revision + 1)}>Refresh status</Button>
    {mounted ? <Reconfigure sessionId={session} modelId={model} revision={String(revision)} /> : null}
  </>
}

createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={localization}><Fixture /></I18nextProvider>
)
