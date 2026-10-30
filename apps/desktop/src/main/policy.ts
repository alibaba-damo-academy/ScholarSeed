import { spawnSync } from 'node:child_process'
import { isAbsolute } from 'node:path'

import {
  POLICY_SCHEMA_VERSION,
  emptyPolicy,
  parsePolicy,
  normalizePolicyOrigin,
} from './policy-record.ts'
import type {
  BrowserAgentAction,
  BrowserAgentDecision,
  BrowserAgentPersistentAction,
  StoredPolicy,
  SiteRule,
} from './policy-record.ts'
export { normalizePolicyOrigin } from './policy-record.ts'
export type {
  BrowserAgentAction,
  BrowserAgentDecision,
  BrowserAgentPersistentAction,
} from './policy-record.ts'

const MAX_POLICY_BYTES = 1024 * 1024
const IO_TIMEOUT_MILLISECONDS = 5000
const MAX_POLICY_CONFLICT_RETRIES = 3
const POLICY_CONFLICT_EXIT_CODE = 73
const POLICY_IO_ERROR = 'browser_policy_io_unavailable'
const POLICY_CONFLICT_ERROR = 'browser_policy_revision_conflict'
const POLICY_INVALID_ERROR = 'browser_policy_invalid'
const POLICY_CORRUPT_ERROR = 'browser_policy_corrupt'
const POLICY_IO_SCRIPT = `import fcntl
import json
import os
import stat
import sys
import uuid

mode, home, expected = sys.argv[1:]
if mode not in ('read', 'write') or not os.path.isabs(home):
    raise ValueError('invalid policy request')
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
def safe_parent(directory):
    details = os.fstat(directory)
    if details.st_uid not in (0, os.geteuid()):
        raise ValueError('untrusted policy ancestor')
    if details.st_mode & 0o022 and not details.st_mode & stat.S_ISVTX:
        raise ValueError('writable policy ancestor')

def open_home(home):
    directory = os.open('/', flags)
    try:
        for component in home.split('/'):
            if not component:
                continue
            if component in ('.', '..'):
                raise ValueError('invalid home component')
            safe_parent(directory)
            next_directory = os.open(component, flags, dir_fd=directory)
            os.close(directory)
            directory = next_directory
        details = os.fstat(directory)
        if details.st_uid != os.geteuid() or details.st_mode & 0o022:
            raise ValueError('unsafe policy home')
        return directory
    except:
        os.close(directory)
        raise

def read_policy(browser):
    try:
        source = os.open('agent-policy.json', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=browser)
    except FileNotFoundError:
        return None
    try:
        details = os.fstat(source)
        if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or details.st_size > 1048576 or details.st_uid != os.geteuid() or details.st_mode & 0o022:
            raise ValueError('invalid policy file')
        contents = os.read(source, 1048577)
        if len(contents) > 1048576:
            raise ValueError('policy file too large')
        return contents
    finally:
        os.close(source)

directory = open_home(home)
try:
    try:
        browser = os.open('browser', flags, dir_fd=directory)
    except FileNotFoundError:
        if mode == 'read':
            sys.stdout.buffer.write(b'0')
            sys.exit(0)
        os.mkdir('browser', 0o700, dir_fd=directory)
        browser = os.open('browser', flags, dir_fd=directory)
    try:
        browser_details = os.fstat(browser)
        if browser_details.st_uid != os.geteuid() or browser_details.st_mode & 0o022:
            raise ValueError('unsafe browser policy directory')
        if mode == 'read':
            current = read_policy(browser)
            sys.stdout.buffer.write(b'0' if current is None else b'1' + current)
        else:
            fcntl.flock(browser, fcntl.LOCK_EX)
            current = read_policy(browser)
            revision = 0 if current is None else json.loads(current.decode('utf-8'))['revision']
            if type(revision) is not int:
                raise ValueError('invalid policy revision')
            if revision != int(expected):
                sys.exit(${POLICY_CONFLICT_EXIT_CODE})
            contents = sys.stdin.buffer.read(1048577)
            if len(contents) > 1048576:
                raise ValueError('policy file too large')
            next_revision = json.loads(contents.decode('utf-8'))['revision']
            if type(next_revision) is not int or next_revision != revision + 1:
                raise ValueError('invalid next policy revision')
            temporary = '.agent-policy-' + uuid.uuid4().hex
            target = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=browser)
            try:
                with os.fdopen(target, 'wb', closefd=False) as output:
                    output.write(contents)
                    output.flush()
                    os.fsync(target)
                os.replace(temporary, 'agent-policy.json', src_dir_fd=browser, dst_dir_fd=browser)
                os.fsync(browser)
                verified_home = open_home(home)
                try:
                    verified_browser = os.open('browser', flags, dir_fd=verified_home)
                    try:
                        home_details = os.fstat(directory)
                        verified_home_details = os.fstat(verified_home)
                        browser_details = os.fstat(browser)
                        verified_browser_details = os.fstat(verified_browser)
                        if (home_details.st_dev, home_details.st_ino) != (verified_home_details.st_dev, verified_home_details.st_ino) or (browser_details.st_dev, browser_details.st_ino) != (verified_browser_details.st_dev, verified_browser_details.st_ino):
                            raise ValueError('policy directory was replaced')
                    finally:
                        os.close(verified_browser)
                finally:
                    os.close(verified_home)
            finally:
                os.close(target)
                try:
                    os.unlink(temporary, dir_fd=browser)
                except FileNotFoundError:
                    pass
    finally:
        os.close(browser)
finally:
    os.close(directory)
`

