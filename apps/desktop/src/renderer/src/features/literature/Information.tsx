import { ChevronRight, SquarePen } from 'lucide-react'
import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  LiteratureDetail as Detail,
  LiteratureFacet,
  LiteratureUpdate,
} from '../../contracts/literature'
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Input,
  IconButton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tag,
  Textarea,
  semanticTagColor,
  semanticTagColorFor,
} from '../../components/ui'
import { TagPicker } from './Tags'
import { literatureCollections } from './projection'

const BIBLIOGRAPHY_TYPES = [
  'article',
  'inproceedings',
  'book',
  'incollection',
  'techreport',
  'phdthesis',
  'mastersthesis',
  'proceedings',
  'inbook',
  'manual',
  'unpublished',
  'booklet',
  'misc',
]
const DETAIL_VALUE_TEXT_CLASS =
  'min-w-0 overflow-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere]'
const DETAIL_VALUE_PRESENTATION_CLASS = {
  field:
    'text-[length:var(--vds-reading-info-field-font-size)] font-[var(--vds-fw-regular)] leading-[var(--vds-reading-info-field-line-height)] text-[var(--vds-text-secondary)]',
  titleClassName:
    'text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-reading-info-title-line-height)] text-[var(--vds-text-primary)]',
  body: 'text-[length:var(--vds-reading-info-body-font-size)] font-[var(--vds-fw-regular)] leading-[var(--vds-reading-info-field-line-height)] text-[var(--vds-text-primary)]',
}
const DETAIL_VALUE_ROW_CLASS =
  'col-span-2 grid min-w-0 grid-cols-subgrid items-center gap-x-[var(--vds-space-4)] py-[var(--vds-space-1)] text-left text-[length:var(--vds-reading-info-field-font-size)] leading-[var(--vds-reading-info-field-line-height)]'
const DETAIL_VALUE_LABEL_CLASS = 'whitespace-nowrap text-left text-[var(--vds-text-tertiary)]'
const DETAIL_SECTION_CLASS = 'col-span-2 min-w-0 py-[var(--vds-space-2)]'
const DETAIL_SECTION_HEADING_CLASS =
  'mb-[var(--vds-space-2)] mt-0 text-[length:var(--vds-reading-info-field-font-size)] font-[var(--vds-fw-medium)]'
const DETAIL_SECTION_CONTENT_CLASS =
  'flex flex-wrap gap-[var(--vds-library-detail-section-content-gap)]'
const DETAIL_MUTED_CLASS =
  'text-[length:var(--vds-reading-info-field-font-size)] text-[var(--vds-text-tertiary)]'
type EditableField = keyof Pick<
  Detail,
  | 'citation_key'
  | 'item_type'
  | 'title'
  | 'subtitle'
  | 'creators_display'
  | 'publication_display'
  | 'year'
  | 'published_date'
  | 'abstract'
  | 'doi'
  | 'arxiv'
  | 'isbn'
  | 'url'
  | 'volume'
  | 'number'
  | 'pages'
  | 'publisher'
  | 'address'
