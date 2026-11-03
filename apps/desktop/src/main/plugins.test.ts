import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { _electron, expect } from '@playwright/test'

const PEER_PROBE = `async () => {
  const first = new RTCPeerConnection()
  const second = new RTCPeerConnection()
  const errors = []
  const timeoutMs = 5000
  let timer
  const terminal = peer => new Promise(resolve => {
    const inspect = () => {
      if (['failed', 'connected', 'completed'].includes(peer.iceConnectionState)) resolve(peer.iceConnectionState)
    }
    peer.addEventListener('iceconnectionstatechange', inspect)
    inspect()
  })
  try {
    const states = Promise.all([terminal(first), terminal(second)])
    const forward = target => ({ candidate }) => {
      if (candidate) void target.addIceCandidate(candidate).catch(error => { errors.push(String(error)) })
    }
    first.onicecandidate = forward(second)
    second.onicecandidate = forward(first)
    first.createDataChannel('test')
    return await Promise.race([
      (async () => {
        await first.setLocalDescription(await first.createOffer())
        await second.setRemoteDescription(first.localDescription)
        await second.setLocalDescription(await second.createAnswer())
        await first.setRemoteDescription(second.localDescription)
        return { states: await states, errors }
      })(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('peer_timeout')), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
    first.close()
    second.close()
  }
}`

