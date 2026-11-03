import { zipSync, strToU8 } from 'fflate/browser'
import {
  FEEDBACK_LIMITS,
  FEEDBACK_SUBMIT_PATH,
  FEEDBACK_HTTP_RATE_LIMITED,
  type FeedbackSubmissionRequest,
  type FeedbackSubmissionResult,
} from '../feedback.ts'
import { redactUpdateLog } from './redaction.ts'
import { SOURCE_BASELINE_ARCNAME } from '../feedback.ts'

const MANAGED_KEY_PATH = '/api/account/api-keys/session'
const MANAGED_KEY_SLOT = 'scholarseed'
const MANAGED_KEY_NAME = '书深技能凭据'
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const REQUEST_FIELDS = new Set([
  'description',
  'email',
  'includeLogs',
  'includeTrace',
  'sessionId',
  'images',
  'recordingReport',
  'rendererDiagnostics',
])
const REPORT_VERSION = 1
const ZIP_STORE_LEVEL = 0
const JWT_SEGMENTS = 3
const PLATFORM_NAMES: Record<string, string> = { darwin: 'macos', win32: 'windows', linux: 'linux' }

export interface FeedbackSubmissionPorts {
  baseUrl: string
  accountBaseUrl: string
  version: string
  platform: string
  arch: string
  readToken(): Promise<string>
  isCurrent(): boolean
  collectBundle(request: FeedbackSubmissionRequest, token: string): Promise<Uint8Array>
  sourceBaseline?(): string | undefined
  hostDiagnostics(): string
  fetch: typeof fetch
}

function validReport(value: unknown): boolean {
  if (value === undefined) return true
  if (!(value instanceof Uint8Array) || value.byteLength > FEEDBACK_LIMITS.reportBytes) return false
  try {
    const report = JSON.parse(new TextDecoder().decode(value))
    return (
      report !== null &&
      typeof report === 'object' &&
      !Array.isArray(report) &&
      report.schemaVersion === REPORT_VERSION
    )
  } catch {
    return false
  }
}

export function feedbackSubmissionRequest(value: unknown): value is FeedbackSubmissionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const request = value as FeedbackSubmissionRequest
  if (
    Object.keys(request).some((key) => !REQUEST_FIELDS.has(key)) ||
    typeof request.description !== 'string' ||
    !request.description.trim() ||
    request.description.length > FEEDBACK_LIMITS.description ||
    typeof request.includeLogs !== 'boolean' ||
    typeof request.includeTrace !== 'boolean' ||
    (request.email !== undefined &&
      (typeof request.email !== 'string' || request.email.length > FEEDBACK_LIMITS.description)) ||
    (request.sessionId !== undefined &&
      request.sessionId !== null &&
      (typeof request.sessionId !== 'string' ||
        request.sessionId.length > FEEDBACK_LIMITS.description)) ||
    !Array.isArray(request.images) ||
    request.images.length > FEEDBACK_LIMITS.images ||
    !validReport(request.recordingReport) ||
    !validReport(request.rendererDiagnostics)
  )
    return false
  let total = 0
  for (const image of request.images) {
    if (
      !image ||
      typeof image.name !== 'string' ||
      !image.name ||
      image.name.length > FEEDBACK_LIMITS.filename ||
      /[\\/]/.test(image.name) ||
      Array.from(image.name).some((character) => character.charCodeAt(0) < 32) ||
      !IMAGE_TYPES.has(image.type) ||
      !(image.bytes instanceof Uint8Array) ||
      !image.bytes.byteLength ||
      image.bytes.byteLength > FEEDBACK_LIMITS.imageBytes
    )
      return false
    total += image.bytes.byteLength
  }
  return total <= FEEDBACK_LIMITS.imagesBytes
}

export async function feedbackResponseBytes(
  response: Response,
  maximum: number
): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > maximum) throw new Error('feedback_response_too_large')
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function responseObject(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(
    new TextDecoder().decode(await feedbackResponseBytes(response, FEEDBACK_LIMITS.responseBytes))
  )
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
}

function blob(bytes: Uint8Array, type: string): Blob {
  return new Blob([new Uint8Array(bytes)], { type })
}

async function localBundle(
  request: FeedbackSubmissionRequest,
  ports: FeedbackSubmissionPorts,
  backendUnavailable: boolean
): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array> = {
    'feedback/collection.json': strToU8(
      JSON.stringify({
        schemaVersion: REPORT_VERSION,
        backend: backendUnavailable ? 'unavailable' : 'not_requested',
        conversationRequested:
          request.includeLogs && request.includeTrace && Boolean(request.sessionId),
        diagnosticsRequested: request.includeLogs,
      })
    ),
  }
  const source = ports.sourceBaseline?.()
  if (request.includeLogs && source) entries[SOURCE_BASELINE_ARCNAME] = strToU8(source)
  if (request.recordingReport) entries['feedback/recording-report.json'] = request.recordingReport
  if (request.rendererDiagnostics)
    entries['feedback/renderer-diagnostics.json'] = request.rendererDiagnostics
  if (request.includeLogs)
    entries['host/desktop.log'] = strToU8(redactUpdateLog(ports.hostDiagnostics())).slice(
      -FEEDBACK_LIMITS.hostBytes
    )
  return zipSync(entries, { level: ZIP_STORE_LEVEL })
}

