import { useEffect } from 'react'
import { Theme } from './model'

/** resolve + apply a theme to <html data-theme>; returns the effective theme */
export function applyTheme(theme: Theme): 'dark' | 'light' {
  const eff: 'dark' | 'light' =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme
  document.documentElement.dataset.theme = eff
  return eff
}

/** apply on change + re-apply when the OS theme flips (only matters for 'system') */
export function useThemeEffect(theme: Theme): void {
  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => {
      applyTheme('system')
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])
}
