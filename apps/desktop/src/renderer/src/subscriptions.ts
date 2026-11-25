export class ExclusiveSubscription {
  private lease: { identity: string; controller: AbortController; close?: () => void } | undefined

  claim(identity: string) {
    this.clear()
    const lease: NonNullable<typeof this.lease> = { identity, controller: new AbortController() }
    this.lease = lease
    return {
      signal: lease.controller.signal,
      current: () => this.lease === lease,
      attach: (open: () => () => void) => {
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
    previous?.controller.abort()
    previous?.close?.()
  }
}
