// Before storage admission, use only the OS dialog and bundled messages. A
// BrowserWindow/session, preferences or backend could touch an unadmitted root.
import { app, clipboard, dialog } from 'electron'
import { startupAdmissionText } from './localization'

const ACTION = { retry: 0, copy: 1, quit: 2 } as const

export async function recoverStartupAdmission(
  error: unknown,
  headless: boolean,
  log: (message: string) => void
): Promise<void> {
  log(`[startup] admission refused; preserving storage and update records: ${String(error)}\n`)
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
