import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { _electron } from '@playwright/test'
import { runBrowserSearch } from './search.ts'
import { fixture, RESULT_URL, DEADLINE_MS, type SearchResult } from './search.fixture.ts'
import { nativeFixture } from '../test-helpers/native.ts'

test(
  'real Electron DOM prioritizes result headings and excludes hidden, inert, sensitive and cross-frame text',
  { timeout: DEADLINE_MS },
  async (context) => {
    const temporary = await mkdtemp(join(tmpdir(), 'search-dom-'))
    const scope = nativeFixture(context, () => rm(temporary, { recursive: true, force: true }))
    const entry = join(temporary, 'main.cjs')
    await writeFile(
      entry,
      `const {app}=require('electron'); app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))}); app.on('window-all-closed',()=>{}); app.whenReady();`
    )
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    )
    delete environment.ELECTRON_RUN_AS_NODE
    const browser = await scope.launch(() => _electron.launch({ args: [entry], env: environment }))
    try {
      const body = `
        <input id="sb_form_q" value="test">
        <div id="b_results">
          <div class="b_algo"><a class="tilk" href="https://example.org/visible">Brand and domain</a><h2><a href="https://example.org/visible">Visible
            <span hidden>hidden title</span><span style="opacity:0">transparent title</span></a></h2>
            <div class="b_caption"><p>Summary <span inert>secret inert</span>
              <span contenteditable>secret editable</span><input value="secret input">
              <span aria-hidden="true">secret aria</span><span style="visibility:hidden">secret style</span></p></div>
          </div>
          <div class="b_algo"><h2 hidden><a href="https://example.org/hidden-heading">Hidden heading</a></h2>
            <a class="tilk" href="https://example.org/fallback">Fallback title</a></div>
          <div class="b_algo" hidden><h2><a href="https://example.org/hidden">Hidden card</a></h2></div>
          <div inert><div class="b_algo"><h2><a href="https://example.org/inert">Inert card</a></h2></div></div>
          <div class="b_algo" style="opacity:0"><h2><a href="https://example.org/transparent">Transparent card</a></h2></div>
          <div class="b_algo"><h2><a style="display:none" href="https://example.org/hidden-link">Secret link</a></h2></div>
          <div class="b_algo"><h2><a href="https://example.org/${'long'.repeat(600)}">Overlong link</a></h2></div>
        </div>
        <iframe srcdoc='<div class="b_algo"><h2><a href="https://example.org/frame">Frame secret</a></h2></div>'></iframe>
      `
      await browser.evaluate(
        async ({ app, BrowserWindow, session }, input) => {
          await app.whenReady()
          await session.defaultSession.protocol.handle(
            'https',
            () => new Response(input.body, { headers: { 'content-type': 'text/html' } })
          )
          const window = new BrowserWindow({
            show: false,
            webPreferences: { contextIsolation: true, sandbox: true },
          })
          await window.loadURL(input.url)
          await window.webContents.executeJavaScript(
            "window.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' }); null"
          )
        },
        { body, url: RESULT_URL }
      )
      const state = fixture({
        evaluate: async (expression) => {
          return (await browser.evaluate(async ({ BrowserWindow }, script) => {
            return await BrowserWindow.getAllWindows()[0].webContents.executeJavaScriptInIsolatedWorld(
              1001,
              [{ code: script }]
            )
          }, expression)) as SearchResult
        },
      })
      const result = await runBrowserSearch(state.input, state.ports)
      assert.deepEqual(
        result.cards.filter((card) => card.title),
        [
          { title: 'Visible', href: 'https://example.org/visible', description: 'Summary' },
          { title: 'Fallback title', href: 'https://example.org/fallback', description: '' },
        ]
      )
      assert.ok(result.cards.every((card) => !JSON.stringify(card).includes('secret')))
      assert.equal(state.status().closed, true)
    } finally {
      await scope.close()
    }
  }
)
