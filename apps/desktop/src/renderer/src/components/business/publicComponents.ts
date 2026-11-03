import { createContext } from 'react'
import type { PublicComponentContribution } from '../../contracts/components'
export const PublicComponentsContext = createContext<ReadonlyMap<string, PublicComponentContribution>>(new Map())
