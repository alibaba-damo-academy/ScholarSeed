import type { ExamplePlan } from './examples.cjs'

export interface PreparedExampleFile {
  id: string
  path: string
  relativePath: string
  sha256: string
  size: number
  mediaType: string
}
export interface PreparedExampleProject {
  key: string
  templateId: string
  templateRevision: string
  operation: string
  id: string
  name: string
  root: string
  files: PreparedExampleFile[]
}
export interface PreparationReceipt {
  status: 'preparing' | 'ready' | 'failed'
  contentDigest: string
  selection: ExamplePlan['selection'] | null
  workspace: string
  projects: PreparedExampleProject[]
}
export class PreparationError extends Error {
  readonly code: string
  readonly receipt: PreparationReceipt
}
export function prepareExample(options: {
  baseUrl: string
  workspace: string
  plan: ExamplePlan
  signal?: AbortSignal
}): Promise<PreparationReceipt>
