const DIAGNOSTIC_ENTRY_LIMIT = 50
const DIAGNOSTIC_TEXT_LIMIT = 8_000
const REDACTED_VALUE = '[redacted]'
const OMITTED_BINARY_VALUE = '[binary omitted]'
const SENSITIVE_KEY = /authorization|cookie|credential|password|secret|token|api[_-]?key/i

type ConsoleLevel = 'debug' | 'error' | 'info' | 'log' | 'warn'

export interface ConsoleDiagnostic {
  level: ConsoleLevel
  message: string
  timestamp: string
}

export interface NetworkDiagnostic {
  method: string
  path: string
  requestBody: string
  responseBody: string
  status: number | null
  timestamp: string
}

export interface RendererDiagnosticsSnapshot {
  schemaVersion: 1
  capturedAt: string
  consoleMessages: ConsoleDiagnostic[]
  networkRequests: NetworkDiagnostic[]
}

const consoleMessages: ConsoleDiagnostic[] = []
const networkRequests: NetworkDiagnostic[] = []
let installed = false
// A caught render crash is still a startup failure. Keep this outside the bounded
// log ring so subsequent console traffic cannot turn a broken workbench healthy.
let renderFailed = false

export function recordRendererCrash(): void {
  renderFailed = true
}

export function rendererHasCrashed(): boolean {
  return renderFailed
}

function appendBounded<T>(entries: T[], entry: T): void {
  entries.push(entry)
  if (entries.length > DIAGNOSTIC_ENTRY_LIMIT)
    entries.splice(0, entries.length - DIAGNOSTIC_ENTRY_LIMIT)
}

function truncate(value: string): string {
  return value.length <= DIAGNOSTIC_TEXT_LIMIT
    ? value
    : `${value.slice(0, DIAGNOSTIC_TEXT_LIMIT)}\n[truncated]`
}

function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redact(item, seen))
  if (value instanceof Error)
    return { name: value.name, message: value.message, stack: value.stack }
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? REDACTED_VALUE : redact(child, seen)
  }
  return output
}

function diagnosticText(value: unknown): string {
  if (typeof value === 'string') return truncate(value)
  try {
    const serialized = JSON.stringify(redact(value))
    return truncate(serialized ?? String(value))
  } catch {
    return truncate(String(value))
  }
}

function bodyText(body: BodyInit | null | undefined): string {
  if (body === null || body === undefined) return ''
  if (typeof body === 'string') {
    try {
      return diagnosticText(JSON.parse(body))
    } catch {
      return truncate(body)
    }
  }
  if (body instanceof URLSearchParams) {
    const values: Record<string, string> = {}
    body.forEach((value, key) => {
      values[key] = SENSITIVE_KEY.test(key) ? REDACTED_VALUE : value
    })
    return diagnosticText(values)
  }
  if (body instanceof FormData) {
    const values: Record<string, unknown> = {}
    body.forEach((value, key) => {
      values[key] = SENSITIVE_KEY.test(key)
        ? REDACTED_VALUE
        : typeof value === 'string'
          ? value
          : { name: value.name, size: value.size, type: value.type }
    })
    return diagnosticText(values)
  }
  if (body instanceof Blob)
    return diagnosticText({ size: body.size, type: body.type || OMITTED_BINARY_VALUE })
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return OMITTED_BINARY_VALUE
  return truncate(String(body))
}

function requestPath(input: RequestInfo | URL): string {
  const raw = input instanceof Request ? input.url : String(input)
  try {
    const url = new URL(raw, window.location.href)
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, REDACTED_VALUE)
    }
    return `${url.pathname}${url.search}`
  } catch {
    return raw
  }
}

function isApiRequest(input: RequestInfo | URL): boolean {
  return requestPath(input).startsWith('/api/')
}

async function responseText(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('text/event-stream')) return '[streaming response omitted]'
  if (!contentType.includes('json') && !contentType.startsWith('text/')) return OMITTED_BINARY_VALUE
  try {
    const text = await response.clone().text()
    if (!text) return ''
    try {
      return diagnosticText(JSON.parse(text))
    } catch {
      return truncate(text)
    }
  } catch (error) {
    return diagnosticText(error)
  }
}

export function installRendererDiagnostics(): void {
  if (installed) return
  installed = true

  for (const level of ['debug', 'error', 'info', 'log', 'warn'] as const) {
    const original = console[level].bind(console)
    console[level] = (...values: unknown[]): void => {
      appendBounded(consoleMessages, {
        level,
        message: truncate(values.map(diagnosticText).join(' ')),
        timestamp: new Date().toISOString(),
      })
      original(...values)
    }
  }

  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isApiRequest(input)) return originalFetch(input, init)
    const entry: NetworkDiagnostic = {
      method: String(
        init?.method || (input instanceof Request ? input.method : 'GET')
      ).toUpperCase(),
      path: requestPath(input),
      requestBody: bodyText(init?.body),
      responseBody: '',
      status: null,
      timestamp: new Date().toISOString(),
    }
    if (init?.body === undefined && input instanceof Request) {
      void input
        .clone()
        .text()
        .then((text) => {
          entry.requestBody = bodyText(text)
        })
        .catch(() => undefined)
    }
    appendBounded(networkRequests, entry)
    try {
      const response = await originalFetch(input, init)
      entry.status = response.status
      void responseText(response).then((text) => {
        entry.responseBody = text
      })
      return response
    } catch (error) {
      entry.responseBody = diagnosticText(error)
      throw error
    }
  }
}

export function rendererDiagnosticsSnapshot(): RendererDiagnosticsSnapshot {
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    consoleMessages: consoleMessages.slice(-DIAGNOSTIC_ENTRY_LIMIT),
    networkRequests: networkRequests.slice(-DIAGNOSTIC_ENTRY_LIMIT),
  }
}

export function rendererDiagnosticsFile(): File {
  return new File([JSON.stringify(rendererDiagnosticsSnapshot())], 'renderer-diagnostics.json', {
    type: 'application/json',
  })
}
