import type { StorageNative, StorageSelection } from './storage'

export interface StorageBindingNative extends StorageNative {
  lineage(pin: unknown): string[]
}

export interface StorageBinding {
  readonly path: string
  readonly identity: string
  readonly ancestors: readonly string[]
}

const IDENTITY = /^(?:posix:[a-f0-9]{16}:[a-f0-9]{16}|windows:[a-f0-9]{16}:[a-f0-9]{32})$/

/** Frozen backend launch observation, never writer admission or permission to create roots. */
export function observeStorageBindings(
  native: StorageBindingNative,
  selected: Pick<StorageSelection, 'home' | 'userData' | 'sessionData'>
): readonly StorageBinding[] {
  const roots = [...new Set([selected.home, selected.userData, selected.sessionData])].sort()
  const pins: unknown[] = []
  let result: readonly StorageBinding[] | undefined
  let failure: unknown
  try {
    result = Object.freeze(
      roots.map((path) => {
        const pin = native.pin(path, false)
        pins.push(pin)
        const lineage = native.lineage(pin)
        if (!lineage.length || lineage.length > 256 || lineage.some((id) => !IDENTITY.test(id)))
          throw new Error('Invalid storage directory identity')
        return Object.freeze({
          path,
          identity: lineage.at(-1)!,
          ancestors: Object.freeze([...new Set(lineage.slice(0, -1))].sort()),
        })
      })
    )
  } catch (error) {
    failure = error
  }
  // An uncertain native release requires retaining all remaining handles to death.
  if ((failure as NodeJS.ErrnoException | undefined)?.code === 'ERR_LEASE_RELEASE') throw failure
  while (pins.length) {
    try {
      native.release(pins.pop())
    } catch (error) {
      throw Object.assign(
        new AggregateError(
          failure ? [failure, error] : [error],
          'Uncertain storage binding release'
        ),
        { code: 'ERR_LEASE_RELEASE' }
      )
    }
  }
  if (failure) throw failure
  return result!
}
