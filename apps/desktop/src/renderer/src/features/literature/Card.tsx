import React, { useEffect, useMemo } from 'react'
import { activeThread, useApp } from '../../store'
import { openByDefault } from '../../fileOpen'
import type { PluginReference } from '../../../../plugins'
import { PluginInteraction } from '../../components/business/Frame'
import { parseReview } from './projection'
import {
  parseDownloadCard,
  openDownloadedFulltext,
  claimDownloadRefresh,
  downloadRefreshKey,
  conversationProject,
} from './admission'
import { LiteratureReferences, referencesContent, referenceUrl } from './References'
import { LiteratureResults, parseResult } from './Summary'
import { LiteratureReviewCard } from './Review'
import { LiteratureDownloads } from './Downloads'
import { LiteratureDeliveryCard } from './Delivery'
import { catalogue } from './catalog'
import { searchPapersBibtex } from './result'
import {
  createLiteratureCollection,
  importBibliography,
  listLiteratureCollections,
  requestLiteratureDelivery,
  resolveDownloadedFulltext,
} from './api'
import { fetchResourceTree } from '../resources/api'
import { CARD_ALLOWED_OPERATIONS, CARD_CAPABILITIES, type LiteratureCardPorts } from './ports'
import { cardRequest } from './operations'
import { deliveryProjectMatches } from './utils'

const SCOPE_CHANGED = 'plugin_card_scope_changed'
const ITEM_UNAVAILABLE = 'plugin_card_item_unavailable'
const BIBLIOGRAPHY_FILENAME = 'references.bib'
const BIBLIOGRAPHY_MIME = 'application/x-bibtex'
const CANCEL_DELIVERY = 'cancel'
const LOCAL_CARD_AUTHORIZATION = async (): Promise<void> => undefined

export const LITERATURE_CARD_VIEWS: Record<
  string,
  React.ComponentType<{
    content: Record<string, unknown>
    cardId: string
    ports: LiteratureCardPorts
  }>
> = {
  'literature-search': LiteratureResults,
  'literature-references': LiteratureReferences,
  'literature-downloads': LiteratureDownloads,
  'literature-delivery': LiteratureDeliveryCard,
  'literature-review': LiteratureReviewCard,
}

