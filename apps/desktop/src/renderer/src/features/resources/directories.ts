import { useEffect, useMemo, useRef, useState } from 'react'
import type { FileEvent } from '../../contracts/content'
import { subscribeFileEvents, whenFileEventCursorLoaded } from '../project/events'
import {
  fetchResourceListingChanges,
  fetchResourceListingDirectory,
  resourceFileEventObservation,
  streamResourceListingSearch,
  type ResourceListingDirectory,
  type ResourceListingProjection,
} from './api'
import { refreshesResourceTree } from './lifecycle'
import {
  createResourceListingRefresh,
  listingDirectoryNodes,
  resourceListingDirectories,
  resourceListingDirectoryEventPaths,
  resourceListingEventPaths,
  type ResourceListingRefresh,
} from './refresh'
import type { ResourceNode } from './state'
import { createResourceListingSearch } from './stream'

interface ListingRead<Result> {
  snapshot: Result | null
  refreshing: boolean
  failed: boolean
}

interface ProjectListing {
  project: string
  directories: ReadonlyMap<string, ListingRead<ResourceListingDirectory>>
  global: ListingRead<ResourceNode[]>
}

interface DirectoryReader {
  refresh: ResourceListingRefresh
  directory?: string
}

const EMPTY_READ = { snapshot: null, refreshing: true, failed: false }
const EMPTY_DIRECTORIES = new Map<string, ListingRead<ResourceListingDirectory>>()

interface ListingController {
  syncDirectories(paths: readonly string[]): void
  setGlobalWanted(wanted: boolean): void
  refresh(directory?: string): void
}