export class FeedbackSubmissionService {
  private busy = false
  constructor(private readonly ports: FeedbackSubmissionPorts) {}

  async submit(
    value: unknown,
    isCurrent: () => boolean = this.ports.isCurrent
  ): Promise<FeedbackSubmissionResult> {
    if (!feedbackSubmissionRequest(value)) return { ok: false, code: 'invalid_request' }
    if (!isCurrent()) return { ok: false, code: 'invalid_sender' }
    if (this.busy) return { ok: false, code: 'busy' }
    if (!this.ports.baseUrl) return { ok: false, code: 'unavailable' }
    this.busy = true
    try {
      return await this.send(value, isCurrent)
    } catch {
      return { ok: false, code: 'failed' }
    } finally {
      this.busy = false
    }
  }

  private async send(
    request: FeedbackSubmissionRequest,
    isCurrent: () => boolean
  ): Promise<FeedbackSubmissionResult> {
    const ports = this.ports
    const token = await ports.readToken()
    const segments = token.split('.')
    const accountToken = segments.length === JWT_SEGMENTS && segments.every(Boolean) ? token : ''
    let key = ''
    if (accountToken && !ports.accountBaseUrl) return { ok: false, code: 'unavailable' }
    if (accountToken && ports.accountBaseUrl) {
      try {
        const response = await ports.fetch(ports.accountBaseUrl + MANAGED_KEY_PATH, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(FEEDBACK_LIMITS.credentialTimeoutMs),
          headers: { authorization: `Bearer ${accountToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ slot: MANAGED_KEY_SLOT, name: MANAGED_KEY_NAME }),
        })
        if (!response.ok) return { ok: false, code: 'unavailable' }
        const payload = await responseObject(response)
        if (typeof payload.token !== 'string' || !payload.token.startsWith('ssk-'))
          return { ok: false, code: 'unavailable' }
        key = payload.token
      } catch {
        return { ok: false, code: 'unavailable' }
      }
    }
    if (!isCurrent() || (await ports.readToken()) !== token)
      return { ok: false, code: 'identity_changed' }
    let bundle: Uint8Array | undefined
    let diagnostics: FeedbackSubmissionResult['diagnostics'] = 'not_requested'
    if (request.includeLogs) {
      try {
        bundle = await ports.collectBundle(request, token)
        if (!bundle.byteLength || bundle.byteLength > FEEDBACK_LIMITS.bundleBytes)
          throw new Error('feedback_bundle_invalid')
        diagnostics = 'complete'
      } catch {
        bundle = await localBundle(request, ports, true)
        diagnostics = 'partial'
      }
    } else if (request.recordingReport || request.rendererDiagnostics)
      bundle = await localBundle(request, ports, false)
    if (bundle && bundle.byteLength > FEEDBACK_LIMITS.bundleBytes)
      return { ok: false, code: 'invalid_request' }
    if (!isCurrent() || (await ports.readToken()) !== token)
      return { ok: false, code: 'identity_changed' }
    const body = new FormData()
    body.set('description', request.description.trim())
    if (request.email?.trim()) body.set('email', request.email.trim())
    body.set('client_version', ports.version)
    body.set('client_platform', PLATFORM_NAMES[ports.platform] ?? ports.platform)
    body.set('client_arch', ports.arch)
    for (const image of request.images)
      body.append('images', blob(image.bytes, image.type), image.name)
    if (bundle) {
      body.set('attach_logs', 'true')
      body.set('logs_bundle', blob(bundle, 'application/zip'), `scholarseed-logs-${Date.now()}.zip`)
    }
    const response = await ports.fetch(ports.baseUrl + FEEDBACK_SUBMIT_PATH, {
      method: 'POST',
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(FEEDBACK_LIMITS.submitTimeoutMs),
      headers: key ? { authorization: `Bearer ${key}` } : {},
    })
    if (!response.ok)
      return {
        ok: false,
        code: 'failed',
        rateLimited: response.status === FEEDBACK_HTTP_RATE_LIMITED,
      }
    const payload = await responseObject(response)
    if (payload.ok === false || typeof payload.id !== 'string' || !payload.id)
      return { ok: false, code: 'failed' }
    if (!isCurrent() || (await ports.readToken()) !== token)
      return { ok: false, code: 'identity_changed' }
    return { ok: true, id: payload.id, diagnostics }
  }
}
