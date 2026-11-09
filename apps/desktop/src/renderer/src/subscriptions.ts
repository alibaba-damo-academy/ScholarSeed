export class ExclusiveSubscription {
  private lease: { identity: string; close?: () => void } | undefined

  claim(identity: string): { current: () => boolean; attach: (open: () => () => void) => void } {
    this.clear()
    const lease = { identity } as { identity: string; close?: () => void }
    this.lease = lease
    return {
      current: () => this.lease === lease,
      attach: (open) => {
        if (this.lease !== lease) return
        lease.close?.()
        lease.close = open()
      },
    }
  }

  retain(identity: string | null): void {
    if (this.lease?.identity !== identity) this.clear()
  }

  clear(): void {
    const previous = this.lease
    this.lease = undefined
    previous?.close?.()
  }
}
