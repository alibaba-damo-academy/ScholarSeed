import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { Copy, Link2 } from 'lucide-react'
import { CopyButton, Link as SemanticLink, Tooltip, cx } from '../ui'
import { writeClipboard } from './clipboard'

export function Link({
  url,
  children,
  compact,
  onOpen,
  onCopy,
  anchorProps,
}: {
  url: string
  children: ReactNode
  compact: boolean
  onOpen: (url: string) => void
  onCopy?: (source: string) => Promise<void>
  anchorProps?: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick' | 'children'>
}): React.JSX.Element {
  const anchor = (
    <SemanticLink
      {...anchorProps}
      href={url}
      icon={compact ? <Link2 /> : undefined}
      rel="noopener noreferrer"
      onClick={(event) => {
        event.preventDefault()
        onOpen(url)
      }}
      className={cx(
        anchorProps?.className,
        compact && 'min-w-0 truncate [&&]:[font-weight:inherit] [&&]:text-inherit'
      )}
    >
      {children}
    </SemanticLink>
  )
  if (!compact) return anchor
  return (
    <span
      data-testid="answer-link"
      className="group/answer-link relative inline-block max-w-full pr-[calc(var(--vds-control-height-xs)+var(--vds-space-1))]"
    >
      <Tooltip content={url} className="min-w-0 max-w-full [&>a]:block">
        {anchor}
      </Tooltip>
      <CopyButton
        iconOnly
        icon={<Copy size="1em" />}
        value={url}
        writeText={onCopy ?? writeClipboard}
        size="xs"
        variant="ghost"
        className="pointer-events-none !absolute bottom-0 right-0 opacity-0 group-hover/answer-link:pointer-events-auto group-hover/answer-link:opacity-[var(--vds-opacity-full)] group-focus-within/answer-link:pointer-events-auto group-focus-within/answer-link:opacity-[var(--vds-opacity-full)]"
      />
    </span>
  )
}
