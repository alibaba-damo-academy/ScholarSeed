import React from 'react'
import { useTranslation } from 'react-i18next'

import {
  Button,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Spinner,
} from '../../components/ui'
import type { LibraryCollection } from '../literature/api'
import { collectionNodes, flattenDestinations } from '../literature/hierarchy'

export function LiteratureCollections({
  collections,
  projectId,
  projectName,
  value,
  disabled,
  nested = false,
  failed,
  onValueChange,
  onRetry,
}: {
  collections: LibraryCollection[] | null
  projectId?: string
  projectName: string
  value: string
  disabled: boolean
  nested?: boolean
  failed: boolean
  onValueChange: (value: string) => void
  onRetry: () => void
}): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const groups = [
    { projectId: null, label: t('artifactEntry.myCollections') },
    { projectId, label: t('artifactEntry.projectCollections', { name: projectName }) },
  ]
    .map((scope) => ({
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
    .filter((group) => group.items.length > 0)
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
        <Select value={value} onValueChange={onValueChange} disabled={disabled}>
          <SelectTrigger aria-label={t('artifactEntry.collectionLocation')}>
            <SelectValue placeholder={t('artifactEntry.unfiled')} />
          </SelectTrigger>
          <SelectContent className={nested ? '!z-[var(--vds-z-modal-nested-flyout)]' : undefined}>
            <SelectItem value="">{t('artifactEntry.unfiled')}</SelectItem>
            {groups.map((group) => (
              <SelectGroup key={group.projectId ?? 'global'} aria-label={group.label}>
                <SelectLabel>{group.label}</SelectLabel>
                {group.items.map(({ node }) => (
                  <SelectItem
                    key={node.collectionId}
                    value={node.collectionId!}
                    aria-label={t('artifactEntry.scopedCollection', {
                      scope: group.label,
                      name: node.path.join(' / '),
                    })}
                  >
                    {node.path.join(' / ')}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  )
}