>
const API_FIELDS: Partial<Record<EditableField, string>> = {
  creators_display: 'authors',
  publication_display: 'publication',
}
function EditableValue({
  field,
  item,
  label,
  multiline = false,
  presentation = 'field',
  focusNonce = 0,
  trailing,
  onSave,
}: {
  field: EditableField
  item: Detail
  label: string
  multiline?: boolean
  presentation?: keyof typeof DETAIL_VALUE_PRESENTATION_CLASS
  focusNonce?: number
  trailing?: React.ReactNode
  onSave: (update: LiteratureUpdate) => Promise<boolean>
}): React.JSX.Element {
  const { t: literature } = useTranslation('literature')
  const original = item[field]
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(String(original ?? ''))
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const pending = useRef(false)
  const wrapper = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!editing) setValue(String(original ?? ''))
  }, [editing, original])
  useEffect(() => {
    if (!focusNonce) return
    setEditing(true)
    const frame = requestAnimationFrame(() => {
      wrapper.current?.querySelector('input')?.focus()
      wrapper.current?.scrollIntoView({ block: 'center' })
    })
    return () => cancelAnimationFrame(frame)
  }, [focusNonce])
  const commit = async (): Promise<void> => {
    if (!editing || pending.current) return
    const normalized = field === 'year' ? (value.trim() ? Number(value) : null) : value.trim()
    if (normalized === original || (normalized === '' && original == null)) {
      setEditing(false)
      setFailed(false)
      return
    }
    pending.current = true
    setSaving(true)
    try {
      const saved = await onSave({ fields: { [API_FIELDS[field] ?? field]: normalized } })
      setFailed(!saved)
      if (saved) setEditing(false)
    } catch {
      setFailed(true)
    } finally {
      pending.current = false
      setSaving(false)
    }
  }
  return (
    <div
      ref={wrapper}
      className={
        presentation === 'field'
          ? `${DETAIL_VALUE_ROW_CLASS}${editing ? ' !items-center' : ''}`
          : `flex min-w-0 items-start${presentation === 'titleClassName' ? ' mb-[var(--vds-space-4)]' : ''}`
      }
    >
      <span className={presentation === 'field' ? DETAIL_VALUE_LABEL_CLASS : 'sr-only'}>
        {label}
      </span>
      {editing ? (
        <div className="min-w-0 flex-1">
          {multiline ? (
            <Textarea
              autoFocus
              disabled={saving}
              aria-label={literature('detail.edit', { label })}
              value={value}
              onChange={(event) => {
                setFailed(false)
                setValue(event.target.value)
              }}
              onBlur={() => {
                if (!failed) void commit()
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setFailed(false)
                  setEditing(false)
                }
              }}
            />
          ) : (
            <Input
              autoFocus
              disabled={saving}
              aria-label={literature('detail.edit', { label })}
              type={field === 'year' ? 'number' : 'text'}
              value={value}
              onChange={(event) => {
                setFailed(false)
                setValue(event.target.value)
              }}
              onBlur={() => {
                if (!failed) void commit()
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void commit()
                }
                if (event.key === 'Escape') {
                  setFailed(false)
                  setEditing(false)
                }
              }}
            />
          )}
          {failed ? (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-[var(--vds-space-2)] text-[var(--vds-error-text-primary)]"
            >
              <span>{literature('detail.saveFailed')}</span>
              <Button variant="ghost" size="sm" onClick={() => void commit()}>
                {literature('detail.retry')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex min-w-0 w-full flex-1 items-start gap-[var(--vds-space-2)]">
          <Button
            aria-label={literature('detail.edit', { label })}
            variant="ghost"
            size="content"
            className={`lit-detail-edit flex-1 w-auto min-w-0 !min-h-0 !py-[var(--vds-space-1)] !my-[calc(-1*var(--vds-space-1))] !justify-between !text-left [&_svg]:mt-[var(--vds-space-1)] [&_svg]:opacity-0 hover:[&_svg]:opacity-[var(--vds-opacity-full)] focus-visible:[&_svg]:opacity-[var(--vds-opacity-full)]${presentation === 'titleClassName' ? ' !px-0 !items-center [&_svg]:!mt-0 hover:!bg-transparent' : ' !items-start !px-[calc(var(--vds-space-1)+var(--vds-space-half))]'}`}
            onClick={() => setEditing(true)}
          >
            <strong
              className={`${DETAIL_VALUE_TEXT_CLASS} ${DETAIL_VALUE_PRESENTATION_CLASS[presentation]}${String(original ?? '').trim() ? ' !text-[var(--vds-reading-info-value-color)]' : ''}`}
            >
              {String(original ?? '') || '—'}
            </strong>
            <SquarePen size={12} className="text-[var(--vds-text-7)]" />
          </Button>
          {trailing}
        </div>
      )}
    </div>
  )
}

