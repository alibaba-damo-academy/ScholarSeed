import { createRoot } from 'react-dom/client'
import { useRef, useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import '../../browser'
import '../../styles.css'
import { createLocalization } from '../../../../localization/engine'
import { resources } from '../../../../localization/resources'
import {
  menuActions,
  type MenuBridge,
  type MenuEvent,
  type MenuModel,
  type MenuReply,
  type MenuDismissReason,
  type MenuAck,
  type MenuActionResult,
} from '../../../../menu'
import { StoreContext } from '../../storeContext'
import type { Store } from '../../store'
import { AccountMenu } from './AccountMenu'
import { Button, ToastProvider, Toaster } from '../ui'
import { setAccountBase } from '../../account'

const query = new URLSearchParams(window.location.search)
const native = query.has('native')
const failed = query.has('failed')
const dirty = query.has('dirty')
const log: string[] = []
const models: MenuModel[] = []
const events = new Set<(event: MenuEvent) => void>()
const revoked = new Set<(event: MenuAck & { reason: MenuDismissReason }) => void>()
const results = new Set<(result: MenuActionResult) => void>()
let current: MenuModel | null = null
let revision = 0
const paints: ((reply: MenuReply) => void)[] = []
const seeds: (() => void)[] = []
if (query.has('credits')) {
  setAccountBase(window.location.origin)
  window.scholarseed.getAuthToken = async () => 'fixture-only-token'
}
const bridge: MenuBridge = {
  presentation: async () => {
    if (query.has('presentationerror')) throw new Error('private transport detail')
    return query.has('unavailable')
      ? { ok: false, revision: 1, error: 'menu_revoked' }
      : { ok: true, revision: 1, presentation: native ? 'native' : 'inline' }
  },
  subscribePresentation: () => () => undefined,
  seed: async (request) => {
    if (query.has('deferredseed'))
      await new Promise<void>((resolve) => {
        seeds.push(resolve)
      })
    return failed
      ? { ok: false, error: 'menu_failed' }
      : {
          ok: true,
          seed: {
            sessionId: `account-${++revision}`,
            revision,
            target: {
              kind: 'account',
              identityRevision: request.surface === 'account-menu' ? request.identityRevision : 1,
            },
          },
        }
  },
  publish: (model) => {
    current = model
    models.push(model)
    return new Promise((resolve) => {
      paints.push(resolve)
    })
  },
  dismiss: async (reason) => {
    log.push(`dismiss:${reason}`)
    if (current)
      revoked.forEach((callback) =>
        callback({ sessionId: current!.sessionId, revision: current!.revision, reason })
      )
    current = null
  },
  subscribe: (callback) => {
    events.add(callback)
    return () => {
      events.delete(callback)
    }
  },
  subscribeRevoked: (callback) => {
    revoked.add(callback)
    return () => {
      revoked.delete(callback)
    }
  },
  subscribeResult: (callback) => {
    results.add(callback)
    return () => {
      results.delete(callback)
    }
  },
}
window.scholarseed.menu = bridge
Object.assign(window, {
  accountHostLog: log,
  accountHostModels: models,
  revokeAccount: (reason: MenuDismissReason) => {
    if (current)
      revoked.forEach((callback) =>
        callback({ sessionId: current!.sessionId, revision: current!.revision, reason })
      )
  },
  accountHostSeeds: seeds,
  seedAccount: (index = seeds.length - 1) => seeds[index]?.(),
  paintAccount: (index = models.length - 1) => {
    const model = models[index]
    if (model)
      paints[index]({ ok: true, ack: { sessionId: model.sessionId, revision: model.revision } })
  },
  accountAction: (actionId: string) => {
    if (!current) return
    const approved = current
    const item = menuActions(approved.items).find((item) => item.actionId === actionId)
    if (item)
      events.forEach((callback) =>
        callback({
          kind: 'action',
          sessionId: approved.sessionId,
          revision: approved.revision,
          requestId: crypto.randomUUID(),
          actionId,
          value: item.value,
        })
      )
  },
})
const localization = createLocalization('zh', resources, { report: () => undefined })
function Fixture(): JSX.Element {
  const [open, setOpen] = useState(true)
  const [identityRevision, setIdentityRevision] = useState(1)
  const [lang, setLang] = useState<'en' | 'zh'>('zh')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const trigger = useRef<HTMLButtonElement | null>(null)
  Object.assign(window, {
    changeAccountIdentity: () => setIdentityRevision((value) => value + 1),
    reopenAccount: () => setOpen(true),
    accountHostOpen: open,
    updateAccountView: (value: { busy: boolean; error: string; lang: 'en' | 'zh' }) => {
      setBusy(value.busy)
      setError(value.error)
      setLang(value.lang)
    },
    finishLogout: () => {
      setBusy(false)
      setError('退出失败，请重试')
    },
  })
  const store = {
    state: { lang },
    act: {
      setLang: async (value: 'en' | 'zh', beforeConfirmation?: () => Promise<void>) => {
        if (dirty) {
          await beforeConfirmation?.()
          log.push('language-confirmation')
          return
        }
        setLang(value)
      },
    },
  } as unknown as Store
  return (
    <I18nextProvider i18n={localization}>
      <ToastProvider>
        <StoreContext.Provider value={store}>
          <Button
            ref={trigger}
            aria-controls="account-menu"
            onClick={() => setOpen((value) => !value)}
          >
            Account
          </Button>
          <AccountMenu
            user={{ user_id: 'private-user', email: 'private@example.invalid', auth: true }}
            profile={{ user_id: 'private-user', nickname: 'Private', phone: '13812348001' }}
            cloudBase="https://private.example.invalid"
            identityRevision={identityRevision}
            open={open}
            trigger={trigger}
            onClose={() => {
              log.push('close')
              setOpen(false)
            }}
            logoutBusy={busy}
            logoutError={error}
            onLogout={async () => {
              log.push('logout')
              setBusy(true)
              return false
            }}
            onLogin={() => log.push('login')}
            onSettings={() => log.push('settings')}
            onGuide={() => log.push('guide')}
            onOpenProfile={() => log.push('profile')}
            onOpenCredits={() => log.push('credits')}
          />
        </StoreContext.Provider>
        <Toaster />
      </ToastProvider>
    </I18nextProvider>
  )
}
const root = createRoot(document.getElementById('root')!)
Object.assign(window, { disposeAccount: () => root.unmount() })
root.render(<Fixture />)
