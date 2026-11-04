import '../../browser'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LocalizationProvider } from '../../app/localization'
import { selectionInstruction } from '../../../../prompts'
import { StoreProvider, useApp } from '../../store'
import { Button, ToastProvider, Toaster } from '../ui'
import { SettingsContent } from './AccountPanel'

let failNextSave = false
const savePreferences = window.scholarseed.savePreferences
window.scholarseed.savePreferences = async (...arguments_) => {
  if (failNextSave) {
    failNextSave = false
    throw new Error('Fixture save failed')
  }
  return savePreferences(...arguments_)
}

function Fixture(): React.JSX.Element {
  const { state, act } = useApp()
  const [visible, setVisible] = useState(true)
  return (
    <>
      <Button data-testid="fixture-language-en" onClick={() => void act.setLang('en')}>
        English
      </Button>
      <Button data-testid="fixture-language-zh" onClick={() => void act.setLang('zh')}>
        中文
      </Button>
      <Button
        data-testid="fixture-toggle-prompts"
        onClick={() => setVisible((current) => !current)}
      >
        Toggle prompts
      </Button>
      <Button
        data-testid="fixture-fail-save"
        onClick={() => {
          failNextSave = true
        }}
      >
        Fail next save
      </Button>
      <output data-testid="fixture-saved-prompts">{JSON.stringify(state.selectionPrompts)}</output>
      <output data-testid="fixture-instruction">
        {selectionInstruction(state.selectionPrompts, 'explain')}
      </output>
      {visible && (
        <SettingsContent
          page="prompts"
          onPage={() => undefined}
          onClose={() => setVisible(false)}
          onLogin={() => undefined}
          onLogout={async () => ({ ok: true, data: { local_cleared: true } }) as const}
        />
      )}
      <Toaster />
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <LocalizationProvider>
    <ToastProvider>
      <StoreProvider assistantSources={[]}>
        <Fixture />
      </StoreProvider>
    </ToastProvider>
  </LocalizationProvider>
)
