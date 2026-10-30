import { feedback } from '../../contracts/feedback'
import React from 'react'

import { listSessions } from '../../api'
import type { FeatureModule } from '../../contracts/features'
import {
  fetchLiteratureBrowseCandidates,
  fetchLiteratureBrowseCollections,
  fetchLiteratureCandidates,
  fetchResourceCandidates,
  fetchResourceFolderCandidates,
  RESOURCE_CONTEXT_KIND,
} from './api'
import { AssistantPanel } from './Panel'
import { Outputs } from './Outputs'
import { isSessionContextCandidate } from './candidates'
import { NextSteps } from './NextSteps'
import { NEXT_STEPS_CARD } from './suggestions'

const SESSION_CONTEXT_CANDIDATE_LIMIT = 500
const UNGROUPED_LITERATURE_NODE_ID = 'literature:ungrouped'

/**
 * AI 面板 Feature 贡献声明（开发 6 拥有）。
 *
 * 挂在 `dock` 槽位（右侧停靠区），与二级侧栏的 `module` 槽位区分开 ——
 * AI 面板与当前工作台视图无关，切资料库/文献库时它都应保持在原位。
 */
// Historical nonempty reference label, retained for the backend context contract.
const CANONICAL_UNTITLED_SESSION_LABEL = '未命名对话'

export function assistantFeature(): FeatureModule {
  return {
    id: 'assistant',
    viewerPlugins: [{ kind: 'outputs', render: () => <Outputs /> }],
    displayCards: [
      {
        type: NEXT_STEPS_CARD,
        placement: 'after-artifacts',
        render: ({ cardId, content, turnId }) => (
          <NextSteps key={cardId} cardId={cardId} content={content} turnId={turnId} />
        ),
      },
    ],
    assistantSources: [
      {
        id: RESOURCE_CONTEXT_KIND,
        label: feedback('assistant', 'sources.resources'),
        icon: 'folder',
        emptyLabel: feedback('assistant', 'sources.resourcesEmpty'),
        kinds: ['file', 'dir'],
        requiresProject: true,
        search: async ({ projectId, query, filter }) => ({
          items:
            query.includes('/') || (!query.trim() && filter === 'all')
              ? await fetchResourceFolderCandidates(projectId, query)
              : await fetchResourceCandidates(projectId, query),
        }),
      },
      {
        id: 'literature',
        label: feedback('assistant', 'sources.literature'),
        icon: 'books',
        emptyLabel: feedback('assistant', 'sources.literatureEmpty'),
        kinds: ['literature'],
        browse: {
          heading: feedback('assistant', 'referencePicker.collections'),
          ungrouped: {
            id: UNGROUPED_LITERATURE_NODE_ID,
            label: feedback('assistant', 'referencePicker.ungrouped'),
          },
          nodes: async (projectId) => {
            const collections = await fetchLiteratureBrowseCollections(projectId)
            return (
              collections?.map((collection) => ({
                id: collection.id,
                label: collection.name,
                parentId: collection.parent_id,
              })) ?? null
            )
          },
          items: (projectId, nodeId) =>
            fetchLiteratureBrowseCandidates(
              projectId,
              nodeId === UNGROUPED_LITERATURE_NODE_ID
                ? { ungrouped: true }
                : { collectionId: nodeId }
            ),
        },
        search: async ({ projectId, query }) => ({
          items: await fetchLiteratureCandidates(projectId, query),
        }),
      },
      {
        id: 'session',
        label: feedback('assistant', 'sources.sessions'),
        icon: 'quote',
        emptyLabel: feedback('assistant', 'sources.sessionsEmpty'),
        kinds: ['session'],
        search: async ({ projectPath, activeSessionId, query }) => {
          const rows = await listSessions(
            projectPath
              ? {
                  limit: SESSION_CONTEXT_CANDIDATE_LIMIT,
                  scope: 'project',
                  projectPath,
                }
              : { limit: SESSION_CONTEXT_CANDIDATE_LIMIT, scope: 'unassigned' }
          )
          const normalized = query.trim().toLocaleLowerCase()
          return {
            items: (rows ?? [])
              .filter((row) => isSessionContextCandidate(row, activeSessionId))
              .filter((row) => !normalized || row.title.toLocaleLowerCase().includes(normalized))
              .map((row) => ({
                kind: 'session' as const,
                source_id: row.session_id,
                // Preserve the existing nonempty label required by ContextRefRequest.
                label: row.title || CANONICAL_UNTITLED_SESSION_LABEL,
                ...(row.title_fallback === 'new_session'
                  ? { labelFallback: 'newSession' as const }
                  : !row.title
                    ? { labelFallback: 'untitledSession' as const }
                    : {}),
                hintKey: 'wholeSession' as const,
                created_at: row.created_at,
                retention: 'next_turn' as const,
                origin: 'explicit' as const,
              })),
          }
        },
      },
    ],
    panels: [
      {
        key: 'ai-panel',
        title: (i18n) => i18n.getFixedT(null, 'assistant')('panel.title'),
        slot: 'dock',
        render: () => <AssistantPanel />,
      },
    ],
  }
}
