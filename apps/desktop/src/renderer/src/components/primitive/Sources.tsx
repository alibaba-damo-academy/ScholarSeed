import type { JSX } from 'react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, FileText, Globe } from 'lucide-react'
import {
  Button,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  IconButton,
  ScrollArea,
} from '../ui'

export interface AnswerSource {
  id: string
  kind: 'file' | 'web'
  title: string
  location: string
  excerpt: string
  url?: string
}
const EXCERPT_COLLAPSE_LENGTH = 240
const SOURCE_ICON_LIMIT = 3

function SourceIcon({ kind }: { kind: AnswerSource['kind'] }): JSX.Element {
  const Icon = kind === 'file' ? FileText : Globe
  return <Icon className="size-[var(--vds-icon-7)] shrink-0" aria-hidden />
}

function SourceExcerpt({
  source,
  onOpen,
}: {
  source: AnswerSource
  onOpen: (source: AnswerSource) => void
}): JSX.Element {
  const { t } = useTranslation('components')
  const [expanded, setExpanded] = useState(false)
  const long = source.excerpt.length > EXCERPT_COLLAPSE_LENGTH
  return (
    <div className="grid min-w-0 gap-[var(--vds-space-2)]">
      <Button
        variant="ghost"
        size="content"
        className="min-w-0 justify-start !whitespace-normal text-left"
        onClick={() => onOpen(source)}
      >
        <SourceIcon kind={source.kind} />
        <span className="break-words">{source.title}</span>
      </Button>
      <p className="m-0 text-[length:var(--vds-font-caption)] text-[var(--vds-text-tertiary)]">
        {source.location}
      </p>
      <ScrollArea className="max-h-[var(--vds-assistant-citation-expanded-max-height)]">
        <Button
          variant="ghost"
          size="content"
          className="block w-full !whitespace-normal text-left text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)]"
          onClick={() => onOpen(source)}
        >
          <span className={!expanded && long ? 'line-clamp-4' : 'whitespace-pre-wrap'}>
            {source.excerpt}
          </span>
        </Button>
      </ScrollArea>
      {long && (
        <Button
          size="xs"
          variant="ghost"
          aria-expanded={expanded}
          className="justify-self-start"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? t('answer.collapse') : t('answer.expand')}
        </Button>
      )}
    </div>
  )
}

/** Hover and pinned click share one portal, so preview and pinned content cannot overlap. */
function SourceHover({
  trigger,
  children,
  pin = false,
}: {
  trigger: ReactNode
  children: ReactNode
  pin?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const content = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent): void => {
      if (
        root.current?.contains(event.target as Node) ||
        content.current?.contains(event.target as Node)
      )
        return
      setPinned(false)
      setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setPinned(false)
        setOpen(false)
      }
    }
    const document = root.current!.ownerDocument
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  return (
    <span ref={root} className="inline-flex max-w-full align-baseline">
      <HoverCard
        open={open}
        onOpenChange={(value) => {
          if (!pinned) setOpen(value)
        }}
      >
        <HoverCardTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            className="inline-flex min-w-0 max-w-full gap-[var(--vds-space-1)]"
            aria-expanded={open}
            onClick={() => {
              if (pin) {
                setPinned(!pinned)
                setOpen(!pinned)
              } else setOpen(true)
            }}
          >
            {trigger}
          </Button>
        </HoverCardTrigger>
        <HoverCardContent className="max-w-[var(--vds-assistant-floating-panel-width)]">
          <div ref={content}>{children}</div>
        </HoverCardContent>
      </HoverCard>
    </span>
  )
}

