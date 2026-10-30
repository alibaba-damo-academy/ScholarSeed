import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { DESKTOP } from './resources.mjs'
import { scanSource, newFindings } from './source.mjs'

export const DEBT_PATH = resolve(DESKTOP, 'scripts/ci/localization/debt.json')
const ROOT = resolve(DESKTOP, '../..')
const PREFIX = 'apps/desktop/'
const SOURCE = /^apps\/desktop\/src\/(?:main|preload|renderer\/src)\/.*\.[jt]sx?$/
// Tests are executable fixtures; UI source itself is never excluded wholesale.
const FIXTURE = /(?:\.test\.|\.fixture\.|\.d\.ts$)/
function git(args, root = ROOT) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }) }
export function resolveBase(ref, root = ROOT) {
  if (!ref) throw new Error('Missing Git comparison base; supply --base <ref> or I18N_BASE_REF')
  return git(['rev-parse', '--verify', `${ref}^{commit}`], root).trim()
}
function tracked(base, root = ROOT) { return git(['ls-tree', '-r', '--name-only', '-z', base, '--', PREFIX + 'src'], root).split('\0').filter(Boolean) }
function candidates(paths) { return paths.filter((path) => SOURCE.test(path) && !FIXTURE.test(path)) }
function at(base, path, root = ROOT) { return git(['show', `${base}:${path}`], root) }

/** A checked-in debt inventory can only shrink, even if its claimed base changes. */
export function checkDebt(debt, previous) {
  if (debt.version !== 1 || !debt.baseCommit || !debt.files || typeof debt.files !== 'object') return ['Invalid localization debt inventory']
  if (!previous) return []
  const errors = []
  for (const [path, rows] of Object.entries(debt.files)) {
    const remaining = new Map()
    for (const row of previous.files[path] ?? []) remaining.set(row.identity, (remaining.get(row.identity) ?? 0) + 1)
    for (const row of rows) {
      const count = remaining.get(row.identity) ?? 0
      if (!count) errors.push(`${path}: localization debt must not expand (${row.kind}: ${row.text})`)
      else remaining.set(row.identity, count - 1)
    }
  }
  return errors
}

export function generateDebt(ref, { tighten = false, root = ROOT, debtPath = DEBT_PATH } = {}) {
  const base = resolveBase(ref, root)
  const previous = existsSync(debtPath) ? JSON.parse(readFileSync(debtPath, 'utf8')) : undefined
  if (previous && !tighten) throw new Error('Debt already exists; only explicit --tighten may remove debt')
  const files = {}
  for (const path of candidates(tracked(base, root))) {
    const rows = scanSource(at(base, path, root), path)
    if (!rows.length) continue
    if (previous) {
      const allowed = previous.files[path] ?? []
      const remaining = new Map()
      for (const row of allowed) remaining.set(row.identity, (remaining.get(row.identity) ?? 0) + 1)
      const retained = rows.filter((row) => {
        const count = remaining.get(row.identity) ?? 0
        if (!count) return false
        remaining.set(row.identity, count - 1)
        return true
      })
      if (retained.length) files[path] = retained
    } else files[path] = rows
  }
  const output = { version: 1, baseCommit: base, policy: 'Exact AST owner/kind/text identity; no new debt. Tests are fixtures. Review human-visible semantics separately.', files }
  writeFileSync(debtPath, JSON.stringify(output, null, 2) + '\n')
  return output
}

export function checkSources(ref, { root = ROOT, debtPath = DEBT_PATH } = {}) {
  const debt = JSON.parse(readFileSync(debtPath, 'utf8'))
  const base = resolveBase(ref ?? process.env.I18N_BASE_REF ?? debt.baseCommit, root)
  const debtRelative = relative(root, debtPath).split('\\').join('/')
  const hasBaseDebt = git(['ls-tree', '--name-only', base, '--', debtRelative], root).trim() === debtRelative
  const originalDebt = hasBaseDebt ? JSON.parse(at(base, debtRelative, root)) : undefined
  const errors = checkDebt(debt, originalDebt)
  const indexedDebt = git(['ls-files', '--cached', '--', debtRelative], root).trim() === debtRelative
  if (indexedDebt) errors.push(...checkDebt(JSON.parse(at('', debtRelative, root)), originalDebt).map((error) => `${error} [index]`))
  const baseFiles = new Set(tracked(base, root))
  // Inspect the index separately: an unstaged correction must not hide staged debt.
  const stagedFiles = new Set(candidates(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z', base, '--', PREFIX + 'src'], root).split('\0').filter(Boolean)))
  const currentFiles = candidates(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', PREFIX + 'src'], root).split('\0').filter(Boolean))
  for (const path of new Set([...currentFiles, ...stagedFiles])) {
    const absolute = resolve(root, path)
    const previous = baseFiles.has(path) ? scanSource(at(base, path, root), path) : []
    const snapshots = []
    if (existsSync(absolute)) snapshots.push(['worktree', readFileSync(absolute, 'utf8')])
    if (stagedFiles.has(path)) snapshots.push(['index', at('', path, root)])
    const reported = new Set()
    for (const [surface, source] of snapshots) {
      for (const hit of newFindings(scanSource(source, path), previous, debt.files[path] ?? [])) {
        const signature = `${hit.identity}:${hit.line}`
        if (reported.has(signature)) continue
        reported.add(signature)
        errors.push(`${path}:${hit.line}: ${hit.kind}: ${hit.text} [${surface}]`)
      }
    }
  }
  return { base, errors }
}
