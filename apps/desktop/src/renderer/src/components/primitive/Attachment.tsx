import React from 'react'
import { MessageSquareText, TextSelect, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  IconButton,
  ScrollArea,
  Tooltip,
  cx,
} from '../ui'

const REMOVE_CLASS_NAME =
  'pointer-events-none absolute -right-[var(--vds-space-1)] -top-[var(--vds-space-1)] z-[var(--vds-z-local-control)] !size-[var(--vds-space-4)] !min-h-0 !min-w-0 !rounded-[var(--vds-radius-circle)] !border-0 !bg-[var(--vds-attachment-remove-bg)] !p-0 !text-[var(--vds-static-white)] opacity-0 hover:!bg-[var(--vds-static-black)] group-hover/attachment:pointer-events-auto group-hover/attachment:opacity-[var(--vds-opacity-full)] group-focus-within/attachment:pointer-events-auto group-focus-within/attachment:opacity-[var(--vds-opacity-full)]'

const REFERENCE_PREVIEW_OFFSET = 8

export function SelectionPreview({
  className,
  children,
  ...props
}: React.ComponentProps<typeof HoverCardContent>): React.JSX.Element {
  return (
    <HoverCardContent
      className={cx(
        '!w-[var(--vds-selection-preview-width)] !max-w-[var(--vds-popover-available-width)] max-h-[var(--vds-selection-preview-max-height)] !rounded-[var(--vds-radius-6)] !border-0 !bg-[var(--vds-static-white)] !p-[var(--vds-space-2)] !shadow-[var(--vds-shadow-2-center)]',
        className
      )}
      {...props}
    >
      <ScrollArea
        className="max-h-[var(--vds-selection-preview-content-max-height)]"
        viewportClassName="max-h-[var(--vds-selection-preview-content-max-height)]"
      >
        {children}
      </ScrollArea>
    </HoverCardContent>
  )
}

export function SelectionQuote({
  text,
  label,
  onOpen,
  onRemove,
  removeLabel,
  openTestId,
}: {
  text: string
  label: string
  onOpen?: () => void
  onRemove?: () => void
  removeLabel?: string
  openTestId?: string
}): React.JSX.Element {
  const { t } = useTranslation('ui')
  const textRef = React.useRef<HTMLSpanElement | null>(null)
  const [overflowing, setOverflowing] = React.useState(false)
  React.useLayoutEffect(() => {
    const element = textRef.current
    if (!element) return
    const update = (): void => {
      setOverflowing(
        element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth
      )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text])
  const content = (
    <span
      ref={textRef}
      className="line-clamp-[var(--vds-selection-preview-lines)] whitespace-pre-wrap [overflow-wrap:anywhere]"
    >
      {text}
    </span>
  )
  return (
    <div className="flex min-w-0 items-start gap-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] p-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)] hover:bg-[var(--vds-other-overlay-1)] focus-within:bg-[var(--vds-other-overlay-1)]">
      <span
        aria-hidden="true"
        className="inline-flex h-[var(--vds-lh-body-lv1)] w-[var(--vds-icon-6)] shrink-0 items-center text-[var(--vds-text-tertiary)]"
      >
        <TextSelect className="size-[var(--vds-icon-6)]" />
      </span>
      <Tooltip
        anchorRef={textRef}
        className="min-w-0 flex-1 !w-auto"
        content={text}
        contentClassName="whitespace-pre-wrap [overflow-wrap:anywhere]"
        disabled={!overflowing}
      >
        {onOpen ? (
          <Button
            unstyled
            size="content"
            aria-label={label}
            data-testid={openTestId}
            className="w-full min-w-0 text-left [font:inherit] text-[inherit]"
            onClick={onOpen}
          >
            {content}
          </Button>
        ) : (
          <span className="block min-w-0">{content}</span>
        )}
      </Tooltip>
      {onRemove && (
        <Tooltip content={t('selection.remove')}>
          <IconButton
            size="xs"
            label={removeLabel ?? t('tag.close')}
            title={undefined}
            icon={<Trash2 />}
            variant="ghost"
            className="!size-[var(--vds-space-5)] mt-[calc((var(--vds-lh-body-lv1)-var(--vds-space-5))/2)] shrink-0 !min-h-0 !min-w-0 !p-0"
            onClick={onRemove}
          />
        </Tooltip>
      )}
    </div>
  )
}

export const AttachmentContainer = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    onRemove?: () => void
    removeLabel?: string
  }
>(function AttachmentContainer({ children, className, onRemove, removeLabel, ...props }, ref) {
  const { t } = useTranslation('ui')
  return (
    <div
      ref={ref}
      className={cx('group/attachment relative box-border min-w-0 max-w-full', className)}
      {...props}
    >
      {children}
      {onRemove && (
        <IconButton
          type="button"
          size="xs"
          variant="secondary"
          data-slot="attachment-remove"
          className={REMOVE_CLASS_NAME}
          label={removeLabel ?? t('tag.close')}
          icon={<X />}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
          }}
          onClick={(event) => {
            event.stopPropagation()
            onRemove()
          }}
        />
      )}
    </div>
  )
})

