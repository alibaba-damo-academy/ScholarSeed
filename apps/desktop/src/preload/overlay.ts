import { contextBridge, ipcRenderer } from 'electron'
import { OVERLAY_CHANNEL, TOOLTIP_OVERLAY_CHANNEL, TOOLTIP_OVERLAY_ARGUMENT } from '../overlay'
import type { BrowserOverlayModel, SuggestionsBridge } from '../overlay'

const channels = process.argv.includes(TOOLTIP_OVERLAY_ARGUMENT) ? TOOLTIP_OVERLAY_CHANNEL : OVERLAY_CHANNEL
const bridge: SuggestionsBridge = {
  subscribeFocus(callback) {
    const handler = (_event: unknown, revision: number) => callback(revision)
    ipcRenderer.on(channels.focusRequest, handler)
    return () => ipcRenderer.removeListener(channels.focusRequest, handler)
  },
  subscribe(callback) {
    const handler = (_event: unknown, model: BrowserOverlayModel) => callback(model)
    ipcRenderer.on(channels.model, handler)
    void ipcRenderer.invoke(channels.ready)
    return () => ipcRenderer.removeListener(channels.model, handler)
  },
  send: event => ipcRenderer.invoke(channels.event, event)
}

contextBridge.exposeInMainWorld('suggestions', bridge)
