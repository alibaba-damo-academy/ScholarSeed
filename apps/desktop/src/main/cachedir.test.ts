import assert from 'node:assert/strict'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { systemCacheDir } from './cachedir.ts'

const POSIX_HOME = '/home/tester'
const WINDOWS_HOME = 'C:\\Users\\tester'
const WINDOWS_LOCAL_APP_DATA = 'D:\\profile\\AppData\\Local'
const XDG_CACHE_HOME = '/mnt/state/cache'

test('win32 用 LOCALAPPDATA，缺失或为空时回退到 home 下的 AppData/Local', () => {
  assert.equal(
    systemCacheDir('win32', { LOCALAPPDATA: WINDOWS_LOCAL_APP_DATA }, WINDOWS_HOME),
    WINDOWS_LOCAL_APP_DATA
  )
  assert.equal(
    systemCacheDir('win32', {}, WINDOWS_HOME),
    join(WINDOWS_HOME, 'AppData', 'Local')
  )
  assert.equal(
    systemCacheDir('win32', { LOCALAPPDATA: '' }, WINDOWS_HOME),
    join(WINDOWS_HOME, 'AppData', 'Local')
  )
})

test('darwin 固定用 home/Library/Caches，不读任何环境变量', () => {
  const expected = join(POSIX_HOME, 'Library', 'Caches')
  assert.equal(systemCacheDir('darwin', {}, POSIX_HOME), expected)
  assert.equal(
    systemCacheDir(
      'darwin',
      { LOCALAPPDATA: WINDOWS_LOCAL_APP_DATA, XDG_CACHE_HOME: XDG_CACHE_HOME },
      POSIX_HOME
    ),
    expected
  )
})

test('linux 用 XDG_CACHE_HOME，缺失或为空时回退到 home/.cache', () => {
  assert.equal(systemCacheDir('linux', { XDG_CACHE_HOME: XDG_CACHE_HOME }, POSIX_HOME), XDG_CACHE_HOME)
  assert.equal(systemCacheDir('linux', {}, POSIX_HOME), join(POSIX_HOME, '.cache'))
  assert.equal(systemCacheDir('linux', { XDG_CACHE_HOME: '' }, POSIX_HOME), join(POSIX_HOME, '.cache'))
})

test('未列举的平台走 XDG 语义，与 linux 一致', () => {
  assert.equal(
    systemCacheDir('freebsd', {}, POSIX_HOME),
    systemCacheDir('linux', {}, POSIX_HOME)
  )
})

test('本机实际解析结果是绝对路径，且不落在 temp 里', () => {
  const directory = systemCacheDir()
  assert.equal(isAbsolute(directory), true)
  assert.notEqual(directory, tmpdir())
  assert.equal(directory.startsWith(tmpdir()), false)
})
