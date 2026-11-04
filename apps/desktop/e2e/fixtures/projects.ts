import { expect, type APIResponse, type Page, type Response, type Locator } from '@playwright/test'
import { apiBase } from './electron'

const OPERATION_TIMEOUT_MS = 90_000
const REQUEST_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 100
const ACCEPTED = 202
const MAINTENANCE = 503
const createdProjects = new WeakMap<Page, Map<string, ReadyProject>>()

export interface ReadyProject {
  id: string
  name: string
  root: string
}

/** Resolve seeded input names through the actual creation result, without copying name policy. */
export function projectOption(page: Page, name: string): Locator {
  const project = createdProjects.get(page)?.get(name)
  return page.getByTestId(`project-menu-option-${project?.name ?? name}`)
}

/** Formal document tabs are separate from the explorer's retained embedded preview. */
export function documentSurface(page: Page): Locator {
  return page.getByTestId('document-dock').locator('.vds-document-view-slot:visible > .vds-document-view')
}

/** Enter the actual owner scope, rather than filtering the global catalogue. */
export async function openLiteratureScope(page: Page, name?: string): Promise<void> {
  if (name === undefined) {
    await page.getByTestId('activity-literature').click()
    await page.getByTestId('literature-panel').locator('[data-sidebar-view="all"]').click()
  } else {
    await openProjectMenu(page)
    await projectOption(page, name).click()
    await page.getByTestId('project-library').click()
    await page.getByTestId('project-library-content').getByRole('tab', { name: '文献', exact: true }).click()
  }
  await expect(page.getByTestId('literature-drop-target')).toBeVisible()
}

/** Project selection is owned by the project center in the current shell. */
export async function openProjectMenu(page: Page): Promise<void> {
  await page.getByTestId('activity-home').click()
  await page.locator('[data-testid="project-navigation-selector"]:visible, [data-testid="topbar-project"]:visible, [data-testid="home-project-selector"]:visible').click()
  await expect(page.getByTestId('project-menu')).toBeVisible()
}

export async function openProjectExplorer(page: Page): Promise<void> {
  const existing = page.getByRole('tab', { name: /^(项目资源管理器|Project Explorer)$/ }).first()
  if (await existing.isVisible()) await existing.click()
  else {
    await page.getByTestId('project-library').click()
    await page.getByTestId('project-library-explorer').click()
  }
  await expect(page.getByTestId('explorer-tree')).toBeVisible()
  const resources = page.getByTestId('explorer-node-resources')
  await expect(resources).toBeVisible()
  const expand = resources.locator('button[aria-expanded]').first()
  if (await expand.getAttribute('aria-expanded') === 'false') await expand.click()
}

export async function openProjectFile(page: Page, path: string): Promise<void> {
  const segments = path.split('/')
  const existing = page.getByRole('tab', { name: segments.at(-1)!, exact: true })
  if (await existing.count() === 1) {
    await existing.click()
    await expect(existing).toHaveAttribute('aria-selected', 'true')
    return
  }
  await openProjectExplorer(page)
  for (let depth = 1; depth < segments.length; depth += 1) {
    const directory = page.getByTestId(`explorer-node-${segments.slice(0, depth).join('/')}`)
    const expand = directory.locator('button[aria-expanded]').first()
    if (await expand.getAttribute('aria-expanded') === 'false') await expand.click()
  }
  await page.getByTestId(`explorer-select-${path}`).click()
  await expect(page.getByTestId('project-explorer').locator('nav[title]')).toHaveAttribute('title', path)
  await page.getByTestId('explorer-open-menu').click()
  await page.getByTestId('explorer-open-tab').click()
  await expect(page.getByRole('tab', { name: segments.at(-1)!, exact: true })).toHaveAttribute('aria-selected', 'true')
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
  const ready = project as unknown as ReadyProject
  const projects = createdProjects.get(page) ?? new Map<string, ReadyProject>()
  projects.set(name, ready)
  projects.set(ready.name, ready)
  createdProjects.set(page, projects)
  return ready
}

/** Wait for the submitted mutation without ever submitting it again. */
export async function waitContentOperation(
  page: Page, submitted: APIResponse | Response
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
    if ('dispose' in submitted) await submitted.dispose()
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
