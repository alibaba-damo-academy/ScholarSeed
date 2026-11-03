import assert from 'node:assert/strict'
import path from 'node:path'
import test, { after } from 'node:test'
import { chromium, expect } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { transformWithEsbuild, type Plugin } from 'vite'
import { renderServers } from '../../../../test-helpers/render.ts'

const servers = renderServers({ after })
const ROOT = path.resolve(import.meta.dirname, '../..')
const PREFIX = '\0resource-creation:'
const STORE = `
  import React from 'react'
  import {resourceCreateNameError} from '/features/resources/state.ts'
  export const Context = React.createContext(null)
  export const useApp = () => React.useContext(Context)
  export function Fixture({children}) {
    const [draft, setDraft] = React.useState(null)
    const [commits, setCommits] = React.useState(0)
    const act = {
      setResourceNameDraft: value => setDraft(current => ({...current, value, error: null})),
      cancelResourceNameDraft: () => setDraft(null),
      commitResourceNameDraft: () => {
        if (!draft || draft.submitting) return
        const error = resourceCreateNameError(draft.value)
        if (error) {setDraft({...draft, error}); return}
        setCommits(current => current + 1)
        setDraft({...draft, submitting: true})
      },
    }
    return <Context.Provider value={{state: {resource: {nameDraft: draft}}, act}}>
      {children}
      <div data-testid="commits">{commits}</div>
      {['create_document', 'create_folder', 'rename'].map(mode => <button key={mode} onClick={() => setDraft({mode, target: '', value: '未命名', suffix: mode === 'create_document' ? '.md' : '', error: null, submitting: false})}>{mode}</button>)}
    </Context.Provider>
  }
`
const plugin: Plugin = {
  name: 'resource-creation-fixture',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source.startsWith(PREFIX)) return source
    if (source === 'creation-fixture') return `${PREFIX}entry.tsx`
    if (source === '../../store' && importer?.endsWith('/resources/Dialogs.tsx'))
      return `${PREFIX}store.tsx`
    if (source === '../workbench/workspace' && importer?.endsWith('/resources/Dialogs.tsx'))
      return `${PREFIX}workspace.tsx`
    return null
  },
  async load(id) {
    if (!id.startsWith(PREFIX)) return null
    const source = id.endsWith('store.tsx')
      ? STORE
      : id.endsWith('workspace.tsx')
        ? 'export const hasDirtyProjectPath = () => false; export const useDocumentWorkspace = () => ({sessions: {}})'
        : `
        import React from 'react'
        import {createRoot} from 'react-dom/client'
        import {I18nextProvider} from 'react-i18next'
        import {createLocalization} from '/../../localization/engine.ts'
        import {resources} from '/../../localization/resources.ts'
        import {CreateDialog} from '/features/resources/Dialogs.tsx'
        import {Fixture} from '${PREFIX}store.tsx'
        import '/styles.css'
        const localization = createLocalization('zh', resources, {report() {}})
        createRoot(document.getElementById('root')).render(<I18nextProvider i18n={localization}><Fixture><CreateDialog /></Fixture></I18nextProvider>)
      `
    return (
      await transformWithEsbuild(source, 'creation-fixture.tsx', {
        loader: 'tsx',
        jsx: 'automatic',
        tsconfigRaw: {},
      })
    ).code
  },
  configureServer(server) {
    server.middlewares.use('/__creation', (_request, response, next) => {
      server
        .transformIndexHtml(
          '/__creation',
          '<div id="root"></div><script type="module" src="/@id/__x00__resource-creation:entry.tsx"></script>'
        )
        .then((html) => {
          response.setHeader('Content-Type', 'text/html')
          response.end(html)
        })
        .catch(next)
    })
  },
}

test('resource creation uses a named dialog, counts twenty characters and never commits on blur or cancel', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [plugin, react()],
    cacheKey: 'resource-creation',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage()
    await page.goto(new URL('/__creation', server.resolvedUrls!.local[0]).href)
    for (const mode of ['create_document', 'create_folder']) {
      await page.getByRole('button', { name: mode, exact: true }).click()
      const dialog = page.getByRole('dialog', {
        name: mode === 'create_document' ? '新建md文档' : '新建文件夹',
      })
      await expect(dialog).toBeVisible()
      const input = dialog.getByRole('textbox')
      await expect(input).toBeFocused()
      await expect(input).toHaveAttribute('maxlength', '20')
      await expect(dialog.getByTestId('resource-name-suffix')).toHaveCount(
        mode === 'create_document' ? 1 : 0
      )
      await input.fill('文'.repeat(20))
      await expect(dialog.getByTestId('resource-name-count')).toHaveText('20/20')
      await input.press('a')
      await expect(input).toHaveValue('文'.repeat(20))
      await dialog.getByRole('button', { name: '取消', exact: true }).focus()
      await expect(page.getByTestId('commits')).toHaveText('0')
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByTestId('commits')).toHaveText('0')
    }
    await page.getByRole('button', { name: 'rename', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('button', { name: 'create_document', exact: true }).click()
    const dialog = page.getByRole('dialog')
    const input = dialog.getByRole('textbox')
    await input.fill('')
    await expect(dialog.getByRole('button', { name: '创建', exact: true })).toBeDisabled()
    await input.fill('错误/名称')
    await input.press('Enter')
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByTestId('commits')).toHaveText('0')
    await input.fill('研究笔记')
    await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
    await expect(page.getByTestId('commits')).toHaveText('0')
    await input.press('Enter')
    await expect(page.getByTestId('commits')).toHaveText('1')
    await expect(input).toBeDisabled()
    await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    assert.equal(await page.getByTestId('commits').textContent(), '1')
  } finally {
    await browser.close()
    await server.close()
  }
})
