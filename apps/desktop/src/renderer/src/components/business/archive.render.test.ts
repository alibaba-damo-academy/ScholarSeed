import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import path from 'node:path'
import { chromium, expect } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { transformWithEsbuild, type Plugin } from 'vite'
import { renderServers } from '../../../../test-helpers/render.ts'

const servers = renderServers({ after })
const ROOT = path.resolve(import.meta.dirname, '../..')
const PREFIX = '\0archive-probe:'
const ENTRY = 'entry'
const modules: Record<string, string> = {
  '../../api': `
    export const deleteSession = () => {}; export const getHistoryWithTodos = () => {};
    export const listAllSessions = () => {}; export const listProjects = () => {};
    export function loadSessionStatus(ids, queued, signal) {
      return new Promise((resolve, reject) => window.probe.reads.push({ids, signal, resolve, reject}))
    }
    export function setSessionArchived(...args) {
      window.probe.puts.push(args)
      return Promise.resolve(window.probe.result)
    }
  `,
  '../../store': `
    import {useSyncExternalStore} from 'react'
    let state = {sessionArchive:{sessionId:'selected',title:'Selected task'},activeSession:'other-running'}
    const listeners = new Set()
    function set(update) {
      state = {...state,...(typeof update === 'function' ? update(state) : update)}
      for (const listener of listeners) listener()
    }
    export function useApp() {
      const current = useSyncExternalStore(listener => {listeners.add(listener);return () => listeners.delete(listener)}, () => state)
      window.probe.select = id => set({sessionArchive:{sessionId:id,title:id}})
      return {state:current,set,act:{removeSession:id => window.probe.removed.push(id)}}
    }
  `,
  'react-i18next': `export const useTranslation = () => ({t:key => key})`,
  '../../features/workbench/workspace': `export const documentWorkspaces = {}`,
  '../../session': `export const sessionDisplayTitle = () => ''; export const sessionProjectName = () => ''`,
  '../../transcript': `export const isUserHistoryTurn = () => false`,
  './deletion': `export const useSessionChildCount = () => ({count:0,failed:false})`,
  '../primitive/Markdown': `export const Markdown = () => null`,
  './Settings': `export const SettingsPage = () => null`,
}
const names = [ENTRY, ...Object.keys(modules)]
const plugin: Plugin = {
  name: 'archive-probe',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source.startsWith(PREFIX)) return source
    if (
      source === ENTRY ||
      (source === '../../store' && importer?.startsWith(PREFIX)) ||
      (importer?.endsWith('/business/Archive.tsx') && source in modules)
    )
      return PREFIX + names.indexOf(source) + '.tsx'
    return null
  },
  async load(id) {
    if (!id.startsWith(PREFIX)) return null
    const name = names[Number(id.slice(PREFIX.length, -'.tsx'.length))]
    const source =
      name === ENTRY
        ? `
      import React from 'react'
      import {createRoot} from 'react-dom/client'
      import {ArchiveDialog} from '/components/business/Archive.tsx'
      import {useApp} from '../../store'
      window.probe = {reads:[], puts:[], removed:[], result:{ok:true,status:200}}
      function Host() {const {state} = useApp();return state.sessionArchive ? <ArchiveDialog/> : null}
      createRoot(document.getElementById('root')).render(<Host/>)
    `
        : modules[name]
    return (
      await transformWithEsbuild(source, 'archive-probe.tsx', {
        loader: 'tsx',
        jsx: 'automatic',
        tsconfigRaw: {},
      })
    ).code
  },
  configureServer(server) {
    server.middlewares.use('/__archive', (_request, response, next) => {
      server
        .transformIndexHtml(
          '/__archive',
          '<div id="root"></div><script type="module" src="/@id/__x00__archive-probe:0.tsx"></script>'
        )
        .then((html) => {
          response.setHeader('Content-Type', 'text/html')
          response.end(html)
        })
        .catch(next)
    })
  },
}

test('archive dialog rejects stale reads, re-confirms status changes and never silently adds stop consent', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [plugin, react()],
    cacheKey: 'archive',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const address = server.httpServer!.address()
  assert.ok(address && typeof address === 'object')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${address.port}/__archive`)
    const submit = page.getByTestId('task-archive-submit')
    const dialog = page.getByTestId('task-archive-confirm')
    const settle = async (running: boolean): Promise<void> => {
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'probe').reads.length))
        .toBeGreaterThan(0)
      await page.evaluate((running) => {
        const probe = Reflect.get(window, 'probe')
        const read = probe.reads.shift()
        read.resolve([
          {
            session_id: read.ids[0],
            running,
            pending_hil: [],
            queued_messages: [],
            uncertain_operations: [],
          },
        ])
      }, running)
    }
    await expect(submit).toBeDisabled()
    await page.evaluate(() => Reflect.get(window, 'probe').select('target-b'))
    await settle(true)
    await expect(submit).toBeDisabled()
    await settle(false)
    await expect(submit).toHaveText('taskArchive.confirm')
    await submit.click()
    await settle(true)
    await expect(submit).toHaveText('taskArchive.stopConfirm')
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'probe').puts), [])
    await submit.click()
    await settle(false)
    await expect(submit).toHaveText('taskArchive.confirm')
    await page.evaluate(() => {
      Reflect.get(window, 'probe').result = { ok: false, status: 409, stopRequired: true }
    })
    await submit.click()
    await settle(false)
    await expect(submit).toHaveText('taskArchive.stopConfirm')
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'probe').puts), [
      ['target-b', true, false],
    ])
    await page.evaluate(() => {
      Reflect.get(window, 'probe').result = { ok: true, status: 200 }
    })
    await submit.click()
    await settle(false)
    await expect(dialog).toBeHidden()
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'probe').removed), ['target-b'])
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'probe').puts), [
      ['target-b', true, false],
      ['target-b', true, true],
    ])

    await page.reload()
    await expect(submit).toBeDisabled()
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'probe').reads.length)).toBe(1)
    await page.evaluate(() =>
      Reflect.get(window, 'probe').reads.shift().reject(new Error('unavailable'))
    )
    await expect(dialog).toContainText('taskArchive.statusFailed')
    await expect(submit).toBeDisabled()
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'probe').puts), [])
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
    await server.close()
  }
})