export function useResourceListing(
  project: string | null,
  expanded: Record<string, boolean>,
  globalWanted: boolean,
  revision: number,
  listingRevision: number
) {
  const [listing, setListing] = useState<ProjectListing | null>(null)
  const controller = useRef<ListingController | null>(null)
  const current = listing?.project === project ? listing : null
  const directories = current?.directories ?? EMPTY_DIRECTORIES
  const visible = useMemo(
    () => resourceListingDirectories(directories, expanded),
    [directories, expanded]
  )

  useEffect(() => {
    if (!project) return
    let active = true
    setListing({ project, directories: EMPTY_DIRECTORIES, global: EMPTY_READ })
    const readers = new Map<string, DirectoryReader>()
    const events = new Set<FileEvent>()
    let observations = Promise.resolve()
    const waitForObservations = async (): Promise<void> => {
      // A simultaneous directory read must wait for the same version observation.
      const pending = Array.from(events, resourceFileEventObservation)
      events.clear()
      observations = Promise.all([observations, ...pending]).then(() => undefined)
      await observations
    }

    const update = (apply: (value: ProjectListing) => ProjectListing): void => {
      if (active) setListing((value) => (value?.project === project ? apply(value) : value))
    }
    const updateDirectory = (
      path: string,
      apply: (value: ListingRead<ResourceListingDirectory>) => ListingRead<ResourceListingDirectory>
    ): void =>
      update((value) => ({
        ...value,
        directories: new Map(value.directories).set(
          path,
          apply(value.directories.get(path) ?? EMPTY_READ)
        ),
      }))
    let globalEnabled = false
    const globalRead = createResourceListingSearch<ResourceNode, ResourceListingProjection>(
      async (signal, onBatch) => {
        await waitForObservations()
        if (signal.aborted) return null
        return streamResourceListingSearch(project, signal, onBatch)
      },
      async (snapshot, paths) => {
        await waitForObservations()
        return fetchResourceListingChanges(project, snapshot, paths)
      },
      (snapshot, refreshing, failed) =>
        update((value) => ({ ...value, global: { snapshot, refreshing, failed } })),
      (callback) => requestAnimationFrame(callback)
    )

    const startDirectory = (path: string): DirectoryReader => {
      const refresh = createResourceListingRefresh(
        async () => {
          await waitForObservations()
          return fetchResourceListingDirectory(project, path, false)
        },
        (result, refreshing, invalidated) => {
          if (result) directoryReader.directory = result.directory
          if (invalidated) directoryReader.directory = undefined
          updateDirectory(path, (old) => ({
            snapshot: invalidated ? null : (result ?? old.snapshot),
            refreshing,
            failed: result === null,
          }))
        },
        async (snapshot, paths) => {
          await waitForObservations()
          return fetchResourceListingChanges(project, snapshot, paths)
        },
        {
          deltaWhileIdle: true,
          hydrate: async (snapshot) => {
            if (snapshot.versionsLoaded || !snapshot.items.length) return snapshot
            return fetchResourceListingDirectory(project, path, true)
          },
        }
      )
      const directoryReader: DirectoryReader = { refresh }
      readers.set(path, directoryReader)
      return directoryReader
    }
    const schedule = (path: string, reader: DirectoryReader, paths?: readonly string[]): void => {
      updateDirectory(path, (old) => ({ ...old, refreshing: true, failed: false }))
      reader.refresh.request(paths)
    }

    let epoch = ''
    const unsubscribe = subscribeFileEvents(project, (event) => {
      if (event.project_id !== project) return
      const continuous =
        typeof event.epoch === 'string' && !!event.epoch && (!epoch || epoch === event.epoch)
      epoch = event.epoch
      const resourceEvent = refreshesResourceTree(event)
      if (continuous && !resourceEvent && event.kind !== 'moved') return
      const paths = continuous && resourceEvent ? resourceListingEventPaths(event) : undefined
      let observed = globalEnabled
      for (const [path, reader] of readers) {
        let affected = resourceListingDirectoryEventPaths(reader.directory, paths)
        if (
          affected?.length === 0 &&
          path &&
          reader.directory !== path &&
          resourceListingDirectoryEventPaths(path, paths)?.length !== 0
        )
          affected = undefined
        if (affected?.length === 0) continue
        observed = true
        schedule(path, reader, affected)
      }
      if (observed) events.add(event)
      globalRead.invalidate(paths)
    })
    const cursorLoaded = whenFileEventCursorLoaded(project)
    const queueDirectory = (path: string, reader: DirectoryReader): void => {
      void cursorLoaded.then(() => {
        if (readers.get(path) === reader) schedule(path, reader)
      })
    }
    controller.current = {
      syncDirectories(paths): void {
        const visible = new Set(paths)
        for (const [path, reader] of readers) {
          if (visible.has(path)) continue
          reader.refresh.dispose()
          readers.delete(path)
          update((value) => {
            const active = new Map(value.directories)
            active.delete(path)
            return { ...value, directories: active }
          })
        }
        for (const path of paths) {
          if (!readers.has(path)) queueDirectory(path, startDirectory(path))
        }
      },
      setGlobalWanted(wanted): void {
        globalEnabled = wanted
        if (wanted) void cursorLoaded.then(() => globalRead.setWanted(globalEnabled))
        else globalRead.setWanted(false)
      },
      refresh(directory): void {
        for (const [path, reader] of readers) {
          if (directory === undefined || directory === path) queueDirectory(path, reader)
        }
        if (directory === undefined) globalRead.invalidate()
      },
    }
    return () => {
      active = false
      unsubscribe()
      for (const reader of readers.values()) reader.refresh.dispose()
      readers.clear()
      globalRead.dispose()
      globalEnabled = false
      controller.current = null
    }
  }, [project])
  useEffect(() => controller.current?.syncDirectories(visible), [project, visible])
  useEffect(() => controller.current?.setGlobalWanted(globalWanted), [project, globalWanted])
  useEffect(() => controller.current?.refresh(), [project, revision, listingRevision])

  const nodes = useMemo(() => listingDirectoryNodes(directories, visible), [directories, visible])
  return {
    nodes,
    directories,
    global: current?.global ?? EMPTY_READ,
    refresh: (directory?: string): void => controller.current?.refresh(directory),
  }
}
