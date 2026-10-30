import {
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { isAbsolute, join, win32 } from 'node:path'

import type { BrowserDownloadSettings } from '../browser.ts'
import { decodeDownloadPreferences } from './downloads-record.ts'
import { browserResourceAllowed } from './navigation.ts'

const PREFERENCES_FILENAME = 'downloads.json'
export const DOWNLOAD_STAGE_PREFIX = 'download-'
const STAGE_MANIFEST_FILENAME = 'manifest.json'
const TEMPORARY_SUFFIX = '.tmp'
const FALLBACK_FILENAME = 'download'
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const FIRST_PRINTABLE_CODE_POINT = 32
const DELETE_CODE_POINT = 127
const INVALID_FILENAME_CHARACTERS = /[<>:"|?*]/g
const PRIVATE_FILE_MODE = 0o600
const MAX_PUBLISH_OUTPUT = 4096
const MACOS_PUBLISH_SCRIPT = `import ctypes
import errno
import json
import os
import stat
import sys
import uuid

source, directory, filename = sys.argv[1:]
if filename in ('.', '..') or chr(0) in filename:
    raise ValueError('invalid download filename')
if not os.path.isabs(source) or not os.path.isabs(directory) or not filename or '/' in filename or '\\\\' in filename:
    raise ValueError('invalid download publication arguments')
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
def open_directory(path):
    descriptor = os.open('/', flags)
    try:
        for component in path.split('/'):
            if not component:
                continue
            if component in ('.', '..'):
                raise ValueError('invalid destination component')
            next_descriptor = os.open(component, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor
    except:
        os.close(descriptor)
        raise

stage_directory, staged_name = os.path.split(source)
stage_fd = open_directory(stage_directory)
try:
    manifest_fd = os.open('manifest.json', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=stage_fd)
    try:
        manifest_stat = os.fstat(manifest_fd)
        if not stat.S_ISREG(manifest_stat.st_mode) or manifest_stat.st_nlink != 1 or manifest_stat.st_size > 4096:
            raise ValueError('invalid download manifest')
        manifest = json.loads(os.read(manifest_fd, 4097))
        if manifest.get('filename') != filename:
            raise ValueError('download manifest mismatch')
        if manifest.get('publicationAttempted'):
            raise ValueError('publication_outcome_unknown')
    finally:
        os.close(manifest_fd)
    source_fd = os.open(staged_name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=stage_fd)
    try:
        source_stat = os.fstat(source_fd)
        if not stat.S_ISREG(source_stat.st_mode) or source_stat.st_nlink != 1:
            raise ValueError('invalid staged download')
        os.fsync(source_fd)
        manifest_name = 'manifest-' + uuid.uuid4().hex + '.tmp'
        temporary_fd = os.open(manifest_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=stage_fd)
        try:
            payload = json.dumps({'filename': filename, 'publicationAttempted': True}).encode()
            with os.fdopen(os.dup(temporary_fd), 'wb', closefd=True) as manifest_file:
                manifest_file.write(payload)
                manifest_file.flush()
            os.fsync(temporary_fd)
        finally:
            os.close(temporary_fd)
        os.replace(manifest_name, 'manifest.json', src_dir_fd=stage_fd, dst_dir_fd=stage_fd)
        os.fsync(stage_fd)
        directory_fd = open_directory(directory)
        try:
            clone = ctypes.CDLL(None, use_errno=True).fclonefileat
            clone.argtypes = (ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32)
            clone.restype = ctypes.c_int
            stem, extension = os.path.splitext(filename)
            for index in range(10000):
                candidate = filename if index == 0 else f'{stem} ({index}){extension}'
                if clone(source_fd, directory_fd, os.fsencode(candidate), 0) == 0:
                    os.fsync(directory_fd)
                    staged_stat = os.stat(staged_name, dir_fd=stage_fd, follow_symlinks=False)
                    if (staged_stat.st_dev, staged_stat.st_ino) != (source_stat.st_dev, source_stat.st_ino):
                        raise ValueError('staged download changed during publication')
                    os.unlink(staged_name, dir_fd=stage_fd)
                    print(os.path.join(directory, candidate))
                    break
                error = ctypes.get_errno()
                if error != errno.EEXIST:
                    raise OSError(error, os.strerror(error))
            else:
                raise FileExistsError('no available download filename')
        finally:
            os.close(directory_fd)
    finally:
        os.close(source_fd)
finally:
    os.close(stage_fd)`

const MACOS_PROBE_SCRIPT = `import ctypes
import os
import sys
import uuid

home, directory = sys.argv[1:]
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
def open_directory(path):
    descriptor = os.open('/', flags)
    try:
        for component in path.split('/'):
            if not component:
                continue
            if component in ('.', '..'):
                raise ValueError('invalid directory component')
            next_descriptor = os.open(component, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor
    except:
        os.close(descriptor)
        raise

source_directory = open_directory(home)
try:
    target_directory = open_directory(directory)
    try:
        token = uuid.uuid4().hex
        source_name = '.scholarseed-download-probe-source-' + token
        target_name = '.scholarseed-download-probe-target-' + token
        source = os.open(source_name, os.O_RDONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=source_directory)
        try:
            clone = ctypes.CDLL(None, use_errno=True).fclonefileat
            clone.argtypes = (ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32)
            clone.restype = ctypes.c_int
            if clone(source, target_directory, os.fsencode(target_name), 0) != 0:
                error = ctypes.get_errno()
                raise OSError(error, os.strerror(error))
        finally:
            os.close(source)
            try:
                os.unlink(source_name, dir_fd=source_directory)
            except FileNotFoundError:
                pass
            finally:
                try:
                    os.unlink(target_name, dir_fd=target_directory)
                except FileNotFoundError:
                    pass
    finally:
        os.close(target_directory)
finally:
    os.close(source_directory)`

export function canPublishDownload(python: string, home: string, directory: string): boolean {
  if (process.platform !== 'darwin') return false
  const result = spawnSync(python, ['-I', '-B', '-c', MACOS_PROBE_SCRIPT, home, directory], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: MAX_PUBLISH_OUTPUT,
  })
  return result.status === 0 && !result.error
}

const MACOS_DISCARD_SCRIPT = `import json
import os
import stat
import sys

source, filename = sys.argv[1:]
if not os.path.isabs(source) or not filename or filename in ('.', '..') or '/' in filename or chr(92) in filename or chr(0) in filename:
    raise ValueError('invalid staged download cleanup arguments')
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
def open_directory(path):
    descriptor = os.open('/', flags)
    try:
        for component in path.split('/'):
            if not component:
                continue
            if component in ('.', '..'):
                raise ValueError('invalid directory component')
            next_descriptor = os.open(component, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor
    except:
        os.close(descriptor)
        raise

parent, stage_name = os.path.split(source)
if not stage_name.startswith('download-') or stage_name in ('.', '..'):
    raise ValueError('invalid staged download directory')
parent_fd = open_directory(parent)
try:
    stage_fd = os.open(stage_name, flags, dir_fd=parent_fd)
    try:
        opened = os.fstat(stage_fd)
        manifest_fd = os.open('manifest.json', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=stage_fd)
        try:
            details = os.fstat(manifest_fd)
            if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or details.st_size > 4096:
                raise ValueError('invalid download manifest')
            manifest = json.loads(os.read(manifest_fd, 4097))
            if manifest.get('filename') != filename:
                raise ValueError('download manifest mismatch')
        finally:
            os.close(manifest_fd)
        current = os.stat(stage_name, dir_fd=parent_fd, follow_symlinks=False)
        if (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino):
            raise ValueError('staged download changed')
        for leaf in (filename, filename + '.crdownload', 'manifest.json'):
            try:
                os.unlink(leaf, dir_fd=stage_fd)
            except FileNotFoundError:
                pass
        os.rmdir(stage_name, dir_fd=parent_fd)
    finally:
        os.close(stage_fd)
finally:
    os.close(parent_fd)`

export function publishDownload(
  python: string,
  stagingPath: string,
  directory: string,
  filename: string
): Promise<string> {
  if (process.platform !== 'darwin')
    return Promise.reject(new Error('automatic_download_unavailable'))
  return new Promise((resolve, reject) => {
    const child = spawn(
      python,
      ['-I', '-B', '-c', MACOS_PUBLISH_SCRIPT, stagingPath, directory, filename],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let output = ''
    let errorOutput = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      output = (output + chunk).slice(-MAX_PUBLISH_OUTPUT)
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      errorOutput = (errorOutput + chunk).slice(-MAX_PUBLISH_OUTPUT)
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0 && output.trim()) resolve(output.trim())
      else reject(new Error(`automatic_download_publish_failed: ${errorOutput.trim()}`))
    })
  })
}