function TagSection({
  item,
  tags,
  onCreate,
  onSave,
}: {
  item: Detail
  tags: LiteratureFacet[]
  onCreate: (name: string) => Promise<void>
  onSave: (update: LiteratureUpdate) => Promise<boolean>
}): React.JSX.Element {
  const { t: literature } = useTranslation('literature')
  const linked = new Set(item.tags.map((tag) => tag.id))
  const toggle = async (target: { id: string }): Promise<void> => {
    const next = item.tags.filter((tag) => tag.id !== target.id).map((tag) => tag.id)
    if (!linked.has(target.id)) next.push(target.id)
    await onSave({ tag_ids: next })
  }
  return (
    <section className={DETAIL_SECTION_CLASS}>
      <div className="flex flex-wrap items-center justify-between gap-[var(--vds-library-detail-section-content-gap)]">
        <h3 className={`${DETAIL_SECTION_HEADING_CLASS} !m-0`}>{literature('panel.tags')}</h3>
        <TagPicker tags={tags} linked={linked} onToggle={toggle} onCreate={onCreate} />
      </div>
      <div className={DETAIL_SECTION_CONTENT_CLASS}>
        {item.tags.length ? (
          item.tags.map((value) => {
            const facet = tags.find((tag) => tag.id === value.id || tag.name === value.name)
            return (
              <Tag
                key={value.id}
                closeLabel={literature('detail.removeTag')}
                color={semanticTagColor(facet?.color) ?? semanticTagColorFor(facet?.id ?? value.id)}
                onClose={() => toggle(value)}
              >
                {value.name}
              </Tag>
            )
          })
        ) : (
          <small className={DETAIL_MUTED_CLASS}>{literature('panel.noTags')}</small>
        )}
      </div>
    </section>
  )
}

