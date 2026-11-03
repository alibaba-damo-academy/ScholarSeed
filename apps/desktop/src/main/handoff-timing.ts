import { handoffFingerprint, parseCallbackUrl } from './handoff-url.ts'

export const CALLBACK_TIMING_FLAG = '--scholarseed-callback-timing='
const TIMING_SCHEMA = 1
const MAX_TIMING_ARGUMENT = 4096
const MAX_TIMING_MS = 24 * 60 * 60 * 1000
const TIMING_DURATION_KEYS = [
  'activate_ms',
  'bootstrap_ms',
  'signature_ms',
  'readiness_ms',
  'pre_engine_ms',
] as const
const TIMING_KEYS = ['schema', 'attempt', 'launcher_pid', 'started_at_ms', ...TIMING_DURATION_KEYS]

export interface CallbackTiming {
  schema: number
  attempt: string
  launcher_pid: number
  started_at_ms: number
  activate_ms: number
  bootstrap_ms: number
  signature_ms: number
  readiness_ms: number
  pre_engine_ms: number
}

export type CallbackSource = 'argv' | 'second_instance' | 'inbox' | 'open_url'

function parseTimingValue(value: unknown): CallbackTiming | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== TIMING_KEYS.length || keys.some((key) => !TIMING_KEYS.includes(key)))
    return null
  if (record.schema !== TIMING_SCHEMA || typeof record.attempt !== 'string') return null
  if (!Number.isSafeInteger(record.launcher_pid) || (record.launcher_pid as number) <= 0)
    return null
  if (!Number.isSafeInteger(record.started_at_ms) || (record.started_at_ms as number) <= 0)
    return null
  for (const key of TIMING_DURATION_KEYS) {
    const duration = record[key]
    if (
      typeof duration !== 'number' ||
      !Number.isFinite(duration) ||
      duration < 0 ||
      duration > MAX_TIMING_MS
    )
      return null
  }
  return record as unknown as CallbackTiming
}

export function validateCallbackTiming(value: unknown, url: string | null): CallbackTiming | null {
  const timing = parseTimingValue(value)
  if (!timing) return null
  const callback = url ? parseCallbackUrl(url) : null
  return callback && timing.attempt === handoffFingerprint(callback.state) ? timing : null
}

export function findCallbackTiming(
  args: readonly string[],
  url: string | null
): CallbackTiming | null {
  const matches = args.filter((argument) => argument.startsWith(CALLBACK_TIMING_FLAG))
  if (matches.length !== 1 || matches[0].length > MAX_TIMING_ARGUMENT) return null
  const encoded = matches[0].slice(CALLBACK_TIMING_FLAG.length)
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null
  try {
    return validateCallbackTiming(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
      url
    )
  } catch {
    return null
  }
}

export function callbackTimingLine(
  url: string,
  source: CallbackSource,
  timing: CallbackTiming | null,
  receivedAt = Date.now()
): string {
  const callback = parseCallbackUrl(url)
  const attempt = callback ? handoffFingerprint(callback.state) : 'none'
  const candidate = parseTimingValue(timing)
  const validated = callback && candidate?.attempt === attempt ? candidate : null
  const delivery = validated ? receivedAt - validated.started_at_ms - validated.pre_engine_ms : null
  const deliveryMs =
    delivery !== null && delivery >= 0 && delivery <= MAX_TIMING_MS ? delivery : null
  return `[callback-timing] ${JSON.stringify({
    event: 'received',
    source,
    attempt,
    receiver_pid: process.pid,
    received_at_ms: receivedAt,
    native: validated,
    delivery_ms: deliveryMs,
  })}\n`
}
