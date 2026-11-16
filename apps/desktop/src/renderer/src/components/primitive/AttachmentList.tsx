import React from 'react'
import { useTranslation } from 'react-i18next'

import type { FilePreviewTarget } from '../../model'
import { FILE_REF_KIND } from '../../reference'
import type { ComposerReference } from '../../contracts/assistant'
import { Button, EllipsisText } from '../ui'
import { cx } from '../ui/utils'
import { FILE_FALLBACK_ICON_CLASS_NAME, FileFormatIcon } from './FileIcon'
import { fileIconKind } from './utils'
import { AttachmentContainer } from './Attachment'

type FileReference = Extract<ComposerReference, { type: 'file' }>
type DirectoryReference = Extract<ComposerReference, { type: 'directory' }>
export type LocalReference = FileReference | DirectoryReference

const ATTACHMENT_FORMAT_LABELS = { excel: 'Excel', word: 'Word', ppt: 'PowerPoint' }
const ATTACHMENTS_CLASS_NAME = 'flex w-full min-w-0 flex-wrap justify-end gap-[var(--vds-space-1)]'
const ATTACHMENTS_INLINE_CLASS_NAME =
  'flex w-max min-w-full flex-nowrap justify-end gap-[var(--vds-space-2)]'
const ATTACHMENT_INLINE_CARD_CLASS_NAME =
  'relative inline-flex box-border h-[var(--vds-control-height-standard)] max-w-[var(--vds-attachment-max-width)] items-center rounded-[var(--vds-radius-4)] bg-[var(--vds-other-overlay-1)] hover:bg-[var(--vds-other-overlay-2)] px-[var(--vds-space-2)] text-left font-[inherit]'
const ATTACHMENT_ITEM_CLASS_NAME = 'group/attachment relative box-border min-w-0 max-w-full'
const ATTACHMENT_ACTIONS_CLASS_NAME =
  'absolute right-[var(--vds-space-1)] top-0 z-[var(--vds-z-local-control)] pointer-events-none opacity-0 transition-opacity duration-150 group-hover/attachment:pointer-events-auto group-hover/attachment:opacity-[var(--vds-opacity-full)] focus-within:pointer-events-auto focus-within:opacity-[var(--vds-opacity-full)] has-[[aria-expanded=true]]:pointer-events-auto has-[[aria-expanded=true]]:opacity-[var(--vds-opacity-full)]'
const ATTACHMENT_CARD_CLASS_NAME =
  'relative inline-flex box-border h-[var(--vds-attachment-card-height)] w-[var(--vds-attachment-card-width)] max-w-full items-center rounded-[var(--vds-radius-4)] bg-[var(--vds-other-overlay-1)] hover:bg-[var(--vds-other-overlay-2)] p-[var(--vds-attachment-card-padding)] pr-[var(--vds-space-2)] text-left font-[inherit] text-[inherit]'
const ATTACHMENT_CARD_CLICKABLE_CLASS_NAME = 'cursor-pointer'
const ATTACHMENT_CARD_IDLE_CLASS_NAME = 'cursor-default'
const ATTACHMENT_CARD_OPEN_CLASS_NAME = 'bg-[var(--vds-brand-light-bg-default)]'
const ATTACHMENT_ICON_CLASS_NAME =
  'inline-flex size-[var(--vds-space-8)] shrink-0 items-center justify-center overflow-hidden text-[var(--vds-text-primary)]'
const ATTACHMENT_COPY_CLASS_NAME = 'flex min-w-0 flex-1 flex-col items-start'
const ATTACHMENT_NAME_CLASS_NAME =
  'flex w-full min-w-0 overflow-hidden text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-primary)]'

function fileName(ref: LocalReference): string {
  const clean = ref.title || ref.path || ref.id
  const slash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  return slash >= 0 ? clean.slice(slash + 1) : clean
}