export function downloadSourceAllowed(
  urls: string[],
  topUrl: string,
  approvedLocalOrigin: string | null,
  apiOrigin: string | null
): boolean {
  if (!urls.length) return false
  try {
    const top = new URL(topUrl)
    if (
      !browserResourceAllowed({ url: top, topOrigin: top.origin, approvedLocalOrigin, apiOrigin })
    )
      return false
    if (
      approvedLocalOrigin !== null &&
      (approvedLocalOrigin !== apiOrigin || top.origin !== approvedLocalOrigin)
    )
      return false
    if (urls[0].startsWith('blob:')) {
      if (!urls.every((value) => value === urls[0])) return false
      const blob = new URL(urls[0])
      const source = new URL(urls[0].slice('blob:'.length))
      return (
        blob.protocol === 'blob:' &&
        blob.origin === top.origin &&
        source.origin === top.origin &&
        browserResourceAllowed({
          url: source,
          topOrigin: top.origin,
          approvedLocalOrigin,
          apiOrigin,
        })
      )
    }
    return urls.every((value) => {
      const url = new URL(value)
      return (
        (approvedLocalOrigin === null || url.origin === approvedLocalOrigin) &&
        browserResourceAllowed({ url, topOrigin: top.origin, approvedLocalOrigin, apiOrigin })
      )
    })
  } catch {
    return false
  }
}

