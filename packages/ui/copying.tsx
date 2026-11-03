import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Button } from '../../apps/desktop/src/renderer/src/components/ui'
import type { CardState } from './contract'

type Register = (id: string, text: string | null) => void
const CopyContext = createContext<Register | null>(null)

export function useCopyContent(text: string | null): void {
  const register = useContext(CopyContext)
  const id = useId()
  useLayoutEffect(() => {
    register?.(id, text)
  }, [register, id, text])
  useLayoutEffect(
    () => () => {
      register?.(id, null)
    },
    [register, id]
  )
}

export function CopyProvider({
  snapshot,
  children
}: {
  snapshot: CardState
  children: React.ReactNode
}): React.JSX.Element {
  const { t: translate } = useTranslation('literature')
  const { t: ui } = useTranslation('ui')
  const contents = useRef(new Map<string, string>())
  const pending = useRef(Promise.resolve())
  const generation = useRef(0)
  const [version, setVersion] = useState(0)
  const [failed, setFailed] = useState(false)
  const register = useCallback<Register>((id, text) => {
    if (contents.current.get(id) === (text || undefined)) return
    if (text) contents.current.set(id, text)
    else contents.current.delete(id)
    setVersion((value) => value + 1)
  }, [])
  useEffect(() => {
    const reconnect = (): void => setVersion(value => value + 1)
    window.addEventListener('online', reconnect)
    return () => window.removeEventListener('online', reconnect)
  }, [])
  useEffect(() => {
    const requested = ++generation.current
    const text = [...contents.current.values()].join('\n\n')
    if (!text) return
    let active = true
    pending.current = pending.current
      .then(async () => {
        if (!active || requested !== generation.current) return
        await window.plugin.setCopyContent({ text })
        if (active) setFailed(false)
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
    }
  }, [version, snapshot])
  return (
    <CopyContext.Provider value={register}>
      {children}
      {failed && (
        <Alert tone="error" description={translate('copyRegistrationFailed')} action={<Button variant="secondary" onClick={() => setVersion(value => value + 1)}>{ui('retry')}</Button>} />
      )}
    </CopyContext.Provider>
  )
}