function InformationGroup({
  title,
  children,
  defaultOpen = false,
  open,
  onOpenChange,
}: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      open={open}
      onOpenChange={onOpenChange}
      className="min-w-0 !gap-0 border-t border-[var(--vds-divider-default)] last:border-b"
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="content"
          className="flex w-full !min-h-[var(--vds-reading-info-heading-height)] items-center !justify-between !rounded-none !border-0 !bg-transparent !px-0 !py-[var(--vds-space-2)] !text-left !text-[var(--vds-text-secondary)] !text-[length:var(--vds-font-body-lv1)] !font-[var(--vds-fw-medium)] hover:!bg-[var(--vds-bg-white-hover-transparent)]"
        >
          <span>{title}</span>
          <ChevronRight
            className="shrink-0 text-[var(--vds-text-tertiary)] [[data-state=open]>&]:rotate-90"
            size={14}
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-[var(--vds-space-4)] !rounded-none !border-0 !bg-transparent !px-0 !pt-0 !pb-[var(--vds-space-4)]">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function Information({
  item,
  projectId,
  tags,
  identifierFocus,
  onRelation,
  onCreateTag,
  onSave,
}: {
  item: Detail
  projectId?: string
  tags: LiteratureFacet[]
  identifierFocus?: { field: 'doi' | 'arxiv'; nonce: number } | null
  onRelation: (kind: 'projects' | 'collections') => void
  onCreateTag: (name: string) => Promise<void>
  onSave: (update: LiteratureUpdate) => Promise<boolean>
}): React.JSX.Element {
  const { t: literature } = useTranslation('literature')
  const [identifiersOpen, setIdentifiersOpen] = useState(false)
  useEffect(() => {
    if (identifierFocus) setIdentifiersOpen(true)
  }, [identifierFocus])
  const editable = (
    field: EditableField,
    label: string,
    multiline = false,
    presentation: keyof typeof DETAIL_VALUE_PRESENTATION_CLASS = 'field'
  ): React.JSX.Element => (
    <EditableValue
      key={field}
      field={field}
      item={item}
      label={label}
      multiline={multiline}
      presentation={presentation}
      onSave={onSave}
    />
  )
  return (
    <div className="min-w-0" data-testid="literature-information">
      {editable('title', literature('columns.title'), false, 'titleClassName')}
      <section
        className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-[var(--vds-space-4)] pb-[var(--vds-space-4)]"
        aria-label={literature('information.basic')}
      >
        <h3 className="sr-only">{literature('information.basic')}</h3>
        {editable('creators_display', literature('columns.creator'))}
        {editable('year', literature('columns.year'))}
        {editable('publication_display', literature('columns.publication'))}
      </section>
      <InformationGroup title={literature('information.abstract')} defaultOpen>
        {editable('abstract', literature('columns.abstract'), true, 'body')}
      </InformationGroup>
      <InformationGroup
        title={literature('information.identifiers')}
        open={identifiersOpen}
        onOpenChange={setIdentifiersOpen}
      >
        {editable('citation_key', literature('columns.citation_key'))}
        <EditableValue
          field="doi"
          item={item}
          label={literature('columns.doi')}
          focusNonce={identifierFocus?.field === 'doi' ? identifierFocus.nonce : 0}
          onSave={onSave}
        />
        <EditableValue
          field="arxiv"
          item={item}
          label={literature('columns.arxiv')}
          focusNonce={identifierFocus?.field === 'arxiv' ? identifierFocus.nonce : 0}
          onSave={onSave}
        />
        {editable('isbn', literature('columns.isbn'))}
        {editable('url', literature('columns.url'))}
      </InformationGroup>
      <InformationGroup title={literature('information.publication')}>
        <div className={DETAIL_VALUE_ROW_CLASS}>
          <span className={DETAIL_VALUE_LABEL_CLASS}>{literature('detail.type')}</span>
          <Select
            aria-label={literature('detail.type')}
            size="sm"
            className="![padding-left:var(--vds-space-3)] min-w-0 flex-[1_1_auto]"
            value={item.bib_type}
            onValueChange={(value) => void onSave({ bib_type: value })}
          >
            <SelectTrigger className="w-full !pr-[var(--vds-space-3)]">
              <SelectValue placeholder={literature('detail.chooseType')}>
                {item.bib_type
                  ? literature(`detail.bibTypes.${item.bib_type}` as 'detail.bibTypes.article')
                  : undefined}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {BIBLIOGRAPHY_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {literature(`detail.bibTypes.${type}` as 'detail.bibTypes.article')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {editable('subtitle', literature('columns.subtitle'))}
        {editable('published_date', literature('columns.published_date'))}
        {editable('volume', literature('columns.volume'))}
        {editable('number', literature('columns.number'))}
        {editable('pages', literature('columns.pages'))}
        {editable('publisher', literature('columns.publisher'))}
        {editable('address', literature('columns.address'))}
      </InformationGroup>
      <InformationGroup title={literature('information.organization')}>
        {!projectId ? (
          <section className={DETAIL_SECTION_CLASS}>
            <h3 className={DETAIL_SECTION_HEADING_CLASS}>
              {literature('relations.linkedProjects')}
            </h3>
            <div className="flex w-full items-center justify-between gap-[var(--vds-space-2)]">
              <div className="min-w-0 flex-1 flex flex-wrap justify-start gap-[var(--vds-space-1)]">
                {item.projects.length ? (
                  item.projects.map((value) => (
                    <Tag key={value.id} size="small">
                      {value.name}
                    </Tag>
                  ))
                ) : (
                  <small>{literature('relations.chooseProject')}</small>
                )}
              </div>
              <IconButton
                label={literature('relations.chooseProject')}
                className="[&_svg]:!size-[var(--vds-icon-6)]"
                size="sm"
                variant="ghostIcon"
                icon={<SquarePen />}
                onClick={() => onRelation('projects')}
              />
            </div>
          </section>
        ) : null}
        <section className={DETAIL_SECTION_CLASS}>
          <div className="flex items-center justify-between gap-[var(--vds-space-2)]">
            <h3 className={`${DETAIL_SECTION_HEADING_CLASS} !m-0`}>
              {projectId ? literature('panel.collections') : literature('panel.custom')}
            </h3>
            <IconButton
              label={literature('detail.chooseCollection')}
              className="[&_svg]:!size-[var(--vds-icon-6)]"
              size="sm"
              variant="ghostIcon"
              icon={<SquarePen />}
              onClick={() => onRelation('collections')}
            />
          </div>
          <div className={DETAIL_SECTION_CONTENT_CLASS}>
            <div className="min-w-0 flex-1 flex flex-wrap justify-start gap-[var(--vds-space-1)]">
              {literatureCollections(item, projectId).length ? (
                literatureCollections(item, projectId).map((value) => (
                  <Tag key={value.id} size="small">
                    {value.name}
                  </Tag>
                ))
              ) : (
                <small className={DETAIL_MUTED_CLASS}>{literature('detail.noCollection')}</small>
              )}
            </div>
          </div>
        </section>
        <TagSection item={item} tags={tags} onCreate={onCreateTag} onSave={onSave} />
      </InformationGroup>
    </div>
  )
}
