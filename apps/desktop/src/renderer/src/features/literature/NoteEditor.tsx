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

interface PendingSelection {
  start: number
  end: number
}

interface NoteEditorProps {
  draft: Pick<NoteDraft, 'title' | 'text'>
  status: NoteSaveStatus
  error?: string
  titlePlaceholder?: string
  actions?: ReactNode
  onTitleChange: (value: string) => void
  onTextChange: (value: string) => void
  onExport: () => void
}

export function NoteEditor({
  draft,
  status,
  error,
  titlePlaceholder,
  actions,
  onTitleChange,
  onTextChange,
  onExport,
}: NoteEditorProps): React.JSX.Element {
  const { t } = useTranslation('literature')
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
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

  const showStatus = !error && !(status === 'saved' && !draft.text.trim() && !draft.title.trim())

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[var(--vds-space-2)]">
      <div className="flex items-center justify-between gap-[var(--vds-space-2)]">
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
        <div className="flex min-w-0 items-center gap-[var(--vds-space-2)]">
          {showStatus ? (
            <span
              className={`text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] ${
                status === 'saved'
                  ? 'text-[var(--vds-success-text-primary)]'
                  : 'text-[var(--vds-text-tertiary)]'
              }`}
              role="status"
            >
              {status === 'saving'
                ? t('notes.statusSaving')
                : status === 'dirty'
                  ? t('notes.statusUnsaved')
                  : t('notes.statusSaved')}
            </span>
          ) : null}
          <Button icon={<Download size={14} />} size="sm" variant="secondary" onClick={onExport}>
            {t('notes.export')}
          </Button>
          {actions}
        </div>
      </div>
      {error ? (
        <span
          role="alert"
          className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-error-text-primary)]"
        >
          {error}
        </span>
      ) : null}
      <Input
        aria-label={t('notes.title')}
        placeholder={titlePlaceholder}
        value={draft.title}
        onChange={(event) => onTitleChange(event.target.value)}
      />
      {mode === 'edit' ? (
        <div className="flex flex-wrap items-center gap-[var(--vds-space-1)]">
          {blockTools.map((tool) => (
            <IconButton
              key={tool.label}
              icon={<tool.icon size={14} />}
              label={tool.label}
              size="sm"
              variant="ghostIcon"
              onClick={tool.run}
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
            />
          ))}
        </div>
      ) : null}
      {mode === 'edit' ? (
        <Textarea
          aria-label={t('notes.bodyPlaceholder')}
          ref={textareaRef}
          className="min-h-[var(--vds-library-note-editor-min-height)] flex-1 resize-none"
          placeholder={t('notes.bodyPlaceholder')}
          value={draft.text}
          onChange={(event) => onTextChange(event.target.value)}
        />
      ) : (
        <ScrollArea
          className="min-h-[var(--vds-library-note-editor-min-height)] flex-1 rounded-[var(--vds-radius-4)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)]"
          viewportClassName="h-full p-[var(--vds-space-3)]"
        >
          {draft.text.trim() ? (
            <Markdown className="text-[length:var(--vds-font-body-lv2)]" text={draft.text} />
          ) : (
            <p className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]">
              {t('notes.bodyPlaceholder')}
            </p>
          )}
        </ScrollArea>
      )}
    </div>
  )
}
