import { Menu, type MenuItemConstructorOptions } from 'electron'

const MACOS_PLATFORM = 'darwin'

export function applicationMenuTemplate(
  platform: NodeJS.Platform = process.platform,
  development = false
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = []
  if (platform === MACOS_PLATFORM) template.push({ role: 'appMenu' })
  template.push({ role: 'editMenu' }, { role: 'windowMenu' })
  if (development) template.push({ role: 'help', submenu: [{ role: 'toggleDevTools' }] })
  return template
}

export function installApplicationMenu(development = false): void {
  const template = applicationMenuTemplate(process.platform, development)
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
