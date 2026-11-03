import type { createBrowserBridge } from '../src/renderer/src/app/browser.ts'

export type PreviewRootScope = Parameters<ReturnType<typeof createBrowserBridge>['syncAuthorizedRoots']>[0]
export type PreviewRootResolvers = Record<PreviewRootScope, () => readonly string[]>
export const PREVIEW_ROOTS_PATH = '/__preview/roots'
export const PREVIEW_ROOT_MODES = { replace: 'replace', add: 'add' } as const
export type PreviewRootMode = typeof PREVIEW_ROOT_MODES[keyof typeof PREVIEW_ROOT_MODES]
const ROOT_SCOPES = { workspace: true, session: true, external: true } satisfies Record<PreviewRootScope, boolean>
const VIRTUAL_PREFIX = '/preview/'

export function previewRootUpdate(value: unknown): { scope: PreviewRootScope; roots: string[]; mode: PreviewRootMode } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { scope, roots, mode } = value as Record<string, unknown>
  if (typeof scope !== 'string' || !Object.prototype.hasOwnProperty.call(ROOT_SCOPES, scope)
    || (mode !== PREVIEW_ROOT_MODES.replace && mode !== PREVIEW_ROOT_MODES.add)
    || !Array.isArray(roots) || roots.some(root => typeof root !== 'string' || !root.startsWith(VIRTUAL_PREFIX) || root.split('/').includes('..'))) return null
  return { scope: scope as PreviewRootScope, roots: [...roots] as string[], mode }
}

export class PreviewRoots {
  private readonly granted = new Map<PreviewRootScope, Set<string>>()
  private disposed = false

  constructor(private readonly resolvers: PreviewRootResolvers) {}

  update(value: unknown): boolean {
    const update = previewRootUpdate(value)
    if (this.disposed || !update) return false
    const { scope: key, roots, mode } = update
    const allowed = new Set(this.resolvers[key]())
    if (roots.some(root => !allowed.has(root))) return false
    const next = mode === PREVIEW_ROOT_MODES.add ? this.read(key) : []
    this.granted.set(key, new Set([...next, ...roots]))
    return true
  }

  read(scope: PreviewRootScope): string[] {
    if (this.disposed) return []
    const allowed = new Set(this.resolvers[scope]())
    return [...this.granted.get(scope) ?? []].filter(root => allowed.has(root))
  }

  counts(): Record<PreviewRootScope, number> {
    return Object.fromEntries(Object.keys(this.resolvers).map(scope => [scope, this.read(scope as PreviewRootScope).length])) as Record<PreviewRootScope, number>
  }

  dispose(): void { this.disposed = true; this.granted.clear() }
}
