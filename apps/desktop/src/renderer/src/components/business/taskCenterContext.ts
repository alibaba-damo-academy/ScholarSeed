import { createContext, useContext } from 'react'

import type { ProductTask } from '../../contracts/tasks'
import type { TaskSourceContribution } from '../../contracts/features'

// Keep context identity outside the Fast Refresh component boundary.
export interface TaskCenterValue {
  activeCount: number
  tasks: ProductTask[]
  sources: readonly TaskSourceContribution[]
  open: boolean
  setOpen: (open: boolean) => void
  clearCompleted: () => Promise<void>
  clearingCompleted: boolean
  cancel: (task: ProductTask) => Promise<void>
  retry: (task: ProductTask) => Promise<void>
  errorText: (task: ProductTask) => string
  failures: (task: ProductTask) => Array<{ name: string; reason: string }>
}

export const TaskCenterContext = createContext<TaskCenterValue | null>(null)

export function useTaskCenter(): TaskCenterValue {
  const value = useContext(TaskCenterContext)
  if (!value) throw new Error('TaskCenterProvider is missing')
  return value
}
