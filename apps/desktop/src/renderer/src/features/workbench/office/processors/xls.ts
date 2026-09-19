import {
  CALC_DOCUMENT_KIND,
  type OfficeProcessor,
  type OfficeProcessorBinding,
  type OfficeProcessorInput
} from './contract.ts'

const XLS_SUFFIX = '.xls'

export const XLS_PROCESSOR: OfficeProcessor = Object.freeze<OfficeProcessor>({
  kind: 'xls',
  bind: ({ filename }: OfficeProcessorInput): OfficeProcessorBinding => {
    if (!filename.toLowerCase().endsWith(XLS_SUFFIX)) {
      throw new Error('office_processor_path_mismatch:xls')
    }
    return {
      filename,
      processor: 'xls',
      expectedDocumentKind: CALC_DOCUMENT_KIND
    }
  }
})