function policyIo(
  home: string,
  python: string | null,
  mode: 'read' | 'write',
  contents = '',
  expectedRevision = 0
): string {
  if (process.platform === 'win32' || !python || !isAbsolute(python) || !isAbsolute(home))
    throw new Error(POLICY_IO_ERROR)
  const result = spawnSync(
    python,
    ['-I', '-B', '-c', POLICY_IO_SCRIPT, mode, home, String(expectedRevision)],
    {
      input: contents,
      encoding: 'utf8',
      maxBuffer: MAX_POLICY_BYTES + 1,
      timeout: IO_TIMEOUT_MILLISECONDS,
      windowsHide: true,
    }
  )
  if (!result.error && result.status === POLICY_CONFLICT_EXIT_CODE && mode === 'write')
    throw new Error(POLICY_CONFLICT_ERROR)
  if (result.error || result.status !== 0) throw new Error(POLICY_IO_ERROR)
  return result.stdout
}

export function createBrowserPolicy(home: string, python: string | null) {
  const changeListeners = new Set<() => void>()
  const notifyChange = (): void => {
    for (const listener of changeListeners) {
      try {
        listener()
      } catch {}
    }
  }
  let policy: StoredPolicy
  let unavailable = false
  const read = (): StoredPolicy => {
    const raw = policyIo(home, python, 'read')
    if (raw === '0') return emptyPolicy()
    if (!raw.startsWith('1')) throw new Error(POLICY_CORRUPT_ERROR)
    return parsePolicy(raw.slice(1))
  }
  try {
    policy = read()
  } catch {
    policy = emptyPolicy()
    unavailable = true
  }
  const assertWritable = (): void => {
    if (unavailable) throw new Error(POLICY_IO_ERROR)
  }
  const refresh = (): void => {
    try {
      const latest = read()
      if (latest.revision < policy.revision) throw new Error(POLICY_CORRUPT_ERROR)
      const changed = unavailable || latest.revision !== policy.revision
      policy = latest
      unavailable = false
      if (changed) notifyChange()
    } catch {
      if (!unavailable) {
        unavailable = true
        notifyChange()
      }
    }
  }
  const decision = (input: string, action: BrowserAgentAction): BrowserAgentDecision => {
    if (action === 'submit') return 'ask'
    refresh()
    if (unavailable) return 'block'
    const origin = normalizePolicyOrigin(input)
    return policy.sites[origin]?.[action] ?? 'ask'
  }
  const commit = (change: (current: StoredPolicy) => StoredPolicy): void => {
    refresh()
    assertWritable()
    for (let attempt = 0; attempt < MAX_POLICY_CONFLICT_RETRIES; attempt += 1) {
      const candidate = change(policy)
      if (candidate === policy) return
      const next: StoredPolicy = {
        schemaVersion: POLICY_SCHEMA_VERSION,
        revision: policy.revision + 1,
        agentBrowserUseEnabled: candidate.agentBrowserUseEnabled,
        sites: candidate.sites,
      }
      try {
        policyIo(home, python, 'write', JSON.stringify(next), policy.revision)
      } catch (error) {
        if (error instanceof Error && error.message === POLICY_CONFLICT_ERROR) {
          refresh()
          assertWritable()
          continue
        }
        unavailable = true
        notifyChange()
        throw error
      }
      policy = next
      notifyChange()
      return
    }
    throw new Error(POLICY_CONFLICT_ERROR)
  }
  const update = (input: string, change: (existing: SiteRule) => SiteRule): void => {
    const origin = normalizePolicyOrigin(input)
    commit((current) => {
      const existing = current.sites[origin] ?? { read: 'ask', interact: 'ask' }
      const updated = change(existing)
      if (existing.read === updated.read && existing.interact === updated.interact) return current
      const sites = { ...current.sites, [origin]: updated }
      if (sites[origin].read === 'ask' && sites[origin].interact === 'ask') delete sites[origin]
      return { ...current, sites }
    })
  }
  const set = (
    input: string,
    action: BrowserAgentPersistentAction,
    choice: BrowserAgentDecision
  ): void => {
    if (action !== 'read' && action !== 'interact') throw new Error(POLICY_INVALID_ERROR)
    if (choice !== 'ask' && choice !== 'allow' && choice !== 'block')
      throw new Error(POLICY_INVALID_ERROR)
    update(input, (existing) => ({ ...existing, [action]: choice }))
  }
  return {
    onChange(listener: () => void): () => void {
      changeListeners.add(listener)
      return () => {
        changeListeners.delete(listener)
      }
    },
    agentUseEnabled: (): boolean => {
      refresh()
      assertWritable()
      return policy.agentBrowserUseEnabled
    },
    agentUseRevision: (): number | null => {
      refresh()
      assertWritable()
      return policy.agentBrowserUseEnabled ? policy.revision : null
    },
    decision,
    inspect: (
      input: string,
      action: BrowserAgentAction
    ): { revision: number; decision: BrowserAgentDecision } => {
      refresh()
      assertWritable()
      const origin = normalizePolicyOrigin(input)
      return {
        revision: policy.revision,
        decision: !policy.agentBrowserUseEnabled
          ? 'block'
          : action === 'submit'
            ? 'ask'
            : (policy.sites[origin]?.[action] ?? 'ask'),
      }
    },
    effectiveDecision: (input: string, action: BrowserAgentAction): BrowserAgentDecision => {
      refresh()
      return unavailable || !policy.agentBrowserUseEnabled ? 'block' : decision(input, action)
    },
    setAgentBrowserUse(enabled: boolean): void {
      if (typeof enabled !== 'boolean') throw new Error(POLICY_INVALID_ERROR)
      commit((current) =>
        current.agentBrowserUseEnabled === enabled
          ? current
          : { ...current, agentBrowserUseEnabled: enabled }
      )
    },
    revision: (): number => {
      refresh()
      assertWritable()
      return policy.revision
    },
    valid: (
      input: string,
      action: BrowserAgentPersistentAction,
      capturedRevision: number
    ): boolean => {
      refresh()
      return (
        !unavailable &&
        policy.agentBrowserUseEnabled &&
        policy.revision === capturedRevision &&
        decision(input, action) === 'allow'
      )
    },
    sites: (): Array<{
      origin: string
      read: BrowserAgentDecision
      interact: BrowserAgentDecision
    }> => {
      refresh()
      return unavailable
        ? []
        : Object.entries(policy.sites).map(([origin, rule]) => ({ origin, ...rule }))
    },
    snapshot: () => {
      refresh()
      assertWritable()
      return {
        revision: policy.revision,
        agentBrowserUseEnabled: policy.agentBrowserUseEnabled,
        sites: Object.entries(policy.sites).map(([origin, rule]) => ({ origin, ...rule })),
      }
    },
    set,
    revoke: (input: string, action: BrowserAgentPersistentAction): void =>
      set(input, action, 'ask'),
    remove: (input: string): void => update(input, () => ({ read: 'ask', interact: 'ask' })),
  }
}
