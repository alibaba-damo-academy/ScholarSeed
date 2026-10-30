/** 导入入口标识，交给 startImport / catalogue.requestImport 分派。 */
export type ImportSourceValue = 'identifier' | 'files' | 'bib_ris' | 'zotero'

/** 入口图标标识；具体图标由 ImportSourceItem 统一渲染，各入口不再各抄一份三元。 */
export type ImportSourceIcon = 'identifier' | 'local-pdf' | 'bib-ris' | 'zotero'

/** 本地 PDF 导入会抽取元数据、结果可能不准；所有摆出这个入口的菜单共用同一句提示。 */
export const IMPORT_LOCAL_PDF_HINT_KEY = 'panel.importLocalPdfHint' as const

export interface ImportSource {
  readonly value: ImportSourceValue
  readonly labelKey:
    | 'panel.importByIdentifier'
    | 'panel.importLocalPdf'
    | 'panel.importBibRis'
    | 'panel.importZotero'
  /** 只有需要提前说明副作用的入口才带提示：本地 PDF 会抽取元数据，结果可能不准。 */
  readonly hintKey?: typeof IMPORT_LOCAL_PDF_HINT_KEY
  readonly icon: ImportSourceIcon
}

/** 数组顺序就是菜单顺序：标识符导入排在本地 PDF 之前。 */
export const IMPORT_SOURCES: readonly ImportSource[] = [
  { value: 'identifier', labelKey: 'panel.importByIdentifier', icon: 'identifier' },
  { value: 'files', labelKey: 'panel.importLocalPdf', hintKey: IMPORT_LOCAL_PDF_HINT_KEY, icon: 'local-pdf' },
  { value: 'bib_ris', labelKey: 'panel.importBibRis', icon: 'bib-ris' },
  { value: 'zotero', labelKey: 'panel.importZotero', icon: 'zotero' }
]
