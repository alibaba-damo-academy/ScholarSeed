import React from 'react'
import { Check, Folder, Inbox } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button, EllipsisText, ScrollArea, Spinner } from '../../components/ui'
import type { LibraryCollection } from '../literature/api'
import { collectionNodes, flattenDestinations } from '../literature/hierarchy'

export function LiteratureCollections({
  collections,
  projectId,
  projectName,
  value,
  disabled,
  failed,
  onValueChange,
  onRetry,
}: {
  collections: LibraryCollection[] | null
  projectId?: string
  projectName: string
  value: string
  disabled: boolean
  failed: boolean
  onValueChange: (value: string) => void
  onRetry: () => void
}): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const groups = [
    { projectId: null, label: t('artifactEntry.myCollections') },
    { projectId, label: t('artifactEntry.projectCollections', { name: projectName }) },
  ].map((scope) => ({
    ...scope,
    items: flattenDestinations(
      collectionNodes(
        (collections ?? []).filter(
          (collection) => (collection.project_id ?? null) === scope.projectId
        ),
        scope.projectId ?? undefined
      )
    ),
  }))
  const selectedGroup = groups.find((group) =>
    group.items.some(({ node }) => node.collectionId === value)
  )
  const selectedNode = selectedGroup?.items.find(({ node }) => node.collectionId === value)?.node
  const destination =
    selectedNode && selectedGroup
      ? t('artifactEntry.scopedCollection', {
          scope: selectedGroup.label,
          name: selectedNode.path.join(' / '),
        })
      : t('artifactEntry.unfiled')
  const option = (id: string, name: string, label: string) => (
    <Button
      key={id}
      aria-label={label}
      aria-pressed={value === id}
      disabled={disabled}
      variant="ghost"
      onClick={() => onValueChange(id)}
      className="h-auto w-full min-w-0 justify-start gap-[var(--vds-space-3)] rounded-[var(--vds-radius-3)] px-[var(--vds-space-3)] py-[var(--vds-space-3)] text-left aria-pressed:bg-[var(--vds-brand-light-bg-default)] aria-pressed:text-[var(--vds-brand-text-primary)] aria-pressed:hover:bg-[var(--vds-brand-light-bg-hover)]"
    >
      {id ? <Folder size="1em" aria-hidden="true" /> : <Inbox size="1em" aria-hidden="true" />}
      <EllipsisText wrapperClassName="min-w-0 flex-1" tooltipPortalled>
        {name}
      </EllipsisText>
      <Check
        size="1em"
        aria-hidden="true"
        className={value === id ? 'shrink-0' : 'invisible shrink-0'}
      />
    </Button>
  )

  return (
    <div
      className="grid min-w-0 gap-[var(--vds-space-2)]"
      data-testid="artifact-literature-collections"
    >
      <div className="text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-primary)]">
        {t('artifactEntry.collectionLocation')}
      </div>
      {collections === null ? (
        <div
          className="flex items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] border border-[var(--vds-border-default)] p-[var(--vds-space-4)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]"
          role="status"
        >
          {failed ? (
            <>
              <span className="min-w-0 flex-1">{t('artifactEntry.collectionsUnavailable')}</span>
              <Button size="sm" variant="outline" disabled={disabled} onClick={onRetry}>
                {t('artifactEntry.retry')}
              </Button>
            </>
          ) : (
            <>
              <Spinner size="sm" />
              <span>{t('artifactEntry.loadingCollections')}</span>
            </>
          )}
        </div>
      ) : (
        <ScrollArea
          className="max-h-[var(--vds-library-destination-tree-max-height)] rounded-[var(--vds-radius-3)] border border-[var(--vds-border-default)]"
          viewportClassName="p-[var(--vds-space-1)]"
        >
          {option('', t('artifactEntry.unfiled'), t('artifactEntry.unfiled'))}
          {groups.map((group) => (
            <section
              key={group.projectId ?? 'global'}
              aria-label={group.label}
              className="mt-[var(--vds-space-1)] border-t border-[var(--vds-divider-default)] pt-[var(--vds-space-2)]"
            >
              <div className="px-[var(--vds-space-3)] pb-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
                <EllipsisText tooltipPortalled>{group.label}</EllipsisText>
              </div>
              {group.items.length ? (
                group.items.map(({ node }) =>
                  option(
                    node.collectionId!,
                    node.path.join(' / '),
                    t('artifactEntry.scopedCollection', {
                      scope: group.label,
                      name: node.path.join(' / '),
                    })
                  )
                )
              ) : (
                <p className="m-0 px-[var(--vds-space-3)] pb-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
                  {t('artifactEntry.emptyCollectionScope')}
                </p>
              )}
            </section>
          ))}
        </ScrollArea>
      )}
      <p
        className="m-0 break-words text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]"
        aria-live="polite"
      >
        {t('save.destination', { path: destination })}
      </p>
      <p className="m-0 text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
        {t('artifactEntry.collectionScopeHint')}
      </p>
    </div>
  )
}
