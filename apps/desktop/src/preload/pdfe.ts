import { contextBridge, ipcRenderer } from 'electron'
import { PDFE_CHANNEL, type PdfeNativeBridge } from '../pdfe'
import {
  OFFICE_FONT_CATALOG_CHANNEL,
  OFFICE_FONT_READ_CHANNEL,
  OFFICE_FONT_CACHE_READ_CHANNEL,
  OFFICE_FONT_CACHE_WRITE_CHANNEL,
} from '../fonts'
import { WINDOW_FULLSCREEN_CHANNEL } from '../window'

if (process.isMainFrame) {
  const boot = ipcRenderer.sendSync(PDFE_CHANNEL.boot) as Pick<
    PdfeNativeBridge,
    'kind' | 'platform' | 'systemVersion' | 'version' | 'fullscreen' | 'dock'
  >
  if (!boot || (boot.kind !== 'product' && boot.kind !== 'controls'))
    throw new Error('PDFE native bootstrap denied')
  const bridge: PdfeNativeBridge = {
    ...boot,
    openScenario: (target) => ipcRenderer.invoke(PDFE_CHANNEL.open, target),
    reload: () => ipcRenderer.invoke(PDFE_CHANNEL.reload),
    hideControls: () => ipcRenderer.invoke(PDFE_CHANNEL.hide),
    setDock: (mode) => ipcRenderer.invoke(PDFE_CHANNEL.dock, mode),
    resizeControls: (width) => ipcRenderer.invoke(PDFE_CHANNEL.resize, width),
    onDockChange: (callback) => {
      const receive = (_event: unknown, mode: PdfeNativeBridge['dock']): void => callback(mode)
      ipcRenderer.on(PDFE_CHANNEL.dockChanged, receive)
      return () => ipcRenderer.removeListener(PDFE_CHANNEL.dockChanged, receive)
    },
    onFullscreenChange: (callback) => {
      const receive = (_event: unknown, value: boolean): void => callback(value)
      ipcRenderer.on(WINDOW_FULLSCREEN_CHANNEL, receive)
      return () => ipcRenderer.removeListener(WINDOW_FULLSCREEN_CHANNEL, receive)
    },
    requestOfficeFontAccess: async () => {
      await ipcRenderer.invoke(OFFICE_FONT_CATALOG_CHANNEL)
      return true
    },
    listOfficeFonts: () => ipcRenderer.invoke(OFFICE_FONT_CATALOG_CHANNEL),
    readOfficeFont: (id) => ipcRenderer.invoke(OFFICE_FONT_READ_CHANNEL, id),
    readOfficeFontCache: (fingerprint) =>
      ipcRenderer.invoke(OFFICE_FONT_CACHE_READ_CHANNEL, fingerprint),
    writeOfficeFontCache: (fingerprint, cache) =>
      ipcRenderer.invoke(OFFICE_FONT_CACHE_WRITE_CHANNEL, fingerprint, cache),
  }
  contextBridge.exposeInMainWorld('pdfe', bridge)
}
