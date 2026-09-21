import { Folder } from 'lucide-react'
import React from 'react'
import { useTranslation } from 'react-i18next'

import { FilePreviewTarget } from '../../model'
import { FILE_REF_KIND } from '../../reference'
import { ComposerReference } from '../../store'
import { useDocumentWorkspace } from '../../features/workbench/workspace'
import { IconButton } from '../ui'
import { cx } from '../ui/utils'
import { IconFont } from './Iconfont'
import { fileIconForName } from './FileIcon'

type FileReference = Extract<ComposerReference, { type: 'file' }>
type DirectoryReference = Extract<ComposerReference, { type: 'directory' }>
type LocalReference = FileReference | DirectoryReference

const ATTACHMENTS_CLASS_NAME = 'contents'
const ATTACHMENT_ITEM_CLASS_NAME =
  'group/attachment relative box-border max-w-full shrink-0 pb-[var(--vds-space-1)] pr-[var(--vds-space-1)]'
const ATTACHMENT_ACTIONS_CLASS_NAME =
  'absolute right-1 top-0 z-[var(--vds-z-local-control)] pointer-events-none opacity-0 transition-opacity duration-150 group-hover/attachment:pointer-events-auto group-hover/attachment:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto has-[[aria-expanded=true]]:opacity-100'
const ATTACHMENT_CARD_CLASS_NAME =
  'relative inline-flex box-border h-[28px] max-w-full items-center gap-[8px] rounded-[8px] border border-solid border-[var(--vds-divider-default)] bg-[var(--vds-other-overlay-1)] px-[8px] py-[4px] text-left font-[inherit] text-[inherit]'
const ATTACHMENT_CARD_CLICKABLE_CLASS_NAME = 'cursor-pointer'
const ATTACHMENT_CARD_IDLE_CLASS_NAME = 'cursor-default'
const ATTACHMENT_CARD_OPEN_CLASS_NAME =
  'border border-[var(--brand-ink)] bg-[color-mix(in_srgb,var(--active-bg)_68%,var(--bg-2))] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--brand-ink)_16%,transparent)]'
const ATTACHMENT_ICON_CLASS_NAME =
  'inline-flex size-3 shrink-0 items-center justify-center overflow-hidden rounded-[2px] text-[var(--vds-text-8)]'
const ATTACHMENT_COPY_CLASS_NAME =
  'flex min-w-0 items-center gap-[var(--vds-space-2)]'
const ATTACHMENT_NAME_CLASS_NAME =
  'flex min-w-0 overflow-hidden text-[14px] font-[var(--vds-fw-medium)] leading-[20px] text-[var(--vds-text-8)]'
const ATTACHMENT_REMOVE_CLASS_NAME =
  'relative ml-auto flex !size-2 scale-[0.8] !min-h-3 !min-w-3 shrink-0 items-center justify-center !p-0 text-[var(--vds-text-tertiary)]'
const ATTACHMENT_REMOVE_ICON_CLASS_NAME = 'block text-[12px]'

function fileName(ref: LocalReference): string {
  const title = ref.title || ref.id
  const clean = title.split(/[?#]/)[0] || title
  const slash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  return slash >= 0 ? clean.slice(slash + 1) : clean
}

function attachmentPreviewTarget(ref: FileReference): FilePreviewTarget {
  return {
    path: ref.path,
    absolutePath: ref.path,
    title: ref.title || ref.id,
    size: ref.size,
    source: ref.previewSource
  }
}

export function ComposerAttachments({
  refs,
  onRemove,
  onOpen,
  renderActions
}: {
  refs: ComposerReference[]
  onRemove?: (index: number) => void
  onOpen?: (target: FilePreviewTarget) => void
  renderActions?: (ref: FileReference) => React.ReactNode
}): React.JSX.Element | null {
  const { t } = useTranslation('ui')
  const documents = useDocumentWorkspace()
  const localRefs = refs
    .map((ref, index) => ({ ref, index }))
    .filter(
      (row): row is { ref: LocalReference; index: number } =>
        row.ref.type === FILE_REF_KIND || row.ref.type === 'directory'
    )
  if (!localRefs.length) return null
  const openPreviewPaths = new Set(
    Object.values(documents.sessions).map((session) => session.source.path)
  )

  return (
    <div className={ATTACHMENTS_CLASS_NAME}>
      {localRefs.map(({ ref, index }) => {
        const name = fileName(ref)
        const open = onOpen && ref.type === 'file'
          ? (): void => onOpen(attachmentPreviewTarget(ref))
          : undefined
        const previewOpen = openPreviewPaths.has(ref.path)
        return (
          <div
            key={ref.type + ref.id}
            className={ATTACHMENT_ITEM_CLASS_NAME}
            data-testid={`message-attachment-${ref.id}`}
          >
            <div
              className={cx(
                'group',
                ATTACHMENT_CARD_CLASS_NAME,
                onRemove ? 'pr-[8px]' : undefined,
                renderActions ? 'pr-6' : undefined,
                open
                  ? ATTACHMENT_CARD_CLICKABLE_CLASS_NAME
                  : ATTACHMENT_CARD_IDLE_CLASS_NAME,
                previewOpen ? ATTACHMENT_CARD_OPEN_CLASS_NAME : undefined
              )}
              title={ref.title}
              onClick={open}
              onKeyDown={(event) => {
                if (!open || (event.key !== 'Enter' && event.key !== ' '))
                  return
                event.preventDefault()
                open()
              }}
              role={open ? 'button' : undefined}
              tabIndex={open ? 0 : undefined}
            >
              <div className={ATTACHMENT_ICON_CLASS_NAME}>
                {React.createElement(ref.type === 'directory' ? Folder : fileIconForName(ref.title || ref.id), {
                  size: 16,
                  strokeWidth: 1.8
                })}
              </div>
              <div className={ATTACHMENT_COPY_CLASS_NAME}>
                <div className={ATTACHMENT_NAME_CLASS_NAME}>
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                    {name}
                  </span>
                </div>
              </div>
              {onRemove && (
                <IconButton
                  type="button"
                  label={t('attachments.remove', { title: ref.title })}
                  className={ATTACHMENT_REMOVE_CLASS_NAME}
                  icon={
                    <IconFont
                      className={ATTACHMENT_REMOVE_ICON_CLASS_NAME}
                      type="line-operation-close"
                    />
                  }
                  size="sm"
                  variant="ghost"
                  onClick={(event) => {
                    event.stopPropagation()
                    onRemove(index)
                  }}
                />
              )}
            </div>
            {renderActions && ref.type === 'file' && (
              <div className={ATTACHMENT_ACTIONS_CLASS_NAME}>
                {renderActions(ref)}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
