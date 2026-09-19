export interface OfficePalette {
  mode: 'dark' | 'light'
  background: string
  foreground: string
  appBackground: number
  calcGrid: number
}

const OFFICE_BACKGROUND_TOKEN = '--vds-bg-page'
const OFFICE_FOREGROUND_TOKEN = '--vds-text-primary'
const OFFICE_GRID_TOKEN = '--vds-border-default'

function token(style: CSSStyleDeclaration, name: string): string {
  const value = style.getPropertyValue(name).trim()
  if (!value) throw new Error(`Missing Office theme token: ${name}`)
  return value
}

export function officeColor(value: string): number {
  const normalized = value.trim()
  const hex = normalized.match(/^#([\da-f]{6})$/i)
  if (hex) return Number.parseInt(hex[1], 16)
  const rgb = normalized.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,[^)]*)?\)$/i)
  if (!rgb) throw new Error(`Unsupported Office theme color: ${value}`)
  const channels = rgb.slice(1, 4).map(Number)
  if (channels.some(channel => channel < 0 || channel > 255)) {
    throw new Error(`Unsupported Office theme color: ${value}`)
  }
  return (channels[0] << 16) | (channels[1] << 8) | channels[2]
}

export function officePalette(root: HTMLElement): OfficePalette {
  const style = getComputedStyle(root)
  const background = token(style, OFFICE_BACKGROUND_TOKEN)
  const foreground = token(style, OFFICE_FOREGROUND_TOKEN)
  const grid = token(style, OFFICE_GRID_TOKEN)
  return {
    mode: root.dataset.theme === 'dark' ? 'dark' : 'light',
    background,
    foreground,
    appBackground: officeColor(background),
    calcGrid: officeColor(grid)
  }
}
