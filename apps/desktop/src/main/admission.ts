// Before storage admission, use only OS reporting and bundled messages. A
// BrowserWindow/session, preferences or backend could touch an unadmitted root.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app, clipboard, dialog, Notification } from 'electron'
import { startupAdmissionText } from './localization'
import { redactDiagnosticError } from './redaction'
import type { SquirrelStartupStatus } from './squirrelstartup'

const ACTION = { retry: 0, copy: 1, quit: 2 } as const
const MACOS_PLATFORM = 'darwin'
const SYSTEM_LOGGER = '/usr/bin/logger'
const SYSTEM_LOG_TAG = 'ScholarSeedStartup'
const REFUSAL_POLICY = {
  installing: { messageKey: 'installing', priority: 'user.notice' },
  restoring: { messageKey: 'restoring', priority: 'user.notice' },
  failed: { messageKey: 'unconfirmed', priority: 'user.err' },
  unconfirmed: { messageKey: 'unconfirmed', priority: 'user.err' },
} satisfies Record<
  SquirrelStartupStatus,
  { messageKey: keyof ReturnType<typeof startupAdmissionText>; priority: string }
>
const REPORT_TIMEOUT_MS = 2000
const REPORT_MAX_BYTES = 4096
const REFUSAL_EXIT_CODE = 1
const run = promisify(execFile)
const activeNotifications = new Set<Notification>()

export class MacStartupAdmissionError extends Error {
  constructor(
    readonly status: SquirrelStartupStatus,
    cause?: unknown
  ) {
    super('Mac update startup admission is unresolved', { cause })
    this.name = 'MacStartupAdmissionError'
  }
}

function notifyMacRefusal(status: SquirrelStartupStatus): Promise<void> {
  return new Promise((resolve) => {
    let finished = false
    let notification: Notification | undefined
    const complete = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (notification) activeNotifications.delete(notification)
      resolve()
    }
    const timer = setTimeout(complete, REPORT_TIMEOUT_MS)
    void app.whenReady().then(() => {
      if (finished) return
      try {
        if (!Notification.isSupported()) return complete()
        const text = startupAdmissionText()
        const body = text[REFUSAL_POLICY[status].messageKey]
        notification = new Notification({ title: text.title, body, silent: true })
        activeNotifications.add(notification)
        notification.once('failed', complete)
        notification.show()
      } catch {
        complete()
      }
    }, complete)
  })
}

async function reportMacRefusal(
  error: MacStartupAdmissionError,
  headless: boolean,
  log: (message: string) => void
): Promise<void> {
  const diagnostic = JSON.stringify({
    component: SYSTEM_LOG_TAG,
    event: 'update-startup-refused',
    timestamp: new Date().toISOString(),
    pid: process.pid,
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    status: error.status,
    error: redactDiagnosticError(error),
  })
  let deadline: ReturnType<typeof setTimeout> | undefined
  const logging = run(
    SYSTEM_LOGGER,
    ['-p', REFUSAL_POLICY[error.status].priority, '-t', SYSTEM_LOG_TAG, diagnostic],
    {
      timeout: REPORT_TIMEOUT_MS,
      maxBuffer: REPORT_MAX_BYTES,
      encoding: 'utf8',
    }
  )
  try {
    await Promise.race([
      Promise.allSettled([
        logging.catch(() => log('[startup] system admission diagnostic unavailable\n')),
        headless ? Promise.resolve() : notifyMacRefusal(error.status),
      ]),
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, REPORT_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(deadline)
    try {
      logging.child?.kill()
    } finally {
      app.exit(REFUSAL_EXIT_CODE)
    }
  }
}

export async function recoverStartupAdmission(
  error: unknown,
  headless: boolean,
  log: (message: string) => void,
  updatePending = false
): Promise<void> {
  log(`[startup] admission refused; preserving storage and update records: ${String(error)}\n`)
  if (
    process.platform === MACOS_PLATFORM &&
    (error instanceof MacStartupAdmissionError || updatePending)
  ) {
    return reportMacRefusal(
      error instanceof MacStartupAdmissionError
        ? error
        : new MacStartupAdmissionError('unconfirmed', error),
      headless,
      log
    )
  }
  if (headless) {
    app.exit(1)
    return
  }
  const text = startupAdmissionText()
  const diagnostic = `ScholarSeed ${app.getVersion()} (${process.platform}/${process.arch})\n${String(error)}`
  const detail = `${text.detail}\n\n${diagnostic}`
  try {
    await app.whenReady()
    for (;;) {
      const { response } = await dialog.showMessageBox({
        type: 'error',
        title: text.title,
        message: text.message,
        detail,
        buttons: [text.retry, text.copy, text.quit],
        defaultId: ACTION.retry,
        cancelId: ACTION.quit,
        noLink: true,
      })
      if (response === ACTION.copy) {
        clipboard.writeText(diagnostic)
        continue
      }
      if (response === ACTION.retry) {
        // Electron retains the exact launch arguments. The next process must
        // repeat the ordinary admission path; no record is acknowledged here.
        app.relaunch()
      }
      app.quit()
      return
    }
  } catch (failure) {
    log(`[startup] admission recovery dialog failed: ${String(failure)}\n`)
    // Keep an OS error surface even if the asynchronous dialog/relaunch fails.
    dialog.showErrorBox(text.title, `${text.message}\n\n${detail}\n\n${String(failure)}`)
    app.quit()
  }
}
