/** Shared by document admission, preview rendering and Office host demand. */
const PREVIEW_FORMATS = ['docx', 'pptx', 'xlsx'] as const
export type OfficePreviewFormat = (typeof PREVIEW_FORMATS)[number]

export function previewFormat(path: string): OfficePreviewFormat | null {
  const extension = path.split('.').pop()?.toLowerCase()
  return PREVIEW_FORMATS.find((format) => format === extension) ?? null
}

export function usesOfficePreview(path: string, viewKind: string): boolean {
  return viewKind === 'preview' && previewFormat(path) !== null
}

/** CSV has one native reader/editor for live documents and immutable snapshots. */
export function usesCsvDocument(path: string): boolean {
  return /\.csv$/i.test(path)
}
