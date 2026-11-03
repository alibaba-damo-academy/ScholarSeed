import { AUTH_CHANNEL, AUTH_ERROR, authLogoutRequest } from '../authentication.ts'
import type { AuthenticationOwner } from './authentication.ts'

interface Frame { readonly url: string }
interface ProductWebContents { readonly mainFrame: Frame; readonly session: object; isDestroyed(): boolean }
interface Sender { sender: unknown; senderFrame?: Frame | null }
interface ProductRenderer { readonly webContents: ProductWebContents; readonly origin: string; readonly navigationEpoch: number }
interface AuthenticationIpc { handle(channel: string, handler: (event: Sender, ...args: unknown[]) => Promise<unknown>): void }
const LEGACY_AUTH_CHANNEL = Object.freeze({ set: 'veda:auth-token-set', get: 'veda:auth-token-get' })

function senderLease(event: Sender, renderer: () => ProductRenderer | null): (() => boolean) | null {
  const captured = renderer()
  if (!captured || !event.senderFrame || event.sender !== captured.webContents
    || event.senderFrame !== captured.webContents.mainFrame || captured.webContents.isDestroyed()) return null
  const session = captured.webContents.session
  const frame = event.senderFrame
  const current = (): boolean => {
    const next = renderer()
    if (!next || next.webContents !== captured.webContents || next.webContents.isDestroyed()
      || next.webContents.session !== session || next.webContents.mainFrame !== frame
      || next.navigationEpoch !== captured.navigationEpoch || next.origin !== captured.origin) return false
    try { return new URL(frame.url).origin === captured.origin } catch { return false }
  }
  return current() ? current : null
}

export function registerAuthenticationIpc(ipc: AuthenticationIpc, owner: AuthenticationOwner, renderer: () => ProductRenderer | null): void {
  ipc.handle(AUTH_CHANNEL.capture, async (event, ...args) => {
    const current = senderLease(event, renderer)
    if (!current) return { ok: false, code: AUTH_ERROR.sender }
    if (args.length) return { ok: false, code: AUTH_ERROR.request }
    return owner.capture(current)
  })
  ipc.handle(AUTH_CHANNEL.logout, async (event, ...args) => {
    const current = senderLease(event, renderer)
    if (!current) return { ok: false, code: AUTH_ERROR.sender }
    if (args.length !== 1 || !authLogoutRequest(args[0])) return { ok: false, code: AUTH_ERROR.request }
    return owner.logout(args[0], current)
  })
  ipc.handle(LEGACY_AUTH_CHANNEL.get, async (event, ...args) => {
    const current = senderLease(event, renderer)
    return current && !args.length ? owner.token(current) : ''
  })
  ipc.handle(LEGACY_AUTH_CHANNEL.set, async (event, ...args) => {
    const current = senderLease(event, renderer)
    if (!current) return { ok: false, code: AUTH_ERROR.sender }
    if (args.length < 1 || args.length > 2 || typeof args[0] !== 'string' || !args[0]
      || (args[1] !== undefined && typeof args[1] !== 'string')) return { ok: false, code: AUTH_ERROR.request }
    const intent = await owner.intent(current)
    if ('ok' in intent) return intent
    return owner.replace(args[0], (args[1] as string | undefined) ?? '', intent)
  })
}
