import {
  ChevronDown,
  Highlighter,
  MessageSquare,
  PenLine,
  Plus,
  Strikethrough,
  Underline,
  WandSparkles,
} from 'lucide-react'
import { useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'

import { requestModelKey } from '../../catalog'
import { ModelMenu } from '../../components/business/ModelMenu'
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  ScrollArea,
  useToast,
} from '../../components/ui'
import type { DocumentPanelContribution } from '../../contracts/features'
import type { PdfRecordSnapshot } from '../../contracts/workbench'
import { useApp } from '../../store'
import { useNoteAutoSave } from './autosave'
import { generateNote, useNoteGeneration } from './generation'
import { insightMarks, insightRequest } from './insights'
import { literatureIdFromDocument } from './note'
import { NOTE_SOURCE_LIMIT } from './sources'
import { PDF_MARK_COLORS } from '../workbench/pdf/records'

type ActionProps = Parameters<NonNullable<DocumentPanelContribution['renderAnnotationAction']>>[0]
const ICONS = {
  highlight: Highlighter,
  underline: Underline,
  strikethrough: Strikethrough,
  comment: MessageSquare,
}

export function GenerateNoteAction(props: ActionProps): React.JSX.Element | null {
  const itemId = literatureIdFromDocument(props.context)
  return itemId ? <GenerateNote key={itemId} {...props} itemId={itemId} /> : null
}

