import { Component, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { submitFeedback } from '../api'
import { Alert, Button, Page, PageBody, PageHeader } from '../components/ui'
import { rendererDiagnosticsFile } from '../diagnostics'
import { createCrashReport } from './crash'

interface ErrorBoundaryProps {
  children: ReactNode
  embedded?: boolean
}

interface ErrorBoundaryState {
  componentStack: string | null
  error: Error | null
}

type FeedbackPhase = 'idle' | 'submitting' | 'submitted' | 'failed'

const INITIAL_STATE: ErrorBoundaryState = { componentStack: null, error: null }

export function ErrorPage({
  componentStack,
  error,
  onReload,
  embedded = false
}: {
  componentStack: string | null
  error: Error
  onReload: () => void
  embedded?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('shell')
  const [feedbackPhase, setFeedbackPhase] = useState<FeedbackPhase>('idle')
  const Container = embedded ? 'div' : 'main'
  const submitCrashFeedback = async (): Promise<void> => {
    if (feedbackPhase === 'submitting' || feedbackPhase === 'submitted') return
    setFeedbackPhase('submitting')
    const description = createCrashReport(
      error,
      componentStack,
      {
        devicePixelRatio: window.devicePixelRatio,
        language: navigator.language,
        location: window.location.href,
        userAgent: navigator.userAgent,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth
      },
      new Date()
    )
    const result = await submitFeedback({
      description,
      includeLogs: true,
      includeTrace: false,
      rendererDiagnostics: rendererDiagnosticsFile(),
      sessionId: null
    })
    setFeedbackPhase(result.ok ? 'submitted' : 'failed')
  }

  return (
    <Container
      className={`grid min-h-0 min-w-0 place-items-center overflow-auto bg-[var(--vds-bg-app)] p-[var(--vds-layout-page-padding)]${embedded ? ' h-full flex-1' : ' min-h-screen'}`}
    >
      <Page className="w-full" width="reading">
        <PageHeader
          description={t('errorBoundary.description')}
          title={t('errorBoundary.title')}
        />
        <PageBody>
          <Alert
            data-i18n-description="shell:errorBoundary.guidance"
            data-i18n-title="shell:errorBoundary.notice"
            description={t('errorBoundary.guidance')}
            title={t('errorBoundary.notice')}
            tone="error"
          />
          <div className="flex flex-wrap gap-[var(--vds-layout-control-gap)]">
            <Button onClick={onReload}>{t('errorBoundary.reload')}</Button>
            <Button
              disabled={feedbackPhase === 'submitted'}
              loading={feedbackPhase === 'submitting'}
              onClick={() => void submitCrashFeedback()}
              variant="secondary"
            >
              {t(
                feedbackPhase === 'submitted'
                  ? 'errorBoundary.feedbackSubmitted'
                  : 'errorBoundary.feedback'
              )}
            </Button>
          </div>
          {feedbackPhase === 'failed' && (
            <Alert
              description={t('errorBoundary.feedbackFailed')}
              title={t('errorBoundary.feedbackFailedTitle')}
              tone="error"
            />
          )}
        </PageBody>
      </Page>
    </Container>
  )
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = INITIAL_STATE

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { componentStack: null, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[renderer] Unhandled React render failure', {
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack
    })
    this.setState({ componentStack: errorInfo.componentStack ?? null })
  }

  private readonly reload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <ErrorPage
          componentStack={this.state.componentStack}
          embedded={this.props.embedded}
          error={this.state.error}
          onReload={this.reload}
        />
      )
    }
    return this.props.children
  }
}