export function AnswerCitation({
  sources,
  onOpen,
}: {
  sources: readonly AnswerSource[]
  onOpen: (source: AnswerSource) => void
}): JSX.Element | null {
  const { t } = useTranslation('components')
  const [page, setPage] = useState(0)
  const [kind, setKind] = useState<AnswerSource['kind']>(sources[0]?.kind ?? 'file')
  if (!sources.length) return null
  const mixed =
    sources.some((source) => source.kind === 'file') &&
    sources.some((source) => source.kind === 'web')
  const items = mixed ? sources.filter((source) => source.kind === kind) : sources
  const current = Math.min(page, items.length - 1)
  return (
    <SourceHover
      trigger={
        <>
          <SourceIcon kind={sources[0].kind} />
          <span className="min-w-0 truncate" title={sources[0].title}>
            {sources[0].title}
          </span>
          {sources.length > 1 && (
            <span className="shrink-0 text-[var(--vds-text-secondary)]">+{sources.length - 1}</span>
          )}
        </>
      }
    >
      <div data-testid="answer-citation-preview" className="grid gap-[var(--vds-space-3)]">
        {mixed && (
          <div className="flex gap-[var(--vds-space-1)]">
            {(['file', 'web'] as const).map((value) => (
              <Button
                key={value}
                size="xs"
                variant={kind === value ? 'secondary' : 'ghost'}
                aria-pressed={kind === value}
                onClick={() => {
                  setKind(value)
                  setPage(0)
                }}
              >
                {t(value === 'file' ? 'answer.files' : 'answer.websites')}
              </Button>
            ))}
          </div>
        )}
        {items.length > 1 && (
          <div className="flex items-center justify-between">
            <IconButton
              label={t('answer.previousSource')}
              icon={<ChevronLeft />}
              size="xs"
              variant="ghostIcon"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            />
            <span className="text-[length:var(--vds-font-caption)]">
              {current + 1} / {items.length}
            </span>
            <IconButton
              label={t('answer.nextSource')}
              icon={<ChevronRight />}
              size="xs"
              variant="ghostIcon"
              disabled={current === items.length - 1}
              onClick={() => setPage(current + 1)}
            />
          </div>
        )}
        <SourceExcerpt key={items[current].id} source={items[current]} onOpen={onOpen} />
      </div>
    </SourceHover>
  )
}

export function AnswerSources({
  sources,
  onOpen,
}: {
  sources: readonly AnswerSource[]
  onOpen: (source: AnswerSource) => void
}): JSX.Element | null {
  const { t } = useTranslation('components')
  const unique = [...new Map(sources.map((source) => [source.id, source])).values()]
  if (!unique.length) return null
  return (
    <div data-testid="answer-sources" className="mt-[var(--vds-space-4)]">
      <SourceHover
        pin
        trigger={
          <>
            <span className="flex items-center gap-[var(--vds-space-1)]">
              {unique.slice(0, SOURCE_ICON_LIMIT).map((source) => (
                <SourceIcon key={source.id} kind={source.kind} />
              ))}
            </span>
            {t('answer.sourceCount', { count: unique.length })}
          </>
        }
      >
        <ScrollArea className="max-h-[var(--vds-reference-list-max-height)]">
          <div className="grid gap-[var(--vds-space-3)]">
            {(['file', 'web'] as const).map(
              (kind) =>
                unique.some((source) => source.kind === kind) && (
                  <section key={kind}>
                    <h4 className="mb-[var(--vds-space-2)] mt-0 text-[length:var(--vds-font-caption)] text-[var(--vds-text-tertiary)]">
                      {t(kind === 'file' ? 'answer.files' : 'answer.websites')}
                    </h4>
                    <div className="grid gap-[var(--vds-space-2)]">
                      {unique
                        .filter((source) => source.kind === kind)
                        .map((source) => (
                          <Button
                            key={source.id}
                            size="content"
                            variant="ghost"
                            className="w-full justify-start !whitespace-normal text-left"
                            onClick={() => onOpen(source)}
                          >
                            <SourceIcon kind={kind} />
                            <span className="min-w-0 break-words">{source.title}</span>
                          </Button>
                        ))}
                    </div>
                  </section>
                )
            )}
          </div>
        </ScrollArea>
      </SourceHover>
    </div>
  )
}
