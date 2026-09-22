/** Real, read-only Skillhub UI acceptance in an isolated Chrome context.
 * No account creation, storage-state export, API mocks, tracing or publication.
 * Password is read without terminal echo and is never persisted.
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  url: { type: 'string' }, chrome: { type: 'string' }, output: { type: 'string' },
  username: { type: 'string', default: 'admin' }, namespace: { type: 'string' },
  skills: { type: 'string', multiple: true },
} })
for (const key of ['url', 'chrome', 'output', 'namespace', 'skills']) {
  if (!values[key]) throw new Error(`Required argument: --${key}`)
}
const origin = new URL(values.url)
const PAGE_READY_TIMEOUT_MS = 60_000
if (origin.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(origin.hostname)) {
  throw new Error('Credentials require HTTPS or an authenticated loopback tunnel')
}

async function password() {
  if (!process.stdin.isTTY) return readFileSync(0, 'utf8').trim()
  process.stdout.write('Skillhub UI password: ')
  process.stdin.setRawMode(true)
  process.stdin.resume()
  return await new Promise((resolvePassword, reject) => {
    let result = ''
    const receive = chunk => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\r' || character === '\n' || character === '\u0003') {
          process.stdin.off('data', receive)
          process.stdin.setRawMode(false)
          process.stdin.pause()
          process.stdout.write('\n')
          if (character === '\u0003') reject(new Error('Cancelled'))
          else resolvePassword(result)
          return
        }
        if (character === '\u007f') result = result.slice(0, -1)
        else result += character
      }
    }
    process.stdin.on('data', receive)
  })
}

const secret = await password()
const output = resolve(values.output)
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ executablePath: values.chrome, headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  const page = await context.newPage()
  page.setDefaultTimeout(PAGE_READY_TIMEOUT_MS)
  await page.goto(new URL('/login', origin).href)
  await page.locator('#username').fill(values.username)
  await page.locator('#password').fill(secret)
  await page.locator('form button[type="submit"]').click()
  await page.waitForURL(url => !url.pathname.startsWith('/login'))
  await page.goto(new URL(`/space/${values.namespace}`, origin).href)
  for (const name of values.skills) {
    await page.getByRole('heading', { name, exact: true }).waitFor({ state: 'visible' })
  }
  // Cards enter with staggered opacity animation. "Visible" alone includes
  // opacity:0; wait on the actual rendered state instead of sleeping.
  await page.waitForFunction(names => {
    const headings = [...document.querySelectorAll('h3')].filter(node => names.includes(node.textContent.trim()))
    return headings.length === names.length && headings.every(heading => {
      for (let node = heading; node; node = node.parentElement) {
        if (Number(getComputedStyle(node).opacity) < 0.99) return false
      }
      return true
    })
  }, values.skills)
  const namespaceShot = resolve(output, 'namespace.png')
  await page.screenshot({ path: namespaceShot, fullPage: true })
  console.log(JSON.stringify({ page: 'namespace', screenshot: namespaceShot }))
  for (const name of values.skills) {
    const versionPrefix = `/api/web/skills/${encodeURIComponent(values.namespace)}/${encodeURIComponent(name)}/versions/`
    // The page loads detail -> file list -> README/SKILL sequentially. A visible
    // heading is not evidence that documentation or the audit has loaded.
    const completed = await Promise.all([
      page.waitForResponse(response => {
        const url = new URL(response.url())
        return url.pathname.startsWith(versionPrefix) && url.pathname.endsWith('/files')
      }),
      page.waitForResponse(response => {
        const url = new URL(response.url())
        return url.pathname.startsWith(versionPrefix) && url.pathname.endsWith('/file')
      }),
      page.waitForResponse(response => /\/api\/v1\/skills\/\d+\/versions\/\d+\/security-audit$/.test(new URL(response.url()).pathname)),
      page.goto(new URL(`/space/${values.namespace}/${name}`, origin).href),
    ])
    for (const response of completed.slice(0, -1)) {
      if (!response.ok()) throw new Error(`${name}: UI request failed (${response.status()}) at ${new URL(response.url()).pathname}`)
      await response.finished()
    }
    // A README can repeat the skill name as its own heading; the page title is
    // the first heading in document order, outside the documentation panel.
    await page.getByRole('heading', { name, exact: true }).first().waitFor({ state: 'visible' })
    await page.getByRole('tabpanel').locator('.max-w-none').waitFor({ state: 'visible' })
    const audit = page.getByText(/安全审核|Security Audit|Security audit/).first()
    await audit.waitFor({ state: 'visible' })
    await page.evaluate(() => window.scrollTo(0, 0))
    const detailShot = resolve(output, `${name}-detail.png`)
    await page.screenshot({ path: detailShot, fullPage: true })
    console.log(JSON.stringify({ page: name, documentation: 'rendered', requests: completed.slice(0, -1).map(response => response.status()), screenshot: detailShot }))
    const details = page.getByRole('button', { name: /查看详情|View Details|View details/ }).first()
    await details.click()
    await page.getByRole('dialog').waitFor({ state: 'visible' })
    const auditShot = resolve(output, `${name}-audit.png`)
    await page.screenshot({ path: auditShot })
    console.log(JSON.stringify({ page: `${name}/audit`, screenshot: auditShot }))
  }
} finally {
  await browser.close()
}
