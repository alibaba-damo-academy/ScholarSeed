import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const git = promisify(execFile)
export const SOURCE_BASELINE_ENV = 'SCHOLARSEED_SOURCE_BASELINE'
const GIT_TIMEOUT_MS = 3000
let startupBaseline: string | undefined

export function sourceBaseline(): string | undefined {
  return startupBaseline
}

function repositoryIdentity(value: string): string {
  const remote = value.trim()
  if (/^[\w.-]+@[\w.-]+:[\w./-]+$/.test(remote)) return remote
  const url = new URL(remote)
  if (!['https:', 'http:', 'ssh:'].includes(url.protocol)) throw new Error('invalid_repository')
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return url.toString()
}

/** Freeze the program source identity, independently of the conversation cwd. */
export async function captureSourceBaseline(
  cwd: string,
  appVersion: string,
  packaged: boolean
): Promise<string | undefined> {
  startupBaseline = undefined
  if (packaged) return undefined
  const snapshot: Record<string, unknown> = {
    schema_version: 1,
    runtime_kind: 'local_dev',
    app_version: appVersion,
    captured_at: new Date().toISOString(),
    status: 'unavailable',
  }
  const read = async (...args: string[]) =>
    (
      await git('git', args, {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      })
    ).stdout.trim()
  try {
    const commit = await read('rev-parse', 'HEAD')
    const sourceRoot = await read('rev-parse', '--show-toplevel')
    const repository = repositoryIdentity(await read('remote', 'get-url', 'origin'))
    const branch = await read('rev-parse', '--abbrev-ref', 'HEAD')
    const dirty = Boolean(await read('status', '--porcelain=v1', '--untracked-files=normal'))
    if (!/^[0-9a-f]{40}$/.test(commit) || commit !== (await read('rev-parse', 'HEAD')))
      throw new Error('source_changed')
    Object.assign(snapshot, {
      status: 'captured',
      source_root: sourceRoot,
      repository_url: repository,
      branch,
      commit,
      dirty,
    })
  } catch {
    // Never retain an earlier launch's baseline or export Git stderr/credentials.
    snapshot.reason = 'source_identity_unavailable'
  }
  startupBaseline = JSON.stringify(snapshot)
  return startupBaseline
}
