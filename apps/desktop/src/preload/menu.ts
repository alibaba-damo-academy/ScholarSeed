import { contextBridge, ipcRenderer } from 'electron'
import { MENU_CHANNEL } from '../menu'
import type { MenuModel, MenuViewBridge } from '../menu'

const bridge: MenuViewBridge = {
  subscribeFind(callback) {
    const handler = (_event: unknown, state: Parameters<typeof callback>[0]) => callback(state)
    ipcRenderer.on(MENU_CHANNEL.findState, handler)
    return () => ipcRenderer.removeListener(MENU_CHANNEL.findState, handler)
  },
  subscribeRefocus(callback) {
    const handler = (_event: unknown, ack: Parameters<typeof callback>[0]) => callback(ack)
    ipcRenderer.on(MENU_CHANNEL.refocus, handler)
    return () => ipcRenderer.removeListener(MENU_CHANNEL.refocus, handler)
  },
  seed: () => ipcRenderer.invoke(MENU_CHANNEL.seed),
  subscribe(callback) {
    const handler = (_event: unknown, model: MenuModel) => callback(model)
    ipcRenderer.on(MENU_CHANNEL.model, handler)
    return () => ipcRenderer.removeListener(MENU_CHANNEL.model, handler)
  },
  send: event => ipcRenderer.invoke(MENU_CHANNEL.event, event),
  paintReady: ack => ipcRenderer.invoke(MENU_CHANNEL.paintReady, ack)
}
contextBridge.exposeInMainWorld('menu', bridge)
