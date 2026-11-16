import assert from 'node:assert/strict'
import test, { after, before, type TestContext } from 'node:test'
import { expect, type Page, type Route } from '@playwright/test'
import { renderFixture } from '../../test-helpers/render.ts'
import { SKILLS_PATH, SKILL_SURFACE_CONVERSATION, SKILL_SURFACE_SETTINGS } from '../../skills.ts'

const ROOT = import.meta.dirname
const SKILL = {
  name: 'eln',
  path: '/skills/eln/SKILL.md',
  version: '1.0.0',
  enabled: true,
  active: true,
  display_names: { zh: '整理实验记录', en: 'Lab Notes Organizer' },
}
let fixture: Awaited<ReturnType<typeof renderFixture>>

before(async () => {
  fixture = await renderFixture(ROOT)
})
after(async () => fixture?.close())

async function composer(context: TestContext) {
  const page = await fixture.page(context)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  context.after(() => assert.deepEqual(errors, []))
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => route.fulfill({ status: 404, json: { error: 'fixture_unavailable' } })
  )
  return page
}

async function open(page: Page) {
  await page.goto(new URL('/launch.render.fixture.html', fixture.url).href)
  await page.evaluate(() =>
    Reflect.get(window, 'launchProbe').patch({
      model: 'model-a',
      backendReady: false,
      workbenchReady: true,
      catalog: {
        models: [{ key: 'model-a', label: 'model-a', model_name: 'model-a', source: 'builtin' }],
        hiddenModels: [],
        subscriptionGroups: [],
        personalProfiles: [],
      },
    })
  )
  await expect(page.getByTestId('composer-input')).toBeVisible()
}

function respond(route: Route, skill = SKILL) {
  if (route.request().method() !== 'GET') return route.fallback()
  return route.fulfill({ json: { skills: [skill] } })
}

test('composer skill picker rejects stale language responses and selects one canonical reference', async (context) => {
  const page = await composer(context)
  const requests: { surface: string | null; locale: string | null }[] = []
  let stale: Route | undefined
  await page.route(
    (url) => url.pathname === SKILLS_PATH,
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const url = new URL(route.request().url())
      const request = {
        surface: url.searchParams.get('surface'),
        locale: url.searchParams.get('locale'),
      }
      requests.push(request)
      if (request.surface === SKILL_SURFACE_CONVERSATION && request.locale === 'zh' && !stale) {
        stale = route
        return
      }
      await respond(route)
    }
  )
  await open(page)
  const input = page.getByTestId('composer-input')
  await input.fill('/')
  await expect.poll(() => Boolean(stale)).toBe(true)
  await page.evaluate(() => Reflect.get(window, 'launchProbe').language('en'))
  const option = page.getByTestId('composer-skill-eln')
  await expect(option).toHaveText(SKILL.display_names.en)
  const finished = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === SKILLS_PATH && url.searchParams.get('locale') === 'zh'
  })
  await respond(stale!, {
    ...SKILL,
    display_names: { zh: '过时的技能名称', en: 'Stale skill name' },
  })
  await (await finished).finished()
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
  await expect(option).toHaveText(SKILL.display_names.en)
  await option.click()
  await expect(input).toHaveValue('')
  await input.fill('/')
  await option.click()
  assert.deepEqual(
    await page.evaluate(() => Reflect.get(window, 'launchProbe').state.composerRefs),
    [
      {
        type: 'skill',
        id: SKILL.name,
        title: SKILL.display_names.en,
        path: SKILL.path,
        version: SKILL.version,
      },
    ]
  )
  assert.ok(
    requests.some(
      (request) => request.surface === SKILL_SURFACE_CONVERSATION && request.locale === 'zh'
    )
  )
  assert.ok(
    requests.some(
      (request) => request.surface === SKILL_SURFACE_CONVERSATION && request.locale === 'en'
    )
  )
  await page.evaluate(() => Reflect.get(window, 'launchProbe').patch({ backendReady: true }))
  await expect
    .poll(() =>
      requests.some(
        (request) => request.surface === SKILL_SURFACE_SETTINGS && request.locale === 'en'
      )
    )
    .toBe(true)
  await page.evaluate(() => Reflect.get(window, 'launchProbe').language('zh'))
  await expect
    .poll(() =>
      requests.some(
        (request) => request.surface === SKILL_SURFACE_SETTINGS && request.locale === 'zh'
      )
    )
    .toBe(true)
  assert.deepEqual(
    await page.evaluate(() =>
      Reflect.get(window, 'launchProbe').state.composerRefs.map(
        ({ id, path, version }: { id: string; path: string; version: string }) => ({
          id,
          path,
          version,
        })
      )
    ),
    [{ id: SKILL.name, path: SKILL.path, version: SKILL.version }]
  )
})

test('composer skill menu separates upload from contextual library navigation and retains the draft', async (context) => {
  const page = await composer(context)
  await page.route(
    (url) => url.pathname === SKILLS_PATH,
    (route) => respond(route)
  )
  await open(page)
  await page.evaluate(() =>
    Reflect.get(window, 'launchProbe').patch({
      homeSelectedProjectId: 'origin-project',
      projects: [{ id: 'origin-project', path: '/project', name: 'Origin project' }],
    })
  )
  const input = page.getByTestId('composer-input')
  await input.fill('Keep this unsent draft')
  const menu = async () => {
    await page.getByTestId('composer-plus').click()
    await page.getByTestId('composer-skills-menu').hover()
    await expect(page.getByTestId('composer-skill-eln')).toBeVisible()
  }
  await menu()
  await page.getByTestId('composer-skill-upload').click()
  assert.equal(
    await page.evaluate(() => Reflect.get(window, 'launchProbe').state.skillUploadOpen),
    true
  )
  assert.notEqual(
    await page.evaluate(() => Reflect.get(window, 'launchProbe').state.mainView),
    'skills'
  )
  await expect(input).toHaveValue('Keep this unsent draft')
  await page.evaluate(() => Reflect.get(window, 'launchProbe').patch({ skillUploadOpen: false }))
  await menu()
  await page.getByTestId('composer-skill-market').click()
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'launchProbe').state.mainView))
    .toBe('skills')
  assert.equal(
    await page.evaluate(() => Reflect.get(window, 'launchProbe').state.workbenchReturnProjectId),
    'origin-project'
  )
  assert.equal(
    await page.evaluate(() => Reflect.get(window, 'launchProbe').state.homeSelectedProjectId),
    'origin-project'
  )
  assert.equal(
    await page.evaluate(() => Reflect.get(window, 'launchProbe').state.skillUploadOpen),
    false
  )
  await expect(input).toHaveValue('Keep this unsent draft')
})