function attachmentPreviewTarget(ref: FileReference): FilePreviewTarget {
  return {
    path: ref.path,
    absolutePath: ref.path,
    title: ref.title || ref.id,
    size: ref.size,
    source: ref.previewSource,
  }
}

export function AttachmentList({
  refs,
  openPaths = [],
  onRemove,
  onOpen,
  onOpenDirectory,
  renderActions,
  presentation = 'card',
  layout = 'wrap',
  sourceLabel,
  source,
  unavailableIds = [],
}: {
  refs: ComposerReference[]
  openPaths?: readonly string[]
  onRemove?: (index: number) => void
  onOpen?: (target: FilePreviewTarget) => void
  onOpenDirectory?: (ref: DirectoryReference) => void
  renderActions?: (ref: LocalReference) => React.ReactNode
  presentation?: 'card' | 'inline'
  layout?: 'wrap' | 'row' | 'contents'
  sourceLabel?: string | ((ref: LocalReference) => string | undefined)
  source?: React.ComponentProps<typeof FileFormatIcon>['source']
  unavailableIds?: readonly string[]
}): React.JSX.Element | null {
  const { t } = useTranslation('ui')
  const localRefs = refs
    .map((ref, index) => ({ ref, index }))
    .filter(
      (row): row is { ref: LocalReference; index: number } =>
        row.ref.type === FILE_REF_KIND || row.ref.type === 'directory'
    )
  if (!localRefs.length) return null
  const openPreviewPaths = new Set(openPaths)

  return (
    <div
      data-slot="attachment-list"
      className={cx(
        layout === 'contents'
          ? 'contents'
          : layout === 'row'
            ? 'flex w-max min-w-full flex-nowrap justify-end gap-[var(--vds-composer-attachment-gap)]'
            : presentation === 'inline'
              ? ATTACHMENTS_INLINE_CLASS_NAME
              : ATTACHMENTS_CLASS_NAME,
        onRemove && (layout === 'row' ? 'py-[var(--vds-space-1)]' : 'p-[var(--vds-space-1)]')
      )}
    >
      {localRefs.map(({ ref, index }) => {
        const originLabel = typeof sourceLabel === 'function' ? sourceLabel(ref) : sourceLabel
        const name = fileName(ref)
        const unavailable = unavailableIds.includes(ref.id)
        const open =
          onOpen && ref.type === 'file'
            ? (): void => onOpen(attachmentPreviewTarget(ref))
            : ref.type === 'directory' && onOpenDirectory
              ? (): void => onOpenDirectory(ref)
              : undefined
        const dot = ref.type === 'file' ? name.lastIndexOf('.') : -1
        const title = presentation === 'inline' ? name : dot > 0 ? name.slice(0, dot) : name
        const formatName = ref.type === 'file' ? (ref.fileName ?? name) : name
        const formatDot = formatName.lastIndexOf('.')
        const kind = fileIconKind(formatName)
        const usesFallbackIcon = ref.type === FILE_REF_KIND && !kind
        const format =
          ref.type === 'directory'
            ? t('attachments.directory')
            : kind && kind in ATTACHMENT_FORMAT_LABELS
              ? ATTACHMENT_FORMAT_LABELS[kind as keyof typeof ATTACHMENT_FORMAT_LABELS]
              : formatDot > 0
                ? formatName.slice(formatDot + 1).toUpperCase()
                : t('attachments.file')
        const previewOpen = openPreviewPaths.has(
          ref.type === 'file' ? (ref.previewSource?.path ?? ref.path) : ref.path
        )
        return (
          <AttachmentContainer
            key={ref.type + ref.id}
            onRemove={onRemove ? () => onRemove(index) : undefined}
            removeLabel={t('attachments.remove', { title: ref.title })}
            className={cx(
              ATTACHMENT_ITEM_CLASS_NAME,
              (presentation === 'inline' || layout !== 'wrap') && 'shrink-0'
            )}
            data-testid={`message-attachment-${ref.id}`}
          >
            <div
              className={cx(
                'group',
                presentation === 'inline'
                  ? ATTACHMENT_INLINE_CARD_CLASS_NAME
                  : ATTACHMENT_CARD_CLASS_NAME,
                open ? ATTACHMENT_CARD_CLICKABLE_CLASS_NAME : ATTACHMENT_CARD_IDLE_CLASS_NAME,
                previewOpen ? ATTACHMENT_CARD_OPEN_CLASS_NAME : undefined
              )}
            >
              <div className="flex min-w-0 flex-1">
                <Button
                  unstyled
                  className="flex w-full min-w-0 items-center gap-[var(--vds-attachment-card-padding)] text-left"
                  onClick={open}
                  aria-label={name}
                >
                  <div
                    className={cx(
                      ATTACHMENT_ICON_CLASS_NAME,
                      presentation === 'inline' && '!size-[var(--vds-space-4)]'
                    )}
                  >
                    <FileFormatIcon
                      name={formatName}
                      source={source}
                      kind={ref.type === 'directory' ? 'dir' : 'file'}
                      className={usesFallbackIcon ? FILE_FALLBACK_ICON_CLASS_NAME : '!size-full'}
                    />
                  </div>
                  <div className={ATTACHMENT_COPY_CLASS_NAME}>
                    <div className={cx(ATTACHMENT_NAME_CLASS_NAME, 'relative')}>
                      {renderActions && presentation === 'inline' && (
                        <span aria-hidden="true" className="invisible min-w-0 truncate">
                          {title}
                        </span>
                      )}
                      <EllipsisText
                        data-slot="attachment-name-end"
                        tooltip={name}
                        tooltipPortalled
                        wrapperClassName={
                          renderActions && presentation === 'inline'
                            ? '!absolute inset-0 !w-auto group-hover/attachment:right-[var(--vds-space-6)] group-focus-within/attachment:right-[var(--vds-space-6)] group-has-[[aria-expanded=true]]/attachment:right-[var(--vds-space-6)]'
                            : 'w-full'
                        }
                      >
                        {title}
                      </EllipsisText>
                    </div>
                    {presentation !== 'inline' && (
                      <div
                        data-slot="attachment-format"
                        className={cx(
                          'w-full truncate text-[length:var(--vds-font-caption)] font-[var(--vds-fw-regular)] leading-[var(--vds-lh-caption)]',
                          unavailable
                            ? 'text-[var(--vds-error-text-primary)]'
                            : 'text-[var(--vds-text-placeholder)]'
                        )}
                      >
                        {format}
                        {unavailable && ` · ${t('attachments.unavailable')}`}
                        {originLabel && ` ·${originLabel}`}
                      </div>
                    )}
                  </div>
                </Button>
              </div>
              {renderActions && presentation !== 'inline' && (
                <div
                  className={cx(
                    ATTACHMENT_ACTIONS_CLASS_NAME,
                    '!static flex w-0 shrink-0 items-center justify-center overflow-hidden group-hover/attachment:ml-[var(--vds-attachment-card-padding)] group-hover/attachment:w-[var(--vds-space-6)] focus-within:ml-[var(--vds-attachment-card-padding)] focus-within:w-[var(--vds-space-6)] has-[[aria-expanded=true]]:ml-[var(--vds-attachment-card-padding)] has-[[aria-expanded=true]]:w-[var(--vds-space-6)]'
                  )}
                >
                  {renderActions(ref)}
                </div>
              )}
            </div>
            {renderActions && presentation === 'inline' && (
              <div
                className={cx(
                  ATTACHMENT_ACTIONS_CLASS_NAME,
                  presentation === 'inline' && '!top-1/2 -translate-y-1/2'
                )}
              >
                {renderActions(ref)}
              </div>
            )}
          </AttachmentContainer>
        )
      })}
    </div>
  )
}
