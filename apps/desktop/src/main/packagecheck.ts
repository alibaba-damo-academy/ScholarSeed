import { randomUUID } from 'crypto'
import { renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { BrowserWindow } from 'electron'

const CHECK_TIMEOUT_MS = 45_000
const CHECK_INTERVAL_MS = 250

interface PackageCheckResult {
  schema: 1
  ok: boolean
  backend: boolean
  renderer: boolean
  platform: NodeJS.Platform
  arch: string
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
): Promise<void> {
  const deadline = Date.now() + CHECK_TIMEOUT_MS
  let backend = false
  let renderer = false
  let error = ''
  while (Date.now() < deadline && !(backend && renderer)) {
    try {
      const health = await fetch(`${apiBase}/api/healthz`)
      const payload = await health.json() as { ok?: boolean; stack?: string }
      backend = health.ok && payload.ok === true && Boolean(payload.stack)
      renderer = Boolean(await win.webContents.executeJavaScript(
        'document.readyState === "complete" && Boolean(document.querySelector("[data-testid=workbench-shell]"))'
      ))
    } catch (caught) {
      error = String(caught)
    }
    if (!(backend && renderer)) {
      await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL_MS))
    }
  }
  writeResult(filename, {
    schema: 1,
    ok: backend && renderer,
    backend,
    renderer,
    platform: process.platform,
    arch: process.arch,
    ...(backend && renderer ? {} : { error: error || 'package check timed out' })
  })
}