test(
  'repeated lease validation drains large snapshots and retains revocation checks',
  { timeout: 30_000 },
  async () => {
    const work = resolve('../../work/ui-sdk')
    await mkdir(work, { recursive: true })
    const directory = await mkdtemp(join(work, 'validation-'))
    const fixture = join(directory, 'main.cjs')
    await build({
      stdin: {
        contents: `
      import { app, BrowserWindow, protocol, session } from 'electron';
      import { createServer } from 'node:http';
      import { createPluginHost } from ${JSON.stringify(resolve('src/main/plugins.ts'))};
      import { PLUGIN_SCHEME, PLUGIN_SCHEME_PRIVILEGES } from ${JSON.stringify(resolve('src/plugins.ts'))};
      protocol.registerSchemesAsPrivileged([{scheme:PLUGIN_SCHEME,privileges:PLUGIN_SCHEME_PRIVILEGES}]);
      app.whenReady().then(() => {
        const owner = new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
        const host = createPluginHost();
        void owner.loadURL('data:text/html,<body>validation</body>');
        globalThis.fixture = {run: async () => {
          const snapshot = {descriptor:{id:'validation',version:'1.0.0',capabilities:[],components:[{id:'card',entry:'card.js',actions:[]}]},fingerprint:'fixed',scenarios:{},files:{'card.js':Buffer.from('document.title="validation"').toString('base64')}};
          const reference = {plugin:'validation',component:'card',fingerprint:'fixed',binding:'bound'};
          const mount = await host.open(owner.webContents,snapshot,false,()=>true,reference);
          const lease = mount.frames.card.lease;
          const SNAPSHOT_BYTES = 12 * 1024 * 1024;
          const VALIDATIONS = 12;
          const server = createServer((_request,response)=>{response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({snapshot:'x'.repeat(SNAPSHOT_BYTES)}));});
          await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
          try {
            const statuses=[];
            for(let index=0;index<VALIDATIONS;index++) statuses.push(await host.validate(owner.webContents,lease,()=>session.defaultSession.fetch('http://127.0.0.1:'+server.address().port)));
            let canceled=false;
            const revoked=await host.validate(owner.webContents,lease,async()=>{
              host.release(owner.webContents,[lease]);
              return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1]));controller.close()},cancel(){canceled=true}}));
            });
            return {statuses,revoked,valid:host.valid(owner.webContents,lease),canceled};
          } finally {server.closeAllConnections();server.close();}
        }};
      });`,
        resolveDir: process.cwd(),
        sourcefile: 'validation.ts',
      },
      outfile: fixture,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
    })
    const application = await _electron.launch({
      args: [fixture, `--user-data-dir=${join(directory, 'profile')}`],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    })
    try {
      await application.firstWindow()
      const result = await application.evaluate(async () =>
        (
          globalThis as unknown as {
            fixture: { run: () => Promise<{ statuses: number[]; revoked: number; valid: boolean }> }
          }
        ).fixture.run()
      )
      assert.deepEqual(result.statuses, Array(12).fill(200))
      assert.equal(result.revoked, 410)
      assert.equal(result.valid, false)
    } finally {
      await application.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
)

test(
  'UI dependency resources stay pinned per lease and shared cards use the isolated loader',
  { timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'plugin-ui-'))
    const fixture = join(directory, 'main.cjs')
    await build({
      stdin: {
        contents: `
      import { app, BrowserWindow, protocol } from 'electron';
      import { createPluginHost } from ${JSON.stringify(resolve('src/main/plugins.ts'))};
      import { PLUGIN_SCHEME, PLUGIN_SCHEME_PRIVILEGES } from ${JSON.stringify(resolve('src/plugins.ts'))};
      protocol.registerSchemesAsPrivileged([{scheme:PLUGIN_SCHEME,privileges:PLUGIN_SCHEME_PRIVILEGES}]);
      app.whenReady().then(async () => {
        const owner = new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
        const host = createPluginHost();
        const encode = value => Buffer.from(value).toString('base64');
        const entry = "document.body.dataset.version=window.scholarseedUI.version;document.body.dataset.kind='shared';";
        const snapshot = {
          descriptor:{id:'ui-contract',version:'1.0.0',capabilities:[],components:[
            {id:'selection',public:true,entry:'__ui__/selection.js',preview:'selection.json',actions:[]},
            {id:'custom',entry:'custom.js',preview:'custom.json',actions:[]}
          ]},fingerprint:'plugin-fixed',scenarios:{},files:{
            'custom.js':encode("document.body.dataset.version=window.scholarseedUI.version;document.body.dataset.kind='custom';"),
            '__ui__/ui.js':encode("window.scholarseedUI={version:'spoof'}")
          },
          ui:{fingerprint:'ui-first',version:'1.0.1',compatibility:'1.0',runtime:'ui.js',exports:['Button'],files:{
            'ui.js':encode("window.scholarseedUI={version:'first'}"),
            'selection.js':encode(entry),
            'nested/../private.js':encode("document.body.dataset.escaped='yes'"),
            'nested\\\\private.js':encode("document.body.dataset.escaped='yes'")
          }}
        };
        const oldMount = await host.open(owner.webContents,snapshot,true);
        snapshot.ui.fingerprint='ui-second'; snapshot.ui.version='1.0.2';
        snapshot.ui.files['ui.js']=encode("window.scholarseedUI={version:'second'}");
        const newMount = await host.open(owner.webContents,snapshot,true);
        globalThis.fixture = {host,owner,oldMount,newMount};
        await owner.loadURL('data:text/html,<html><body></body></html>');
        for (const [label,mount] of Object.entries({old:oldMount,new:newMount})) {
          for (const [component,frame] of Object.entries(mount.frames)) {
            await owner.webContents.executeJavaScript('(() => {const frame=document.createElement("iframe");frame.id='+JSON.stringify(label+'-'+component)+';frame.sandbox="allow-scripts";frame.src='+JSON.stringify(frame.url)+';document.body.append(frame)})()');
          }
        }
      });`,
        resolveDir: process.cwd(),
        sourcefile: 'ui-contract.ts',
      },
      outfile: fixture,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
    })
    const application = await _electron.launch({
      args: [fixture],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    })
    try {
      const page = await application.firstWindow()
      await expect(page.locator('iframe')).toHaveCount(4)
      const oldShared = page.frameLocator('#old-selection')
      await expect(oldShared.locator('body')).toHaveAttribute('data-version', 'first')
      await expect(oldShared.locator('body')).toHaveAttribute('data-kind', 'shared')
      await expect(page.frameLocator('#old-custom').locator('body')).toHaveAttribute(
        'data-version',
        'first'
      )
      await expect(page.frameLocator('#new-selection').locator('body')).toHaveAttribute(
        'data-version',
        'second'
      )
      await expect(page.frameLocator('#new-custom').locator('body')).toHaveAttribute(
        'data-version',
        'second'
      )
      const identity = await application.evaluate(() => {
        const fixture = (
          globalThis as unknown as {
            fixture: {
              oldMount: { ui: unknown }
              newMount: { ui: unknown; frames: { selection: { url: string } } }
            }
          }
        ).fixture
        return {
          old: fixture.oldMount.ui,
          current: fixture.newMount.ui,
          other: fixture.newMount.frames.selection.url,
        }
      })
      assert.deepEqual(identity.old, {
        fingerprint: 'ui-first',
        version: '1.0.1',
        compatibility: '1.0',
      })
      assert.deepEqual(identity.current, {
        fingerprint: 'ui-second',
        version: '1.0.2',
        compatibility: '1.0',
      })
      await page.evaluate(`(() => {
        window.requestIds = [];
        addEventListener('message', event => {
          const frame = document.getElementById('old-selection');
          if (event.source !== frame.contentWindow || !event.data.requestId) return;
          window.requestIds.push(event.data.requestId);
          frame.contentWindow.postMessage({channel:event.data.channel,lease:event.data.lease,requestId:event.data.requestId,result:{saved:true}}, '*');
        });
      })()`)
      const register = async (): Promise<void> => {
        await oldShared.locator('body').evaluate(`(async () => {
          await window.plugin.setCopyContent({text:'complete card'});
          await window.plugin.save({selected:['paper']});
          await window.plugin.request('inspect', {});
        })()`)
      }
      await register()
      const frameUrl = await page.locator('#old-selection').getAttribute('src')
      const firstDocument = page.frames().find((frame) => frame.url() === frameUrl)
      assert.ok(firstDocument)
      await firstDocument.goto(frameUrl!)
      await expect(oldShared.locator('body')).toHaveAttribute('data-version', 'first')
      await register()
      const requestIds = (await page.evaluate('window.requestIds')) as string[]
      assert.equal(requestIds.length, 6)
      assert.equal(new Set(requestIds).size, 6)
      assert.ok(requestIds.every((identifier) => /^[a-zA-Z0-9_-]{1,64}$/.test(identifier)))
      for (const path of [
        '/__ui__/missing.js',
        '/__ui__/nested%2f..%2fprivate.js',
        '/__ui__/nested%5cprivate.js',
        '/__ui__/%ZZ',
        new URL('/__ui__/ui.js', identity.other).href,
      ]) {
        const loaded = await oldShared.locator('body').evaluate(`new Promise(resolve => {
        const script = document.createElement('script')
        script.onload = () => { script.remove(); resolve(true) }
        script.onerror = () => { script.remove(); resolve(false) }
        script.src = ${JSON.stringify(path)}
        document.body.append(script)
      })`)
        assert.equal(loaded, false, `unexpected resource access: ${path}`)
      }
      await expect(oldShared.locator('body')).toHaveAttribute('data-version', 'first')
      assert.equal(await oldShared.locator('body').getAttribute('data-escaped'), null)
    } finally {
      await application.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
)

test(
  'conversation component isolates host APIs and blocks external fetch and navigation',
  { timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'plugin-component-'))
    const fixture = join(directory, 'main.cjs')
    const font = (
      await readFile(
        resolve('src/renderer/src/components/primitive/Iconfont/download/iconfont.woff2')
      )
    ).toString('base64')
    await build({
      stdin: {
        contents: `
      import { app, BrowserWindow, protocol } from 'electron';
      import { createPluginHost } from ${JSON.stringify(resolve('src/main/plugins.ts'))};
      import { PLUGIN_SCHEME, PLUGIN_SCHEME_PRIVILEGES } from ${JSON.stringify(resolve('src/plugins.ts'))};
      protocol.registerSchemesAsPrivileged([{scheme:PLUGIN_SCHEME,privileges:PLUGIN_SCHEME_PRIVILEGES}]);
      app.whenReady().then(async () => {
        const owner = new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
        const host = createPluginHost();
        const code = "document.body.dataset.node=typeof require;document.body.dataset.host=typeof window.scholarseed;fetch('https://example.com').then(()=>document.body.dataset.network='allowed').catch(()=>document.body.dataset.network='blocked');const connection=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:9'}]});document.body.dataset.rtc=String(connection.getConfiguration().iceServers.length);connection.close();window.plugin.onState(state=>document.body.dataset.state=state.status);";
        const fontProbe = "new FontFace('PluginIcons','url(/icons.woff2)').load().then(font=>{document.fonts.add(font);document.body.dataset.font=font.status}).catch(()=>document.body.dataset.font='failed');";
        const snapshot = {descriptor:{id:'contract',version:'1.0.0',capabilities:[],components:[{id:'card',entry:'card.js',preview:'scenario.json',actions:[]}]},fingerprint:'verified',scenarios:{card:{data:{},responses:{}}},files:{'card.js':Buffer.from(code+fontProbe).toString('base64'),'icons.woff2':${JSON.stringify(font)}}};
        snapshot.descriptor.components.push({id:'public-question',slot:'interaction.question',public:true,preview:'question.json',actions:[]});
        const reference = {plugin:'contract',component:'card',fingerprint:'verified',binding:'fixed-binding'};
        const mount = await host.open(owner.webContents,snapshot,false,()=>true,reference);
        const other = await host.open(owner.webContents,snapshot,true);
        globalThis.fixture = {host,owner,mount,other};
        await owner.loadURL('data:text/html,<html><body></body></html>');
        await owner.webContents.executeJavaScript('const frame=document.createElement("iframe");frame.sandbox="allow-scripts";frame.src='+JSON.stringify(mount.frames.card.url)+';document.body.append(frame);');
      });`,
        resolveDir: process.cwd(),
        sourcefile: 'component-contract.ts',
      },
      outfile: fixture,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
    })
    const application = await _electron.launch({
      args: [fixture],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    })
    try {
      const page = await application.firstWindow()
      assert.deepEqual(
        await application.evaluate(() => {
          const fixture = (
            globalThis as unknown as {
              fixture: {
                host: { reference: (owner: unknown, lease: string) => unknown }
                owner: { webContents: unknown }
                mount: { frames: Record<string, { lease: string }> }
              }
            }
          ).fixture
          return {
            components: Object.keys(fixture.mount.frames),
            reference: fixture.host.reference(
              fixture.owner.webContents,
              fixture.mount.frames.card.lease
            ),
          }
        }),
        {
          components: ['card'],
          reference: {
            plugin: 'contract',
            component: 'card',
            fingerprint: 'verified',
            binding: 'fixed-binding',
          },
        }
      )
      const guest = page.frameLocator('iframe')
      await expect(guest.locator('body')).toHaveAttribute('data-network', 'blocked')
      await expect(guest.locator('body')).toHaveAttribute('data-font', 'loaded')
      const otherFont = await application.evaluate(() => {
        const fixture = (
          globalThis as unknown as { fixture: { other: { frames: { card: { url: string } } } } }
        ).fixture
        return new URL('/icons.woff2', fixture.other.frames.card.url).href
      })
      const crossInstanceFont = await guest.locator('body').evaluate(`(async () => {
      try {
        await new FontFace('OtherPluginIcons', ${JSON.stringify(`url(${otherFont})`)}).load()
        return true
      } catch {
        return false
      }
    })()`)
      assert.equal(crossInstanceFont, false)
      await expect(guest.locator('body')).toHaveAttribute('data-node', 'undefined')
      await expect(guest.locator('body')).toHaveAttribute('data-host', 'undefined')
      await expect(guest.locator('body')).toHaveAttribute('data-rtc', '0')
      assert.equal(
        await page.evaluate(`(() => {
      const connection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:9' }] })
      const count = connection.getConfiguration().iceServers?.length
      connection.close()
      return count
    })()`),
        1
      )
      assert.deepEqual(await guest.locator('body').evaluate(`(${PEER_PROBE})()`), {
        states: ['failed', 'failed'],
        errors: [],
      })
      const hostPeers = (await page.evaluate(`(${PEER_PROBE})()`)) as {
        states: string[]
        errors: string[]
      }
      assert.equal(
        hostPeers.states.every((state) => state === 'connected' || state === 'completed'),
        true
      )
      assert.deepEqual(hostPeers.errors, [])
      assert.equal(application.windows().length, 1)
      const readable = await guest
        .locator('body')
        .evaluate(
          '(() => { try { return Boolean(parent.document.body) } catch { return false } })()'
        )
      assert.equal(readable, false)
      await guest.locator('body').evaluate("location.href = 'https://example.com'")
      assert.match(page.frames()[1].url(), /^scholarseed-plugin:/)
      const lifecycle = await application.evaluate(() => {
        const fixture = (
          globalThis as unknown as {
            fixture: {
              host: {
                valid: (owner: unknown, lease: string) => boolean
                close: (name: string) => void
              }
              owner: { webContents: unknown }
              mount: { frames: { card: { lease: string } } }
            }
          }
        ).fixture
        const lease = fixture.mount.frames.card.lease
        const before = fixture.host.valid(fixture.owner.webContents, lease)
        fixture.host.close('contract')
        return { before, after: fixture.host.valid(fixture.owner.webContents, lease) }
      })
      assert.deepEqual(lifecycle, { before: true, after: false })
    } finally {
      await application.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
)
