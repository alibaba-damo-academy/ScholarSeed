import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import '../../styles.css'
import { DropdownMenu, DropdownMenuContent } from '../ui'
import { AccountMenuPanel } from './AccountMenuPanel'
import type { AccountMenuView, MenuValue } from '../../../../menu'

const initial: AccountMenuView = { alias: '138****8001', avatar: '13', credits: { phase: 'error', value: null, unlimited: false }, availableActions: ['account.profile', 'account.credits', 'account.language', 'account.settings', 'account.logout'], logoutBusy: false, logoutError: null, locale: 'zh-CN' }
const actions: Array<{ action: string; value: MenuValue }> = []
Object.assign(window, { accountActions: actions })
function Fixture(): JSX.Element {
  const [view, setView] = useState(initial)
  const [open, setOpen] = useState(true)
  Object.assign(window, { setAccountView: setView, accountClosed: !open })
  return <DropdownMenu open={open} onOpenChange={setOpen}><DropdownMenuContent position={{ kind: 'anchor', left: 40, right: 70, top: 40, bottom: 70, width: 30 }}>
    <AccountMenuPanel view={view} onAction={(action, value) => { actions.push({ action, value }); if (action === 'account.language' && value.kind === 'choice') setView(current => ({ ...current, locale: value.value as AccountMenuView['locale'] })) }} />
  </DropdownMenuContent></DropdownMenu>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
