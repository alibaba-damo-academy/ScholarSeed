const PROJECT_HEADING_MAX_CHARACTERS = 10
const PROJECT_HEADING_ELLIPSIS = '...'
const projectNameSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function assistantHeadingScope(
  fullscreen: boolean,
  sidebarVisible: boolean,
  projectName: string | null,
  globalLiterature: boolean,
  literatureOverview: string
): string | null {
  if (!fullscreen || sidebarVisible) return null
  return projectName ?? (globalLiterature ? literatureOverview : null)
}

export function truncateProjectName(name: string): string {
  const characters = Array.from(projectNameSegmenter.segment(name), (part) => part.segment)
  if (characters.length <= PROJECT_HEADING_MAX_CHARACTERS) return name
  return `${characters.slice(0, PROJECT_HEADING_MAX_CHARACTERS).join('')}${PROJECT_HEADING_ELLIPSIS}`
}
