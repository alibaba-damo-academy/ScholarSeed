import type { APIResponse, Page } from '@playwright/test'
import { apiBase } from './electron'

const OPERATION_TIMEOUT_MS = 90_000
const REQUEST_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 100
const ACCEPTED = 202
const MAINTENANCE = 503

export interface ReadyProject {
  id: string
  name: string
  root: string
}

/** Submit once through the product API and wait for its actual committed result. */
export async function createReadyProject(page: Page, name: string): Promise<ReadyProject> {
  const base = await apiBase(page)
  const submitted = await page.request.post(`${base}/api/content/projects`, {
    data: { name },
    timeout: REQUEST_TIMEOUT_MS,
  })
  const project = await waitContentOperation(page, submitted)
  if (!['id', 'name', 'root'].every((key) => typeof project[key] === 'string')) {
    throw new Error('project creation returned an invalid project')
  }
  return project as unknown as ReadyProject
}

/** Wait for the submitted mutation without ever submitting it again. */
export async function waitContentOperation(
  page: Page, submitted: APIResponse
): Promise<Record<string, unknown>> {
  const base = await apiBase(page)
  let identity: string
  try {
    if (submitted.status() !== ACCEPTED) {
      throw new Error(`content submission ${submitted.status()}: ${await submitted.text()}`)
    }
    identity = (await submitted.json()).operation
    if (typeof identity !== 'string' || !/^[a-f0-9]{32}$/.test(identity)) {
      throw new Error('content submission returned an invalid operation identity')
    }
  } finally {
    await submitted.dispose()
  }
  const deadline = Date.now() + OPERATION_TIMEOUT_MS
  while (Date.now() < deadline) {
    const response = await page.request.get(`${base}/api/content/operations/${identity}`, {
      timeout: REQUEST_TIMEOUT_MS,
    })
    try {
      if (response.status() !== MAINTENANCE) {
        if (!response.ok()) {
          throw new Error(`content result ${response.status()}: ${await response.text()}`)
        }
        const operation = await response.json()
        if (operation.operation !== identity) throw new Error('content result identity changed')
        if (operation.state === 'failed')
          throw new Error(`content operation failed: ${operation.error}`)
        if (operation.state === 'succeeded') {
          if (!operation.result || typeof operation.result !== 'object') {
            throw new Error('content operation returned an invalid result')
          }
          return operation.result as Record<string, unknown>
        }
        if (operation.state !== 'queued' && operation.state !== 'running') {
          throw new Error(`unexpected content operation state: ${operation.state}`)
        }
      }
    } finally {
      await response.dispose()
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error(`content operation outcome unknown: ${identity}; mutation was not resubmitted`)
}
