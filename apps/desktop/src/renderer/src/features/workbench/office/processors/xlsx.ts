import {
  CALC_DOCUMENT_KIND,
  type OfficeProcessor,
  type OfficeProcessorBinding,
  type OfficeProcessorInput
} from './contract.ts'

const XLSX_SUFFIX = '.xlsx'

export const XLSX_PROCESSOR: OfficeProcessor = Object.freeze<OfficeProcessor>({
  kind: 'xlsx',
  bind: ({ filename }: OfficeProcessorInput): OfficeProcessorBinding => {
    if (!filename.toLowerCase().endsWith(XLSX_SUFFIX)) {
      throw new Error('office_processor_path_mismatch:xlsx')
    }
    return {
      filename,
      processor: 'xlsx',
      expectedDocumentKind: CALC_DOCUMENT_KIND
    }
  }
})
