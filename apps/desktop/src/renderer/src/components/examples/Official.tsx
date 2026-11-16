import { Fragment, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { sections } from '../../../../../../../packages/ui/preview/inventory.js'
import { Preview } from '../../../../../../../packages/ui/preview/page.jsx'
import { Button, Tabs, TabsContent, TabsList, TabsTrigger, cx } from '../ui'
import { useOpenWebSource } from '../../features/assistant/Citations'
import { LABEL_KEYS } from './labels'
import { OpenUIDirectory } from './OpenUI'
import { conversationEntries } from './navigation'

const FIRST_OFFICIAL_SCENE = conversationEntries.length
const OFFICIAL_PREFIX = 'official-'
const GROUP_KEYS = {
  content: 'groups.content',
  charts: 'groups.charts',
  conversation: 'groups.conversation',
  research: 'groups.research',
  citations: 'groups.citations',
  artifacts: 'groups.artifacts',
  foundations: 'groups.foundations',
} as const

export const officialEntries = sections
  .flatMap((section) => section.items)
  .map((entry, index) => ({
    ...entry,
    id: `${OFFICIAL_PREFIX}${entry.name}`,
    number: String(FIRST_OFFICIAL_SCENE + index).padStart(2, '0'),
  }))

export function OfficialDirectory({
  activeId,
  onSelect,
}: {
  activeId: string
  onSelect: (id: string) => void
}): JSX.Element {
  const { t } = useTranslation('official')
  return (
    <div className="grid min-w-0 gap-[var(--vds-space-3)]" data-testid="official-directory">
      {sections.map((section) => {
        const groupKey = GROUP_KEYS[section.id as keyof typeof GROUP_KEYS]
        const group = groupKey ? t(groupKey) : t('missingGroup')
        return (
          <div role="group" aria-label={group} key={section.id} data-category={section.id}>
            <h3 className="mb-[var(--vds-space-1)] mt-[var(--vds-space-2)] px-[var(--vds-space-2)] text-[length:var(--vds-font-caption)] font-[var(--vds-fw-medium)] text-[var(--vds-text-tertiary)]">
              {group}
            </h3>
            {section.items.map((entry) => {
              const id = `${OFFICIAL_PREFIX}${entry.name}`
              const number = officialEntries.find((item) => item.id === id)?.number
              const labelKey = LABEL_KEYS[entry.name as keyof typeof LABEL_KEYS]
              const label = labelKey ? t(labelKey) : (entry.label ?? entry.name)
              return (
                <Fragment key={id}>
                  <Button
                    variant="ghost"
                    size="content"
                    aria-label={`${label} (${entry.name})`}
                    aria-current={id === activeId ? 'page' : undefined}
                    onClick={() => onSelect(id)}
                    data-export={entry.name}
                    data-aliases={JSON.stringify(entry.aliases)}
                    data-scene-number={number}
                    className={cx(
                      '!flex w-full min-w-0 items-start justify-start gap-[var(--vds-space-2)] !whitespace-normal rounded-[var(--vds-radius-3)] px-[var(--vds-space-2)] py-[var(--vds-space-2)] text-left text-[length:var(--vds-font-body-lv1)]',
                      id === activeId && 'bg-[var(--vds-surface-muted)]'
                    )}
                  >
                    <span
                      aria-hidden
                      className="shrink-0 font-[var(--vds-font-code)] text-[length:var(--vds-font-caption)] text-[var(--vds-text-tertiary)]"
                    >
                      {number}
                    </span>
                    <span className="min-w-0 flex-1 break-words">{label}</span>
                  </Button>
                  {entry.name === 'Canvas' && (
                    <OpenUIDirectory activeId={activeId} onSelect={onSelect} />
                  )}
                </Fragment>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

export function OfficialPreview({
  name,
  example,
  onOpened,
}: {
  name: string
  example?: string
  onOpened?: () => void
}): JSX.Element {
  const openWebSource = useOpenWebSource(onOpened)
  return <Preview sample={name} example={example} onOpenWebSource={openWebSource} />
}

const conversationPreviews = {
  artifacts: {
    titleKey: 'artifactPreview.title',
    tabs: [
      { value: 'file', labelKey: 'artifactPreview.file', name: 'Artifact', example: 'md' },
      {
        value: 'images',
        labelKey: 'artifactPreview.images',
        name: 'ArtifactGroup',
        example: 'images-4',
      },
      { value: 'combined', labelKey: 'artifactPreview.combined', name: 'ArtifactGroup' },
    ],
  },
  citations: {
    titleKey: 'citationPreview.title',
    tabs: [
      { value: 'sources', labelKey: 'citationPreview.sources', name: 'CitationSources' },
      { value: 'markers', labelKey: 'citationPreview.markers', name: 'CitationLink' },
    ],
  },
  body: {
    titleKey: 'bodyPreview.title',
    tabs: [
      { value: 'formula', labelKey: 'bodyPreview.formula', name: 'Formula' },
      { value: 'table', labelKey: 'bodyPreview.table', name: 'Tabulation' },
      { value: 'markdown', labelKey: 'bodyPreview.markdown', name: 'Markdown' },
    ],
  },
} as const

export function conversationPreviewKind(id: string): keyof typeof conversationPreviews | undefined {
  return (Object.keys(conversationPreviews) as (keyof typeof conversationPreviews)[]).find(
    (kind) => id === `conversation-${kind}`
  )
}

export function ConversationPreview({
  kind,
}: {
  kind: keyof typeof conversationPreviews
}): JSX.Element {
  const { t } = useTranslation('examples')
  const preview = conversationPreviews[kind]
  return (
    <section
      id={`conversation-${kind}`}
      className="flex h-full min-h-0 flex-col gap-[var(--vds-space-4)]"
    >
      <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] text-[var(--vds-text-primary)]">
        {t(preview.titleKey)}
      </h2>
      <Tabs
        key={kind}
        defaultValue={preview.tabs[0].value}
        className="min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)]"
      >
        <TabsList aria-label={t(preview.titleKey)}>
          {preview.tabs.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {t(tab.labelKey)}
            </TabsTrigger>
          ))}
        </TabsList>
        {preview.tabs.map((tab) => (
          <TabsContent
            key={tab.value}
            value={tab.value}
            className="mt-[var(--vds-space-4)] min-h-0 flex-1 overflow-hidden"
          >
            <OfficialPreview name={tab.name} example={'example' in tab ? tab.example : undefined} />
          </TabsContent>
        ))}
      </Tabs>
    </section>
  )
}