export function safeDownloadName(input: string): string {
  const name = win32
    .basename(input.replaceAll('/', '\\'))
    .split('')
    .filter(
      (character) =>
        character.charCodeAt(0) >= FIRST_PRINTABLE_CODE_POINT &&
        character.charCodeAt(0) !== DELETE_CODE_POINT
    )
    .join('')
    .replace(INVALID_FILENAME_CHARACTERS, '_')
    .replace(/[. ]+$/, '')
    .trim()
  return !name || name === '.' || name === '..' || WINDOWS_DEVICE_NAME.test(name)
    ? FALLBACK_FILENAME
    : name
}

export interface DownloadStage {
  directory: string
  filename: string
  path: string
  publicationAttempted?: boolean
}

export function createDownloadStage(home: string, filename: string): DownloadStage {
  if (safeDownloadName(filename) !== filename || filename === STAGE_MANIFEST_FILENAME)
    throw new Error('invalid_staged_download_name')
  const directory = mkdtempSync(join(home, DOWNLOAD_STAGE_PREFIX))
  try {
    const manifest = join(directory, STAGE_MANIFEST_FILENAME)
    const descriptor = openSync(manifest, 'wx', PRIVATE_FILE_MODE)
    try {
      writeFileSync(descriptor, JSON.stringify({ filename }), 'utf8')
    } finally {
      closeSync(descriptor)
    }
    return { directory, filename, path: join(directory, filename) }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

export function discardDownloadStage(stage: DownloadStage, python: string): void {
  if (process.platform !== 'darwin' || !python)
    throw new Error('staged_download_cleanup_unavailable')
  const result = spawnSync(
    python,
    ['-I', '-B', '-c', MACOS_DISCARD_SCRIPT, stage.directory, stage.filename],
    { windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: MAX_PUBLISH_OUTPUT }
  )
  if (result.status !== 0 || result.error) throw new Error('staged_download_cleanup_failed')
}

export function findPendingDownloadStages(
  home: string,
  onSuspicious: (directory: string) => void = () => undefined
): DownloadStage[] {
  if (process.platform !== 'darwin') return []
  const pending: DownloadStage[] = []
  for (const entry of readdirSync(home, { withFileTypes: true })) {
    if (!entry.name.startsWith(DOWNLOAD_STAGE_PREFIX)) continue
    const directory = join(home, entry.name)
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      onSuspicious(directory)
      continue
    }
    try {
      if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
        onSuspicious(directory)
        continue
      }
      const files = readdirSync(directory)
      if (files.length === 0) {
        onSuspicious(directory)
        continue
      }
      const manifestPath = join(directory, STAGE_MANIFEST_FILENAME)
      if (!lstatSync(manifestPath).isFile() || lstatSync(manifestPath).isSymbolicLink()) {
        onSuspicious(directory)
        continue
      }
      const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (
        !manifest ||
        typeof manifest !== 'object' ||
        !('filename' in manifest) ||
        typeof manifest.filename !== 'string'
      ) {
        onSuspicious(directory)
        continue
      }
      const filename = manifest.filename
      if (safeDownloadName(filename) !== filename || filename === STAGE_MANIFEST_FILENAME) {
        onSuspicious(directory)
        continue
      }
      const stage: DownloadStage = {
        directory,
        filename,
        path: join(directory, filename),
        ...(manifest &&
        typeof manifest === 'object' &&
        'publicationAttempted' in manifest &&
        manifest.publicationAttempted === true
          ? { publicationAttempted: true }
          : {}),
      }
      if (
        files.length === 2 &&
        files.includes(STAGE_MANIFEST_FILENAME) &&
        files.includes(filename) &&
        lstatSync(stage.path).isFile() &&
        !lstatSync(stage.path).isSymbolicLink()
      )
        pending.push(stage)
      else onSuspicious(directory)
    } catch {
      onSuspicious(directory)
    }
  }
  return pending
}

