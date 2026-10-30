import { createContext, useContext } from 'react'

export const StorageFixtureContext = createContext<{
  state: { storageFirstLaunchSeen: boolean }
  set: (value: { storageFirstLaunchSeen: boolean }) => void
} | null>(null)

export function useStorageFixtureApp() {
  const value = useContext(StorageFixtureContext)
  if (!value) throw new Error('Missing storage fixture')
  return value
}