export function ReferenceAttachment({
  variant = 'default',
  icon,
  label,
  description,
  suffix,
  closeLabel,
  onClose,
  previewTrigger = false,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  variant?: 'default' | 'annotation' | 'text'
  icon?: React.ReactNode
  label: React.ReactNode
  description?: string
  suffix?: React.ReactNode
  closeLabel?: string
  onClose?: () => void
  previewTrigger?: boolean
}): React.JSX.Element {
  const attachmentRef = React.useRef<HTMLDivElement | null>(null)
  const referenceLabel = previewTrigger ? (
    <Button
      type="button"
      unstyled
      size="content"
      className="inline-flex min-w-0 max-w-full cursor-pointer items-center text-left [font:inherit] text-[inherit]"
    >
      {label}
    </Button>
  ) : (
    label
  )
  const attachment = (
    <AttachmentContainer
      ref={attachmentRef}
      className={cx(
        'bg-[var(--vds-other-overlay-1)] hover:bg-[var(--vds-other-overlay-2)]',
        description !== undefined
          ? 'inline-flex h-[var(--vds-attachment-card-height)] w-[var(--vds-attachment-card-width)] shrink-0 items-center gap-[var(--vds-attachment-card-padding)] rounded-[var(--vds-radius-4)] bg-[var(--vds-other-overlay-1)] pl-[var(--vds-attachment-card-padding)] pr-[var(--vds-space-2)] py-[var(--vds-attachment-card-padding)]'
          : 'inline-flex h-[var(--vds-control-height-sm)] shrink-0 items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] border border-solid border-[var(--vds-divider-default)] px-[var(--vds-space-2)] py-[var(--vds-space-1)]',
        variant === 'text' &&
          '!h-auto !gap-[var(--vds-space-1)] !border-0 !bg-transparent !p-0 [&>span]:!text-[var(--vds-brand-text-primary)] [&>span]:!font-[var(--vds-fw-regular)]',
        previewTrigger && 'cursor-pointer',
        className
      )}
      onRemove={variant === 'text' ? undefined : onClose}
      removeLabel={closeLabel}
      {...props}
    >
      {(icon || variant === 'annotation') && (
        <span
          className={
            description !== undefined
              ? 'inline-flex size-[var(--vds-space-8)] shrink-0 items-center justify-center rounded-[var(--vds-radius-4)] text-[var(--vds-text-tertiary)] [&>svg]:size-[var(--vds-icon-7)]'
              : 'inline-flex size-[var(--vds-icon-6)] shrink-0 items-center justify-center text-[var(--vds-text-primary)]'
          }
        >
          {variant === 'annotation' ? <MessageSquareText strokeWidth={1.5} /> : icon}
        </span>
      )}
      {description !== undefined ? (
        <span className="flex min-w-0 flex-1 flex-col text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] leading-[var(--vds-lh-caption)]">
          <span className="min-w-0 truncate text-[var(--vds-text-primary)]">{referenceLabel}</span>
          <span
            className="min-w-0 truncate text-[length:var(--vds-font-caption)] text-[var(--vds-text-placeholder)]"
            title={previewTrigger ? undefined : description}
          >
            {description}
          </span>
        </span>
      ) : (
        <span
          className={cx(
            'min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--vds-text-primary)]',
            variant === 'text'
              ? '[font:inherit] tracking-[inherit]'
              : 'text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-control-label-line-height)]'
          )}
        >
          {referenceLabel}
        </span>
      )}
      {suffix && (
        <span className="shrink-0 text-[length:var(--vds-font-caption)] uppercase leading-[var(--vds-ref-chip-suffix-line-height)] text-[var(--vds-text-tertiary)]">
          {suffix}
        </span>
      )}
    </AttachmentContainer>
  )
  return previewTrigger ? (
    <HoverCardTrigger
      asChild
      positionAnchorRef={attachmentRef}
      sideOffset={REFERENCE_PREVIEW_OFFSET}
    >
      {attachment}
    </HoverCardTrigger>
  ) : (
    attachment
  )
}

export function SentReferenceAttachment({
  variant,
  icon,
  label,
  description,
  details,
  status,
  onOpen,
  className,
  disabled,
  title,
  ...props
}: {
  variant?: 'default' | 'annotation' | 'text'
  icon?: React.ReactNode
  label: React.ReactNode
  description?: string
  details?: React.ReactNode
  status?: React.ReactNode
  onOpen?: () => void
  className?: string
  disabled?: boolean
  title?: string
  'data-testid'?: string
}): React.JSX.Element {
  const attachment = (
    <ReferenceAttachment
      variant={variant}
      data-slot="sent-reference-attachment"
      className={className}
      title={title}
      icon={icon}
      description={description}
      previewTrigger={Boolean(details) && description !== undefined}
      label={
        (onOpen || details) && !(details && description !== undefined) ? (
          <Button
            type="button"
            unstyled
            size="content"
            className="inline-flex min-w-0 max-w-full items-center text-left"
            disabled={disabled}
            onClick={onOpen}
          >
            {label}
          </Button>
        ) : (
          label
        )
      }
      suffix={status}
      {...props}
    />
  )
  return details ? (
    <HoverCard>
      {description !== undefined ? (
        attachment
      ) : (
        <HoverCardTrigger asChild>{attachment}</HoverCardTrigger>
      )}
      {variant === 'annotation' ? (
        <HoverCardContent className="!w-[var(--vds-assistant-notes-width)] !max-w-[var(--vds-assistant-notes-max-width)] overflow-hidden !rounded-[var(--vds-radius-6)] !border-0 !bg-[var(--vds-surface-raised)] !p-0 !shadow-[var(--vds-shadow-2-center)]">
          {details}
        </HoverCardContent>
      ) : description !== undefined ? (
        <SelectionPreview>{details}</SelectionPreview>
      ) : (
        <HoverCardContent className="max-w-[var(--vds-assistant-floating-panel-width)]">
          <ScrollArea className="max-h-[var(--vds-composer-reference-picker-max-height)]">
            {details}
          </ScrollArea>
        </HoverCardContent>
      )}
    </HoverCard>
  ) : (
    attachment
  )
}
