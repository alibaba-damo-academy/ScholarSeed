import React from 'react'
import { Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../src/renderer/src/components/ui'
import { PREFERENCE_LANGUAGES, PREFERENCE_THEMES, type PreferenceLanguage, type PreferenceTheme } from '../src/preferences.ts'
import { isPreviewLoginMode, PREVIEW_LOGIN, type PreviewLoginMode } from './accounts.ts'
import type zh from './locales/zh.json'

function ControlSelect({ id, label, value, choices, disabled, onChange }: {
  id: string
  label: string
  value: string
  choices: readonly { id: string; title: string }[]
  disabled: boolean
  onChange: (value: string) => void
}): React.JSX.Element {
  return <div className="grid min-w-0 gap-[var(--vds-space-1)]">
    <Label htmlFor={id}>{label}</Label>
    <Select value={value} onValueChange={onChange} disabled={disabled} size="standard">
      <SelectTrigger id={id}><SelectValue /></SelectTrigger>
      <SelectContent className="!z-[var(--vds-z-modal-nested-flyout)]">{choices.map(choice => <SelectItem key={choice.id} value={choice.id}>{choice.title}</SelectItem>)}</SelectContent>
    </Select>
  </div>
}

export function PdfeControls({ theme, language, login, accountControl, pending, translate, onTheme, onLanguage, onLogin }: {
  theme: PreferenceTheme
  language: PreferenceLanguage
  login?: PreviewLoginMode
  accountControl: boolean
  pending: boolean
  translate: (key: keyof typeof zh) => string
  onTheme: (value: PreferenceTheme) => void
  onLanguage: (value: PreferenceLanguage) => void
  onLogin: (value: PreviewLoginMode) => void
}): React.JSX.Element {
  return <div role="group" aria-label={translate('publicControls')} className="grid min-w-0 grid-cols-2 gap-[var(--vds-space-2)]">
    {accountControl && <div className="col-span-2 min-w-0"><ControlSelect id="preview-login" label={translate('loginState')} value={login ?? ''} choices={PREVIEW_LOGIN.modes.map(id => ({ id, title: translate(id === 'ready' ? 'mockLoggedIn' : 'mockLoggedOut') }))} disabled={pending || login === undefined} onChange={value => { if (isPreviewLoginMode(value)) onLogin(value) }} /></div>}
    <ControlSelect id="preview-theme" label={translate('theme')} value={theme} choices={PREFERENCE_THEMES.map(id => ({ id, title: translate(id) }))} disabled={pending} onChange={value => { if (PREFERENCE_THEMES.includes(value as PreferenceTheme)) onTheme(value as PreferenceTheme) }} />
    <ControlSelect id="preview-language" label={translate('language')} value={language} choices={PREFERENCE_LANGUAGES.map(id => ({ id, title: translate(id === 'zh' ? 'chinese' : 'english') }))} disabled={pending} onChange={value => { if (PREFERENCE_LANGUAGES.includes(value as PreferenceLanguage)) onLanguage(value as PreferenceLanguage) }} />
  </div>
}
