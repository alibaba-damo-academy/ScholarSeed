/** Receipts belong to one runtime document, never to the currently selected tab. */
export class OfficeImageLeases<T> {
  private readonly entries = new Map<string, T>()
  private disposed = false
  constructor(private readonly release: (lease: T) => Promise<void>, private readonly failed: (error: unknown) => void) {}

  async add(id: string, lease: T): Promise<boolean> {
    if (this.disposed) {
      await this.cleanup(lease)
      return false
    }
    this.entries.set(id, lease)
    return true
  }

  snapshot(): string[] { return [...this.entries.keys()] }

  async remove(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const lease = this.entries.get(id)
      if (lease === undefined) continue
      if (await this.cleanup(lease)) this.entries.delete(id)
    }
  }

  dispose(): void {
    this.disposed = true
    void this.remove(this.snapshot())
  }

  private async cleanup(lease: T): Promise<boolean> {
    try { await this.release(lease); return true }
    catch (error) { this.failed(error); return false }
  }
}
