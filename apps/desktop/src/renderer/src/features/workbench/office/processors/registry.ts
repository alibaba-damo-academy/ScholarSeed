import type { DocumentProcessorKind } from '../../../../contracts/workbench'
import {
  CALC_DOCUMENT_KIND,
  type OfficeProcessor,
  type OfficeProcessorBinding,
  type OfficeProcessorInput
} from './contract.ts'
import { XLS_PROCESSOR } from './xls.ts'
import { XLSX_PROCESSOR } from './xlsx.ts'

const CSV_SUFFIX = '.csv'

const CSV_PROCESSOR: OfficeProcessor = Object.freeze<OfficeProcessor>({
  kind: 'csv',
  bind: ({ filename }: OfficeProcessorInput): OfficeProcessorBinding => {
    if (!filename.toLowerCase().endsWith(CSV_SUFFIX)) {
      throw new Error('office_processor_path_mismatch:csv')
    }
    return {
      filename,
      processor: 'csv',
      expectedDocumentKind: CALC_DOCUMENT_KIND
    }
  }
})

const PROCESSORS: Readonly<Record<DocumentProcessorKind, OfficeProcessor>> = Object.freeze({
  csv: CSV_PROCESSOR,
  xls: XLS_PROCESSOR,
  xlsx: XLSX_PROCESSOR
})

export function officeProcessor(kind: DocumentProcessorKind | null): OfficeProcessor {
  if (kind === null) throw new Error('office_processor_missing')
  const processor = PROCESSORS[kind]
  if (!processor) throw new Error(`office_processor_unknown:${String(kind)}`)
  return processor
}
