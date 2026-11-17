export const CANVAS_SLOT = 'canvas.ui'
export const CANVAS_REVISION = 'host-canvas-v1'
export const CANVAS_VERSION = 1
export const CANVAS_CHANNEL = 'scholarseed:canvas'
export const CANVAS_HANDLER_TIMEOUT_MS = 60000
export const CANVAS_ACTIONS = ['rollback', 'cancel', 'submit'] as const
export type CanvasAction = typeof CANVAS_ACTIONS[number]
export type CanvasValues = Record<string, unknown>
export interface CanvasDocument {
  format: 'openui-lang' | 'html'
  version: typeof CANVAS_VERSION
  source: string
  initial_state?: CanvasValues
  interaction?: { actions: CanvasAction[]; output_schema?: Record<string, unknown> } | null
}

export function canvasValues(value: unknown, bindings?: Record<string, string>): unknown {
  if (Array.isArray(value)) return value.map(item => canvasValues(item))
  if (!value || typeof value !== 'object') return value
  const object = value as CanvasValues
  if (Object.hasOwn(object, 'value'))
    return canvasValues(object.value)
  return Object.fromEntries([
    ...Object.entries(object).filter(([key]) => !bindings || !key.startsWith('$')).map(([key, item]) => [key, canvasValues(item)]),
    ...Object.entries(bindings ?? {}).filter(([, target]) => Object.hasOwn(object, target)).map(([name, target]) => [name, canvasValues(object[target])]),
  ])
}

export function canvasInteractive(document: CanvasDocument): boolean {
  return Boolean(document.interaction?.actions.some(action => action === 'submit' || action === 'cancel'))
}

export function canvasHtml(source: string, identity: string, nonce = ''): string {
  if (nonce) {
    const document = new DOMParser().parseFromString(source, 'text/html')
    for (const script of document.querySelectorAll('script')) script.setAttribute('nonce', nonce)
    source = document.documentElement.outerHTML
  }
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'"><script${nonce ? ` nonce="${nonce}"` : ''}>
(() => {
  const channel = ${JSON.stringify(CANVAS_CHANNEL)};
  const identity = ${JSON.stringify(identity)};
  let handlers = {};
  let state = {};
  const send = message => parent.postMessage({channel, identity, ...message}, '*');
  window.canvas = Object.freeze({
    register(next) { handlers = next; },
    getState() { return state; },
    save(values) { state = values; send({event:'draft', values}); }
  });
  addEventListener('message', async event => {
    if (event.source !== parent || event.data?.channel !== channel || event.data.identity !== identity) return;
    const message = event.data;
    if (message.event === 'restore') {
      state = message.values;
      try { await handlers.onRestore?.(state); }
      catch (error) { send({event:'error', error:String(error)}); }
      return;
    }
    if (message.event !== 'action') return;
    try {
      const handler = handlers[message.handler];
      if (typeof handler !== 'function') throw new Error('canvas_handler_missing:' + message.handler);
      const values = await handler();
      if (message.handler === 'onRollback' && values && typeof values === 'object' && !Array.isArray(values)) state = values;
      send({event:'result', request:message.request, values:values ?? {}});
    } catch (error) { send({event:'result', request:message.request, error:String(error)}); }
  });
  addEventListener('load', () => send({event:'ready'}), {once:true});
})();
</script>${source}`
}
