import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PRODUCT_NAME = 'ScholarSeed'
const INSTALL_TIMEOUT_MS = 600_000

export function selectMacApp(entries: string[]): string {
  const apps = entries.filter(entry => entry.endsWith('.app'))
  if (apps.length !== 1 || apps[0] !== `${PRODUCT_NAME}.app`) {
    throw new Error(`DMG must contain exactly one ${PRODUCT_NAME}.app`)
  }
  return apps[0]
}

export interface InstalledApplication {
  executable: string
  cleanup: () => void
}

export function installerSha256(installer: string): string {
  const hash = createHash('sha256')
  const descriptor = openSync(installer, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let length
    while ((length = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, length))
    }
  } finally {
    closeSync(descriptor)
  }
  return hash.digest('hex')
}

export function installFromArtifact(installer: string, root: string, expectedSha256: string): InstalledApplication {
  if (!existsSync(installer) || !statSync(installer).isFile()) throw new Error('installer does not exist')
  if (installerSha256(installer) !== expectedSha256) throw new Error('installer SHA-256 changed before installation')
  const installed = join(root, 'installed')
  mkdirSync(installed, { recursive: true })
  if (process.platform === 'darwin') {
    const mount = join(root, 'mount')
    mkdirSync(mount)
    let attached = false
    try {
      execFileSync('hdiutil', ['attach', installer, '-readonly', '-nobrowse', '-mountpoint', mount],
        { timeout: INSTALL_TIMEOUT_MS })
      attached = true
      const app = selectMacApp(readdirSync(mount))
      execFileSync('ditto', [join(mount, app), join(installed, app)], { timeout: INSTALL_TIMEOUT_MS })
      const executable = join(installed, app, 'Contents', 'MacOS', PRODUCT_NAME)
      if (!existsSync(executable)) throw new Error('installed macOS executable is missing')
      return { executable, cleanup: () => rmSync(installed, { recursive: true, force: true }) }
    } finally {
      if (attached) execFileSync('hdiutil', ['detach', mount, '-force'], { timeout: INSTALL_TIMEOUT_MS })
      rmSync(mount, { recursive: true, force: true })
    }
  }
  if (process.platform === 'win32') {
    execFileSync(installer, ['/S', `/D=${installed}`], { timeout: INSTALL_TIMEOUT_MS })
    const roots = [installed, ...readdirSync(installed, { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => join(installed, entry.name))]
    const executable = roots.map(candidate => join(candidate, `${PRODUCT_NAME}.exe`))
      .find(candidate => existsSync(candidate))
    if (!executable) throw new Error('installed Windows executable is missing')
    return { executable, cleanup: () => rmSync(installed, { recursive: true, force: true }) }
  }
  throw new Error(`unsupported native installer platform: ${process.platform}`)
}

export function createInstallRoot(): string {
  return mkdtempSync(join(tmpdir(), 'scholarseed-ci-install-'))
}
