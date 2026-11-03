import { randomUUID } from 'node:crypto'
import { session, type WebContents, type WebFrameMain } from 'electron'
import {
  PLUGIN_MAX_FRAMES,
  PLUGIN_MAX_PENDING_REQUESTS,
  PLUGIN_REQUEST_TIMEOUT_MS,
  PLUGIN_MESSAGE_CHANNEL,
  PLUGIN_REVOKED_CHANNEL,
  PLUGIN_SCHEME,
  PLUGIN_UI_RESOURCE_PREFIX,
  type PluginMount,
  type PluginSnapshot,
  type PluginReference,
} from '../plugins'

const PLUGIN_CONTAINER = '__component.html'
const PLUGIN_CONNECTION_POLICY = '(response-origin);webrtc=block;redirects=block'
const PLUGIN_MIME_TYPES: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
}
interface ComponentInstance {
  owner: WebContents
  snapshot: PluginSnapshot
  entry: string
  reference?: PluginReference
}
function pluginFrame(frame: WebFrameMain | null | undefined): boolean {
  for (let current = frame; current; current = current.parent) {
    if (current.url.startsWith(`${PLUGIN_SCHEME}:`)) return true
  }
  return false
}
function resourcePath(path: string): boolean {
  return (
    Boolean(path) &&
    !/[\\\x00-\x1f\x7f]/.test(path) &&
    path.split('/').every((part) => Boolean(part) && part !== '.' && part !== '..')
  )
}
function resource(snapshot: PluginSnapshot, path: string): string | undefined {
  if (!resourcePath(path)) return undefined
  const official = path.startsWith(PLUGIN_UI_RESOURCE_PREFIX)
  const files = official ? snapshot.ui?.files : snapshot.files
  const key = official ? path.slice(PLUGIN_UI_RESOURCE_PREFIX.length) : path
  return files && Object.hasOwn(files, key) ? files[key] : undefined
}
function container(entry: string, lease: string, runtime?: string): string {
  const bootstrap = `(() => {
    let state; let sequence = 0; const requestPrefix = ${JSON.stringify(randomUUID())}; const listeners = new Set(); const pending = new Map();
    const send = payload => parent.postMessage({channel:${JSON.stringify(PLUGIN_MESSAGE_CHANNEL)},lease:${JSON.stringify(lease)},...payload}, '*');
    Object.defineProperty(window, 'plugin', { value: Object.freeze({
      onState(callback) { listeners.add(callback); if (state) callback(state); return () => listeners.delete(callback); },
      submit(action, values) { send({action, values}); },
      setCopyContent(content) { return request({copy:content,revision:state?.revision ?? 0}); },
      save(values = {}) { return this.request(undefined, values); },
      request(action, values = {}) {
        return request(action === undefined ? {draft:values} : {action,values});
      }
    }) });
    function request(payload) {
        if (pending.size >= ${PLUGIN_MAX_PENDING_REQUESTS}) return Promise.reject(new Error('plugin_request_limit'));
        const requestId = requestPrefix + '_' + String(++sequence);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('plugin_request_timeout')); }, ${PLUGIN_REQUEST_TIMEOUT_MS});
          pending.set(requestId, {resolve, reject, timer}); send({requestId,...payload});
        });
    }
    addEventListener('message', event => {
      if (event.source !== parent || event.data?.channel !== ${JSON.stringify(PLUGIN_MESSAGE_CHANNEL)} || event.data?.lease !== ${JSON.stringify(lease)}) return;
      if (event.data.requestId) {
        const request = pending.get(event.data.requestId); if (!request) return;
        pending.delete(event.data.requestId); clearTimeout(request.timer);
        if (event.data.error) request.reject(Object.assign(new Error(event.data.error), {code:event.data.code})); else request.resolve(event.data.result);
        return;
      }
      state = event.data.state; for (const listener of listeners) listener(state);
    });
    addEventListener('pagehide', () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('plugin_instance_revoked')); } pending.clear(); });
    new ResizeObserver(() => send({height:document.getElementById('root').scrollHeight})).observe(document.getElementById('root'));
  })();`
  const scripts = [runtime, entry]
    .filter((path): path is string => Boolean(path))
    .map((path) => `<script src="/${path.split('/').map(encodeURIComponent).join('/')}"></script>`)
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script>${bootstrap}</script>${scripts}</body></html>`
}
export function createPluginHost(): {
  open: (
    owner: WebContents,
    snapshot: PluginSnapshot,
    preview: boolean,
    current?: () => boolean,
    reference?: PluginReference
  ) => Promise<PluginMount>
  reference: (owner: WebContents, lease: string) => PluginReference | undefined
  close: (name?: string) => void
  release: (owner: WebContents, leases: string[]) => void
  valid: (owner: WebContents, lease: string) => boolean
  validate: (
    owner: WebContents,
    lease: string,
    verify: (reference: PluginReference) => Promise<Response>
  ) => Promise<number>
} {
  const instances = new Map<string, ComponentInstance>()
  const observed = new Set<number>()
  const revoke = (lease: string): void => {
    const instance = instances.get(lease)
    instances.delete(lease)
    if (instance && !instance.owner.isDestroyed())
      instance.owner.send(PLUGIN_REVOKED_CHANNEL, lease)
  }
  session.defaultSession.protocol.handle(PLUGIN_SCHEME, (request) => {
    const url = new URL(request.url)
    const instance = instances.get(url.hostname)
    if (!instance || instance.owner.isDestroyed() || request.method !== 'GET')
      return new Response(null, { status: 404 })
    let path: string
    try {
      path = decodeURIComponent(url.pathname.slice(1))
    } catch {
      return new Response(null, { status: 404 })
    }
    const origin = `${PLUGIN_SCHEME}://${url.hostname}`
    const policy = `default-src 'none'; sandbox allow-scripts; script-src ${origin} 'unsafe-inline'; style-src ${origin} 'unsafe-inline'; img-src ${origin} data:; font-src ${origin}; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'`
    const headers = {
      'Content-Security-Policy': policy,
      'Connection-Allowlist': PLUGIN_CONNECTION_POLICY,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Access-Control-Allow-Origin': 'null',
    }
    const runtime = instance.snapshot.ui
      ? `${PLUGIN_UI_RESOURCE_PREFIX}${instance.snapshot.ui.runtime}`
      : undefined
    if (path === PLUGIN_CONTAINER)
      return new Response(container(instance.entry, url.hostname, runtime), {
        headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
      })
    const encoded = resource(instance.snapshot, path)
    if (!encoded) return new Response(null, { status: 404 })
    return new Response(Buffer.from(encoded, 'base64'), {
      headers: {
        ...headers,
        'Content-Type':
          PLUGIN_MIME_TYPES[path.split('.').pop() || ''] || 'application/octet-stream',
      },
    })
  })
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const fromPlugin =
      pluginFrame(details.frame) || details.referrer.startsWith(`${PLUGIN_SCHEME}:`)
    if (!details.url.startsWith(`${PLUGIN_SCHEME}:`)) {
      callback({ cancel: fromPlugin })
      return
    }
    const target = new URL(details.url).hostname
    const instance = instances.get(target)
    const source = details.frame?.url.startsWith(`${PLUGIN_SCHEME}:`)
      ? details.frame.url
      : details.referrer
    const sameInstance =
      source.startsWith(`${PLUGIN_SCHEME}:`) && new URL(source).hostname === target
    callback({
      cancel:
        !instance ||
        instance.owner.isDestroyed() ||
        instance.owner.id !== details.webContentsId ||
        (fromPlugin ? !sameInstance : details.resourceType !== 'subFrame'),
    })
  })
  return {
    reference(owner, lease) {
      const instance = instances.get(lease)
      return instance?.owner === owner ? instance.reference : undefined
    },
    valid(owner, lease) {
      return instances.get(lease)?.owner === owner && !owner.isDestroyed()
    },
    async validate(owner, lease, verify) {
      const instance = instances.get(lease)
      if (instance?.owner !== owner || owner.isDestroyed()) return 410
      if (!instance.reference) return 200
      const response = await verify(instance.reference)
      await response.arrayBuffer()
      return instances.get(lease) === instance && !owner.isDestroyed() ? response.status : 410
    },
    release(owner, leases) {
      for (const lease of leases) if (instances.get(lease)?.owner === owner) revoke(lease)
    },
    async open(owner, snapshot, preview, current = () => true, reference) {
      if (!current() || owner.isDestroyed()) throw new Error('plugin_instance_revoked')
      const fixed = structuredClone(snapshot)
      const components = fixed.descriptor.components.filter(
        (component) =>
          (!component.public || component.entry) &&
          (!reference || component.id === reference.component)
      )
      if (fixed.ui && !resource(fixed, `${PLUGIN_UI_RESOURCE_PREFIX}${fixed.ui.runtime}`))
        throw new Error('plugin_ui_runtime_missing')
      if (components.some((component) => !component.entry || !resource(fixed, component.entry)))
        throw new Error('plugin_entry_missing')
      if (instances.size + components.length > PLUGIN_MAX_FRAMES)
        throw new Error('plugin_instance_limit')
      if (!observed.has(owner.id)) {
        observed.add(owner.id)
        const ownerId = owner.id
        owner.on('will-frame-navigate', (event) => {
          if (pluginFrame(event.frame)) event.preventDefault()
        })
        owner.once('destroyed', () => {
          observed.delete(ownerId)
          for (const [lease, instance] of instances)
            if (instance.owner.id === ownerId) instances.delete(lease)
        })
      }
      const frames: PluginMount['frames'] = {}
      for (const component of components) {
        const lease = randomUUID()
        instances.set(lease, {
          owner,
          snapshot: fixed,
          entry: component.entry!,
          reference: reference ? structuredClone(reference) : undefined,
        })
        frames[component.id] = { lease, url: `${PLUGIN_SCHEME}://${lease}/${PLUGIN_CONTAINER}` }
      }
      return {
        descriptor: snapshot.descriptor,
        fingerprint: snapshot.fingerprint,
        scenarios: preview ? snapshot.scenarios : {},
        frames,
        interaction: snapshot.interaction,
        ...(fixed.ui
          ? {
              ui: {
                fingerprint: fixed.ui.fingerprint,
                version: fixed.ui.version,
                compatibility: fixed.ui.compatibility,
              },
            }
          : {}),
      }
    },
    close(name) {
      for (const [lease, instance] of instances)
        if (!name || instance.snapshot.descriptor.id === name) revoke(lease)
    },
  }
}