export function createDownloadPreferences(
  home: string,
  defaultDirectory: string,
  automaticAvailable = false,
  probe: (directory: string) => boolean = () => automaticAvailable
) {
  const path = join(home, PREFERENCES_FILENAME)
  let directoryOverride: string | null = null
  let askEveryTime = true
  try {
    const stored = decodeDownloadPreferences(readFileSync(path, 'utf8'))
    directoryOverride = stored.directoryOverride
    askEveryTime = stored.askEveryTime
  } catch {
    directoryOverride = null
  }
  const persist = (candidate: string | null, ask: boolean) => {
    const temporary = `${path}${TEMPORARY_SUFFIX}-${randomUUID()}`
    const descriptor = openSync(temporary, 'wx', PRIVATE_FILE_MODE)
    try {
      try {
        writeFileSync(
          descriptor,
          JSON.stringify({ directoryOverride: candidate, askEveryTime: ask }),
          'utf8'
        )
      } finally {
        closeSync(descriptor)
      }
      renameSync(temporary, path)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
  const directoryAvailable = (directory: string): boolean => {
    try {
      return statSync(directory).isDirectory()
    } catch {
      return false
    }
  }
  return {
    snapshot(): BrowserDownloadSettings {
      const directory = directoryOverride ?? defaultDirectory
      const exists = directoryAvailable(directory)
      const available = automaticAvailable && exists && probe(directory)
      return {
        directory,
        isDefault: directoryOverride === null,
        directoryAvailable: exists,
        askEveryTime: askEveryTime || !available,
        automaticAvailable: available,
      }
    },
    canAutomaticallySave(): boolean {
      const directory = directoryOverride ?? defaultDirectory
      return automaticAvailable && directoryAvailable(directory) && probe(directory)
    },
    select(directory: string): BrowserDownloadSettings {
      if (!isAbsolute(directory)) throw new Error('invalid_download_directory')
      persist(directory, askEveryTime)
      directoryOverride = directory
      return this.snapshot()
    },
    reset(): BrowserDownloadSettings {
      persist(null, askEveryTime)
      directoryOverride = null
      return this.snapshot()
    },
    setAskEveryTime(enabled: boolean): BrowserDownloadSettings {
      if (!enabled && !this.canAutomaticallySave())
        throw new Error('automatic_download_unavailable')
      persist(directoryOverride, enabled)
      askEveryTime = enabled
      return this.snapshot()
    },
  }
}
