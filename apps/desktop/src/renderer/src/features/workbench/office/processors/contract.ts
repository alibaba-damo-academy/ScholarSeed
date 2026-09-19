import type { DocumentProcessorKind } from '../../../../contracts/workbench'

export const CALC_DOCUMENT_KIND = 'calc'

export interface OfficeProcessorInput {
  filename: string
}

export interface OfficeProcessorBinding {
  filename: string
  processor: DocumentProcessorKind
  expectedDocumentKind: typeof CALC_DOCUMENT_KIND
}

export interface OfficeProcessor {
  kind: DocumentProcessorKind
  bind: (input: OfficeProcessorInput) => OfficeProcessorBinding
}
