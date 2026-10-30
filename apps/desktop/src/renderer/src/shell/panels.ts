import { featureRegistry } from '../app/composition'

const PANEL_BY_VIEW: Record<string, string> = {
  projects: 'project-manage',
  resource: 'resource-tree',
  literature: 'literature-filters'
}

export function modulePanelForView(view: string) {
  const panelKey = PANEL_BY_VIEW[view]
  return featureRegistry.panels.find((entry) => entry.key === panelKey && entry.slot === 'module')
}
