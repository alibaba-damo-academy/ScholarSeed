import {
  Bold,
  Code,
  Download,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  Strikethrough,
} from 'lucide-react'
import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Markdown } from '../../components/primitive'
import {
  Alert,
  Button,
  IconButton,
  Input,
  ScrollArea,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
} from '../../components/ui'
import type { NoteDraft, NoteSaveStatus } from './note'
import type { NoteSourceControls } from './NoteSources'

interface PendingSelection {
  start: number
  end: number
}

interface NoteEditorProps {
  draft: Pick<NoteDraft, 'title' | 'text'>
  status: NoteSaveStatus
  error?: string
  disabled?: boolean
  initialMode?: 'edit' | 'preview'
  titlePlaceholder?: string
  navigation?: ReactNode
  stackedHeader?: boolean
  actions?: ReactNode
  sources?: NoteSourceControls
  onTitleChange: (value: string) => void
  onTextChange: (value: string) => void
  onExport?: () => void
  onRetry?: () => void
}

export function NoteEditor({
  draft,
  status,
  error,
  disabled = false,
  initialMode = 'edit',
  titlePlaceholder,
  navigation,
  stackedHeader = false,
  actions,
  sources,
  onTitleChange,
  onTextChange,
  onExport,
  onRetry,
}: NoteEditorProps): React.JSX.Element {
  const { t } = useTranslation('literature')
  const [mode, setMode] = useState<'edit' | 'preview'>(initialMode)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const pendingSelection = useRef<PendingSelection | null>(null)

  useEffect(() => {
    const element = textareaRef.current
    const pending = pendingSelection.current
    if (!element || !pending) return
    pendingSelection.current = null
    element.focus()
    element.setSelectionRange(pending.start, pending.end)
  })

  const replaceText = (next: string, start: number, end: number): void => {
    onTextChange(next)
    pendingSelection.current = { start, end }
  }

  const wrapInline = (before: string, after: string): void => {
    const element = textareaRef.current
    if (!element) return
    const { selectionStart: start, selectionEnd: end, value } = element
    const selected = value.slice(start, end)
    if (
      selected.startsWith(before) &&
      selected.endsWith(after) &&
      selected.length >= before.length + after.length
    ) {
      const inner = selected.slice(before.length, selected.length - after.length)
      replaceText(value.slice(0, start) + inner + value.slice(end), start, start + inner.length)
      return
    }
    if (selected) {
      replaceText(
        `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`,
        start + before.length,
        start + before.length + selected.length
      )
      return
    }
    replaceText(
      `${value.slice(0, start)}${before}${after}${value.slice(end)}`,
      start + before.length,
      start + before.length
    )
  }

  const applyLinePrefix = (prefix: string, existing: RegExp): void => {
    const element = textareaRef.current
    if (!element) return
    const { selectionStart: start, selectionEnd: end, value } = element
    const lineStart = value.lastIndexOf('\n', Math.max(start - 1, 0)) + 1
    let lineEnd = value.indexOf('\n', end)
    if (lineEnd === -1) lineEnd = value.length
    const lines = value.slice(lineStart, lineEnd).split('\n')
    const allPrefixed = lines.every((line) => line.startsWith(prefix))
    const stripped = lines.map((line) => line.replace(existing, ''))
    const nextLines = allPrefixed ? stripped : stripped.map((line) => prefix + line)
    const block = nextLines.join('\n')
    replaceText(
      value.slice(0, lineStart) + block + value.slice(lineEnd),
      lineStart,
      lineStart + block.length
    )
  }

  const blockTools = [
    {
      icon: Heading1,
      label: t('notes.formatHeading1'),
      run: () => applyLinePrefix('# ', /^#{1,3}\s?/),
    },
    {
      icon: Heading2,
      label: t('notes.formatHeading2'),
      run: () => applyLinePrefix('## ', /^#{1,3}\s?/),
    },
    {
      icon: Heading3,
      label: t('notes.formatHeading3'),
      run: () => applyLinePrefix('### ', /^#{1,3}\s?/),
    },
    {
      icon: List,
      label: t('notes.formatBulletList'),
      run: () => applyLinePrefix('- ', /^(?:- |\d+\.\s?)/),
    },
    {
      icon: ListOrdered,
      label: t('notes.formatOrderedList'),
      run: () => applyLinePrefix('1. ', /^(?:- |\d+\.\s?)/),
    },
  ]
  const inlineTools = [
    {
      icon: Bold,
      label: t('notes.formatBold'),
      run: () => wrapInline('**', '**'),
    },
    {
      icon: Italic,
      label: t('notes.formatItalic'),
      run: () => wrapInline('*', '*'),
    },
    {
      icon: Strikethrough,
      label: t('notes.formatStrikethrough'),
      run: () => wrapInline('~~', '~~'),
    },
    {
      icon: Code,
      label: t('notes.formatCode'),
      run: () => wrapInline('`', '`'),
    },
    {
      icon: Link2,
      label: t('notes.formatLink'),
      run: () => wrapInline('[', '](https://)'),
    },
  ]

  const saveStatus =
    !error && !(status === 'saved' && !draft.text.trim() && !draft.title.trim()) ? (
      <span
        className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]"
        role="status"
      >
        {status === 'saving'
          ? t('notes.statusSaving')
          : status === 'dirty'
            ? t('notes.statusUnsaved')
            : t('notes.statusSaved')}
      </span>
    ) : null
  const modeTabs = (
    <Tabs
      aria-label={t('notes.viewMode')}
      value={mode}
      onValueChange={(value) => setMode(value === 'preview' ? 'preview' : 'edit')}
    >
      <TabsList>
        <TabsTrigger value="edit">{t('notes.modeEdit')}</TabsTrigger>
        <TabsTrigger value="preview">{t('notes.modePreview')}</TabsTrigger>
      </TabsList>
    </Tabs>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[var(--vds-space-2)]">
      <div className="flex flex-wrap items-center justify-between gap-[var(--vds-space-2)]">
        {navigation}
        {stackedHeader ? (
          saveStatus
        ) : (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-[var(--vds-space-2)]">
            {saveStatus}
            {modeTabs}
          </div>
        )}
      </div>
      {stackedHeader ? <div className="self-start">{modeTabs}</div> : null}
      {onExport || actions ? (
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-[var(--vds-space-2)]">
          {onExport ? (
            <Button icon={<Download size={14} />} size="sm" variant="ghost" onClick={onExport}>
              {t('notes.export')}
            </Button>
          ) : null}
          {actions}
        </div>
      ) : null}
      {error ? (
        <Alert
          tone="error"
          title={error}
          action={
            onRetry ? (
              <Button size="sm" variant="secondary" disabled={disabled} onClick={onRetry}>
                {t('notes.retrySave')}
              </Button>
            ) : undefined
          }
        />
      ) : null}
      <Input
        aria-label={t('notes.title')}
        className={
          mode === 'preview'
            ? '!h-auto !rounded-none !border-0 !bg-transparent !px-0 !py-[var(--vds-space-2)] !text-[length:var(--vds-font-display-lv2)] !font-[var(--vds-fw-semibold)] !leading-[var(--vds-lh-display-lv2)] ![font-family:var(--vds-font-serif)]'
            : undefined
        }
        placeholder={titlePlaceholder}
        value={draft.title}
        disabled={disabled}
        onChange={(event) => onTitleChange(event.target.value)}
      />
      {mode === 'edit' ? (
        <div className="flex flex-wrap items-center justify-between gap-y-[var(--vds-space-1)]">
          {blockTools.map((tool) => (
            <IconButton
              key={tool.label}
              icon={<tool.icon size={14} />}
              label={tool.label}
              size="sm"
              variant="ghostIcon"
              onClick={tool.run}
              disabled={disabled}
            />
          ))}
          <span
            aria-hidden="true"
            className="mx-[var(--vds-space-1)] h-[var(--vds-library-note-toolbar-divider-height)] w-[var(--vds-library-note-toolbar-divider-width)] bg-[var(--vds-border-default)]"
          />
          {inlineTools.map((tool) => (
            <IconButton
              key={tool.label}
              icon={<tool.icon size={14} />}
              label={tool.label}
              size="sm"
              variant="ghostIcon"
              onClick={tool.run}
              disabled={disabled}
            />
          ))}
          {!disabled
            ? sources?.tools((markdown) => {
                const element = textareaRef.current
                if (!element) return
                const { selectionStart: start, selectionEnd: end, value } = element
                replaceText(
                  value.slice(0, start) + markdown + value.slice(end),
                  start + markdown.length,
                  start + markdown.length
                )
              })
            : null}
        </div>
      ) : null}
      {mode === 'edit' ? (
        <Textarea
          aria-label={t('notes.bodyPlaceholder')}
          ref={textareaRef}
          className="min-h-[var(--vds-library-note-editor-min-height)] flex-1 resize-none"
          placeholder={t('notes.bodyPlaceholder')}
          value={draft.text}
          disabled={disabled}
          onChange={(event) => onTextChange(event.target.value)}
        />
      ) : (
        <ScrollArea
          className="min-h-[var(--vds-library-note-editor-min-height)] flex-1"
          viewportClassName="h-full py-[var(--vds-space-2)]"
        >
          {draft.text.trim() ? (
            <Markdown
              className="text-[length:var(--vds-font-body-lv2)]"
              text={sources?.previewText ?? draft.text}
              renderSourceLink={sources?.renderLink}
            />
          ) : (
            <p className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]">
              {t('notes.bodyPlaceholder')}
            </p>
          )}
          {sources?.coverageView}
        </ScrollArea>
      )}
      {mode === 'edit' ? sources?.editView : null}
      {sources?.stale ? <Alert tone="warning">{t('noteSources.stale')}</Alert> : null}
    </div>
  )
}
