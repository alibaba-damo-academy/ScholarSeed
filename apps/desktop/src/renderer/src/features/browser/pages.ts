import { BROWSER_ERROR, type BrowserBridge, type BrowserSnapshot } from '../../../../browser.ts'

export class BrowserPages {
  private readonly pages = new Map<string, Promise<string>>()
  private snapshot?: BrowserSnapshot

  constructor(private readonly bridge: Pick<BrowserBridge, 'dispatch'>) {}

  remember(snapshot?: BrowserSnapshot): void {
    this.snapshot = snapshot
  }

  snapshotFor(tabId: string): BrowserSnapshot | undefined {
    return this.snapshot?.tabs.some((tab) => tab.tabId === tabId) ? this.snapshot : undefined
  }

  own(owner: string, tabId: string): void {
    if (!this.pages.has(owner)) this.pages.set(owner, Promise.resolve(tabId))
  }

  forget(owner: string): void {
    this.pages.delete(owner)
  }

  acquire(owner: string): Promise<string> {
    const existing = this.pages.get(owner)
    if (existing) return existing
    const pending = this.bridge.dispatch({ kind: 'open' }).then((reply) => {
      if (!reply.ok) throw new Error(reply.error)
      if (!reply.openedTabId) throw new Error(BROWSER_ERROR.operationFailed)
      return reply.openedTabId
    })
    this.pages.set(owner, pending)
    void pending.catch(() => {
      if (this.pages.get(owner) === pending) this.pages.delete(owner)
    })
    return pending
  }

  async release(owner: string, ownedPageId?: string): Promise<void> {
    const pending =
      this.pages.get(owner) ?? (ownedPageId ? Promise.resolve(ownedPageId) : undefined)
    if (!pending) return
    this.pages.delete(owner)
    const tabId = await pending
    const reply = await this.bridge.dispatch({ kind: 'close', tabId })
    if (!reply.ok && reply.error !== BROWSER_ERROR.targetClosed) throw new Error(reply.error)
  }
}
