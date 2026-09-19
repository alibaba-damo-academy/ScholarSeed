import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'

import { createLocalization } from '../../../localization/engine'
import zhResources from '../../../localization/locales/zh/resources.json'
import enResources from '../../../localization/locales/en/resources.json'
import zhUi from '../../../localization/locales/zh/ui.json'
import enUi from '../../../localization/locales/en/ui.json'
import { SearchFeedback } from '../features/resources/Feedback'
import { Button, ToastProvider, Toaster, useToast } from './ui'
import type { ToastInput } from './ui'
import '../styles.css'

const localization = createLocalization('zh', {
  zh: { resources: zhResources, ui: zhUi },
  en: { resources: enResources, ui: enUi }
}, { report: () => undefined })

const SAMPLES: Record<string, ToastInput> = {
  failure: {
    id: 'failure', tone: 'error',
    title: <SearchFeedback message={{ kind: 'label', messageKey: 'webSearchFailure.webTitle' }} />,
    description: <SearchFeedback message={{ kind: 'failure', error: 'browser_launch_failed' }} />
  },
  fallback: {
    id: 'fallback', tone: 'warning',
    title: <SearchFeedback message={{ kind: 'label', messageKey: 'webFeedback.browser' }} />,
    description: <SearchFeedback message={{ kind: 'fallback', error: 'runtime_capability_unavailable' }} />
  },
  completed: {
    id: 'completed', tone: 'success',
    title: <SearchFeedback message={{ kind: 'label', messageKey: 'webFeedback.completed' }} />,
    description: <SearchFeedback message={{ kind: 'count', messageKey: 'webFeedback.candidates', total: 3 }} />
  },
  importFailure: {
    id: 'importFailure', tone: 'error',
    title: <SearchFeedback message={{ kind: 'label', messageKey: 'webFeedback.requestFailed' }} />,
    description: <SearchFeedback message={{ kind: 'importFailure', error: 'upstream TLS detail abc' }} />
  },
  saved: {
    id: 'saved', tone: 'warning',
    title: <SearchFeedback message={{ kind: 'count', messageKey: 'webFeedback.saved', total: 2 }} />,
    description: <SearchFeedback message={{ kind: 'count', messageKey: 'webFeedback.partial', total: 1 }} />
  }
}

function Fixture(): React.JSX.Element {
  const { toast, toasts } = useToast()
  const [emissions, setEmissions] = useState(0)
  return <>
    <Button onClick={() => void localization.changeLanguage('zh')}>中文</Button>
    <Button onClick={() => void localization.changeLanguage('en')}>English</Button>
    {Object.entries(SAMPLES).map(([name, sample]) => <Button key={name} onClick={() => {
      toast(sample)
      setEmissions(value => value + 1)
    }}>{name}</Button>)}
    <output data-testid="emissions">{emissions}</output>
    <output data-testid="toast-ids">{toasts.map(item => item.id).join(',')}</output>
    <Toaster />
  </>
}

createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={localization}><ToastProvider><Fixture /></ToastProvider></I18nextProvider>
)
