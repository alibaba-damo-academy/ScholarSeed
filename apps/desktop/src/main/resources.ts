// Application files follow app.asar; the Electron executable and its resources
// stay in the independently versioned engine component on packaged Windows.
import { basename, dirname, isAbsolute, join } from 'node:path'

const WINDOWS_PLATFORM = 'win32'
const APPLICATION_ARCHIVE = 'app.asar'
const APPLICATION_RESOURCES = 'resources'
const CURRENT_DIRECTORY = 'current'
const APPLICATION_EXECUTABLE = 'ScholarSeed.exe'
const APPLICATION_ICON = 'windows-tray.ico'
const APPLICATION_RENDERER = 'renderer'
const APPLICATION_OUTPUT = 'out'

interface ApplicationIdentity {
  readonly isPackaged: boolean
  getAppPath(): string
}
interface ApplicationHost {
  readonly platform: string
  readonly resourcesPath: string
  readonly execPath: string
}

export function applicationResources(
  application: ApplicationIdentity,
  host: ApplicationHost = process
): string {
  if (host.platform !== WINDOWS_PLATFORM || !application.isPackaged) return host.resourcesPath
  const archive = application.getAppPath()
  const resources = dirname(archive)
  const current = dirname(resources)
  if (
    !isAbsolute(archive) ||
    basename(archive) !== APPLICATION_ARCHIVE ||
    basename(resources) !== APPLICATION_RESOURCES ||
    basename(current) !== CURRENT_DIRECTORY
  ) {
    throw new Error('Packaged Windows application must load current/resources/app.asar')
  }
  return resources
}

export function applicationExecutable(
  application: ApplicationIdentity,
  host: ApplicationHost = process
): string {
  return host.platform === WINDOWS_PLATFORM && application.isPackaged
    ? join(dirname(applicationResources(application, host)), APPLICATION_EXECUTABLE)
    : host.execPath
}

export function applicationRenderer(
  application: ApplicationIdentity,
  host: ApplicationHost = process
): string {
  return application.isPackaged
    ? join(applicationResources(application, host), APPLICATION_RENDERER)
    : join(application.getAppPath(), APPLICATION_OUTPUT, APPLICATION_RENDERER)
}

export function applicationInstallation(
  application: ApplicationIdentity,
  host: ApplicationHost = process
): { root: string; executables: string[] } {
  const launcher = applicationExecutable(application, host)
  return {
    root: dirname(dirname(launcher)),
    executables: [...new Set([basename(launcher), basename(host.execPath)])],
  }
}

export function applicationIcon(
  application: ApplicationIdentity,
  host: ApplicationHost = process
): string | undefined {
  return host.platform === WINDOWS_PLATFORM && application.isPackaged
    ? join(applicationResources(application, host), APPLICATION_ICON)
    : undefined
}
