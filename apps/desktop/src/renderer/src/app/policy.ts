import { browserSettingsSection } from '../../../navigation.ts'

const BROWSER_FEATURE = 'browser'
const SAFE_VIEW = 'home'
const SAFE_TAB = 'overview'
const ROUTE_FEATURES: Readonly<Record<string, string>> = { browser: BROWSER_FEATURE }
const TAB_FEATURES: Readonly<Record<string, string>> = { browser: BROWSER_FEATURE }
const SETTINGS_FEATURES: Readonly<Record<string, string>> = { browser: BROWSER_FEATURE }
const HIL_FEATURES: Readonly<Record<string, string>> = { browser_approval: BROWSER_FEATURE, browser_history_approval: BROWSER_FEATURE }

interface NavigationState {
  mainView: string
  tabs: readonly { id: string; kind: string }[]
  activeTab: string
  accountSettingsPage: string | null
  browserSettingsSection?: unknown
}

interface Location {
  view: string
  settingsPage: string | null
  browserSettingsSection?: unknown
  target?: { kind: string; id?: string } | null
}

export function createAvailabilityPolicy(browserEnabled: boolean) {
  const enabled: Readonly<Record<string, boolean>> = { [BROWSER_FEATURE]: browserEnabled }
  const available = (requirements: Readonly<Record<string, string>>, key: string): boolean => {
    const feature = requirements[key]
    return !feature || enabled[feature] === true
  }
  const routeAvailable = (view: string): boolean => available(ROUTE_FEATURES, view)
  const tabIdAvailable = (id: string): boolean => available(TAB_FEATURES, id)
  const tabAvailable = (tab: { id: string; kind: string }): boolean =>
    available(TAB_FEATURES, tab.kind) && tabIdAvailable(tab.id)
  const settingsAvailable = (page: string | null): boolean => page === null || available(SETTINGS_FEATURES, page)
  return {
    browserEnabled,
    routeAvailable,
    tabAvailable,
    tabIdAvailable,
    settingsAvailable,
    hilAvailable: (kind: string): boolean => available(HIL_FEATURES, kind),
    navigationPatch<State extends NavigationState>(current: State, patch: Partial<State>): Partial<State> {
      const projected = { ...patch }
      if (projected.mainView !== undefined && !routeAvailable(projected.mainView)) projected.mainView = routeAvailable(current.mainView) ? current.mainView : SAFE_VIEW
      if (projected.tabs) projected.tabs = projected.tabs.filter(tabAvailable) as State['tabs']
      if (projected.activeTab !== undefined && !tabIdAvailable(projected.activeTab)) projected.activeTab = tabIdAvailable(current.activeTab) ? current.activeTab : SAFE_TAB
      if (projected.accountSettingsPage !== undefined && !settingsAvailable(projected.accountSettingsPage)) projected.accountSettingsPage = settingsAvailable(current.accountSettingsPage) ? current.accountSettingsPage : null
      if ('accountSettingsPage' in patch || 'browserSettingsSection' in patch) projected.browserSettingsSection = browserSettingsSection(projected.accountSettingsPage === undefined ? current.accountSettingsPage : projected.accountSettingsPage,
        projected.accountSettingsPage !== undefined && !('browserSettingsSection' in patch) ? undefined : 'browserSettingsSection' in patch ? projected.browserSettingsSection : current.browserSettingsSection)
      return projected
    },
    navigationLocation<Target extends Location>(location: Target): Target {
      const settingsPage = settingsAvailable(location.settingsPage) ? location.settingsPage : null
      const section = browserSettingsSection(settingsPage, location.browserSettingsSection)
      if (browserEnabled && section === location.browserSettingsSection) return location
      return {
        ...location,
        view: routeAvailable(location.view) ? location.view : SAFE_VIEW,
        ...(location.target === undefined ? {} : { target: location.target?.kind === 'tab' && !tabIdAvailable(location.target.id ?? '') ? null : location.target }),
        settingsPage,
        browserSettingsSection: section
      }
    }
  }
}

export type AvailabilityPolicy = ReturnType<typeof createAvailabilityPolicy>
export const availabilityPolicy = createAvailabilityPolicy(
  typeof window !== 'undefined' && window.scholarseed?.browserEnabled === true
)