function GenerateNote({
  itemId,
  snapshot,
  disabled,
  openPanel,
  dismissSelection,
  placement = 'annotations',
  onDirectWrite,
}: ActionProps & { itemId: string }): React.JSX.Element {
  const { t, i18n } = useTranslation('literature')
  const { t: pdf } = useTranslation('pdf')
  const { state } = useApp()
  const { toast } = useToast()
  const generation = useNoteGeneration(itemId)
  const { flush } = useNoteAutoSave({ itemId, notes: [] })
  const [open, setOpen] = useState(false)
  const addNoteTrigger = useRef<HTMLButtonElement>(null)
  const [frozen, setFrozen] = useState<PdfRecordSnapshot | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [model, setModel] = useState('')
  const marks = insightMarks(frozen)
  const generationDisabled = !generation.pending && (disabled || !insightMarks(snapshot).length)
  const availableModel =
    state.catalog.models.find((candidate) => candidate.key === model && !candidate.disabled)?.key ??
    ''
  const changed = Boolean(
    frozen &&
    (snapshot?.source_state !== 'available' ||
      frozen.record_revision !== snapshot?.record_revision ||
      frozen.source_revision !== snapshot?.source_revision)
  )
  const changeOpen = (next: boolean): void => {
    if (next) {
      if (generation.pending) {
        toast({
          id: 'note-generation-in-progress',
          title: t('generation.inProgress'),
          tone: 'info',
        })
        return
      }
      dismissSelection?.()
      setFrozen(snapshot)
      setChosen(new Set(insightMarks(snapshot).map((mark) => mark.id)))
      setModel(
        requestModelKey(state.catalog.models, state.model, state.activeSession, state.threads)
      )
    }
    setOpen(next)
  }
  const submit = (): void => {
    if (
      !frozen ||
      changed ||
      disabled ||
      generation.pending ||
      !availableModel ||
      !chosen.size ||
      chosen.size > NOTE_SOURCE_LIMIT
    )
      return
    const request = insightRequest(frozen, chosen, availableModel, i18n.language)
    setOpen(false)
    openPanel()
    void generateNote(itemId, request, flush)
  }
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      {onDirectWrite ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button ref={addNoteTrigger} size="sm" variant="primary" icon={<Plus size={14} />}>
              {t('list.rowMenu.addNote')}
              <ChevronDown aria-hidden="true" size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                disabled={generationDisabled}
                onSelect={() => {
                  addNoteTrigger.current?.focus()
                  changeOpen(true)
                }}
              >
                <WandSparkles size={14} />
                {t('generation.action')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onDirectWrite}>
                <PenLine size={14} />
                {t('readerNotes.directWrite')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenu>
      ) : (
        <DialogTrigger asChild>
          <Button
            className={
              placement === 'panel'
                ? 'min-h-[var(--vds-control-height-sm)] min-w-0 flex-1 !whitespace-normal'
                : 'w-full'
            }
            variant={placement === 'panel' ? 'secondary' : 'primary'}
            size={placement === 'panel' ? 'content' : 'md'}
            icon={<WandSparkles className="size-[var(--vds-icon-8)]" />}
            disabled={generationDisabled}
            data-testid={
              placement === 'panel' ? 'reader-generate-note' : 'annotations-generate-note'
            }
          >
            {t('generation.action')}
          </Button>
        </DialogTrigger>
      )}
      <DialogPortal>
        <DialogContent
          headerLayout="aligned"
          className="flex min-h-0 flex-col overflow-hidden !gap-[var(--vds-space-3)] !px-[var(--vds-space-5)] !py-[var(--vds-space-3)] !bg-[var(--vds-bg-gray-light-default)]"
          data-testid="note-generation-dialog"
        >
          <DialogHeader>
            <DialogTitle>{t('generation.action')}</DialogTitle>
            <DialogDescription className="sr-only">{t('generation.description')}</DialogDescription>
          </DialogHeader>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-[var(--vds-space-3)]">
            <div className="flex items-center gap-[var(--vds-space-2)]">
              <Checkbox
                label={t('generation.all')}
                checked={
                  chosen.size === marks.length && marks.length > 0
                    ? true
                    : chosen.size
                      ? 'mixed'
                      : false
                }
                onCheckedChange={(checked) =>
                  setChosen(new Set(checked ? marks.map((mark) => mark.id) : []))
                }
              />
              <span className="text-[var(--vds-text-tertiary)]">
                {t('generation.selected', { count: chosen.size })}
              </span>
            </div>
            <div className="flex items-center gap-[var(--vds-space-2)]">
              <span className="text-[var(--vds-text-tertiary)]">{t('generation.model')}</span>
              <ModelMenu
                compact
                variant="outline"
                independent
                showEffort={false}
                modelKey={model}
                onModelSelect={(selected) => setModel(selected.key)}
                testIdPrefix="note-generation-model"
              />
            </div>
          </div>
          <ScrollArea
            overlay
            className="flex min-h-0 max-h-[var(--vds-dialog-list-max-height)] flex-1 flex-col -mr-[var(--vds-space-5)]"
            viewportClassName="min-h-0 flex-1 pr-[var(--vds-space-5)]"
            shadow={false}
          >
            <div className="flex flex-col gap-[var(--vds-space-3)]">
              {marks.map((mark) => {
                const MarkIcon = ICONS[mark.style]
                const comments =
                  frozen?.records.comments.filter((comment) => comment.mark_id === mark.id) ?? []
                const label = pdf('page', { page: mark.page })
                return (
                  <div
                    key={mark.id}
                    className="flex items-start gap-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] border border-[var(--vds-divider-default)] bg-[var(--vds-bg-component)] px-[var(--vds-space-3)] pb-[var(--vds-space-3)] pt-[var(--vds-space-2)]"
                  >
                    <Checkbox
                      aria-label={`${label} ${mark.style === 'comment' ? (comments[0]?.body ?? '') : mark.text}`}
                      checked={chosen.has(mark.id)}
                      onCheckedChange={(checked) =>
                        setChosen((current) => {
                          const next = new Set(current)
                          if (checked) next.add(mark.id)
                          else next.delete(mark.id)
                          return next
                        })
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-[var(--vds-space-2)] text-[var(--vds-text-tertiary)]">
                        <span>{label}</span>
                        <span title={pdf(`pdfAnnotation.filter.${mark.style}`)}>
                          <MarkIcon size={14} />
                        </span>
                      </div>
                      {mark.style !== 'comment' ? (
                        <p
                          className="mb-0 mt-[var(--vds-space-2)] line-clamp-2 border-l-[length:var(--vds-border-width-2)] border-[var(--pdf-mark-color)] pl-[var(--vds-space-2)] text-[var(--vds-text-tertiary)]"
                          style={
                            {
                              '--pdf-mark-color': PDF_MARK_COLORS[mark.color],
                            } as CSSProperties
                          }
                        >
                          {mark.text}
                        </p>
                      ) : null}
                      {comments.map((comment) => (
                        <p
                          className="my-[var(--vds-space-2)] whitespace-pre-wrap break-words"
                          key={comment.id}
                        >
                          {comment.body}
                        </p>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </ScrollArea>
          {changed ? <p role="alert">{t('generation.changed')}</p> : null}
          {chosen.size > NOTE_SOURCE_LIMIT ? (
            <p role="alert">{t('generation.limit', { count: NOTE_SOURCE_LIMIT })}</p>
          ) : null}
          <DialogFooter className="pb-[var(--vds-space-2)]">
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t('notes.cancel')}
            </Button>
            <Button
              icon={<WandSparkles className="size-[var(--vds-icon-8)]" />}
              disabled={
                disabled ||
                changed ||
                generation.pending ||
                !chosen.size ||
                chosen.size > NOTE_SOURCE_LIMIT ||
                !availableModel
              }
              onClick={submit}
            >
              {t('generation.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
