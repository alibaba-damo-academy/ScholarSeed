import { app, dialog } from 'electron'
import { realpathSync } from 'node:fs'
import { constants } from 'node:os'
import { mainLocalization } from './localization.ts'
import {
  planInstalledUpdate,
  repairExecutable,
  repairInstalledUpdate,
  verifyRepairApplication,
  UPDATE_REPAIR_ARGUMENT,
  UPDATE_REPAIR_SELECTION,
  type UpdateRepairScope,
} from './repair.ts'
import type { TerminalRestorationRuntime } from './restoration.ts'

const ACCEPT = 0
const CANCEL = 1
const REPAIR_ATTEMPTS = 3
type BaseScope = Omit<UpdateRepairScope, 'application' | 'selection'>

async function choose(title: string, application: boolean): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title,
    properties: application ? ['openFile'] : ['openDirectory', 'showHiddenFiles'],
    ...(application ? { filters: [{ name: title, extensions: ['app'] }] } : {}),
  })
  return result.canceled || result.filePaths.length !== 1
    ? null
    : realpathSync.native(result.filePaths[0])
}

export async function prepareRepair(scope: UpdateRepairScope, runtime: TerminalRestorationRuntime) {
  const t = mainLocalization().getFixedT(null, 'native')
  const helper = await choose(t('repair.helper'), true)
  if (!helper) return null
  if (helper === scope.application) throw new Error('ERR_UPDATE_REPAIR_SELF')
  await verifyRepairApplication(helper, scope.bundleId, scope.expectedTeam, runtime)
  const selected = { ...scope, repairApplication: helper }
  await planInstalledUpdate(selected, runtime)
  const confirmation = await dialog.showMessageBox({
    type: 'warning',
    message: t('repair.confirm'),
    detail: t('repair.confirmDetail'),
    buttons: [t('repair.continue'), t('repair.cancel')],
    defaultId: CANCEL,
    cancelId: CANCEL,
    noLink: true,
  })
  if (confirmation.response !== ACCEPT) return null
  return {
    execPath: await repairExecutable(helper),
    args: [
      `${UPDATE_REPAIR_ARGUMENT}${scope.application}`,
      ...Object.entries(UPDATE_REPAIR_SELECTION).map(
        ([key, prefix]) => `${prefix}${scope.selection![key as keyof typeof scope.selection]}`
      ),
    ],
  }
}

export function repairBusy(error: unknown): boolean {
  const native = error as {
    code?: string
    nativeCode?: string
    systemCode?: number
    mutationPerformed?: boolean
    committed?: boolean
  } | null
  const code =
    native?.code === 'qualification_refused' &&
    native.mutationPerformed === false &&
    native.committed === false
      ? native.nativeCode
      : native?.code
  return (
    !!native &&
    ['ERR_TERMINAL_OPEN', 'ERR_TERMINAL_PARK', 'ERR_TERMINAL_OBSERVATION'].includes(code ?? '') &&
    [constants.errno.EBUSY, constants.errno.EWOULDBLOCK].includes(native.systemCode ?? -1)
  )
}

export async function runRepairWizard(
  base: BaseScope,
  runtime: TerminalRestorationRuntime,
  relaunch: (result: Awaited<ReturnType<typeof repairInstalledUpdate>>) => void,
  log: (message: string) => void
): Promise<boolean> {
  await app.whenReady()
  const t = mainLocalization().getFixedT(null, 'native')
  try {
    await verifyRepairApplication(base.repairApplication, base.bundleId, base.expectedTeam, runtime)
    const application = await choose(t('repair.target'), true)
    if (!application) return false
    if (application === base.repairApplication) throw new Error('ERR_UPDATE_REPAIR_SELF')
    const selection: Record<string, string> = {}
    const titles = {
      home: t('repair.home'),
      userData: t('repair.userData'),
      workspace: t('repair.workspace'),
    }
    for (const key of Object.keys(UPDATE_REPAIR_SELECTION) as Array<
      keyof typeof UPDATE_REPAIR_SELECTION
    >) {
      const directory = await choose(titles[key], false)
      if (!directory) return false
      selection[key] = directory
    }
    const scope = {
      ...base,
      application,
      selection: selection as NonNullable<UpdateRepairScope['selection']>,
    }
    await planInstalledUpdate(scope, runtime)
    const confirmation = await dialog.showMessageBox({
      type: 'warning',
      message: t('repair.quitTarget'),
      detail: `${application}\n\n${Object.values(selection).join('\n')}\n\n${t('repair.selectionDetail')}`,
      buttons: [t('repair.continue'), t('repair.cancel')],
      defaultId: CANCEL,
      cancelId: CANCEL,
      noLink: true,
    })
    if (confirmation.response !== ACCEPT) return false
    for (let attempt = 1; attempt <= REPAIR_ATTEMPTS; attempt++) {
      try {
        const result = await repairInstalledUpdate(scope, runtime)
        await dialog.showMessageBox({
          type: 'info',
          message: t('repair.complete'),
          detail: t('repair.completeDetail'),
          buttons: [t('repair.continue')],
        })
        relaunch(result)
        return true
      } catch (error) {
        if (!repairBusy(error) || attempt === REPAIR_ATTEMPTS) throw error
        log(`[update] repair temporarily busy: ${String(error)}\n`)
        const answer = await dialog.showMessageBox({
          type: 'warning',
          message: t('repair.busy'),
          detail: t('repair.busyDetail'),
          buttons: [t('repair.retry'), t('repair.cancel')],
          defaultId: CANCEL,
          cancelId: CANCEL,
          noLink: true,
        })
        if (answer.response !== ACCEPT) return false
      }
    }
    return false
  } catch (error) {
    const diagnostic = error as {
      code?: string
      nativeCode?: string
      systemCode?: number
      mutationPerformed?: boolean
      committed?: boolean
    }
    log(
      `[update] repair refused without bypass: ${String(error)} ${JSON.stringify({ code: diagnostic?.code, nativeCode: diagnostic?.nativeCode, systemCode: diagnostic?.systemCode, mutationPerformed: diagnostic?.mutationPerformed, committed: diagnostic?.committed })}\n`
    )
    await dialog.showMessageBox({
      type: 'error',
      message: t('repair.failed'),
      detail: t('repair.failedDetail'),
      buttons: [t('repair.cancel')],
    })
    return false
  }
}
