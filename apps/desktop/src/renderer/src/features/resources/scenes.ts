/** Presentation presets project onto the existing admission policy. */
export const VERSION_SCENES = [
  { id: 'reading', titleKey: 'fileSettings.reading', descriptionKey: 'fileSettings.readingDescription', patterns: ['*.md', '*.markdown', '*.txt', '*.pdf'] },
  { id: 'data', titleKey: 'fileSettings.data', descriptionKey: 'fileSettings.dataDescription', patterns: ['*.csv', '*.tsv', '*.xls', '*.xlsx', '*.json', '*.jsonl'] },
  { id: 'office', titleKey: 'fileSettings.office', descriptionKey: 'fileSettings.officeDescription', patterns: ['*.doc', '*.docx', '*.xls', '*.xlsx', '*.ppt', '*.pptx', '*.pdf'] },
  { id: 'code', titleKey: 'fileSettings.code', descriptionKey: 'fileSettings.codeDescription', patterns: ['*.py', '*.r', '*.java', '*.c', '*.cpp', '*.h', '*.sh', '*.js', '*.jsx', '*.ts', '*.tsx', '*.html', '*.css', '*.yaml', '*.yml', '*.toml', '*.xml'] }
] as const
export type VersionScene = typeof VERSION_SCENES[number]['id']
export function scenePatterns(ids: readonly VersionScene[]): string[] {
  return [...new Set(VERSION_SCENES.filter(scene => ids.includes(scene.id)).flatMap(scene => [...scene.patterns]))]
}
export function changeScenes(patterns: string[], previous: VersionScene[], next: VersionScene[]): string[] {
  const owned = new Set(scenePatterns(previous))
  return [...new Set([...scenePatterns(next), ...patterns.filter(pattern => !owned.has(pattern))])]
}
export function matchingScenes(patterns: string[]): VersionScene[] {
  const ids = VERSION_SCENES.filter(scene => scene.patterns.every(pattern => patterns.includes(pattern))).map(scene => scene.id)
  const union = scenePatterns(ids)
  return union.length === new Set(patterns).size && union.every(pattern => patterns.includes(pattern)) ? ids : []
}
export const VERSION_TYPE_PATTERNS = [...new Set(VERSION_SCENES.flatMap(scene => [...scene.patterns]))]

export const VERSION_EXCLUSION_TYPES = ['*.tmp', '*.log']

export const VERSION_TYPE_LABELS = {
  '*.md': 'fileSettings.markdownType', '*.markdown': 'fileSettings.markdownType',
  '*.txt': 'fileSettings.textType', '*.pdf': 'fileSettings.pdfType',
  '*.csv': 'fileSettings.csvType', '*.tsv': 'fileSettings.tsvType',
  '*.xls': 'fileSettings.excelType', '*.xlsx': 'fileSettings.excelType',
  '*.doc': 'fileSettings.wordType', '*.docx': 'fileSettings.wordType',
  '*.ppt': 'fileSettings.presentationType', '*.pptx': 'fileSettings.presentationType',
  '*.json': 'fileSettings.jsonType', '*.jsonl': 'fileSettings.jsonlType',
  '*.tmp': 'fileSettings.temporaryType', '*.log': 'fileSettings.logType'
} as const
