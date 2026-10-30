import { createLocalization } from '../../../../localization/engine.ts'
import english from '../../../../localization/locales/en/components.json' with { type: 'json' }
import chinese from '../../../../localization/locales/zh/components.json' with { type: 'json' }
import { LOCALES } from '../../../../localization/catalog.ts'
import { MENU_ACTION, type AccountMenuAction, type AccountMenuView, type MenuItem } from '../../../../menu.ts'

const localizations = {
  en: createLocalization('en', { en: { components: english }, zh: { components: chinese } }),
  'zh-CN': createLocalization('zh', { en: { components: english }, zh: { components: chinese } })
}
export const accountMenuText = (locale: AccountMenuView['locale']) => localizations[locale].getFixedT(null, 'components')
export interface AccountMenuLease { identityRevision: number; menuRevision: number }
export function accountActionAllowed(expected: AccountMenuLease, current: AccountMenuLease & { open: boolean; busy: boolean; availableActions: readonly AccountMenuAction[] }, action: AccountMenuAction): boolean {
  return expected.identityRevision === current.identityRevision && expected.menuRevision === current.menuRevision && current.open
    && !current.busy && current.availableActions.includes(action)
}
export function accountAlias(value: string): string {
  return value.replace(/\d{8,}/g, phone => `${phone.slice(0, 3)}****${phone.slice(-4)}`).replace(/\S+@\S+/g, email => `${email.slice(0, 1)}…`)
}
export function accountMenuItems(view: AccountMenuView): Exclude<MenuItem, { kind: 'zoom' }>[] {
  const translate = accountMenuText(view.locale)
  const action = (actionId: AccountMenuAction, label: string): Extract<MenuItem, { kind: 'action' }> => ({ kind: 'action', id: actionId, actionId, label,
    disabled: !view.availableActions.includes(actionId) || view.logoutBusy, checked: false, value: { kind: 'none' } })
  const items: Exclude<MenuItem, { kind: 'zoom' }>[] = [view.alias ? action(MENU_ACTION.profile, view.alias) : action(MENU_ACTION.login, translate('accountMenu.login'))]
  if (view.availableActions.includes(MENU_ACTION.credits)) items.push(action(MENU_ACTION.credits, translate('accountMenu.credits')))
  if (view.availableActions.includes(MENU_ACTION.creditsMore)) items.push(action(MENU_ACTION.creditsMore, translate('accountMenu.creditsMore')))
  items.push({ kind: 'separator', id: 'account.preferences.separator' })
  if (view.availableActions.includes(MENU_ACTION.language)) items.push({ kind: 'submenu', id: MENU_ACTION.language,
    label: `${translate('preferences.language')} ${LOCALES[view.locale === 'en' ? 'en' : 'zh'].label}`, items: Object.entries(LOCALES).map(([locale, value]) => ({
      kind: 'action', id: `${MENU_ACTION.language}.${locale}`, actionId: MENU_ACTION.language, label: value.label,
      disabled: view.logoutBusy, checked: view.locale === (locale === 'en' ? 'en' : 'zh-CN'), value: { kind: 'choice', value: locale === 'en' ? 'en' : 'zh-CN' }
    })) })
  const labels = { [MENU_ACTION.guide]: 'accountMenu.guide', [MENU_ACTION.feedback]: 'accountMenu.feedback', [MENU_ACTION.settings]: 'accountMenu.settings' } as const
  for (const [actionId, label] of Object.entries(labels)) if (view.availableActions.includes(actionId as AccountMenuAction)) items.push(action(actionId as AccountMenuAction, translate(label)))
  if (view.alias && view.availableActions.includes(MENU_ACTION.logout)) items.push({ kind: 'separator', id: 'account.logout.separator' }, action(MENU_ACTION.logout, translate(view.logoutBusy ? 'accountMenu.loggingOut' : 'accountMenu.logout')))
  return items
}