export function LiteratureCard({
  type,
  content,
  cardId,
  component,
}: {
  type: string
  content: Record<string, unknown>
  cardId: string
  component?: PluginReference
}): React.JSX.Element {
  const { state, act } = useApp()
  const thread = activeThread(state)
  const project = conversationProject(state.projects, thread.projectPath)
  const projectId = project?.id
  const projectName = project?.name
  const downloads = parseDownloadCard(content)
  const receiptKey = downloadRefreshKey(cardId, downloads)
  useEffect(() => {
    if (claimDownloadRefresh(receiptKey)) catalogue.reload()
  }, [receiptKey])
  const createPorts = useMemo(
    () =>
      (authorize: () => Promise<void>): LiteratureCardPorts => {
        const references = referencesContent(content)
        const result = parseResult(content)
        const review = parseReview(content)
        const sessionId = typeof content.session_id === 'string' ? content.session_id : ''
        const deliveryId = typeof content.delivery_id === 'string' ? content.delivery_id : ''
        const deliveryRequest = { sessionId, deliveryId }
        const reference = (id: string) => {
          const found = references?.references.find((candidate) => candidate.ref_id === id)
          if (!found) throw new Error(ITEM_UNAVAILABLE)
          return found
        }
        const delivery = async () => {
          if (!sessionId || !deliveryId) throw new Error(ITEM_UNAVAILABLE)
          const value = await requestLiteratureDelivery(sessionId, deliveryId)
          if (!deliveryProjectMatches(value.project_id, projectId, thread.projectPath))
            throw new Error(SCOPE_CHANGED)
          return value
        }
        const targetProject = (id: string | undefined): string | undefined => {
          if (id && !state.projects.some((candidate) => candidate.id === id))
            throw new Error(SCOPE_CHANGED)
          return id
        }
        const collection = async (id?: string, selectedProjectId = projectId): Promise<void> => {
          if (
            id &&
            !(await listLiteratureCollections(targetProject(selectedProjectId))).some(
              (candidate) => candidate.id === id
            )
          )
            throw new Error(SCOPE_CHANGED)
        }
        return {
          projectId,
          projectName,
          projects: state.projects.map(({ id, name }) => ({ id, name })),
          async openSource(refId) {
            const url = referenceUrl(reference(refId))
            if (!url) throw new Error(ITEM_UNAVAILABLE)
            await authorize()
            await window.scholarseed.openExternal(url)
          },
          async addReference(refId, collectionId) {
            await collection(collectionId)
            const file = new File([searchPapersBibtex([reference(refId)])], BIBLIOGRAPHY_FILENAME, {
              type: BIBLIOGRAPHY_MIME,
            })
            await authorize()
            const imported = await importBibliography([file], { projectId, collectionId })
            catalogue.reload()
            return { id: imported.items[0]?.id ?? '' }
          },
          collections: async (selectedProjectId = projectId) => {
            await authorize()
            return listLiteratureCollections(targetProject(selectedProjectId))
          },
          async createCollection(name, parentId) {
            await collection(parentId)
            await authorize()
            const created = await createLiteratureCollection(name, projectId, parentId)
            catalogue.reload()
            return created
          },
          async openResults() {
            if (!result) throw new Error(ITEM_UNAVAILABLE)
            await authorize()
            act.openLiteratureResult({
              session_id: result.session_id,
              card_id: cardId,
              title: result.criteria[0] || '',
            })
          },
          async openFulltext(paperId) {
            const paper = downloads?.papers.find((candidate) => candidate.paper_id === paperId)
            if (!downloads || !paper) throw new Error(ITEM_UNAVAILABLE)
            await authorize()
            return openDownloadedFulltext(act, downloads, paper, resolveDownloadedFulltext)
          },
          async openLibrary(paperId) {
            if (deliveryId && paperId) {
              const batch = await delivery()
              const paper = batch.papers.find((candidate) => candidate.paper_id === paperId)
              if (!paper?.literature_id) throw new Error(ITEM_UNAVAILABLE)
              await authorize()
              await act.openLiteratureItem(
                paper.literature_id,
                batch.choice?.project_id || batch.project_id
              )
              return
            }
            if (!downloads?.papers[0]) throw new Error(ITEM_UNAVAILABLE)
            await authorize()
            await act.openLiteratureDownloads(
              downloads.session_id,
              downloads.run,
              downloads.project_id || null,
              downloads.papers.map((paper) => paper.paper_id)
            )
          },
          delivery,
          async folders(parent, offset, selectedProjectId = projectId) {
            await delivery()
            await authorize()
            if (!selectedProjectId) throw new Error(SCOPE_CHANGED)
            return fetchResourceTree(targetProject(selectedProjectId), parent, offset)
          },
          async pickDirectory() {
            await delivery()
            await authorize()
            return (await window.scholarseed.pickDeliveryDirectory(deliveryRequest)) as Awaited<
              ReturnType<LiteratureCardPorts['pickDirectory']>
            >
          },
          async save(choice) {
            await delivery()
            const selectedProjectId =
              choice.target === 'project'
                ? targetProject(choice.project_id || projectId)
                : projectId
            if (choice.target === 'project' && !selectedProjectId) throw new Error(SCOPE_CHANGED)
            await collection(choice.collection_id, selectedProjectId)
            await authorize()
            const reply = await window.scholarseed.saveDelivery({ ...deliveryRequest, choice })
            if (reply.ok) {
              catalogue.reload()
              await act.reloadResourceTree(undefined, selectedProjectId)
              await act.reloadLiterature()
            }
            return reply as Awaited<ReturnType<LiteratureCardPorts['save']>>
          },
          async cancel() {
            await delivery()
            await authorize()
            return requestLiteratureDelivery(sessionId, deliveryId, CANCEL_DELIVERY)
          },
          async openDirectory() {
            await delivery()
            await authorize()
            return (await window.scholarseed.openDeliveryDirectory(deliveryRequest)) as Awaited<
              ReturnType<LiteratureCardPorts['openDirectory']>
            >
          },
          async openArtifact(artifactId) {
            const artifact = review?.artifacts.find(
              (candidate) => candidate.artifact_id === artifactId
            )
            if (!review || !artifact || thread.sessionId !== review.session_id)
              throw new Error(ITEM_UNAVAILABLE)
            await authorize()
            const absolute = thread.workdir
              ? `${thread.workdir.replace(/\/$/, '')}/${artifact.path.replace(/^\//, '')}`
              : artifact.path
            await openByDefault(
              { relative: artifact.path, absolute, title: artifact.title },
              {
                openPreview: (target) =>
                  act.openFilePreview({
                    ...target,
                    absolutePath: absolute,
                    sessionId: review.session_id,
                    artifactId: artifact.artifact_id,
                    mediaType: artifact.media_type,
                    size: artifact.size,
                  }),
                onFailed: (_context, note) =>
                  act.openFilePreview({
                    path: artifact.path,
                    absolutePath: absolute,
                    sessionId: review.session_id,
                    artifactId: artifact.artifact_id,
                    title: artifact.title,
                    mediaType: artifact.media_type,
                    size: artifact.size,
                    content: note,
                  }),
              }
            )
          },
        }
      },
    [
      content,
      cardId,
      projectId,
      projectName,
      state.projects,
      thread.projectPath,
      thread.sessionId,
      thread.workdir,
      act,
    ]
  )
  const componentData = useMemo(
    () => ({
      ...content,
      context: {
        projectId,
        projectName,
        ...(type === 'literature-delivery'
          ? { projects: state.projects.map(({ id, name }) => ({ id, name })) }
          : {}),
      },
    }),
    [content, type, projectId, projectName, state.projects]
  )
  const View = LITERATURE_CARD_VIEWS[type]
  if (component)
    return (
      <PluginInteraction
        reference={component}
        data={componentData}
        status="resolved"
        onAction={() => undefined}
        onRequest={async (action, values, capability, authorize) => {
          if (thread.projectPath && !project) throw new Error(SCOPE_CHANGED)
          if (
            !CARD_ALLOWED_OPERATIONS[type]?.includes(action) ||
            CARD_CAPABILITIES[action] !== capability
          )
            throw new Error('plugin_capability_undeclared')
          return cardRequest(createPorts(authorize))(action, values)
        }}
      />
    )
  return <View content={content} cardId={cardId} ports={createPorts(LOCAL_CARD_AUTHORIZATION)} />
}
