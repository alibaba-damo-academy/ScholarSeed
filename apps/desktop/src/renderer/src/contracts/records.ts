export type RecordOwner = 'project_asset' | 'literature_attachment'

export interface RecordTarget {
  owner: RecordOwner
  scope_id: string
  subject_id: string
}
