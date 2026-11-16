import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Ellipsis, Highlighter, MessageSquareText } from 'lucide-react'
import {
  IconButton,
  Divider,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  Switch,
} from '../../../components/ui'
import { documentSelectionInteractionProps } from '../focus'
import { Icon } from '../../../icons'
import type { PdfTextMarkStyle } from '../../../contracts/workbench'
import { PDF_MARK_COLORS, PDF_MARK_PALETTE, type PdfMarkColor } from './records'

export const PDF_COMMENT_TOOL = 'comment'
export const PDF_COPY_FEEDBACK_DURATION_MS = 3_000
export type PdfTool = PdfTextMarkStyle | typeof PDF_COMMENT_TOOL

const TOOL_HOVER_CLASS_NAME =
  'enabled:hover:![background:var(--vds-other-overlay-1)] aria-pressed:enabled:![background:var(--vds-surface-active)] aria-pressed:enabled:hover:![background:var(--vds-surface-active)]'

export function PdfSelectionActions({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="contents [--vds-control-padding-sm:0_calc(var(--vds-space-1)*1.5)] [&_button]:!h-[var(--vds-control-height-sm)] [&_button]:!text-[length:var(--vds-font-body-lv1)] [&_button:not(.vds-icon-button)]:!text-[var(--vds-text-primary)] [&_button_svg]:!text-[var(--vds-icon-outline-default)] [&_button_.vds-icon]:!text-[var(--vds-icon-outline-default)] [&_button[aria-pressed=true]]:!bg-[var(--vds-surface-active)] [&_.vds-icon-button]:!w-[var(--vds-control-height-sm)] [&_.vds-icon-button[aria-pressed=true]_svg]:!text-[var(--vds-text-primary)] [&_.vds-icon-button[aria-pressed=true]_.vds-icon]:!text-[var(--vds-text-primary)]">
      {children}
    </div>
  )
}

const MARK_TOOLS = [
  { style: 'highlight', icon: 'highlighter', selectionOrder: 3 },
  { style: 'underline', icon: 'underline', selectionOrder: 1 },
  { style: 'strikethrough', icon: 'strikethrough', selectionOrder: 2 },
] as const

