import type { Store } from '../../store'
import type { OnboardingGroup } from '../../../../onboarding'
import { getLiterature, listLiteratures } from '../literature/api'
import { documentWorkspaces } from '../workbench/workspace'
import { OVERVIEW_TAB } from '../workbench/tabs'
import { SAMPLE_SOURCE } from './sample'
import { clearSelection, OB_TIMING, selectSentence, settle, target, waitUntil } from './dom'
import type { GuideRequest, GuideStep } from './engine'

export type Notice = 'noProject' | 'sample' | 'sampleLimited' | 'noPdf' | 'openFailed' | 'unavailable'

export function guideValid(store: Store, request: GuideRequest): boolean {
  const { state } = store
  if (state.workspaceLoadState !== 'ready') return false
  if (request.group === 'home') return state.mainView === 'home' && !state.homeSelectedProjectId
  if (request.group === 'globalLib') return state.mainView === 'literature' && (request.force || !state.homeSelectedProjectId)
  if (request.group === 'project') return Boolean(state.homeSelectedProjectId && state.homeSelectedProjectId === request.projectId && ['resource', 'literature', 'writing'].includes(state.mainView))
  return Boolean(target('pdf-reader') && (!request.documentId || target('pdf-reader')?.dataset.obDocument === request.documentId))
}
export function guideSteps(get: () => Store, group: OnboardingGroup): GuideStep[] {
  const sidebar = async (view: 'resource' | 'literature', signal: AbortSignal): Promise<void> => {
    const { act, state } = get()
    if (state.aiPanel.open) act.toggleAiPanel()
    act.openWorkbenchView(view, { preserveProject: group === 'project' })
    await settle(signal)
  }
  const closeAi = async (signal: AbortSignal): Promise<void> => {
    if (get().state.aiPanel.open) get().act.toggleAiPanel()
    await settle(signal)
  }
  const openAi = (): void => { get().act.openPanel('user_request') }
  const expandDiscovery = (name: string) => async (signal: AbortSignal): Promise<void> => {
    // Click the existing control via its stable anchor, preserving its own state handler.
    const control = target(name)
    if (control?.getAttribute('aria-expanded') === 'false') control.click()
    await settle(signal)
  }
  const groups: Record<OnboardingGroup, GuideStep[]> = {
    home: [{ id: 'home', targets: [] }],
    project: [
      { id: 'project-switcher', targets: ['project-switcher'], before: signal => sidebar('resource', signal) },
      { id: 'project-resources', targets: ['resources'], extra: ['activity-resource'] },
      { id: 'project-discovery', targets: ['resource-discovery'], before: expandDiscovery('resource-discovery-toggle') },
      { id: 'project-literature', targets: ['literature'], extra: ['activity-literature'], before: signal => sidebar('literature', signal) },
      { id: 'project-ai', targets: ['ai-entry'], after: async signal => { await sidebar('resource', signal); openAi() } }
    ],
    globalLib: [
      { id: 'global-library', targets: ['literature'], extra: ['activity-literature'], before: signal => sidebar('literature', signal) },
      { id: 'global-import', targets: ['literature-import'] },
      { id: 'global-discovery', targets: ['literature-discovery'], before: expandDiscovery('literature-discovery-toggle') },
      { id: 'global-categories', targets: ['literature-project-categories', 'literature-categories'], before: expandDiscovery('literature-library-toggle') },
      { id: 'global-ai', targets: ['ai-entry'], after: openAi }
    ],
    pdf: [
      { id: 'pdf-figure', targets: ['pdf-figure'], before: closeAi },
      { id: 'pdf-tools', targets: ['pdf-tools'] },
      { id: 'pdf-selection', targets: ['pdf-selection'], setup: selectSentence },
      { id: 'pdf-ai', targets: ['ai-entry'], before: async signal => { clearSelection(); await closeAi(signal) }, after: openAi }
    ]
  }
  // Packaged samples have no library identity: do not pretend AI context or annotations exist.
  if (group === 'pdf' && target('pdf-reader')?.dataset.obDocument === `builtin:${SAMPLE_SOURCE.id}`) return [{ id: 'pdf-sample-selection', targets: ['pdf-selection'], before: closeAi, setup: selectSentence }]
  return groups[group]
}

export async function navigateGuide(get: () => Store, group: OnboardingGroup, signal: AbortSignal, notice: (key: Notice) => void, sampleTitle: string): Promise<GuideRequest | null> {
  const { state, act, set, closeMenus } = get()
  closeMenus(); act.openSettings(null)
  if (group === 'home') { act.openWorkbenchView('home'); await settle(signal); return { group } }
  if (group === 'project') {
    const id = state.homeSelectedProjectId
      ?? state.projects.find(project => project.id === state.onboarding.recentProjectId)?.id
      ?? state.projects[0]?.id
    if (!id) { notice('noProject'); set({ projectForm: { mode: 'create' } }); return null }
    act.selectProject(id); act.openWorkbenchView('resource'); await settle(signal)
    return { group, projectId: id }
  }
  act.openWorkbenchView('literature')
  await settle(signal)
  if (group === 'globalLib') return { group }
  const all = await listLiteratures({ page_size: 1 })
  signal.throwIfAborted()
  if (!all.total) {
    notice('sample')
    set({ activeTab: OVERVIEW_TAB.id })
    const id = await documentWorkspaces.forProject(null).open(SAMPLE_SOURCE, 'preview', sampleTitle)
    signal.throwIfAborted()
    set({ activeTab: id })
    await waitUntil(() => target('pdf-reader')?.dataset.obDocument === `builtin:${SAMPLE_SOURCE.id}`, signal, OB_TIMING.readerTimeout)
    notice('sampleLimited')
    return { group, documentId: `builtin:${SAMPLE_SOURCE.id}` }
  }
  // Try MRU identities first, tolerating removed items; then use the catalogue's first readable PDF.
  let chosen: Awaited<ReturnType<typeof getLiterature>> | undefined
  for (const entry of state.recentLiterature) {
    signal.throwIfAborted()
    try {
      const item = await getLiterature(entry.id)
      if (item.attachments.some(file => file.media_type === 'application/pdf' && file.availability === 'available')) { chosen = item; break }
    } catch (error) {
      // Deleted MRU pointers are stale. Network/server failures are handled by the catalogue request below.
      console.debug('[onboarding] recent document unavailable', entry.id, error)
    }
  }
  const item = chosen ?? (await listLiteratures({ attachment: 'with_pdf', page_size: 1 })).items[0]
  signal.throwIfAborted()
  const attachment = item?.attachments.find(file => file.media_type === 'application/pdf' && file.availability === 'available')
  if (!item || !attachment) { notice('noPdf'); return null }
  get().act.openLiteratureAttachment(item.id, attachment.id)
  const documentId = `literature:${item.id}:attachment:${attachment.id}`
  const ready = await waitUntil(() => target('pdf-reader')?.dataset.obDocument === documentId, signal, OB_TIMING.readerTimeout)
  if (!ready) throw new Error('onboarding_pdf_not_ready')
  return { group, documentId }
}
