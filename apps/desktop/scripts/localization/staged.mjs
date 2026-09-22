import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, sep } from 'node:path'
import { DESKTOP, checkResourceFiles } from './resources.mjs'
import { checkProjectCalls } from './calls.mjs'

const DESKTOP_PATH = 'apps/desktop'
// Electron imports the repository-owned Python launcher contract. Snapshot it
// from the index too, so staged checks never borrow working-tree dependencies.
const INPUT_PATHS = [DESKTOP_PATH, 'scripts']

/** Check a coherent index tree; never mix staged calls with unstaged resources/types. */
export function checkStaged({ root = resolve(DESKTOP, '../..'), dependencies = resolve(DESKTOP, 'node_modules') } = {}) {
  const git = (args, options = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options })
  if (!git(['diff', '--cached', '--name-only', '--', DESKTOP_PATH]).trim()) return { checked: false, errors: [] }
  const directory = mkdtempSync(join(tmpdir(), 'scholarseed-i18n-index-'))
  const desktop = resolve(directory, DESKTOP_PATH)
  try {
    const paths = git(['ls-files', '-z', '--', ...INPUT_PATHS])
    git(['checkout-index', '-z', '--stdin', '--prefix=' + directory + sep], { input: paths })
    mkdirSync(desktop, { recursive: true })
    // Installed dependencies are shared read-only; no snapshot package scripts execute.
    symlinkSync(dependencies, resolve(desktop, 'node_modules'), 'junction')
    const resources = checkResourceFiles({ desktop })
    return { checked: true, errors: checkProjectCalls(resources, { desktop, diagnostics: true }).map((error) => `[index] ${error.replaceAll(directory + sep, '')}`) }
  } catch (error) {
    return { checked: true, errors: [`[index] ${error.message.replaceAll(directory + sep, '')}`] }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