export function PdfSelectionMenu({
  enabled,
  disabled,
  onEnabledChange,
}: {
  enabled: boolean
  disabled?: boolean
  onEnabledChange: (enabled: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation('pdf')
  return (
    <DropdownMenu>
      <Tooltip portalled content={t('selectionMore')} side="bottom">
        <DropdownMenuTrigger asChild>
          <IconButton
            label={t('selectionMore')}
            title={undefined}
            icon={<Ellipsis size={16} />}
            size="sm"
            variant="ghost"
          />
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent
        {...documentSelectionInteractionProps}
        align="end"
        aria-label={t('selectionMore')}
      >
        <div className="flex items-center gap-[var(--vds-space-6)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-primary)]">
          <span>{t('selectionAutomatic')}</span>
          <Switch
            label={t('selectionAutomatic')}
            checked={enabled}
            disabled={disabled}
            onCheckedChange={onEnabledChange}
          />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function PdfTools({
  colors,
  disabled,
  hasSelection,
  onApply,
  onColor,
  onComment,
  commentOpen,
  activeTool,
  onToggle,
  onOpenChange,
  selectionColor,
  onSelectionColor,
  section = 'all',
}: {
  colors: Record<PdfTextMarkStyle, PdfMarkColor>
  disabled: boolean
  hasSelection: boolean
  onApply: (style: PdfTextMarkStyle, color: PdfMarkColor) => void
  onColor: (style: PdfTextMarkStyle, color: PdfMarkColor) => void
  activeTool?: PdfTool | null
  onToggle?: (tool: PdfTool) => void
  onComment: () => void
  commentOpen: boolean
  onOpenChange?: (open: boolean) => void
  selectionColor?: PdfMarkColor
  onSelectionColor?: (color: PdfMarkColor) => void
  section?: 'all' | 'marks' | 'comment'
}): React.JSX.Element {
  const { t } = useTranslation('pdf')
  const labels = {
    highlight: t('addHighlight'),
    underline: t('addUnderline'),
    strikethrough: t('pdfAnnotation.addStrikethrough'),
  }
  const paletteLabels = {
    yellow: t('palette.yellow'),
    orange: t('palette.orange'),
    green: t('palette.green'),
    teal: t('palette.teal'),
    blue: t('palette.blue'),
    purple: t('palette.purple'),
    red: t('palette.red'),
    gray: t('palette.gray'),
  }
  const [openStyle, setOpenStyle] = useState<PdfTextMarkStyle | null>(null)
  const compact = selectionColor !== undefined
  const colorPicker = (style: PdfTextMarkStyle): React.JSX.Element => {
    const selectedColor = selectionColor ?? colors[style]
    const label = t('selectionColor')
    return (
      <Popover
        open={openStyle === style}
        onOpenChange={(open) => {
          setOpenStyle(open ? style : null)
          onOpenChange?.(open)
        }}
      >
        <Tooltip portalled content={label} side="bottom">
          <PopoverTrigger asChild>
            <IconButton
              data-pdf-color-trigger
              className={`${TOOL_HOVER_CLASS_NAME} [&.vds-icon-button[data-pdf-color-trigger]]:!w-auto !min-w-0 !border-0 !px-[var(--vds-space-1)] !text-[var(--vds-icon-outline-default)] [&>span]:!w-auto`}
              label={label}
              title={undefined}
              icon={
                <span className="inline-flex items-center gap-[var(--vds-space-half)]">
                  <span
                    className="block aspect-square size-[calc(var(--vds-space-2)+var(--vds-space-half))] shrink-0 rounded-full border border-[var(--vds-border-default)] bg-[var(--pdf-tool-color)]"
                    style={
                      { '--pdf-tool-color': PDF_MARK_COLORS[selectedColor] } as React.CSSProperties
                    }
                  />
                  <Icon name="chevron-down" size={10} />
                </span>
              }
              size="sm"
              variant="ghost"
              disabled={disabled}
            />
          </PopoverTrigger>
        </Tooltip>
        <PopoverContent
          className="grid-flow-col grid-rows-1 gap-[var(--vds-space-1)] p-[var(--vds-space-2)]"
          aria-label={label}
        >
          {PDF_MARK_PALETTE.map((color) => (
            <IconButton
              key={color.name}
              label={t('markColor', { color: paletteLabels[color.name] })}
              aria-pressed={selectedColor === color.name}
              size="md"
              variant={selectedColor === color.name ? 'secondary' : 'ghost'}
              icon={
                <span
                  className="block aspect-square size-[calc(var(--vds-space-4)+var(--vds-space-half))] shrink-0 rounded-full border border-[var(--vds-border-default)] bg-[var(--pdf-tool-color)]"
                  style={{ '--pdf-tool-color': color.hex } as React.CSSProperties}
                />
              }
              onClick={() => {
                if (compact) onSelectionColor?.(color.name)
                else {
                  for (const tool of MARK_TOOLS) onColor(tool.style, color.name)
                  if (!onToggle && hasSelection) onApply(style, color.name)
                }
                setOpenStyle(null)
                onOpenChange?.(false)
              }}
            />
          ))}
        </PopoverContent>
      </Popover>
    )
  }
  return (
    <span
      className="inline-flex items-center gap-[var(--vds-toolbar-icon-gap)]"
      data-pdf-annotation-tools
    >
      {section !== 'comment' &&
        (compact
          ? [...MARK_TOOLS].sort((left, right) => left.selectionOrder - right.selectionOrder)
          : MARK_TOOLS
        ).map((tool) => (
          <span key={tool.style} className="inline-flex items-center" data-pdf-tool={tool.style}>
            <Tooltip portalled content={labels[tool.style]} side="bottom" consumeEscape={!onToggle}>
              <IconButton
                className={TOOL_HOVER_CLASS_NAME}
                label={labels[tool.style]}
                title={undefined}
                icon={
                  tool.style === 'highlight' ? (
                    <Highlighter size={16} />
                  ) : (
                    <Icon name={tool.icon} size={16} />
                  )
                }
                size="sm"
                variant="ghostIcon"
                aria-pressed={onToggle ? activeTool === tool.style : undefined}
                disabled={disabled || (!onToggle && !hasSelection)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (onToggle) onToggle(tool.style)
                  else if (selectionColor !== undefined) {
                    onColor(tool.style, selectionColor)
                    onApply(tool.style, selectionColor)
                  } else onApply(tool.style, colors[tool.style])
                }}
              />
            </Tooltip>
          </span>
        ))}
      {section !== 'comment' && colorPicker('highlight')}
      {compact && section === 'all' && (
        <Divider
          orientation="vertical"
          className="!self-center !min-h-0 !h-[var(--vds-lh-body-lv1)] [--vds-divider-margin-vertical:0_var(--vds-space-1)]"
        />
      )}
      {section !== 'marks' && (
        <Tooltip portalled content={t('addComment')} side="bottom" consumeEscape={!onToggle}>
          <IconButton
            className={TOOL_HOVER_CLASS_NAME}
            label={t('addComment')}
            title={undefined}
            icon={<MessageSquareText size={16} />}
            size="sm"
            variant="ghostIcon"
            aria-pressed={onToggle ? activeTool === PDF_COMMENT_TOOL : commentOpen}
            disabled={disabled || (!onToggle && !hasSelection)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => (onToggle ? onToggle(PDF_COMMENT_TOOL) : onComment())}
          />
        </Tooltip>
      )}
      {compact && section === 'all' && (
        <Divider
          orientation="vertical"
          className="!self-center !min-h-0 !h-[var(--vds-lh-body-lv1)] [--vds-divider-margin-vertical:0_var(--vds-space-1)]"
        />
      )}
    </span>
  )
}
