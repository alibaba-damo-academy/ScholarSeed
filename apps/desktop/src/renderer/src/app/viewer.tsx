import React, { Suspense, type ErrorInfo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Alert } from '../components/ui'
import type { ViewerPlugin } from '../contracts/features'

type ViewerProps = Parameters<ViewerPlugin['render']>[0]

interface ViewerBoundaryProps {
  viewer: ViewerPlugin
  document: ViewerProps
  children: ReactNode
}

interface ViewerBoundaryState {
  failed: boolean
}

function ViewerFailure(): React.JSX.Element {
  const { t } = useTranslation('workbench')
  return (
    <div className="p-[var(--vds-space-4)]" data-testid="document-view-error">
      <Alert tone="error" title={t('dock.viewFailed')} description={t('dock.viewFailedHint')} />
    </div>
  )
}

class ViewerBoundary extends React.Component<ViewerBoundaryProps, ViewerBoundaryState> {
  state: ViewerBoundaryState = { failed: false }

  static getDerivedStateFromError(): ViewerBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[viewer] Document view failed', {
      kind: this.props.viewer.kind,
      path: this.props.document.path,
      documentSessionId: this.props.document.documentSessionId,
      tabId: this.props.document.tabId
    }, error, info.componentStack)
  }

  render(): ReactNode {
    return this.state.failed ? <ViewerFailure /> : this.props.children
  }
}

function ViewerLoading(): React.JSX.Element {
  const { t } = useTranslation('workbench')
  return <div className="vds-viewer-empty">{t('dock.opening')}</div>
}

function ViewerContent({ viewer, document }: { viewer: ViewerPlugin; document: ViewerProps }): ReactNode {
  return viewer.render(document)
}

export function withViewerBoundary(viewer: ViewerPlugin): ViewerPlugin {
  return {
    ...viewer,
    render: (document) => (
      <ViewerBoundary
        key={JSON.stringify([viewer.kind, document.documentSessionId, document.tabId, document.path, document.viewKind])}
        viewer={viewer}
        document={document}
      >
        <Suspense fallback={<ViewerLoading />}>
          <ViewerContent viewer={viewer} document={document} />
        </Suspense>
      </ViewerBoundary>
    )
  }
}
