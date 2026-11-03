import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { expect } from '@playwright/test'
import { createServer, transformWithEsbuild } from 'vite'
import { renderFixture } from '../src/test-helpers/render.ts'
import zh from './locales/zh.json' with { type: 'json' }
import en from './locales/en.json' with { type: 'json' }
import { supportedFontSources } from '../renderer.ts'
import { styles } from '../scripts/shared/styles.cjs'
import { PREVIEW_HOME } from './home.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const ENTRY = '/__pdfe-header.tsx'
const VIRTUAL = '\0pdfe-header.tsx'
const OUTPUT = join(ROOT, 'test-results', 'pdfe-header-unit')

test('headless workbench chrome regression: public controls, assets navigation, icons and dock divider interaction', { timeout: 120_000 }, async context => {
  const source = (file: string) => '/@fs/' + join(ROOT, file).split('\\').join('/')
  const fixture = await renderFixture(join(ROOT, 'src/renderer'), {
    create: config => createServer({ ...config, css: { postcss: styles('pdfe') }, server: { ...config.server, fs: { allow: [ROOT] } }, plugins: [...config.plugins ?? [], supportedFontSources(), {
      name: 'pdfe-header-unit',
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (!request.url?.startsWith('/__pdfe-header.html')) return next()
          response.setHeader('content-type', 'text/html')
          response.end(await server.transformIndexHtml(request.url, '<html><body><div id="root"></div><script type="module" src="' + ENTRY + '"></script></body></html>'))
        })
      },
      resolveId(source) { if (source === ENTRY) return VIRTUAL },
      async load(id) {
        if (id !== VIRTUAL) return
        const code = `
          import React, { useState } from 'react'
          import { createRoot } from 'react-dom/client'
          import { PdfeHeader } from ${JSON.stringify(source('preview/Header.tsx'))}
          import { PdfeControls } from ${JSON.stringify(source('preview/Controls.tsx'))}
          import { PdfeDivider } from ${JSON.stringify(source('preview/Divider.tsx'))}
          import { PdfeNavigation } from ${JSON.stringify(source('preview/Navigation.tsx'))}
          import { PREVIEW_CATALOG } from ${JSON.stringify(source('preview/catalog.ts'))}
          import { Dialog, DialogContent, DialogHeader, DialogTitle } from ${JSON.stringify(source('src/renderer/src/components/ui/index.ts'))}
          import zh from ${JSON.stringify(source('preview/locales/zh.json'))}
          import en from ${JSON.stringify(source('preview/locales/en.json'))}
          import ${JSON.stringify(source('src/renderer/src/styles.css'))}
          import { createLocalization } from ${JSON.stringify(source('src/localization/engine.ts'))}
          const parameters = new URLSearchParams(location.search)
          document.documentElement.dataset.theme = parameters.get('theme')
          const dictionary = parameters.get('language') === 'en' ? en : zh
          const translate = createLocalization(parameters.get('language') === 'en' ? 'en' : 'zh', { zh: { preview: zh }, en: { preview: en } }).getFixedT(null, 'preview')
          function Fixture() {
            const [materials, setMaterials] = useState(false)
            const [dock, setDock] = useState('detached')
            const [help, setHelp] = useState(false)
            const [width, setWidth] = useState(null)
            const [theme, setTheme] = useState(parameters.get('theme'))
            const [language, setLanguage] = useState(parameters.get('language'))
            const [login, setLogin] = useState('ready')
            const [reloads, setReloads] = useState(0)
            const [selected, setSelected] = useState(PREVIEW_CATALOG.find(page => page.id === 'page-home'))
            const [scene, setScene] = useState(parameters.get('scene') ?? 'home-states')
            return <Dialog open modal={false}><DialogContent hideCloseButton className="!inset-0 !h-full !w-full !max-w-none !transform-none !rounded-none !overflow-auto !grid-rows-[auto_auto_minmax(0,1fr)]">
              {dock === 'docked' && <PdfeDivider label={dictionary.resizeWorkbench} onResize={async width => setWidth(width)} onError={() => { throw new Error('unexpected resize failure') }} />}
              <PdfeHeader materials={materials} dock={dock} pending={false} translate={translate} onSection={section => setMaterials(section === 'materials')} onHelp={() => setHelp(true)} onDock={() => setDock(dock === 'docked' ? 'detached' : 'docked')} onReset={() => {}} onReload={() => setReloads(value => value + 1)} onClose={() => {}} />
              <div><PdfeControls theme={theme} language={language} login={login} accountControl={!parameters.has('noLogin')} pending={parameters.has('pending')} translate={translate} onTheme={setTheme} onLanguage={setLanguage} onLogin={setLogin} /><span className="sr-only"><output data-testid="public-control-values">{login + '|' + theme + '|' + language}</output><output data-testid="reload-count">{reloads}</output><output data-testid="resized-width">{width}</output></span></div>
              <div className="min-h-0 overflow-auto"><PdfeNavigation pages={PREVIEW_CATALOG.filter(page => page.launch?.kind !== 'components')} selected={selected} activePage={selected.id} scene={scene} searching={false} pending={false} translate={translate} stateLabel={state => dictionary['state_' + state] ?? state} onSelect={setSelected} onLaunch={(page, scene) => { setSelected(page); setScene(scene) }} /></div>
              <Dialog open={help} onOpenChange={setHelp}><DialogContent><DialogHeader><DialogTitle>{dictionary.guide}</DialogTitle></DialogHeader></DialogContent></Dialog>
            </DialogContent></Dialog>
          }
          createRoot(document.getElementById('root')).render(<Fixture />)
        `
        return transformWithEsbuild(code, ENTRY, { loader: 'tsx', jsx: 'automatic' })
      },
    }] }),
  })
  context.after(() => fixture.close())
  mkdirSync(OUTPUT, { recursive: true })
  const page = await fixture.page(context)
  const errors: string[] = []
  page.on('pageerror', error => { errors.push(error.message); context.diagnostic(error.stack ?? error.message) })
  page.on('console', message => { if (message.type() === 'error') context.diagnostic(message.text()) })
  for (const [language, dictionary] of [['zh', zh], ['en', en]] as const) for (const theme of ['light', 'dark']) for (const width of [320, 420]) {
    await page.setViewportSize({ width, height: 660 })
    await page.goto(fixture.url + '__pdfe-header.html?language=' + language + '&theme=' + theme)
    const actions = page.getByRole('group', { name: dictionary.workbenchActions })
    await expect(actions).toBeVisible()
    assert.ok(await page.evaluate(async () => (await document.fonts.load('16px iconfont')).length) > 0)
    await expect(page.getByTestId('preview-group-center')).toContainText(dictionary.pageProjectCenter)
    await expect(page.getByTestId('preview-group-viewer')).toHaveCount(0)
    await expect(page.getByTestId('preview-group-page')).toHaveCount(0)
    await expect(page.getByTestId('preview-page-page-home')).toHaveCount(0)
    for (const id of ['page-projects', 'viewer-projects', 'surface-project-form']) await expect(page.getByTestId('preview-page-' + id)).toHaveCount(0)
    const projectForm = page.getByTestId('preview-scene-surface-project-form-surface-project-form-states')
    await expect(projectForm).toBeVisible()
    assert.ok(await projectForm.evaluate(element => Boolean(element.closest('[data-testid="preview-capabilities-page-home"]'))))
    await projectForm.click()
    await expect(projectForm).toHaveAttribute('aria-current', 'page')
    const projectSection = page.getByTestId('preview-section-page-home-areaDaily')
    await expect(projectSection).toHaveAttribute('aria-expanded', 'true')
    const emptyScene = page.getByTestId('preview-scene-page-home-home-empty')
    await emptyScene.click()
    await expect(emptyScene).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('heading', { name: dictionary.areaDaily, exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: dictionary.areaBoundaries, exact: true })).toBeVisible()
    await expect(page.getByText(dictionary.mockDeclared, { exact: true })).toHaveCount(0)
    const recoverySection = page.getByTestId('preview-section-page-home-areaRecovery')
    await expect(recoverySection).toHaveAttribute('aria-expanded', 'false')
    await recoverySection.click()
    for (const scene of ['home-task-loading', 'home-task-retry', 'home-project-read-loading', 'home-project-read-failed']) {
      await expect(page.getByTestId('preview-scene-page-home-' + scene)).toBeVisible()
    }
    await expect(emptyScene).toBeVisible()
    await expect(emptyScene).toHaveAttribute('aria-current', 'page')
    await recoverySection.click()
    await expect(recoverySection).toHaveAttribute('aria-expanded', 'false')
    for (const alias of ['home-browse', 'home-create', 'home-open-project', 'home-project-actions']) await expect(page.getByTestId('preview-scene-page-home-' + alias)).toHaveCount(0)
    const operationSection = page.getByTestId('preview-section-page-home-areaBoundaries')
    await operationSection.click()
    await expect(projectSection).toHaveAttribute('aria-expanded', 'true')
    await expect(emptyScene).toBeVisible()
    await expect(emptyScene).toHaveAttribute('aria-current', 'page')
    const projectFamily = page.getByTestId('preview-family-page-home-homeProjectBoundaryGroup')
    const taskFamily = page.getByTestId('preview-family-page-home-homeTaskBoundaryGroup')
    await projectFamily.click()
    await taskFamily.click()
    await expect(projectFamily).toHaveAttribute('aria-expanded', 'true')
    await expect(taskFamily).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('preview-scene-page-home-home-projects-' + (PREVIEW_HOME.projectPage + 1))).toBeVisible()
    await operationSection.press('Space')
    await expect(operationSection).toHaveAttribute('aria-expanded', 'false')
    await operationSection.press('Enter')
    const centerGroup = page.getByTestId('preview-group-center')
    const conversationGroup = page.getByTestId('preview-group-conversation')
    await conversationGroup.click()
    await expect(centerGroup).toHaveAttribute('aria-expanded', 'true')
    await expect(conversationGroup).toHaveAttribute('aria-expanded', 'true')
    await conversationGroup.click()
    await centerGroup.press('Enter')
    await expect(centerGroup).toHaveAttribute('aria-expanded', 'false')
    await centerGroup.press('Enter')
    await expect(projectSection).toHaveAttribute('aria-expanded', 'true')
    await expect(operationSection).toHaveAttribute('aria-expanded', 'true')
    const sectionBounds = await projectSection.boundingBox()
    const sceneBounds = await emptyScene.boundingBox()
    assert.ok(sectionBounds && sceneBounds && sceneBounds.x > sectionBounds.x, 'scenario rows indent deeper than their feature area')
    await projectSection.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(OUTPUT, 'navigation-' + language + '-' + theme + '-' + width + '.png') })
    await expect(page.getByTestId('preview-family-page-home-homeRegularGroup')).toHaveCount(0)
    await expect(page.getByTestId('preview-scene-page-home-home-states')).toBeVisible()
    await expect(page.getByTestId('preview-scene-page-home-home-open-task')).toBeVisible()
    for (const scene of ['home-states', 'home-open-task', 'home-empty', 'home-no-tasks']) {
      const action = page.getByTestId('preview-scene-page-home-' + scene)
      await action.click()
      await expect(action).toHaveAttribute('aria-current', 'page')
    }
    const bounds = await actions.boundingBox()
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width)
    await expect(actions.locator('svg')).toHaveCount(5)
    for (const label of [dictionary.guide, dictionary.dockWorkbench, dictionary.reset, dictionary.reload, dictionary.close]) {
      const action = actions.getByRole('button', { name: label, exact: true })
      await expect(action).toHaveAttribute('title', label)
      assert.equal((await action.innerText()).trim(), '')
    }
    await actions.getByRole('button', { name: dictionary.reload, exact: true }).click()
    await expect(page.getByTestId('reload-count')).toHaveText('1')
    const controls = page.getByRole('group', { name: dictionary.publicControls })
    const controlBounds = await controls.boundingBox()
    assert.ok(controlBounds && controlBounds.x >= 0 && controlBounds.x + controlBounds.width <= width)
    await controls.getByRole('combobox', { name: dictionary.loginState }).click()
    await page.getByRole('option', { name: dictionary.mockLoggedOut, exact: true }).click()
    await expect(page.getByTestId('public-control-values')).toHaveText('anonymous|' + theme + '|' + language)
    await controls.getByRole('combobox', { name: dictionary.loginState }).click()
    await page.getByRole('option', { name: dictionary.mockLoggedIn, exact: true }).click()
    await controls.getByRole('combobox', { name: dictionary.theme, exact: true }).click()
    await page.getByRole('option', { name: dictionary.system, exact: true }).click()
    await expect(page.getByTestId('public-control-values')).toHaveText('ready|system|' + language)
    await controls.getByRole('combobox', { name: dictionary.theme, exact: true }).click()
    await page.getByRole('option', { name: dictionary[theme as 'light' | 'dark'], exact: true }).click()
    await controls.getByRole('combobox', { name: dictionary.language }).click()
    await page.getByRole('option', { name: language === 'zh' ? dictionary.english : dictionary.chinese, exact: true }).click()
    await expect(page.getByTestId('public-control-values')).toHaveText('ready|' + theme + '|' + (language === 'zh' ? 'en' : 'zh'))
    await controls.getByRole('combobox', { name: dictionary.language }).click()
    await page.getByRole('option', { name: language === 'zh' ? dictionary.chinese : dictionary.english, exact: true }).click()
    const materials = page.getByRole('tab', { name: dictionary.componentsEntry, exact: true })
    await materials.click()
    await expect(materials).toHaveAttribute('aria-selected', 'true')
    const features = page.getByRole('tab', { name: dictionary.featureSection, exact: true })
    await features.click()
    await expect(features).toHaveAttribute('aria-selected', 'true')
    await actions.getByRole('button', { name: dictionary.dockWorkbench, exact: true }).click()
    await expect(actions.getByRole('button', { name: dictionary.detachWorkbench, exact: true })).toBeVisible()
    const divider = page.getByRole('separator', { name: dictionary.resizeWorkbench, exact: true })
    await expect(divider).toBeVisible()
    const idle = await divider.evaluate(element => ({
      width: element.getBoundingClientRect().width,
      margin: getComputedStyle(element).margin,
      background: getComputedStyle(element).backgroundColor,
      outline: getComputedStyle(element).outlineStyle,
      line: getComputedStyle(element, '::after').width,
    }))
    assert.deepEqual(idle, { width: 8, margin: '0px', background: 'rgba(0, 0, 0, 0)', outline: 'none', line: '1px' })
    await divider.hover()
    await expect.poll(() => divider.evaluate(element => getComputedStyle(element, '::after').width)).toBe('2px')
    const brand = await divider.evaluate(element => {
      const probe = document.createElement('span')
      probe.style.color = getComputedStyle(element).getPropertyValue('--vds-border-brand').trim()
      return probe.style.color
    })
    await expect.poll(() => divider.evaluate(element => getComputedStyle(element, '::after').backgroundColor)).toBe(brand)
    await page.screenshot({ path: join(OUTPUT, language + '-' + theme + '-' + width + '-divider-hover.png') })
    const handle = await divider.boundingBox()
    assert.ok(handle)
    const middle = handle.y + handle.height / 2
    await page.mouse.move(handle.x + handle.width / 2, middle)
    await page.mouse.down()
    await expect(divider).toHaveAttribute('data-dragging', 'true')
    await page.mouse.move(handle.x + handle.width / 2 - 24, middle, { steps: 12 })
    await page.mouse.up()
    await expect(divider).toHaveAttribute('data-dragging', 'false')
    await expect(page.getByTestId('resized-width')).toHaveText(String(width + 24))
    assert.equal(await page.locator('html').evaluate(element => element.classList.contains('select-none')), false)
    await divider.focus()
    await divider.press('ArrowLeft')
    await expect(page.getByTestId('resized-width')).toHaveText(String(width + 20))
    await divider.press('ArrowRight')
    await expect(page.getByTestId('resized-width')).toHaveText(String(width - 20))
    await divider.hover()
    await page.mouse.down()
    await expect(divider).toHaveAttribute('data-dragging', 'true')
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await expect(divider).toHaveAttribute('data-dragging', 'false')
    await page.mouse.up()
    assert.equal(await page.locator('html').evaluate(element => element.classList.contains('cursor-col-resize')), false)
    await actions.getByRole('button', { name: dictionary.guide, exact: true }).click()
    const guide = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: dictionary.guide, exact: true }) }).last()
    await expect(guide).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(guide).not.toBeVisible()
    await page.screenshot({ path: join(OUTPUT, language + '-' + theme + '-' + width + '.png') })
  }
  await page.goto(fixture.url + '__pdfe-header.html?language=en&theme=light&pending')
  await expect(page.getByRole('group', { name: en.publicControls }).getByRole('combobox')).toHaveCount(3)
  for (const control of await page.getByRole('group', { name: en.publicControls }).getByRole('combobox').all()) await expect(control).toBeDisabled()
  await page.goto(fixture.url + '__pdfe-header.html?language=en&theme=light&noLogin')
  await expect(page.getByRole('combobox', { name: en.loginState })).toHaveCount(0)
  await page.goto(fixture.url + '__pdfe-header.html?language=en&theme=light&scene=home-create')
  await expect(page.getByTestId('preview-scene-page-home-home-create')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('preview-scene-page-home-home-empty')).toHaveCount(0)
  await page.goto(fixture.url + '__pdfe-header.html?language=en&theme=light&scene=home-browse')
  await expect(page.getByTestId('preview-scene-page-home-home-browse')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('preview-scene-page-home-home-states')).toHaveCount(0)
  assert.deepEqual(errors, [])
})
