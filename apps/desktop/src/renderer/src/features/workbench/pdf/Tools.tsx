import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageSquareText } from 'lucide-react'
import {
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip
} from '../../../components/ui'
import { Icon } from '../../../icons'
import type { PdfMark } from '../api'
import { PDF_MARK_COLORS, PDF_MARK_PALETTE, type PdfMarkColor } from './records'

export const PDF_COMMENT_TOOL = 'comment'
export type PdfTool = PdfMark['style'] | typeof PDF_COMMENT_TOOL

const TOOL_HOVER_CLASS_NAME = 'enabled:hover:![background:var(--vds-other-overlay-1)]'

const MARK_TOOLS = [
  { style: 'highlight', icon: 'highlighter' },
  { style: 'underline', icon: 'underline' },
  { style: 'strikethrough', icon: 'strikethrough' }
] as const

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
  onOpenChange
}: {
  colors: Record<PdfMark['style'], PdfMarkColor>
  disabled: boolean
  hasSelection: boolean
  onApply: (style: PdfMark['style'], color: PdfMarkColor) => void
  onColor: (style: PdfMark['style'], color: PdfMarkColor) => void
  activeTool?: PdfTool | null
  onToggle?: (tool: PdfTool) => void
  onComment: () => void
  commentOpen: boolean
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation('pdf')
  const labels = {
    highlight: t('addHighlight'),
    underline: t('addUnderline'),
    strikethrough: t('pdfAnnotation.addStrikethrough')
  }
  const paletteLabels = {
    yellow: t('palette.yellow'),
    orange: t('palette.orange'),
    green: t('palette.green'),
    teal: t('palette.teal'),
    blue: t('palette.blue'),
    purple: t('palette.purple'),
    red: t('palette.red'),
    gray: t('palette.gray')
  }
  const [openStyle, setOpenStyle] = useState<PdfMark['style'] | null>(null)
  return (
    <span className="inline-flex items-center gap-[var(--vds-toolbar-icon-gap)]" data-pdf-annotation-tools>
      {MARK_TOOLS.map((tool) => (
        <span
          key={tool.style}
          className="inline-flex items-center rounded-[var(--vds-radius-4)] border border-solid border-[var(--vds-border-default)]"
          data-pdf-tool={tool.style}
        >
          <Tooltip portalled content={labels[tool.style]} side="bottom">
            <IconButton
              className={TOOL_HOVER_CLASS_NAME}
              label={labels[tool.style]}
              title={undefined}
              icon={<Icon name={tool.icon} size={16} />}
              size="sm"
              variant={
                onToggle && activeTool === tool.style ? 'secondary' : 'ghost'
              }
              aria-pressed={onToggle ? activeTool === tool.style : undefined}
              disabled={disabled || (!onToggle && !hasSelection)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() =>
                onToggle
                  ? onToggle(tool.style)
                  : onApply(tool.style, colors[tool.style])
              }
            />
          </Tooltip>
          <Popover
            open={openStyle === tool.style}
            onOpenChange={(open) => {
              setOpenStyle(open ? tool.style : null)
              onOpenChange?.(open)
            }}
          >
            <PopoverTrigger asChild>
              <Tooltip
                portalled
                content={t('markColors', { style: labels[tool.style] })}
                side="bottom"
              >
                <IconButton
                  className={TOOL_HOVER_CLASS_NAME}
                  label={t('markColors', { style: labels[tool.style] })}
                  title={undefined}
                  icon={
                    <span className="inline-flex items-center">
                      <span
                        className="size-[10px] rounded-full border border-[var(--vds-border-default)] bg-[var(--pdf-tool-color)]"
                        style={
                          {
                            '--pdf-tool-color':
                              PDF_MARK_COLORS[colors[tool.style]]
                          } as React.CSSProperties
                        }
                      />
                      <Icon name="chevron-down" size={10} />
                    </span>
                  }
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                />
              </Tooltip>
            </PopoverTrigger>
            <PopoverContent
              className="grid-flow-col grid-rows-1 gap-1 p-2"
              aria-label={t('markColors', { style: labels[tool.style] })}
            >
              {PDF_MARK_PALETTE.map((color) => (
                <IconButton
                  key={color.name}
                  label={t('markColor', { color: paletteLabels[color.name] })}
                  aria-pressed={colors[tool.style] === color.name}
                  size="md"
                  variant={
                    colors[tool.style] === color.name ? 'secondary' : 'ghost'
                  }
                  icon={
                    <span
                      className="size-[18px] rounded-full border border-[var(--vds-border-default)] bg-[var(--pdf-tool-color)]"
                      style={
                        { '--pdf-tool-color': color.hex } as React.CSSProperties
                      }
                    />
                  }
                  onClick={() => {
                    onColor(tool.style, color.name)
                    setOpenStyle(null)
                    onOpenChange?.(false)
                    if (!onToggle && hasSelection)
                      onApply(tool.style, color.name)
                  }}
                />
              ))}
            </PopoverContent>
          </Popover>
        </span>
      ))}
      <Tooltip portalled content={t('addComment')} side="bottom">
        <IconButton
          className={TOOL_HOVER_CLASS_NAME}
          label={t('addComment')}
          title={undefined}
          icon={<MessageSquareText size={16} />}
          size="sm"
          variant={
            (onToggle ? activeTool === PDF_COMMENT_TOOL : commentOpen)
              ? 'secondary'
              : 'ghost'
          }
          aria-pressed={onToggle ? activeTool === PDF_COMMENT_TOOL : undefined}
          disabled={disabled || (!onToggle && !hasSelection)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => (onToggle ? onToggle(PDF_COMMENT_TOOL) : onComment())}
        />
      </Tooltip>
    </span>
  )
}
