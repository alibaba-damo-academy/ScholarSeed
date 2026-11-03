import type { MainView } from '../src/navigation.ts'
import type { PreviewPage } from './catalog.ts'

export const PDFE_MIN_GROUP_SCENARIOS = 3

export const PDFE_PAGE_GROUPS = [
  { id: 'center', title: 'pageProjectCenter' },
  { id: 'conversation', title: 'pageConversation' },
  { id: 'workspace', title: 'pageWorkspace' },
  { id: 'literature', title: 'pageLiterature' },
  { id: 'skills', title: 'pageSkills' },
  { id: 'browser', title: 'pageBrowser' },
  { id: 'settings', title: 'pageSettings' },
  { id: 'application', title: 'pageApplication' },
] as const
type PageGroup = typeof PDFE_PAGE_GROUPS[number]['id']
const VIEWS: Partial<Record<MainView, PageGroup>> = { home: 'center', projects: 'center', conversation: 'conversation', resource: 'workspace', literature: 'literature', skills: 'skills', browser: 'browser', writing: 'workspace' }
const APPLICATION_SURFACES = new Set(['login', 'feedback', 'close', 'error'])

export function pdfeNavigationGroup(page: PreviewPage) {
  const id = page.category === 'settings' ? 'settings' : page.category === 'surface' && APPLICATION_SURFACES.has(page.entry) ? 'application' : VIEWS[page.target?.view ?? page.entry as MainView] ?? 'application'
  return PDFE_PAGE_GROUPS.find(group => group.id === id)!
}
