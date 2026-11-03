import { dialog, shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import { DELIVERY_PICK_CHANNEL, DELIVERY_OPEN_CHANNEL, DELIVERY_SAVE_CHANNEL, DELIVERY_NATIVE_UNAVAILABLE, DELIVERY_INVALID_SENDER,
  deliveryPath, parseDeliveryRequest, parseDeliverySave, type DeliveryNativeReply } from '../delivery.ts'

interface DeliveryOwners {
  window(): BrowserWindow | null
  base(): string | null
  headers(): Record<string, string>
  sender(event: IpcMainInvokeEvent): boolean
  title(): string
}

const HTTP_ERROR_PREFIX = 'http_'
const DIRECTORY_ACTION = 'directory'
const OPEN_ACTION = 'open'
const SAVE_ACTION = 'save'

export function registerDeliveryIpc(ipc: Pick<IpcMain, 'handle'>, owners: DeliveryOwners): void {
  ipc.handle(DELIVERY_SAVE_CHANNEL, async (event, value: unknown): Promise<DeliveryNativeReply> => {
    if (!owners.sender(event)) return { ok: false, error: DELIVERY_INVALID_SENDER }
    const window = owners.window()
    const base = owners.base()
    if (!window || !base) return { ok: false, error: DELIVERY_NATIVE_UNAVAILABLE }
    try {
      const request = parseDeliverySave(value)
      const response = await window.webContents.session.fetch(`${base}${deliveryPath(request, SAVE_ACTION)}`, {
        method: 'POST', credentials: 'include', redirect: 'error',
        headers: { ...owners.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify(request.choice)
      })
      const payload = await response.json() as { detail?: string }
      if (!response.ok) return { ok: false, error: payload.detail ?? `${HTTP_ERROR_PREFIX}${response.status}` }
      return { ok: true, value: payload }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : DELIVERY_NATIVE_UNAVAILABLE } }
  })
  ipc.handle(DELIVERY_PICK_CHANNEL, async (event, value: unknown): Promise<DeliveryNativeReply> => {
    if (!owners.sender(event)) return { ok: false, error: DELIVERY_INVALID_SENDER }
    const window = owners.window()
    const base = owners.base()
    if (!window || !base) return { ok: false, error: DELIVERY_NATIVE_UNAVAILABLE }
    try {
      const request = parseDeliveryRequest(value)
      const selected = await dialog.showOpenDialog(window, {
        title: owners.title(), properties: ['openDirectory', 'createDirectory']
      })
      if (selected.canceled || !selected.filePaths.length) return { ok: false, canceled: true }
      if (!owners.sender(event) || window.isDestroyed() || owners.base() !== base)
        return { ok: false, error: DELIVERY_NATIVE_UNAVAILABLE }
      const response = await window.webContents.session.fetch(`${base}${deliveryPath(request, DIRECTORY_ACTION)}`, {
        method: 'POST', credentials: 'include', redirect: 'error',
        headers: { ...owners.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ absolute: selected.filePaths[0] })
      })
      const payload = await response.json() as { ticket?: string; label?: string; detail?: string }
      if (!response.ok || !payload.ticket || !payload.label)
        return { ok: false, error: payload.detail ?? `${HTTP_ERROR_PREFIX}${response.status}` }
      return { ok: true, ticket: payload.ticket, label: payload.label }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : DELIVERY_NATIVE_UNAVAILABLE } }
  })
  ipc.handle(DELIVERY_OPEN_CHANNEL, async (event, value: unknown): Promise<DeliveryNativeReply> => {
    if (!owners.sender(event)) return { ok: false, error: DELIVERY_INVALID_SENDER }
    const window = owners.window()
    const base = owners.base()
    if (!window || !base) return { ok: false, error: DELIVERY_NATIVE_UNAVAILABLE }
    try {
      const request = parseDeliveryRequest(value)
      const response = await window.webContents.session.fetch(`${base}${deliveryPath(request, OPEN_ACTION)}`, {
        method: 'POST', credentials: 'include', redirect: 'error', headers: owners.headers()
      })
      const payload = await response.json() as { absolute?: string; detail?: string }
      if (!response.ok || !payload.absolute)
        return { ok: false, error: payload.detail ?? `${HTTP_ERROR_PREFIX}${response.status}` }
      if (!owners.sender(event) || owners.base() !== base) return { ok: false, error: DELIVERY_NATIVE_UNAVAILABLE }
      const error = await shell.openPath(payload.absolute)
      return error ? { ok: false, error } : { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : DELIVERY_NATIVE_UNAVAILABLE } }
  })
}
