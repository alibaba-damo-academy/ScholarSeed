import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { _electron } from '@playwright/test'
import { build } from 'esbuild'
import type { BrowserRegistry } from './browser.ts'
import type { createAgentBrowserController as createController } from './agent.ts'
import { nativeFixture } from '../test-helpers/native.ts'

const DESKTOP = fileURLToPath(new URL('../../', import.meta.url))
const DOCUMENTS = [
  [
    'https://www.rfc-editor.org/',
    '<!doctype html><title>Agent document</title><main>Agent document</main>',
  ],
  [
    'https://httpbin.org/html',
    '<!doctype html><title>Cross-frame sentinel</title><main>Moby-Dick</main>',
  ],
]

interface BrowserFixture {
  ready: Promise<void>
  registry: BrowserRegistry
  agent: ReturnType<typeof createController>
}

test(
  'Main read lease keeps debugger attached across snapshot/read and rejects navigation-stale refs',
  { timeout: 90_000 },
  async (context) => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-agent-read-'))
    const fixture = nativeFixture(context, () => rm(temporary, { recursive: true, force: true }))
    const entry = join(temporary, 'main.cjs')
    await build({
      stdin: {
        contents: `
    import { app, BrowserWindow } from 'electron'
    import { createBrowserRegistry } from './src/main/browser.ts'
    import { selectStorage, publishStorage } from './src/main/storage.ts'
    import { createAgentBrowserController } from './src/main/agent.ts'
    app.setPath('userData', ${JSON.stringify(join(temporary, 'profile'))})
    app.setPath('sessionData', ${JSON.stringify(join(temporary, 'sessionData'))})
    app.commandLine.appendSwitch('use-mock-keychain')
    if (!process.env.SCHOLARSEED_HOME) throw new Error('Probe requires isolated home')
    const unexpectedPointer = () => { throw new Error('Explicit probe home must not read pointer') }
    publishStorage(selectStorage('browser-probe', {
      pin: unexpectedPointer, readAt: unexpectedPointer, release: unexpectedPointer
    }))
    globalThis.ready = app.whenReady().then(async () => {
      const window = new BrowserWindow({ show: true })
      globalThis.registry = createBrowserRegistry(window, { apiBase: '', publish() {}, log() {} })
      globalThis.agent = createAgentBrowserController(globalThis.registry, { validateAuthority: authority => authority.grantRevision === 1 })
      await globalThis.registry.dispatch({ kind: 'open' })
      const tabId = globalThis.registry.snapshot().activeTabId
      const documents = new Map(${JSON.stringify(DOCUMENTS)})
      await globalThis.registry.target(tabId).session.protocol.handle('https', request => {
        const body = documents.get(request.url)
        return new Response(body ?? 'Not found', { status: body === undefined ? 404 : 200,
          headers: { 'content-type': 'text/html' } })
      })
      await globalThis.registry.dispatch({ kind: 'navigate', tabId, input: 'https://www.rfc-editor.org/' })
      await globalThis.registry.dispatch({ kind: 'bounds', tabId, x: 0, y: 0, width: 700, height: 500, visible: true })
    })
  `,
        resolveDir: DESKTOP,
      },
      outfile: entry,
      platform: 'node',
      format: 'cjs',
      bundle: true,
      external: ['electron', './lease.node'],
    })
    const environment = Object.fromEntries(
      Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined)
    )
    delete environment.ELECTRON_RUN_AS_NODE
    environment.SCHOLARSEED_HOME = join(temporary, 'home')
    const application = await fixture.launch(() =>
      _electron.launch({ args: [entry], env: environment, timeout: 20_000 })
    )
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry, agent } = globalThis as unknown as BrowserFixture
        const tabId = registry.snapshot().activeTabId
        if (!tabId) throw new Error('browser tab unavailable')
        const authority = {
          tabId,
          grantRevision: 1,
          grantId: 'grant',
          grantRequestId: 'request',
          scope: {
            sessionId: 'session',
            instanceId: 'instance',
            productTurnId: 'product-turn',
            turnId: 'turn',
            generation: 1,
            interruptGeneration: 0,
            lifecycleEpoch: 1,
          },
        }
        registry.attach(tabId)
        let busy = ''
        try {
          await agent.snapshot(authority)
        } catch (error) {
          busy = String(error)
        }
        registry.detach(tabId)
        const frameLoad = await registry.target(tabId).executeJavaScript(`new Promise(resolve => {
        document.body.replaceChildren()
        document.body.insertAdjacentHTML('afterbegin', '<h1>Public agent heading</h1><label id="visible-label" for="visible-input">Visible label</label><input id="visible-input" type="text" aria-labelledby="visible-label"><div style="opacity:0"><label id="css-hidden-label" for="css-hidden-input">CSS hidden secret</label></div><input id="css-hidden-input" type="text" aria-labelledby="css-hidden-label"><div style="color:transparent"><label id="color-hidden-label" for="color-hidden-input">Color hidden secret</label><span>Color static secret</span></div><input id="color-hidden-input" type="text" aria-labelledby="color-hidden-label"><div style="position:absolute;left:-9999px"><label id="offscreen-label" for="offscreen-input">Offscreen label secret</label><span>Offscreen static secret</span></div><input id="offscreen-input" type="text" aria-labelledby="offscreen-label"><span id="hidden-label" hidden>Hidden label secret</span><button aria-labelledby="hidden-label">Public button</button><input type="password" aria-label="Password label secret" value="secret-value"><input id="agent-fill-target" type="text" aria-label="Agent query">')
        document.body.insertAdjacentHTML('afterbegin', '<div style="text-indent:-9999px"><label id="indented-label" for="indented-input">Indented label text</label><span>Indented static text</span></div><input id="indented-input" type="text" aria-labelledby="indented-label"><div style="background:white;color:white"><label id="same-color-label" for="same-color-input">Same color label</label><span>Same color static text</span></div><input id="same-color-input" type="text" aria-labelledby="same-color-label"><div style="color:transparent"><label id="restored-label" for="restored-input" style="color:black">Restored label</label><span style="color:black">Restored static text</span></div><input id="restored-input" type="text" aria-labelledby="restored-label">')
        const deepWrapperCount = 18
        const submitTarget = document.createElement('button')
        submitTarget.textContent = 'Submit query'
        submitTarget.addEventListener('mousedown', event => { globalThis.agentPressedButtons = event.buttons })
        document.body.append(submitTarget)
        let deepParent = document.body
        for (let index = 0; index < deepWrapperCount; index += 1) {
          const wrapper = document.createElement('div')
          deepParent.append(wrapper)
          deepParent = wrapper
        }
        deepParent.append(document.getElementById('agent-fill-target'))
        document.getElementById('agent-fill-target').value = 'previous query'
        const frame = document.createElement('iframe')
        frame.id = 'agent-cross-frame'
        frame.title = 'Cross frame'
        frame.addEventListener('load', () => resolve('loaded'), { once: true })
        frame.src = 'https://httpbin.org/html'
        document.body.append(frame)
        setTimeout(() => resolve('timeout'), 10000)
      })`)
        const snapshot = await agent.snapshot(authority)
        const visibleLabeledInput = snapshot.elements.some(
          (element) => element.name === 'Visible label' && element.role.toLowerCase() === 'textbox'
        )
        const tree = (await registry.target(tabId).debugger.sendCommand('Page.getFrameTree')) as {
          frameTree: { frame: { id: string }; childFrames?: Array<{ frame: { url: string } }> }
        }
        const frameUrls = registry.target(tabId).mainFrame.framesInSubtree.map((frame) => frame.url)
        const crossFrameLoaded = frameUrls.includes('https://httpbin.org/html')
        const crossFrame = registry
          .target(tabId)
          .mainFrame.framesInSubtree.find((frame) => frame.url === 'https://httpbin.org/html')
        const crossFrameBody = crossFrame
          ? ((await crossFrame.executeJavaScript('document.body.innerText')) as string)
          : ''
        const ax = (await registry
          .target(tabId)
          .debugger.sendCommand('Accessibility.getFullAXTree', {
            frameId: tree.frameTree.frame.id,
            depth: 5,
          })) as {
          nodes: Array<{
            nodeId?: string
            parentId?: string
            frameId?: string
            role?: { value?: string }
          }>
        }
        const axRootFrameId = ax.nodes.find(
          (node) => node.role?.value?.toLowerCase() === 'rootwebarea' && !node.parentId
        )?.frameId
        const heading = snapshot.elements[0]
        const readable = await agent.read({
          ...authority,
          snapshotId: snapshot.snapshotId,
          elementRef: heading.ref,
        })
        const mutableRef = snapshot.elements.find(
          (element) => element.name === 'Public agent heading'
        )?.ref
        if (!mutableRef) throw new Error('public heading unavailable')
        await registry.target(tabId).executeJavaScript("document.querySelector('h1').remove()")
        let mutated = ''
        try {
          await agent.read({
            ...authority,
            snapshotId: snapshot.snapshotId,
            elementRef: mutableRef,
          })
        } catch (error) {
          mutated = String(error)
        }
        const attached = registry.target(tabId).debugger.isAttached()
        const inputRef = snapshot.elements.find((element) => element.name === 'Agent query')?.ref
        if (!inputRef) throw new Error('agent input unavailable')
        const preparedFill = agent.prepareInteract({
          ...authority,
          requestId: 'electron-fill',
          snapshotId: snapshot.snapshotId,
          elementRef: inputRef,
          action: 'fill',
          value: 'filled by agent',
          intent: 'Fill agent query',
        })
        await agent.execute({
          preparedId: preparedFill.id,
          proofId: preparedFill.proofId,
          approvalId: 'electron-fill-approval',
          requestId: preparedFill.requestId,
          scope: preparedFill.scope,
          tabId: preparedFill.tabId,
          target: preparedFill.target,
          snapshotId: preparedFill.snapshotId,
          elementRef: preparedFill.elementRef,
          backendNodeId: preparedFill.backendNodeId,
          grantId: preparedFill.grantId,
          grantRequestId: preparedFill.grantRequestId,
          grantRevision: preparedFill.grantRevision,
          revocationEpoch: preparedFill.revocationEpoch,
          action: preparedFill.action,
          intent: preparedFill.intent,
          expiresAt: preparedFill.expiresAt,
        })
        const filledValue = await registry
          .target(tabId)
          .executeJavaScript("document.getElementById('agent-fill-target').value")
        const clickSnapshot = await agent.snapshot(authority)
        const submitRef = clickSnapshot.elements.find(
          (element) => element.name === 'Submit query'
        )?.ref
        if (!submitRef) throw new Error('submit target unavailable')
        const preparedClick = agent.prepareSubmit({
          ...authority,
          requestId: 'electron-submit',
          snapshotId: clickSnapshot.snapshotId,
          elementRef: submitRef,
          intent: 'Submit query',
        })
        await agent.execute({
          ...preparedClick,
          preparedId: preparedClick.id,
          approvalId: 'electron-submit-approval',
        })
        const pressedButtons = await registry
          .target(tabId)
          .executeJavaScript('globalThis.agentPressedButtons')
        let wrongGrant = ''
        try {
          await agent.read({
            ...authority,
            grantRevision: 2,
            snapshotId: snapshot.snapshotId,
            elementRef: heading.ref,
          })
        } catch (error) {
          wrongGrant = String(error)
        }
        agent.revoke(tabId)
        const detachedOnRevoke = !registry.target(tabId).debugger.isAttached()
        let revoked = ''
        try {
          await agent.read({
            ...authority,
            snapshotId: snapshot.snapshotId,
            elementRef: heading.ref,
          })
        } catch (error) {
          revoked = String(error)
        }
        const afterRevoke = await agent.snapshot(authority)
        const afterRevokeElement = afterRevoke.elements[0]
        const moved = new Promise<void>((resolveMoved) =>
          registry.target(tabId).once('did-navigate-in-page', () => resolveMoved())
        )
        await registry.target(tabId).executeJavaScript("location.hash = 'agent-ref-stale'")
        await moved
        let hashStale = ''
        try {
          await agent.read({
            ...authority,
            snapshotId: afterRevoke.snapshotId,
            elementRef: afterRevokeElement.ref,
          })
        } catch (error) {
          hashStale = String(error)
        }
        const afterHash = await agent.snapshot(authority)
        const afterHashElement = afterHash.elements[0]
        await registry.clearData({ kind: 'clear-history' })
        const clearReadable = await agent.read({
          ...authority,
          snapshotId: afterHash.snapshotId,
          elementRef: afterHashElement.ref,
        })
        const afterClear = await agent.snapshot(authority)
        const afterClearElement = afterClear.elements[0]
        await registry.dispatch({ kind: 'reload', tabId })
        let stale = ''
        try {
          await agent.read({
            ...authority,
            snapshotId: afterClear.snapshotId,
            elementRef: afterClearElement.ref,
          })
        } catch (error) {
          stale = String(error)
        }
        await registry.dispatch({ kind: 'close', tabId })
        let closed = ''
        try {
          await agent.read({
            ...authority,
            snapshotId: afterRevoke.snapshotId,
            elementRef: afterRevokeElement.ref,
          })
        } catch (error) {
          closed = String(error)
        }
        await registry.dispatch({ kind: 'open' })
        let blank = ''
        const blankTabId = registry.snapshot().activeTabId
        if (!blankTabId) throw new Error('blank browser tab unavailable')
        try {
          await agent.snapshot({ ...authority, tabId: blankTabId })
        } catch (error) {
          blank = String(error)
        }
        agent.dispose()
        return {
          attached,
          detachedOnRevoke,
          filledValue,
          pressedButtons,
          visibleLabeledInput,
          heading: readable.name,
          mutated,
          stale,
          hashStale,
          clearReadable: clearReadable.name,
          expectedClearReadable: afterHashElement.name,
          revoked,
          busy,
          wrongGrant,
          closed,
          blank,
          frameLoad,
          crossFrameLoaded,
          crossFrameBody,
          frameUrls,
          pageFrameId: tree.frameTree.frame.id,
          axRootFrameId,
          serialized: JSON.stringify(snapshot),
        }
      })
      assert.equal(result.attached, true)
      assert.equal(result.visibleLabeledInput, true)
      assert.equal(result.filledValue, 'filled by agent')
      assert.equal(result.pressedButtons, 1)
      assert.equal(result.detachedOnRevoke, true)
      assert.equal(result.axRootFrameId, result.pageFrameId)
      assert.equal(
        result.frameLoad,
        'loaded',
        JSON.stringify({
          frameUrls: result.frameUrls,
          crossFrameLoaded: result.crossFrameLoaded,
          crossFrameBody: result.crossFrameBody,
        })
      )
      assert.equal(result.crossFrameLoaded, true, JSON.stringify(result.frameUrls))
      assert.match(result.crossFrameBody, /Moby-Dick/)
      assert.ok(result.heading.length > 0)
      assert.match(result.mutated, /stale_ref/)
      assert.match(result.stale, /stale|target_closed/)
      assert.match(result.hashStale, /stale_ref/)
      assert.equal(result.clearReadable, result.expectedClearReadable)
      assert.match(result.busy, /cdp_busy/)
      assert.match(result.wrongGrant, /stale_ref/)
      assert.match(result.revoked, /stale_ref/)
      assert.match(result.closed, /stale_ref/)
      assert.match(result.blank, /permission_denied/)
      assert.match(result.serialized, /Public agent heading/)
      assert.match(result.serialized, /CSS hidden secret/)
      assert.match(result.serialized, /Color hidden secret/)
      assert.match(result.serialized, /Color static secret/)
      assert.match(result.serialized, /Offscreen label secret/)
      assert.match(result.serialized, /Offscreen static secret/)
      assert.match(result.serialized, /Indented label text/)
      assert.match(result.serialized, /Indented static text/)
      assert.match(result.serialized, /Same color label/)
      assert.match(result.serialized, /Same color static text/)
      assert.match(result.serialized, /Restored label/)
      assert.match(result.serialized, /Restored static text/)
      assert.doesNotMatch(
        result.serialized,
        /secret-value|Password label secret|Hidden label secret|Cross frame|Moby-Dick/
      )
    } finally {
      await fixture.close()
    }
  }
)
