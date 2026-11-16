import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import mermaid from 'mermaid'

import {
  Button,
  CopyButton,
  Dialog,
  DialogContent,
  DialogPortal,
  DialogTitle,
  Spinner,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '../ui'
import { Check, Copy } from 'lucide-react'
import { ImageView } from './Image'
import { Code } from './Code'
import type { SourceLeaf } from '../markdown/source'
import { CARD_HEADER, CARD_ACTIONS, CARD_TABS, CARD_TAB } from './utils'

let rendering: Promise<unknown> = Promise.resolve()
let sequence = 0

function renderDiagram(source: string, dark: boolean): Promise<string> {
  const next = rendering.then(async () => {
    const styles = getComputedStyle(document.documentElement)
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      suppressErrorRendering: true,
      theme: 'base',
      themeVariables: {
        darkMode: dark,
        primaryColor: styles.getPropertyValue('--vds-surface-muted').trim(),
        primaryTextColor: styles.getPropertyValue('--vds-text-primary').trim(),
        primaryBorderColor: styles.getPropertyValue('--vds-border-default').trim(),
        lineColor: styles.getPropertyValue('--vds-text-secondary').trim(),
      },
      secure: Object.keys(mermaid.mermaidAPI.getConfig()),
    })
    const { svg } = await mermaid.render(`scholarseed-diagram-${++sequence}`, source)
    return svg
  })
  rendering = next.catch(() => undefined)
  return next
}

export function Diagram({
  source,
  title,
  onCopy,
  pending = false,
  sourceMap,
}: {
  pending?: boolean
  sourceMap?: SourceLeaf
  source: string
  title?: string
  onCopy?: (source: string) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const [showSource, setShowSource] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [theme, setTheme] = useState(document.documentElement.dataset.theme === 'dark')
  const [view, setView] = useState<Readonly<Record<string, unknown>>>({})
  const label = title || t('diagram.title')
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setTheme(document.documentElement.dataset.theme === 'dark')
    )
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    let active = true
    setUrl('')
    setError('')
    setView({})
    if (pending)
      return () => {
        active = false
      }
    void renderDiagram(source, theme)
      .then((svg) => {
        if (!active) return
        setUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
      })
      .catch((failure) => {
        if (active) setError(failure instanceof Error ? failure.message : String(failure))
      })
    return () => {
      active = false
    }
  }, [source, theme, pending])
  return (
    <Tabs
      value={showSource || error || pending ? 'source' : 'figure'}
      onValueChange={(value) => setShowSource(value === 'source')}
      data-testid="conversation-diagram"
      className={`group/conversation-card !block my-[var(--vds-space-3)] min-w-0 overflow-hidden rounded-[var(--vds-radius-6)] border border-solid bg-[var(--vds-fill-2)] ${error ? 'border-[var(--vds-warning-light-border)]' : 'border-[var(--vds-border-default)]'}`}
    >
      <div data-testid="diagram-toolbar" className={CARD_HEADER}>
        <span title={label} className="min-w-0 truncate [font-weight:var(--vds-fw-regular)]">
          {label}
        </span>
        <div className={CARD_ACTIONS}>
          <TabsList className={CARD_TABS}>
            <TabsTrigger className={CARD_TAB} value="figure" disabled={Boolean(error) || pending}>
              {t('diagram.figure')}
            </TabsTrigger>
            <TabsTrigger className={CARD_TAB} value="source">
              {t('diagram.source')}
            </TabsTrigger>
          </TabsList>
          {onCopy ? (
            <CopyButton
              iconOnly
              icon={<Copy />}
              copiedIcon={<Check />}
              tooltip
              value={source}
              writeText={onCopy}
              variant="ghostIcon"
              size="xs"
            />
          ) : null}
        </div>
      </div>
      <TabsContent value={showSource || error || pending ? 'source' : 'figure'}>
        {error ? (
          <div
            role="alert"
            className="px-[var(--vds-space-3)] pt-[var(--vds-space-2)] text-[var(--vds-warning-text-primary)]"
          >
            {t('diagram.failed')}
            <details>
              <summary>{t('diagram.details')}</summary>
              <pre className="max-w-full whitespace-pre-wrap break-words">{error}</pre>
            </details>
          </div>
        ) : null}
        {showSource || error || pending ? (
          <Code embedded code={source} language="mermaid" sourceMap={sourceMap} />
        ) : url ? (
          <div className="p-[var(--vds-space-3)]">
            <Button
              unstyled
              className="block w-full max-w-full cursor-zoom-in focus-visible:shadow-[var(--vds-focus-brand)]"
              aria-label={t('diagram.expand')}
              disabled={!url || Boolean(error) || pending}
              onClick={() => setExpanded(true)}
            >
              <img src={url} alt={label} className="max-w-full" />
            </Button>
          </div>
        ) : (
          <Spinner aria-label={t('diagram.loading')} />
        )}
      </TabsContent>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogPortal>
          <DialogContent>
            <DialogTitle>{label}</DialogTitle>
            {url ? (
              <div className="h-[var(--vds-diagram-viewer-height)]">
                <ImageView
                  url={url}
                  title={label}
                  viewState={view}
                  onViewChange={(value) => setView({ ...value })}
                />
              </div>
            ) : null}
          </DialogContent>
        </DialogPortal>
      </Dialog>
    </Tabs>
  )
}
