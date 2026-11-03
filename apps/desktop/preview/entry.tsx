import { installPreviewBridge, PREVIEW_DIAGNOSTIC_EVENT } from './bridge.ts'
import { PREVIEW_CATALOG } from './catalog.ts'
import { PREVIEW_TOOLBAR_ACTIONS_ID } from './constants.ts'
import zh from './locales/zh.json'
import en from './locales/en.json'

const ALLOWED_NAVIGATION_PROTOCOLS = new Set(['http:', 'https:'])

export function protectPreviewNavigation(): void {
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (!(target instanceof HTMLAnchorElement)) return
    const url = new URL(target.href, window.location.href)
    if (!target.hasAttribute('download') && ALLOWED_NAVIGATION_PROTOCOLS.has(url.protocol) && url.origin === window.location.origin) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const detail = { kind: 'navigation-blocked', protocol: url.protocol, origin: url.origin }
    console.warn('[preview-navigation]', detail)
    window.dispatchEvent(new CustomEvent(PREVIEW_DIAGNOSTIC_EVENT, { detail }))
  }, true)
}

async function startPreview(): Promise<void> {
  if (!window.pdfe) throw new Error((navigator.language.startsWith('zh') ? zh : en).nativeRequired)
  protectPreviewNavigation()
  const query = new URLSearchParams(window.location.search)
  const pageId = query.get('page') ?? PREVIEW_CATALOG.find(page => page.id === query.get('scene') || page.scenarios.some(scene => scene.id === query.get('scene')))?.id ?? PREVIEW_CATALOG[0].id
  await installPreviewBridge()
  if (window.pdfe?.kind === 'product') {
    const actions = document.createElement('div')
    actions.id = PREVIEW_TOOLBAR_ACTIONS_ID
    actions.className = 'empty:hidden'
    if (PREVIEW_CATALOG.find(page => page.id === pageId)?.host?.kind === 'panel') {
      document.body.classList.add('flex', 'flex-col', 'overflow-hidden')
      document.getElementById('root')?.classList.add('min-h-0', 'flex-1', '!h-auto', '[--vds-app-shell-viewport-height:100%]')
      actions.className = 'order-first flex shrink-0 items-center justify-end gap-[var(--vds-space-2)] p-[var(--vds-space-4)] [-webkit-app-region:no-drag] empty:hidden'
    }
    document.body.append(actions)
    const { mountPreviewHost } = await import('./host')
    mountPreviewHost(pageId)
    return
  }
  const { mountConsole } = await import('./Console')
  mountConsole()
}

void startPreview().catch((error: unknown) => {
  console.error('[preview-startup]', error)
  const message = document.createElement('p')
  message.setAttribute('role', 'alert')
  message.textContent = (navigator.language.startsWith('zh') ? zh : en).startupFailed
  const diagnostic = document.createElement('pre')
  diagnostic.textContent = error instanceof Error ? error.message : String(error)
  document.getElementById('root')?.replaceChildren(message, diagnostic)
})
