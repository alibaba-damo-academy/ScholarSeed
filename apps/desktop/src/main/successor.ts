import { EventEmitter } from 'node:events'
import type { SquirrelUpdater } from './squirrel.ts'

export interface SuccessorBridge {
  prepareSuccessor(
    url: string,
    alternate: boolean,
    callback: (error: string | null) => void
  ): number
  installSuccessor(handle: number): void
  disposeSuccessor(handle: number): void
}

/** The native successor reports an empty check as an error. Only a ready download succeeds. */
export class SuccessorUpdater
  extends EventEmitter<{ error: [Error]; 'update-downloaded': [] }>
  implements SquirrelUpdater
{
  private url?: string
  private handle?: number
  private detached = false

  constructor(
    private readonly bridge: SuccessorBridge,
    private readonly alternate: boolean
  ) {
    super()
  }

  setFeedURL({ url, headers }: Parameters<SquirrelUpdater['setFeedURL']>[0]): void {
    if (headers !== undefined)
      throw new Error('Successor preparation does not support feed headers')
    this.url = url
  }

  checkForUpdates(): void {
    if (!this.url || this.detached || this.handle !== undefined)
      throw new Error('Successor preparation unavailable')
    this.handle = this.bridge.prepareSuccessor(this.url, this.alternate, (error) => {
      if (this.detached) return
      if (error !== null) this.emit('error', new Error(error))
      else this.emit('update-downloaded')
    })
  }

  quitAndInstall(): void {
    if (this.detached || this.handle === undefined)
      throw new Error('Successor installation unavailable')
    // AppKit can synchronously notify quit listeners. Keep the handle for disposal.
    this.detached = true
    try {
      this.bridge.installSuccessor(this.handle)
    } catch (error) {
      if (this.handle !== undefined) this.detached = false
      throw error
    }
  }

  dispose(): void {
    this.detached = true
    const handle = this.handle
    this.handle = undefined
    if (handle !== undefined) this.bridge.disposeSuccessor(handle)
  }
}
