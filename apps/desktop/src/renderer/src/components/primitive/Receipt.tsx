import React from 'react'
import { BookOpen, ChevronDown, Ellipsis } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Card,
  Collapsible,
  CollapsibleContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  EllipsisText,
  ScrollArea,
  type ButtonSize,
  cx,
} from '../ui'
import { PRODUCT_MENU_CONTENT_CLASS } from './menu'

export const ARTIFACT_ICON_CLASS =
  'flex size-[var(--vds-artifact-card-icon-size)] shrink-0 items-center justify-center'
const ARTIFACT_ICON_COLOR_CLASS =
  'bg-[var(--vds-brand-light-bg-default)] text-[var(--vds-brand-text-primary)] [&_svg]:!text-[var(--vds-brand-text-primary)]'
export const ARTIFACT_OUTLINE_ICON_CLASS = `rounded-[var(--vds-radius-5)] [&_svg]:size-[var(--vds-icon-10)] ${ARTIFACT_ICON_COLOR_CLASS}`
export const ARTIFACT_BORDERED_ICON_CLASS =
  'rounded-[var(--vds-radius-5)] border border-[var(--vds-divider-default)] text-[var(--vds-text-primary)] [&_svg]:size-[var(--vds-icon-10)]'
export const ARTIFACT_TITLE_CLASS =
  'text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] font-[var(--vds-fw-medium)] text-[var(--vds-text-primary)]'
export const ARTIFACT_DESCRIPTION_CLASS =
  'text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)]'

