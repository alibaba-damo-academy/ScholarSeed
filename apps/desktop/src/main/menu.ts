import { Menu, type MenuItemConstructorOptions } from 'electron'

const MACOS_PLATFORM = 'darwin'

export function applicationMenuTemplate(
  platform: NodeJS.Platform = process.platform
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = []
  if (platform === MACOS_PLATFORM) template.push({ role: 'appMenu' })
  template.push({ role: 'editMenu' }, { role: 'windowMenu' })
  return template
}

export function installApplicationMenu(): void {
  const template = applicationMenuTemplate()
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
