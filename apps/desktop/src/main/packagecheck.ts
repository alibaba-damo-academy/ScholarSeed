import { randomUUID } from 'crypto'
import { renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { app, type BrowserWindow } from 'electron'
import { applicationResources, applicationExecutable } from './resources.ts'
import { workspaceReady } from './workspace-ready'

const CHECK_TIMEOUT_MS = 45_000
const CHECK_INTERVAL_MS = 250

export interface EngineEvidence {
  version: string
  node: string
  modules: string
  napi: string
  packaged: boolean
  appVersion: string
  appPath: string
  executable: string
  resources: string
  applicationResources: string
  launcher: string
  nativeModules: Array<{ path: string; loaded: true }>
}

function engineEvidence(): EngineEvidence {
  const report = process.report.getReport() as { sharedObjects?: unknown }
  if (!Array.isArray(report.sharedObjects) || !report.sharedObjects.every((item) => typeof item === 'string'))
    throw new Error('Electron diagnostic report has no valid shared object inventory')
  return {
    version: process.versions.electron,
    node: process.versions.node,
    modules: process.versions.modules,
    napi: process.versions.napi || '',
    packaged: app.isPackaged,
    appVersion: app.getVersion(),
    appPath: app.getAppPath(),
    executable: process.execPath,
    resources: process.resourcesPath,
    applicationResources: applicationResources(app),
    launcher: applicationExecutable(app),
    nativeModules: report.sharedObjects
      .filter((filename: string) => filename.toLowerCase().endsWith('.node'))
      .map((filename: string) => ({ path: filename, loaded: true as const }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  }
}

interface PackageCheckResult {
  schema: 1
  ok: boolean
  backend: boolean
  renderer: boolean
  workbench: boolean
  readyMs: number
  platform: NodeJS.Platform
  arch: string
  engine?: EngineEvidence
  error?: string
}

function writeResult(filename: string, result: PackageCheckResult): void {
  const temporary = join(dirname(filename), `.package-check-${randomUUID()}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
  renameSync(temporary, filename)
}

export async function runPackageCheck(
  win: BrowserWindow,
  apiBase: string,
  filename: string
): Promise<boolean> {
  win.showInactive()
  const started = Date.now()
  const deadline = Date.now() + CHECK_TIMEOUT_MS
  let backend = false
  let renderer = false
  let error = ''
  let workbench = false
  let previousReady = false
  while (Date.now() < deadline && !(backend && renderer && workbench)) {
    try {
      const health = await fetch(`${apiBase}/api/healthz`, {
        signal: AbortSignal.timeout(CHECK_INTERVAL_MS * 4),
      })
      const payload = (await health.json()) as { ok?: boolean; stack?: string }
      backend = health.ok && payload.ok === true && Boolean(payload.stack)
      renderer = Boolean(
        await win.webContents.executeJavaScript(
          'document.readyState === "complete" && Boolean(document.querySelector("[data-testid=workbench-shell]"))'
        )
      )
      const ready = backend && renderer && (await workspaceReady(win.webContents))
      workbench = ready && previousReady
      previousReady = ready
    } catch (caught) {
      workbench = false
      previousReady = false
      error = String(caught)
    }
    if (!(backend && renderer && workbench)) {
      await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS))
    }
  }
  const readyMs = Date.now() - started
  try {
    const image = await win.webContents.capturePage()
    writeFileSync(`${filename}.png`, image.toPNG())
  } catch (caught) {
    workbench = false
    error = `workspace capture failed: ${String(caught)}`
  }
  writeResult(filename, {
    schema: 1,
    ok: backend && renderer && workbench,
    backend,
    renderer,
    workbench,
    readyMs,
    platform: process.platform,
    arch: process.arch,
    ...(process.platform === 'win32' ? { engine: engineEvidence() } : {}),
    ...(backend && renderer && workbench ? {} : { error: error || 'package check timed out' }),
  })
  return backend && renderer && workbench
}
