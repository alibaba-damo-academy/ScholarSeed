import { createContext } from 'react'

export const NavigationRecoveryContext = createContext<(() => void) | null>(null)
