import { StrictMode, useState } from 'react'
import { feedbackSubmissionForm, type FeedbackSubmissionRequest } from '../../../feedback'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'

import { createLocalization } from '../../../localization/engine'
import zhResources from '../../../localization/locales/zh/resources.json'
import enResources from '../../../localization/locales/en/resources.json'
import zhUi from '../../../localization/locales/zh/ui.json'
import enUi from '../../../localization/locales/en/ui.json'
import zhComponents from '../../../localization/locales/zh/components.json'
import enComponents from '../../../localization/locales/en/components.json'
import { Feedback, FeedbackRecovery } from './business/Feedback'
import { FloatingWindow } from './primitive/FloatingWindow'
import { SearchFeedback } from '../features/resources/Feedback'
import { Button, ToastProvider, Toaster, useToast } from './ui'
import type { ToastInput } from './ui'
import '../styles.css'

const localization = createLocalization(
  new URLSearchParams(window.location.search).get('lang') === 'en' ? 'en' : 'zh',
  {
    zh: { resources: zhResources, ui: zhUi, components: zhComponents },
    en: { resources: enResources, ui: enUi, components: enComponents },
  },
  { report: () => undefined }
)
window.scholarseed = {
  submitFeedback: async (request: FeedbackSubmissionRequest) => {
    const response = await fetch('/api/serve/feedback', {
      method: 'POST',
      body: feedbackSubmissionForm(request),
    })
    const payload = await response.json()
    return {
      ok: response.ok,
      id: payload.id,
      rateLimited: response.status === 429,
      ...(new URLSearchParams(window.location.search).has('partial')
        ? { diagnostics: 'partial' }
        : {}),
    }
  },
} as unknown as Window['scholarseed']

// Valid PNG bytes exercise the automatic screenshot's File/object URL path.
const SCREENSHOT = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='
  ),
  (c) => c.charCodeAt(0)
)

const SAMPLES: Record<string, ToastInput> = {
  failure: {
    id: 'failure',
    tone: 'error',
    title: <SearchFeedback message={{ kind: 'label', messageKey: 'webSearchFailure.webTitle' }} />,
    description: <SearchFeedback message={{ kind: 'failure', error: 'browser_launch_failed' }} />,
  },
  fallback: {
    id: 'fallback',
    tone: 'warning',
    title: <SearchFeedback message={{ kind: 'label', messageKey: 'webFeedback.browser' }} />,
    description: (
      <SearchFeedback message={{ kind: 'fallback', error: 'runtime_capability_unavailable' }} />
    ),
  },
  completed: {
    id: 'completed',
    tone: 'success',
    title: <SearchFeedback message={{ kind: 'label', messageKey: 'webFeedback.completed' }} />,
    description: (
      <SearchFeedback message={{ kind: 'count', messageKey: 'webFeedback.candidates', total: 3 }} />
    ),
  },
  importFailure: {
    id: 'importFailure',
    tone: 'error',
    title: <SearchFeedback message={{ kind: 'label', messageKey: 'webFeedback.requestFailed' }} />,
    description: (
      <SearchFeedback message={{ kind: 'importFailure', error: 'upstream TLS detail abc' }} />
    ),
  },
  saved: {
    id: 'saved',
    tone: 'warning',
    title: (
      <SearchFeedback message={{ kind: 'count', messageKey: 'webFeedback.saved', total: 2 }} />
    ),
    description: (
      <SearchFeedback message={{ kind: 'count', messageKey: 'webFeedback.partial', total: 1 }} />
    ),
  },
}

function Fixture(): React.JSX.Element {
  const { toast, toasts } = useToast()
  const [emissions, setEmissions] = useState(0)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [recordingRequested, setRecordingRequested] = useState(false)
  const [floatingOpen, setFloatingOpen] = useState(false)
  const recordingEnabled = !new URLSearchParams(window.location.search).has('withoutRecorder')
  if (new URLSearchParams(window.location.search).has('recovery'))
    return <FeedbackRecovery title="Service unavailable" detail="Backend startup failed" />
  return (
    <>
      <Button onClick={() => void localization.changeLanguage('zh')}>中文</Button>
      <Button onClick={() => void localization.changeLanguage('en')}>English</Button>
      <Button onClick={() => setFeedbackOpen(true)}>Open feedback</Button>
      <Button onClick={() => setFloatingOpen(true)}>Open reader floating window</Button>
      {floatingOpen && (
        <FloatingWindow title="翻译" onClose={() => setFloatingOpen(false)}>
          <p>Translation result</p>
        </FloatingWindow>
      )}
      {feedbackOpen && (
        <Feedback
          autoScreenshot={SCREENSHOT}
          phone=""
          sessionId={null}
          onClose={() => setFeedbackOpen(false)}
          onRecord={
            recordingEnabled
              ? () => {
                  setFeedbackOpen(false)
                  setRecordingRequested(true)
                }
              : undefined
          }
        />
      )}
      {recordingRequested && <output data-testid="recording-requested">Recording requested</output>}
      {Object.entries(SAMPLES).map(([name, sample]) => (
        <Button
          key={name}
          onClick={() => {
            toast(sample)
            setEmissions((value) => value + 1)
          }}
        >
          {name}
        </Button>
      ))}
      <output data-testid="emissions">{emissions}</output>
      <output data-testid="toast-ids">{toasts.map((item) => item.id).join(',')}</output>
      <Toaster />
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nextProvider i18n={localization}>
      <ToastProvider>
        <Fixture />
      </ToastProvider>
    </I18nextProvider>
  </StrictMode>
)
