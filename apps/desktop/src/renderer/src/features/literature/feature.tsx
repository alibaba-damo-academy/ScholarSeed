import React, { useLayoutEffect } from 'react'

import { useApp } from '../../store'
import { catalogue, useCatalogue } from './catalog'

import type { FeatureModule } from '../../contracts/features'
import { LiteratureList } from './LiteratureList'
import { LiteraturePanel } from './LiteraturePanel'
import { LiteratureReferences } from './References'
import { LiteratureResults, LiteratureResultTab, literatureResultArtifacts } from './Results'
import { LiteratureReviewCard } from './Review'
import { LITERATURE_RESULT_PREFIX } from '../workbench/tabs'
import { LiteratureSearchTab } from './Search'
import { literatureRetrievalAuthorization, literatureReviewInteraction } from './interaction'
import { LiteratureNotesPanel, LiteratureNotesTitle } from './ReaderNotes'
import { LITERATURE_NOTES_PANEL_ID, literatureIdFromDocument } from './note'
import { reviewSupersessionKey, searchSupersessionKey } from './projection'

const LITERATURE_REFERENCES_CARD = 'literature-references'

function LiteratureScope({ children }: { children: React.ReactNode }): React.JSX.Element | null {
  const { state } = useApp()
  const { projectId } = useCatalogue()
  const target = state.homeSelectedProjectId
  useLayoutEffect(() => catalogue.scope(target), [target])
  return projectId === target ? <React.Fragment key={target}>{children}</React.Fragment> : null
}

export function literatureFeature(): FeatureModule {
  return {
    id: 'literature',
    activityItems: [{ key: 'literature', label: (i18n, { hasProject }) => i18n.getFixedT(null, 'literature')(hasProject ? 'navigation.project' : 'navigation.overview'), icon: 'books', order: 30 }],
    panels: [{ key: 'literature-filters', title: (i18n) => i18n.getFixedT(null, 'literature')('navigation.overview'), slot: 'module', render: () => <LiteratureScope><LiteraturePanel /></LiteratureScope> }],
    viewerPlugins: [
      { kind: 'literature', render: () => <LiteratureScope><LiteratureList /></LiteratureScope> },
      { kind: 'literature_search', render: ({ tabId, path }) => (tabId ?? path).startsWith(LITERATURE_RESULT_PREFIX)
        ? <LiteratureResultTab tabId={tabId ?? path} /> : <LiteratureSearchTab tabId={tabId ?? path} /> }
    ],
    documentPanels: [{
      id: LITERATURE_NOTES_PANEL_ID,
      label: (i18n) => i18n.getFixedT(null, 'literature')('readerNotes.title'),
      title: <LiteratureNotesTitle />,
      placement: 'viewer',
      matches: (context) => Boolean(literatureIdFromDocument(context)),
      render: (context) => <LiteratureNotesPanel context={context} />
    }],
    displayCards: [{
      type: 'literature-review',
      supersessionKey: reviewSupersessionKey,
      render: ({ content }) => <LiteratureReviewCard content={content} />
    }, {
      type: 'literature-search',
      supersessionKey: searchSupersessionKey,
      supersessionPosition: 'first',
      presentedArtifacts: literatureResultArtifacts,
      render: ({ content, cardId }) => <LiteratureResults content={content} cardId={cardId} />
    }, {
      type: LITERATURE_REFERENCES_CARD,
      render: ({ content }) => <LiteratureReferences content={content} />
    }],
    interactionPolicies: [literatureRetrievalAuthorization, literatureReviewInteraction]
  }
}
