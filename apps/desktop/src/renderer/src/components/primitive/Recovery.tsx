import React, { type ErrorInfo, type ReactNode } from 'react'
import { Check, Copy, Info } from 'lucide-react'
import { CopyButton } from '../ui'

interface SourceBoundaryProps {
  source: string
  message: string
  onCopy?: (source: string) => Promise<void>
  children: ReactNode
}

interface SourceBoundaryState {
  source: string
  failed: boolean
}

export class SourceBoundary extends React.Component<SourceBoundaryProps, SourceBoundaryState> {
  state: SourceBoundaryState = { source: this.props.source, failed: false }

  static getDerivedStateFromProps(
    props: SourceBoundaryProps,
    state: SourceBoundaryState
  ): Partial<SourceBoundaryState> | null {
    return props.source === state.source ? null : { source: props.source, failed: false }
  }

  static getDerivedStateFromError(): Partial<SourceBoundaryState> {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      '[markdown] Rendering failed; original source preserved',
      error,
      info.componentStack
    )
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <section
        data-testid="markdown-render-fallback"
        className="my-[var(--vds-space-3)] min-w-0 max-w-full"
      >
        <div className="relative overflow-hidden rounded-[var(--vds-radius-6)] border border-[var(--vds-border-default)] bg-[var(--vds-surface-raised)]">
          {this.props.onCopy && (
            <CopyButton
              iconOnly
              icon={<Copy size="1em" />}
              copiedIcon={<Check size="1em" />}
              tooltip
              value={this.props.source}
              writeText={this.props.onCopy}
              size="sm"
              variant="ghost"
              className="absolute right-[var(--vds-space-1)] top-[var(--vds-space-1)]"
            />
          )}
          <pre
            tabIndex={0}
            className="m-0 max-w-full overflow-x-auto whitespace-pre p-[var(--vds-space-3)] pr-[var(--vds-space-9)] font-[family-name:var(--font-mono)] text-[length:var(--vds-code-font-size)]"
          >
            {this.props.source}
          </pre>
        </div>
        <p
          role="status"
          className="mt-[var(--vds-space-2)] flex items-start gap-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv3)] text-[var(--vds-text-tertiary)]"
        >
          <Info aria-hidden="true" size="1em" className="shrink-0" />
          {this.props.message}
        </p>
      </section>
    )
  }
}
