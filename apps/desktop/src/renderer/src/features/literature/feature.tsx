import React, { useLayoutEffect } from 'react'

import { useApp } from '../../store'
import { catalogue, useCatalogue } from './catalog'

import type { FeatureModule } from '../../contracts/features'
import { LiteratureList } from './LiteratureList'
import { LITERATURE_DELIVERY_CARD, LiteratureDeliveryCard } from './Delivery'
import { LiteraturePanel } from './LiteraturePanel'
import { LiteratureReferences } from './References'
import { LiteratureResults, LiteratureResultTab, literatureResultArtifacts } from './Results'
import { LiteratureDownloads } from './Downloads'
import { downloadSupersessionKey } from './admission'
import { LiteratureReviewCard } from './Review'
import { LITERATURE_RESULT_PREFIX } from '../workbench/tabs'
import { LiteratureSearchTab } from './Search'
import {
  literatureRetrievalAuthorization,
  literatureReviewInteraction,
  preciseFulltextSubsetAuthorization,
} from './interaction'
import { LiteratureNotesPanel, LiteratureNotesTitle } from './ReaderNotes'
import { LITERATURE_NOTES_PANEL_ID, literatureIdFromDocument } from './note'
import { reviewSupersessionKey, searchSupersessionKey } from './projection'

const LITERATURE_REFERENCES_CARD = 'literature-references'

function LiteratureScope({ children }: { children: React.ReactNode }): React.JSX.Element | null {
  const { state } = useApp()
  const { projectId, query } = useCatalogue()
  const target = state.homeSelectedProjectId
  useLayoutEffect(() => catalogue.scope(target), [target])
  const scopeKey = JSON.stringify([
    target,
    query.download_session_id,
    query.download_run,
    query.exclude_paper_id,
  ])
  return projectId === target ? <React.Fragment key={scopeKey}>{children}</React.Fragment> : null
}

export function literatureFeature(): FeatureModule {
  return {
    id: 'literature',
    activityItems: [
      {
        key: 'literature',
        label: (i18n) => i18n.getFixedT(null, 'layout')('literature'),
        icon: 'books',
        order: 30,
      },
    ],
    panels: [
      {
        key: 'literature-filters',
        title: (i18n) => i18n.getFixedT(null, 'literature')('navigation.overview'),
        slot: 'module',
        render: () => (
          <LiteratureScope>
            <LiteraturePanel />
          </LiteratureScope>
        ),
      },
    ],
    viewerPlugins: [
      {
        kind: 'project-literature',
        render: () => (
          <LiteratureScope>
            <LiteratureList presentation="project" />
          </LiteratureScope>
        ),
      },
      {
        kind: 'literature',
        render: () => (
          <LiteratureScope>
            <LiteratureList />
          </LiteratureScope>
        ),
      },
      {
        kind: 'literature_search',
        render: ({ tabId, path }) =>
          (tabId ?? path).startsWith(LITERATURE_RESULT_PREFIX) ? (
            <LiteratureResultTab tabId={tabId ?? path} />
          ) : (
            <LiteratureSearchTab tabId={tabId ?? path} />
          ),
      },
    ],
    documentPanels: [
      {
        id: LITERATURE_NOTES_PANEL_ID,
        label: (i18n) => i18n.getFixedT(null, 'literature')('readerNotes.title'),
        title: <LiteratureNotesTitle />,
        placement: 'viewer',
        matches: (context) => Boolean(literatureIdFromDocument(context)),
        render: (context) => <LiteratureNotesPanel context={context} />,
      },
    ],
    displayCards: [
      {
        type: LITERATURE_DELIVERY_CARD,
        supersessionKey: (content) =>
          typeof content.delivery_id === 'string' ? content.delivery_id : null,
        render: ({ content }) => <LiteratureDeliveryCard content={content} />,
      },
      {
        type: 'literature-downloads',
        supersessionKey: downloadSupersessionKey,
        render: ({ cardId, content }) => <LiteratureDownloads cardId={cardId} content={content} />,
      },
      {
        type: 'literature-review',
        supersessionKey: reviewSupersessionKey,
        render: ({ content }) => <LiteratureReviewCard content={content} />,
      },
      {
        type: 'literature-search',
        supersessionKey: searchSupersessionKey,
        supersessionPosition: 'first',
        presentedArtifacts: literatureResultArtifacts,
        render: ({ content, cardId }) => <LiteratureResults content={content} cardId={cardId} />,
      },
      {
        type: LITERATURE_REFERENCES_CARD,
        render: ({ content }) => <LiteratureReferences content={content} />,
      },
    ],
    interactionPolicies: [
      preciseFulltextSubsetAuthorization,
      literatureRetrievalAuthorization,
      literatureReviewInteraction,
    ],
  }
}
