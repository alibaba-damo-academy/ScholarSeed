import { realpathSync } from 'fs'
import { isAbsolute, relative, resolve, sep } from 'path'

/**
 * 授权档位。
 *
 * `external` 是产品显式授权的项目外根（proposal 47 §6.7）：关联导入的资料
 * 物理上在项目外，废纸篓/访达/指定应用打开都必须能对它生效，否则「关联」在
 * 产品里就是只能看不能动。
 *
 * 档位集合与类型守卫在这里导出：主进程此前把 `'workspace' | 'session'` 这对
 * 字面量又硬编码了一遍，于是新增档位会**静默失效**——校验先把它拒掉，而
 * 类型上一切正常。
 */
export const AUTHORIZATION_SCOPES = ['workspace', 'session', 'external'] as const

export type AuthorizationScope = (typeof AUTHORIZATION_SCOPES)[number]

export function isAuthorizationScope(value: unknown): value is AuthorizationScope {
  return typeof value === 'string' && (AUTHORIZATION_SCOPES as readonly string[]).includes(value)
}

type Canonicalize = (path: string) => string

const canonicalizeRealPath: Canonicalize = (path) => realpathSync.native(resolve(path))

function isWithin(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

/** Canonical allowlist for OS-level file actions. Symlinks are resolved before the boundary check. */
export class PathAuthorizer {
  private readonly roots = new Map<AuthorizationScope, Set<string>>()

  constructor(private readonly canonicalize: Canonicalize = canonicalizeRealPath) {}

  replace(scope: AuthorizationScope, paths: string[]): void {
    const next = new Set<string>()
    for (const path of paths) {
      const canonical = this.tryCanonicalize(path)
      if (canonical) next.add(canonical)
    }
    this.roots.set(scope, next)
  }

  add(scope: AuthorizationScope, path: string): void {
    const canonical = this.tryCanonicalize(path)
    if (!canonical) return
    const roots = this.roots.get(scope) ?? new Set<string>()
    roots.add(canonical)
    this.roots.set(scope, roots)
  }

  clear(scope: AuthorizationScope): void {
    this.roots.delete(scope)
  }

  roots_of(scope: AuthorizationScope): string[] {
    return [...(this.roots.get(scope) ?? new Set<string>())]
  }

  resolveAuthorized(path: string): string | null {
    const target = this.tryCanonicalize(path)
    if (!target) return null
    for (const roots of this.roots.values()) {
      for (const root of roots) {
        if (isWithin(root, target)) return target
      }
    }
    return null
  }

  private tryCanonicalize(path: string): string | null {
    if (!path) return null
    try {
      return this.canonicalize(path)
    } catch {
      return null
    }
  }
}
