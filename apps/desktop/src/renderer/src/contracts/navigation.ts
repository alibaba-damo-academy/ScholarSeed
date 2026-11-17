import { createContext } from 'react'

export const NavigationRecoveryContext = createContext<(() => void) | null>(null)

export const WebNavigationContext = createContext<(url: string, onOpened?: () => void) => void>(
  () => {
    throw new Error('web_navigation_unavailable')
  }
)
