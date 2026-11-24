import { useCallback, useState } from 'react'

import { projectTreeReadSignal, type ProjectTreePage } from './api.ts'

export interface DirectoryRefresh {
  include(
    read: (signal: AbortSignal) => Promise<ProjectTreePage | null>,
    cancellation: AbortSignal
  ): Promise<{ page: ProjectTreePage | null; failed: boolean }> | undefined
}

export function createDirectoryRefresh(): DirectoryRefresh {
  let enrollment: Array<
    Promise<{ page: ProjectTreePage | null; cancellation: AbortSignal }>
  > | null = []
  let deadline: AbortSignal | undefined
  let complete: Promise<boolean> | undefined
  return {
    include(read, cancellation) {
      const reads = enrollment
      if (!reads) return
      deadline ??= projectTreeReadSignal()
      const result = read(projectTreeReadSignal(cancellation, deadline)).catch(() => null)
      reads.push(result.then((page) => ({ page, cancellation })))
      // All mounted directories register in the same commit before a new tree can be shown.
      complete ??= Promise.resolve().then(async () => {
        enrollment = null
        const results = await Promise.all(reads)
        return results.every(({ page, cancellation }) => page !== null || cancellation.aborted)
      })
      return Promise.all([result, complete]).then(([page, ready]) => ({
        page: ready && !cancellation.aborted ? page : null,
        failed: page === null && !cancellation.aborted,
      }))
    },
  }
}

export function useDirectoryRefresh(): [DirectoryRefresh, () => void] {
  const [refresh, setRefresh] = useState(createDirectoryRefresh)
  const restart = useCallback(() => setRefresh(createDirectoryRefresh()), [])
  return [refresh, restart]
}
