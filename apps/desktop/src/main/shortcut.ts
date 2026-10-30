import { lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { win32 } from 'node:path'
import { SCHOLARSEED_PRODUCT_NAME } from './product.ts'
import { WINDOWS_NOTIFICATION_ID } from './identity.ts'

const LEGACY_SHORTCUT = 'Electron.lnk'
const ENGINE_NAME = 'ScholarSeedEngine.exe'
const ENGINE_DIRECTORY = ['runtime', 'electron'] as const
interface ShortcutDetails {
  target: string
  args?: string
  appUserModelId?: string
}
interface ShortcutShell {
  readShortcutLink(path: string): ShortcutDetails
}
export interface ShortcutFiles {
  physical(path: string): string
  read(path: string): Buffer
  regular(path: string): boolean
  remove(path: string): void
}
const files: ShortcutFiles = {
  physical: realpathSync,
  read: readFileSync,
  regular: (path) => {
    const stat = lstatSync(path)
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
  },
  remove: unlinkSync,
}
const same = (left: string, right: string) =>
  win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()

export function isLegacyNotificationShortcut(
  legacy: ShortcutDetails,
  installed: ShortcutDetails,
  launcher: string
): boolean {
  if (
    !win32.isAbsolute(launcher) ||
    !win32.isAbsolute(legacy.target) ||
    !win32.isAbsolute(installed.target)
  )
    return false
  if (
    legacy.appUserModelId !== WINDOWS_NOTIFICATION_ID ||
    installed.appUserModelId !== WINDOWS_NOTIFICATION_ID ||
    (legacy.args || '').trim() ||
    (installed.args || '').trim() ||
    !same(installed.target, launcher)
  )
    return false
  const root = win32.dirname(win32.dirname(launcher))
  const relative = win32.relative(win32.join(root, ...ENGINE_DIRECTORY), legacy.target)
  if (win32.isAbsolute(relative)) return false
  const parts = relative.split(win32.sep)
  return (
    parts.length === 2 &&
    !['.', '..', ''].includes(parts[0]) &&
    !parts[0].includes(':') &&
    same(parts[1], ENGINE_NAME)
  )
}

function physicalTargetOrAncestor(target: string, io: ShortcutFiles): boolean {
  let candidate = target
  for (;;) {
    try {
      return same(io.physical(candidate), candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = win32.dirname(candidate)
      if (parent === candidate) return false
      candidate = parent
    }
  }
}

export function cleanupNotificationShortcut(
  programs: string,
  launcher: string,
  shell: ShortcutShell,
  io: ShortcutFiles = files
): 'removed' | 'absent' | 'preserved' {
  const legacyPath = win32.join(programs, LEGACY_SHORTCUT)
  const installedPath = win32.join(programs, `${SCHOLARSEED_PRODUCT_NAME}.lnk`)
  try {
    // Fail closed on redirected directories/targets and non-ordinary shortcut files.
    if (
      !same(io.physical(programs), programs) ||
      !same(io.physical(launcher), launcher) ||
      !io.regular(legacyPath) ||
      !io.regular(installedPath) ||
      !same(io.physical(legacyPath), legacyPath) ||
      !same(io.physical(installedPath), installedPath)
    )
      return 'preserved'
    const original = io.read(legacyPath)
    const installedBytes = io.read(installedPath)
    const legacy = shell.readShortcutLink(legacyPath)
    const installed = shell.readShortcutLink(installedPath)
    if (
      !isLegacyNotificationShortcut(legacy, installed, launcher) ||
      !physicalTargetOrAncestor(legacy.target, io)
    )
      return 'preserved'
    // Recheck both inputs immediately before removing only the exact legacy leaf.
    if (
      !original.equals(io.read(legacyPath)) ||
      !installedBytes.equals(io.read(installedPath)) ||
      !io.regular(legacyPath)
    )
      return 'preserved'
    io.remove(legacyPath)
    return 'removed'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        io.read(legacyPath)
        return 'preserved'
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
        throw missing
      }
    }
    throw error
  }
}
