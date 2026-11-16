import { useEffect, useMemo, useSyncExternalStore } from 'react'

import { SKILL_SURFACE_SETTINGS } from '../../../../skills'
import { getSkills, type SkillInfo } from '../../api'
import { skillName } from '../../skill'
import { useAccountAccess } from './access'

enum CatalogStatus {
  Loading = 'loading',
  Ready = 'ready',
  Failed = 'failed',
}
type SkillNameMetadata = Pick<SkillInfo, 'name' | 'display_name' | 'display_names'>
type CatalogKey = { identity: number; revision: number; language: string }
type CatalogSnapshot = {
  key: CatalogKey
  skills: readonly SkillNameMetadata[]
  status: CatalogStatus
}

export interface SkillNames {
  names: ReadonlyMap<string, string>
  pending: boolean
}

const EMPTY_METADATA: readonly SkillNameMetadata[] = []
const listeners = new Set<() => void>()
let snapshot: CatalogSnapshot | null = null
let activeRequest: CatalogKey | null = null

const getSnapshot = (): CatalogSnapshot | null => snapshot
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const publish = (next: CatalogSnapshot): void => {
  snapshot = next
  for (const listener of listeners) listener()
}
const sameKey = (current: CatalogKey | undefined, next: CatalogKey): boolean =>
  current?.identity === next.identity &&
  current.revision === next.revision &&
  current.language === next.language

const refresh = (key: CatalogKey): void => {
  if (sameKey(snapshot?.key, key) && snapshot?.status !== CatalogStatus.Failed) return
  const skills = snapshot?.key.identity === key.identity ? snapshot.skills : EMPTY_METADATA
  activeRequest = key
  publish({ key, skills, status: CatalogStatus.Loading })
  void getSkills(SKILL_SURFACE_SETTINGS, key.language)
    .then((catalog) => {
      if (activeRequest !== key) return
      publish({
        key,
        skills: catalog.map(({ name, display_name, display_names }) => ({
          name,
          display_name,
          display_names,
        })),
        status: CatalogStatus.Ready,
      })
    })
    .catch((error) => {
      if (activeRequest !== key) return
      console.warn('[skills] sent reference names unavailable', error)
      publish({ key, skills, status: CatalogStatus.Failed })
    })
}

export function useSkillNames(ready: boolean, language: string): SkillNames {
  const { identity, revision } = useAccountAccess(ready)
  const current = useSyncExternalStore(subscribe, getSnapshot)
  const metadata = current?.key.identity === identity ? current.skills : EMPTY_METADATA
  const names = useMemo(
    () => new Map(metadata.map((skill) => [skill.name, skillName(skill, language)])),
    [metadata, language]
  )
  const pending =
    !sameKey(current?.key, { identity, revision, language }) ||
    current?.status === CatalogStatus.Loading
  useEffect(() => {
    if (ready) refresh({ identity, revision, language })
  }, [ready, identity, revision, language])
  return useMemo(() => ({ names, pending }), [names, pending])
}