export function ArtifactOpenButton({
  onOpen,
  defaultLabel,
  buttonText,
  options,
  onOptionsOpen,
  busy = false,
  size = 'sm',
}: {
  onOpen: () => void
  defaultLabel?: string
  buttonText?: string
  options?: React.ReactNode
  onOptionsOpen?: () => void
  busy?: boolean
  size?: ButtonSize
}): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const label = defaultLabel ?? t('artifactEntry.openInRightTab')
  const openButton = (
    <Button
      size={size}
      variant="outline"
      className={options ? '!rounded-e-none' : undefined}
      title={label}
      disabled={busy}
      data-testid="artifact-open-default"
      onClick={onOpen}
    >
      {buttonText ?? t(options ? 'artifactEntry.openWith' : 'artifactEntry.open')}
    </Button>
  )
  if (!options) return openButton

  return (
    <div className="inline-flex shrink-0 items-center">
      {openButton}
      <DropdownMenu onOpenChange={(open) => open && onOptionsOpen?.()}>
        <DropdownMenuTrigger asChild>
          <IconButton
            icon={<ChevronDown />}
            label={t('artifactEntry.chooseOpenMethod')}
            size="sm"
            variant="outline"
            className="!rounded-s-none !border-s-0"
            disabled={busy}
            data-testid="artifact-open-options"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className={PRODUCT_MENU_CONTENT_CLASS}>
          <DropdownMenuItem onSelect={onOpen}>{label}</DropdownMenuItem>
          <DropdownMenuSeparator />
          {options}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function Receipt({
  title,
  className,
  count,
  icon = <BookOpen />,
  onOpen,
  openLabel = title,
  defaultOpenLabel,
  openButtonText,
  openOptions,
  onOpenOptions,
  showOpenButton = true,
  openButtonSize,
  busy = false,
  menu,
  onMenuOpen,
  action,
  actionRevealOnHover = false,
  description,
  titleTooltip,
  iconAppearance = 'outline',
  compact = false,
  preview,
  inlinePreview = false,
  previewCollapsible = true,
  defaultExpanded = false,
  expandLabel = title,
  collapseLabel = title,
  previewOverlay = false,
  previewOverlayScrollOnly = false,
  previewPlacement = 'separate',
  previewViewportClassName = 'max-h-[var(--vds-literature-receipt-preview-height)]',
  previewContentClassName = 'p-[var(--vds-space-4)]',
}: {
  title: string
  className?: string
  count?: string
  icon?: React.ReactNode
  onOpen: () => void
  openLabel?: string
  defaultOpenLabel?: string
  openButtonText?: string
  openOptions?: React.ReactNode
  onOpenOptions?: () => void
  showOpenButton?: boolean
  openButtonSize?: ButtonSize
  busy?: boolean
  menu?: React.ReactNode
  onMenuOpen?: () => void
  action?: React.ReactNode
  actionRevealOnHover?: boolean
  description?: string
  titleTooltip?: string
  iconAppearance?: 'asset' | 'outline' | 'bordered'
  compact?: boolean
  preview?: React.ReactNode
  inlinePreview?: boolean
  previewCollapsible?: boolean
  defaultExpanded?: boolean
  expandLabel?: string
  collapseLabel?: string
  previewOverlay?: boolean
  previewOverlayScrollOnly?: boolean
  previewPlacement?: 'separate' | 'inside'
  previewViewportClassName?: string
  previewContentClassName?: string
}): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const [expanded, setExpanded] = React.useState(defaultExpanded)
  const collapsiblePreview = preview && !inlinePreview
  const headerLayout = 'flex h-[var(--vds-artifact-card-height)] w-full min-w-0 items-center'
  const header = (
    <>
      <Button
        variant="ghost"
        size="content"
        disabled={busy}
        aria-busy={busy}
        aria-label={openLabel}
        data-testid="artifact-open"
        onClick={onOpen}
        className={cx(
          'flex min-w-0 flex-1 shrink items-center self-stretch justify-start gap-[var(--vds-space-2)] overflow-hidden !rounded-none !bg-transparent !py-0 text-left',
          compact
            ? '!border-0 !pl-[calc(var(--vds-space-4)-var(--vds-border-width-1))] !pr-[var(--vds-space-3)]'
            : 'px-[var(--vds-space-3)]'
        )}
      >
        <span
          aria-hidden
          className={cx(
            compact
              ? 'flex size-[var(--vds-control-height-standard)] shrink-0 items-center justify-center'
              : ARTIFACT_ICON_CLASS,
            iconAppearance === 'bordered' && ARTIFACT_BORDERED_ICON_CLASS,
            iconAppearance === 'outline' &&
              (compact
                ? `rounded-[var(--vds-radius-4)] [&_svg]:size-[var(--vds-icon-8)] ${ARTIFACT_ICON_COLOR_CLASS}`
                : ARTIFACT_OUTLINE_ICON_CLASS)
          )}
        >
          {icon}
        </span>
        <span
          className={cx(
            'grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)]',
            compact &&
              '-my-[calc(var(--vds-space-1)-var(--vds-border-width-1))] gap-[var(--vds-space-1)]'
          )}
        >
          <EllipsisText
            className={cx(
              ARTIFACT_TITLE_CLASS,
              compact && '!leading-[var(--vds-control-label-line-height)]'
            )}
            tooltip={titleTooltip ?? [title, count].filter(Boolean).join(' ')}
            tooltipContentClassName="whitespace-pre-wrap"
            tooltipPortalled
          >
            {title}
            {count && ` ${count}`}
          </EllipsisText>
          {description && (
            <EllipsisText className={ARTIFACT_DESCRIPTION_CLASS} tooltipPortalled>
              {description}
            </EllipsisText>
          )}
        </span>
      </Button>
      <div
        className={cx(
          'relative ml-auto flex shrink-0 items-center gap-[var(--vds-space-1)] py-[var(--vds-space-2)]',
          compact
            ? 'pr-[calc(var(--vds-space-4)-var(--vds-border-width-1))]'
            : 'pr-[var(--vds-space-3)]'
        )}
      >
        {actionRevealOnHover && action ? (
          <span className="absolute inset-y-0 right-full hidden items-center bg-[var(--receipt-background)] pr-[var(--vds-space-1)] group-hover/receipt:inline-flex group-focus-within/receipt:inline-flex before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-[var(--vds-space-4)] before:bg-[linear-gradient(to_right,transparent,var(--receipt-background))] before:content-['']">
            {action}
          </span>
        ) : (
          action
        )}
        {showOpenButton && (
          <ArtifactOpenButton
            onOpen={onOpen}
            defaultLabel={defaultOpenLabel}
            buttonText={openButtonText}
            options={openOptions}
            onOptionsOpen={onOpenOptions}
            busy={busy}
            size={openButtonSize}
          />
        )}
        {(menu || (collapsiblePreview && previewCollapsible)) && (
          <DropdownMenu onOpenChange={(open) => open && onMenuOpen?.()}>
            <DropdownMenuTrigger asChild>
              <IconButton
                icon={<Ellipsis className="rotate-90" />}
                label={t('artifactEntry.moreActions', { name: title })}
                variant="ghostIcon"
                size="sm"
                data-testid="artifact-more-actions"
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className={PRODUCT_MENU_CONTENT_CLASS}
              data-testid="artifact-dropdown-menu"
            >
              {collapsiblePreview && previewCollapsible && (
                <DropdownMenuItem
                  data-testid="receipt-toggle"
                  onSelect={() => setExpanded((value) => !value)}
                >
                  {expanded ? collapseLabel : expandLabel}
                </DropdownMenuItem>
              )}
              {menu}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </>
  )
  const previewInside = Boolean(collapsiblePreview) && previewPlacement === 'inside'
  const stacked = inlinePreview || previewInside
  const scrollablePreview = collapsiblePreview ? (
    <CollapsibleContent className="!rounded-none !border-0 !bg-transparent !p-0">
      {expanded && (
        <ScrollArea
          overlay={previewOverlay}
          overlayScrollOnly={previewOverlayScrollOnly}
          orientation="vertical"
          viewportClassName={previewViewportClassName}
          viewportProps={{
            tabIndex: 0,
            role: 'region',
            'aria-label': title,
            'data-testid': 'receipt-preview',
          }}
          className={
            previewInside
              ? undefined
              : 'rounded-b-[var(--vds-radius-6)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-surface-raised)]'
          }
        >
          <div className={previewContentClassName}>{preview}</div>
        </ScrollArea>
      )}
    </CollapsibleContent>
  ) : null
  const receipt = (
    <Card
      padding="none"
      data-artifact-receipt
      className={cx(
        'group/receipt relative box-border w-full min-w-0 overflow-hidden [--vds-card-radius:var(--vds-radius-6)] [--receipt-background:var(--vds-artifact-card-bg)] !bg-[var(--receipt-background)] transition-shadow duration-[var(--vds-duration-fast)] motion-reduce:transition-none hover:!shadow-[var(--vds-shadow-1-center)] active:[--receipt-background:var(--vds-artifact-card-pressed)] [&:has([aria-expanded=true])]:[--receipt-background:var(--vds-artifact-card-pressed)] !shadow-none',
        stacked ? 'flex flex-col' : headerLayout,
        previewInside && expanded && 'pb-[var(--vds-space-3)]',
        compact && '!border-[var(--vds-divider-default)]',
        className
      )}
    >
      {stacked ? <div className={headerLayout}>{header}</div> : header}
      {inlinePreview && preview && (
        <div className="px-[var(--vds-space-3)] pb-[var(--vds-space-3)]">{preview}</div>
      )}
      {previewInside && scrollablePreview}
    </Card>
  )
  if (!preview || inlinePreview) return receipt
  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} className="w-full min-w-0 !gap-0">
      {receipt}
      {!previewInside && scrollablePreview}
    </Collapsible>
  )
}
