import type { AdoptOutcome } from './handoff.ts'

const DESKTOP_ADOPTED_PATH = '/api/desktop/adopted'
export const RECEIPT_TIMEOUT_MS = 5_000
export const RECEIPT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504])

interface ReceiptDependencies {
  base: (signal: AbortSignal) => Promise<string | null>
  request: typeof fetch
  wait: (ms: number) => Promise<void>
  log: (line: string) => void
}

/** Best-effort delivery of an immutable result; never changes local login state. */
export async function reportReceipt(
  state: string,
  outcome: AdoptOutcome,
  token: string,
  isCurrent: () => boolean,
  deps: ReceiptDependencies
): Promise<void> {
  for (let attempt = 0; attempt <= RECEIPT_DELAYS_MS.length; attempt += 1) {
    if (!isCurrent()) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(controller.signal.reason)
      }, RECEIPT_TIMEOUT_MS)
    })
    let retryable = true
    let reason = 'account-base-unavailable'
    let status: number | null = null
    try {
      await Promise.race([
        deadline,
        (async () => {
          const base = await deps.base(controller.signal)
          if (!isCurrent() || controller.signal.aborted) return
          if (base) {
            const response = await deps.request(base + DESKTOP_ADOPTED_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
              body: JSON.stringify({ state, outcome }),
              signal: controller.signal,
            })
            if (controller.signal.aborted) return
            status = response.status
            reason = response.ok ? 'delivered' : 'http-error'
            retryable = !response.ok && RETRYABLE.has(status)
          }
        })(),
      ])
    } catch {
      reason = controller.signal.aborted ? 'timeout' : 'network-error'
    } finally {
      clearTimeout(timer!)
    }
    if (!isCurrent()) return
    const retry = retryable && attempt < RECEIPT_DELAYS_MS.length
    deps.log(
      `[shell] handoff outcome report ${JSON.stringify({ outcome, attempt: attempt + 1, status, reason, retry })}\n`
    )
    if (!retry) return
    await deps.wait(RECEIPT_DELAYS_MS[attempt])
  }
}
