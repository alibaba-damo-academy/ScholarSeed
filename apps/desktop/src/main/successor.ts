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

/** A separate native updater keeps its own downloaded request and event subscription. */
export class SuccessorUpdater extends EventEmitter implements SquirrelUpdater {
  private url?: string
  private handle?: number
  private detached = false

  constructor(
    private readonly bridge: SuccessorBridge,
    private readonly alternate: boolean
  ) {
    super()
  }

  setFeedURL({ url }: { url: string }): void {
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
    this.bridge.installSuccessor(this.handle)
  }

  dispose(): void {
    this.detached = true
    if (this.handle !== undefined) this.bridge.disposeSuccessor(this.handle)
    this.handle = undefined
  }
}
