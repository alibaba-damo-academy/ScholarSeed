import React, { useLayoutEffect } from 'react'
import { FileText, Info } from 'lucide-react'

import { useApp } from '../../store'
import { catalogue, useCatalogue } from './catalog'
import { literatureJoinTasks } from './admission'

import type { FeatureModule } from '../../contracts/features'
import { LiteratureList } from './LiteratureList'
import { LiteraturePanel } from './LiteraturePanel'
import { LiteratureCard } from './Card'
import { literaturePublicComponents } from './Component'
import { LiteratureResultTab, literatureResultArtifacts } from './Results'
import { isLiteratureResultTab } from '../workbench/tabs'
import { LiteratureSearchTab } from './Search'
import {
  literatureRetrievalAuthorization,
  literatureCurationInteraction,
  literatureOutlineConfirmation,
  preciseSearchStartInteraction,
  literatureReviewInteraction,
  preciseFulltextSubsetAuthorization,
} from './interaction'
import { LiteratureNotesPanel, LiteratureNotesTitle } from './ReaderNotes'
import { LiteratureAuthorizationReceipt } from './Authorization'
import { GenerateNoteAction } from './Generate'
import {
  LITERATURE_INFORMATION_PANEL_ID,
  LiteratureInformationPanel,
  LiteratureInformationTitle,
} from './ReaderInformation'
import { LITERATURE_NOTES_PANEL_ID, literatureIdFromDocument } from './note'
import { reviewSupersessionKey, searchSupersessionKey } from './projection'

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
    taskSources: [literatureJoinTasks],
    publicComponents: literaturePublicComponents,
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
        dockable: isLiteratureResultTab,
        duplicable: false,
        render: ({ tabId, path, active }) =>
          isLiteratureResultTab(tabId ?? path) ? (
            <LiteratureResultTab tabId={tabId ?? path} active={active} />
          ) : (
            <LiteratureSearchTab tabId={tabId ?? path} />
          ),
      },
    ],
    documentPanels: [
      {
        id: LITERATURE_INFORMATION_PANEL_ID,
        label: (i18n) => i18n.getFixedT(null, 'literature')('information.title'),
        title: <LiteratureInformationTitle />,
        placement: 'viewer',
        railPlacement: 'start',
        icon: <Info size={16} />,
        headerSeparator: false,
        matches: (context) => Boolean(literatureIdFromDocument(context)),
        headerActions: 'content',
        render: (context, presentation) => (
          <LiteratureInformationPanel context={context} presentation={presentation} />
        ),
      },
      {
        id: LITERATURE_NOTES_PANEL_ID,
        label: (i18n) => i18n.getFixedT(null, 'literature')('detail.tabs.notes'),
        title: <LiteratureNotesTitle />,
        placement: 'viewer',
        headerActions: 'content',
        resizable: true,
        icon: <FileText size={14} />,
        matches: (context) => Boolean(literatureIdFromDocument(context)),
        render: (context, presentation) => (
          <LiteratureNotesPanel context={context} presentation={presentation} />
        ),
        renderAnnotationAction: (props) => <GenerateNoteAction {...props} />,
      },
    ],
    displayCards: [
      {
        type: 'literature-review',
        layout: 'artifact',
        supersessionKey: reviewSupersessionKey,
        render: (props) => <LiteratureCard {...props} type="literature-review" />,
      },
      {
        type: 'literature-search',
        supersessionKey: searchSupersessionKey,
        supersessionPosition: 'first',
        presentedArtifacts: literatureResultArtifacts,
        render: (props) => <LiteratureCard {...props} type="literature-search" />,
      },
    ],
    interactionPolicies: [
      {
        ...preciseFulltextSubsetAuthorization,
        renderReply: (props) => <LiteratureAuthorizationReceipt {...props} />,
      },
      {
        ...literatureRetrievalAuthorization,
        renderReply: (props) => <LiteratureAuthorizationReceipt {...props} />,
      },
      literatureReviewInteraction,
      preciseSearchStartInteraction,
      literatureCurationInteraction,
      literatureOutlineConfirmation,
    ],
  }
}
