import { createContext, useContext } from 'react'

import type { ProductTask } from '../../contracts/tasks'

// Keep context identity outside the Fast Refresh component boundary.
export interface TaskCenterValue {
  activeCount: number
  tasks: ProductTask[]
  open: boolean
  setOpen: (open: boolean) => void
  cancel: (task: ProductTask) => Promise<void>
  retry: (task: ProductTask) => Promise<void>
  errorText: (task: ProductTask) => string
}

export const TaskCenterContext = createContext<TaskCenterValue | null>(null)


export function useTaskCenter(): TaskCenterValue {
  const value = useContext(TaskCenterContext)
  if (!value) throw new Error('TaskCenterProvider is missing')
  return value
}
