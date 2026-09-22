import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, EllipsisText, IconButton, Input, ScrollArea } from '../ui'
import { Icon } from '../../icons'

const INDENT_PX = 18

export interface DestinationNode {
  path: string
  name: string
  kind: 'file' | 'dir'
  count?: number
  children?: DestinationNode[]
  origin?: 'local' | 'link'
  version?: { managementState: string; needsReview: boolean }
}

export interface DestinationTreeProps {
  nodes: DestinationNode[]
  rootPath?: string
  folderDraft?: { parent: string; name: string; onChange: (name: string) => void; onCommit: () => void; onCancel: () => void }
  selected: string
  expanded: Record<string, boolean>
  onToggle: (path: string) => void
  onSelect: (path: string, node: DestinationNode) => void
  selectionValue?: (node: DestinationNode) => string
  selectable?: (node: DestinationNode) => boolean
  showFiles?: boolean
  disabled?: boolean
  remaining?: Record<string, number>
  onLoadMore?: (path: string) => void
}

export function DestinationTree({
  nodes, rootPath = '', folderDraft, selected, expanded, onToggle, onSelect, selectionValue = (node) => node.path,
  selectable = (node) => node.kind === 'dir', showFiles = false, disabled = false,
  remaining = {}, onLoadMore
}: DestinationTreeProps): React.JSX.Element {
  const { t } = useTranslation('resources')
  const draftRow = (parent: string, depth: number): React.JSX.Element | null => {
    if (!folderDraft || folderDraft.parent !== parent) return null
    return <div className="flex min-w-0 items-center gap-[var(--vds-space-1)] pl-[var(--destination-indent)]" style={{ '--destination-indent': `${depth * INDENT_PX}px` } as CSSProperties}>
      <span aria-hidden="true" className="size-7 shrink-0" />
      <Icon name="folder" size={14} />
      <Input autoFocus aria-label={t('destination.name')} className="min-w-0 flex-1" value={folderDraft.name} disabled={disabled}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => folderDraft.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); folderDraft.onCommit() }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); folderDraft.onCancel() }
        }} />
      <IconButton icon={<Icon name="plus" size={14} />} label={t('destination.create')} disabled={disabled || !folderDraft.name.trim()} variant="ghostIcon" size="sm" onClick={folderDraft.onCommit} />
      <IconButton icon={<Icon name="close" size={14} />} label={t('cancel')} disabled={disabled} variant="ghostIcon" size="sm" onClick={folderDraft.onCancel} />
    </div>
  }
  const row = (node: DestinationNode, depth: number): React.JSX.Element | null => {
    if (!showFiles && node.kind !== 'dir') return null
    const open = expanded[node.path] ?? false
    const allowed = selectable(node)
    // Indentation comes from observed tree depth, not a visual theme override.
    const geometry = { '--destination-indent': `${depth * INDENT_PX}px` } as CSSProperties
    return (
      <div key={node.path}>
        <div className="flex min-w-0 items-center gap-[var(--vds-space-1)] pl-[var(--destination-indent)]" style={geometry}>
          {node.kind === 'dir' ? (
            <IconButton
              icon={<Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />}
              label={t(open ? 'destination.collapse' : 'destination.expand', { name: node.name })}
              disabled={disabled}
              aria-expanded={open}
              variant="ghostIcon" size="sm"
              onClick={() => onToggle(node.path)}
            />
          ) : <span aria-hidden="true" className="size-7 shrink-0" />}
          <Button
            className="min-w-0 flex-1 !justify-start overflow-hidden"
            data-testid={`destination-node-${node.path}`}
            icon={<Icon name={node.kind === 'dir' ? 'folder' : 'doc'} size={14} />}
            variant={selected === selectionValue(node) ? 'secondary' : 'ghost'}
            disabled={disabled || (!allowed && node.kind !== 'dir')}
            aria-pressed={allowed ? selected === selectionValue(node) : undefined}
            onClick={() => allowed ? onSelect(selectionValue(node), node) : onToggle(node.path)}
          >
            <EllipsisText wrapperClassName="flex-1" className="text-left" tooltipPortalled>{node.name}</EllipsisText>
            {selected === selectionValue(node) ? <span className="ml-auto shrink-0" aria-label={t('destination.selected')}>✓</span> : null}
          </Button>
        </div>
        {node.kind === 'dir' && open ? (
          <div>
            {draftRow(node.path, depth + 1)}
            {node.children?.map((child) => row(child, depth + 1))}
            {(remaining[node.path] ?? 0) > 0 && onLoadMore ? (
              <Button variant="ghost" disabled={disabled} onClick={() => onLoadMore(node.path)}>
                {t('panel.loadMore', { count: remaining[node.path] })}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    )
  }
  return <ScrollArea className="max-h-64" viewportClassName="!max-h-64 !min-h-0 [scrollbar-gutter:stable] ![scrollbar-width:auto] ![scrollbar-color:auto]">
    {draftRow(rootPath, 0)}
    {nodes.map((node) => row(node, 0))}
  </ScrollArea>
}
