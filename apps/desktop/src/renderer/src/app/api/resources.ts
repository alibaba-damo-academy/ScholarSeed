export const RESOURCE_CAPTURE_LIMIT = 128
export const RESOURCE_OBSERVATION_BUDGET_MS = 30_000
const RESOURCE_ENTRY_LIMIT = 8
const RESOURCE_SETTLE_TASK_DELAY_MS = 0
const PROTOCOLS = new Set(['http/1.0', 'http/1.1', 'h2', 'h3'])
type DispatchWindow = { url: string; startedAt: number; dispatchedAt: number }
const windows: DispatchWindow[] = []
let activeCaptures = 0

const duration = (start: number, end: number): number | null =>
  Number.isFinite(start) && Number.isFinite(end) && start > 0 && end >= start ? end - start : null

export function resourceTimingDetails(entry: PerformanceResourceTiming) {
  const timestamp = (value: number) =>
    Number.isFinite(value) && value > 0 ? performance.timeOrigin + value : null
  return {
    resource_start_timestamp_ms: performance.timeOrigin + entry.startTime,
    resource_end_timestamp_ms: performance.timeOrigin + entry.responseEnd,
    fetch_start_timestamp_ms: timestamp(entry.fetchStart),
    request_start_timestamp_ms: timestamp(entry.requestStart),
    response_start_timestamp_ms: timestamp(entry.responseStart),
    total_ms: Number.isFinite(entry.duration) && entry.duration >= 0 ? entry.duration : null,
    before_request_ms: duration(entry.fetchStart, entry.requestStart),
    dns_ms: duration(entry.domainLookupStart, entry.domainLookupEnd),
    connect_ms: duration(entry.connectStart, entry.connectEnd),
    request_to_headers_ms: duration(entry.requestStart, entry.responseStart),
    transfer_ms: duration(entry.responseStart, entry.responseEnd),
    protocol: PROTOCOLS.has(entry.nextHopProtocol) ? entry.nextHopProtocol : null,
  }
}

export class CatalogResourceCapture {
  private readonly window: DispatchWindow
  private readonly observer: PerformanceObserver
  private readonly entries: PerformanceResourceTiming[] = []
  private closed = false
  private finishing = false
  private truncated = false
  private readonly expiry: ReturnType<typeof setTimeout>

  constructor(
    url: string,
    private readonly report: (details: Record<string, unknown>) => void
  ) {
    this.window = {
      url: new URL(url, typeof location === 'undefined' ? undefined : location.href).href,
      startedAt: Infinity,
      dispatchedAt: -Infinity,
    }
    this.observer = new PerformanceObserver((list) => this.collect(list.getEntries()))
    try {
      this.observer.observe({ type: 'resource' })
    } catch (error) {
      this.observer.disconnect()
      throw error
    }
    activeCaptures += 1
    windows.push(this.window)
    if (windows.length > RESOURCE_CAPTURE_LIMIT) windows.shift()
    this.expiry = setTimeout(() => this.flush(true), RESOURCE_OBSERVATION_BUDGET_MS)
  }

  private collect(entries: PerformanceEntry[]): void {
    for (const entry of entries) {
      if (entry.entryType !== 'resource' || entry.name !== this.window.url) continue
      if (this.entries.length >= RESOURCE_ENTRY_LIMIT) {
        this.truncated = true
        continue
      }
      this.entries.push(entry as PerformanceResourceTiming)
    }
  }

  begin(): void {
    this.window.startedAt = performance.now()
  }

  dispatched(): void {
    this.window.dispatchedAt = performance.now()
  }

  finish(): void {
    if (this.finishing || this.closed) return
    this.finishing = true
    setTimeout(() => this.flush(), RESOURCE_SETTLE_TASK_DELAY_MS)
  }

  private flush(expired = false): void {
    if (this.closed) return
    this.closed = true
    activeCaptures -= 1
    try {
      this.collect(this.observer.takeRecords())
      const entries = this.entries.filter(
        (entry) =>
          entry.initiatorType === 'fetch' &&
          entry.startTime >= this.window.startedAt &&
          entry.startTime <= this.window.dispatchedAt
      )
      const entry = entries.length === 1 ? entries[0] : undefined
      const candidates = entry
        ? windows.filter(
            (window) =>
              window.url === this.window.url &&
              entry.startTime >= window.startedAt &&
              entry.startTime <= window.dispatchedAt
          ).length
        : 0
      const status = !windows.includes(this.window)
        ? 'history_evicted'
        : this.truncated
          ? 'truncated'
          : entries.length > 1 || candidates > 1
            ? 'ambiguous'
            : entry && candidates === 1
              ? 'matched'
              : 'unavailable'
      this.report({
        resource_status: status,
        matching_entries: entries.length,
        matching_dispatches: candidates,
        observation_expired: expired,
        dispatch_started_timestamp_ms: performance.timeOrigin + this.window.startedAt,
        dispatch_returned_timestamp_ms: performance.timeOrigin + this.window.dispatchedAt,
        resource: status === 'matched' && entry ? resourceTimingDetails(entry) : null,
      })
    } catch {
    } finally {
      clearTimeout(this.expiry)
      this.observer.disconnect()
    }
  }
}

export function captureCatalogResource(
  url: string,
  report: (details: Record<string, unknown>) => void
): CatalogResourceCapture | undefined {
  try {
    if (typeof PerformanceObserver === 'undefined') return undefined
    if (activeCaptures >= RESOURCE_CAPTURE_LIMIT) {
      report({ resource_status: 'capacity', resource: null })
      return undefined
    }
    return new CatalogResourceCapture(url, report)
  } catch {
    return undefined
  }
}
