export interface ExampleFile {
  readonly id: string
  readonly path: string
  readonly sourcePath: string
  readonly sourceRoot: string
  readonly mediaType: string
  readonly size: number
  readonly sha256: string
}
export interface ExampleProject {
  readonly key: string
  readonly id: string
  readonly revision: string
  readonly name: string
  readonly description: string
  readonly source: { readonly kind: string; readonly origin: string; readonly rights: string }
  readonly files: readonly ExampleFile[]
}
export interface ExamplePlan {
  readonly schemaVersion: number
  readonly selection: { readonly kind: 'project' | 'workspace'; readonly id: string; readonly revision: string }
  readonly contentDigest: string
  readonly projects: readonly ExampleProject[]
}
export interface ExampleOptions {
  readonly root?: string
  readonly projectId?: string
  readonly workspaceId?: string
  readonly expectedDigest?: string
}
export const EXAMPLE_ROOT: string
export class ExampleError extends Error { readonly code: string }
export function resolveExample(options?: ExampleOptions): ExamplePlan
export function readExampleFile(file: ExampleFile): Buffer
export function fileMetadata(path: string): { size: number; sha256: string }
