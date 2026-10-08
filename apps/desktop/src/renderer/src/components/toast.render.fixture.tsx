import { StrictMode, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'

import { createLocalization } from '../../../localization/engine'
import zhUi from '../../../localization/locales/zh/ui.json'
import { Button, ToastProvider, Toaster, useToast } from './ui'
import '../styles.css'

const localization = createLocalization('zh', { zh: { ui: zhUi } }, { report: () => undefined })

function Fixture(): React.JSX.Element {
  const { toast, toasts } = useToast()
  const [returnedId, setReturnedId] = useState('')
  const [version, setVersion] = useState(0)
  const updateCount = useRef(0)
  const repeat = (): void => {
    setReturnedId(toast({ title: '操作失败', description: '名称过长', tone: 'error' }))
  }
  const update = (): void => {
    const nextVersion = ++updateCount.current
    setVersion(nextVersion)
    setReturnedId(toast({
      id: 'editable-error',
      title: `失败详情 ${nextVersion}`,
      tone: 'error',
      action: <Button onClick={update}>更新详情</Button>
    }))
  }
  return <>
    <Button onClick={repeat}>显示错误</Button>
    <Button onClick={() => toast({ title: '另一错误', tone: 'error' })}>其他错误</Button>
    <Button onClick={update}>带操作的错误</Button>
    <Button onClick={() => toast({
      dedupeKey: 'resource-name-error',
      description: <>资源名称<span>过长</span></>,
      tone: 'error'
    })}>富文本错误</Button>
    <Button onClick={() => toast({
      title: '需要确认',
      duration: false,
      action: <Button>处理通知</Button>
    })}>常驻通知</Button>
    <Button onClick={() => { repeat(); repeat() }}>连续重复</Button>
    <Button onClick={() => setVersion(value => value + 1)}>无关更新</Button>
    <output data-testid="toast-count">{toasts.length}</output>
    <output data-testid="toast-returned-id">{returnedId}</output>
    <output data-testid="fixture-version">{version}</output>
    <Toaster />
  </>
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><I18nextProvider i18n={localization}><ToastProvider><Fixture /></ToastProvider></I18nextProvider></StrictMode>
)
