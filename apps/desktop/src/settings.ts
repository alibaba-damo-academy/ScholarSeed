import { BROWSER_SETTINGS_SECTIONS, type AccountSettingsPage, type BrowserSettingsSection } from './navigation.ts'
import { PREFERENCE_LANGUAGES, PREFERENCE_THEMES, type PreferenceLanguage, type PreferenceTheme } from './preferences.ts'

export const SETTINGS_VISIBLE_PAGES = [
  'notifications', 'prompts', 'models', 'skills', 'developer', 'browser', 'files', 'storage', 'archives', 'about'
] as const satisfies readonly AccountSettingsPage[]
export type SettingsPage = typeof SETTINGS_VISIBLE_PAGES[number]
export type SettingsTheme = Exclude<PreferenceTheme, 'system'>
export const SETTINGS_INPUT_MODES = ['blocked', 'settings', 'product-modal', 'none'] as const
export type SettingsInputMode = typeof SETTINGS_INPUT_MODES[number]
export const SETTINGS_SUSPEND_REASONS = [
  'window-blur', 'window-minimize', 'window-hide', 'window-close', 'language-switch', 'skills-login',
  'protected-vault', 'system-chooser', 'subscription-window'
] as const
export type SettingsSuspendReason = typeof SETTINGS_SUSPEND_REASONS[number]
export const SETTINGS_REVOKE_REASONS = [
  'product-navigation', 'product-crash', 'window-destroy', 'host-dispose', 'explicit-close', 'cleanup-failed'
] as const
export type SettingsRevokeReason = typeof SETTINGS_REVOKE_REASONS[number]
export const SETTINGS_CLOSE_REASONS = ['close-button', 'escape', 'outside', 'explicit-close'] as const
export type SettingsCloseReason = typeof SETTINGS_CLOSE_REASONS[number]
export const SETTINGS_SEQUENCE_TERMINALS = ['pointer-click', 'pointer-cancel', 'key-up'] as const
export type SettingsSequenceTerminal = typeof SETTINGS_SEQUENCE_TERMINALS[number]
export const SETTINGS_QUALIFICATION_STATUSES = ['ready', 'unavailable'] as const
export const SETTINGS_ID_CHARACTERS = '00000000-0000-4000-8000-000000000000'.length
const SETTINGS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const INITIAL_REVISION = 0
const FIRST_GENERATION = 1
const RESOLVED_THEMES = PREFERENCE_THEMES.filter(theme => theme !== 'system')

export type SettingsHostIdentity = Readonly<{
  ownerId: string
  windowGeneration: number
  productDocumentGeneration: number
}>
export type SettingsLease = SettingsHostIdentity & Readonly<{
  sessionId: string
  pageEpoch: number
  inputGeneration: number
  requestId: string
  authGeneration: number
  backendGeneration: number
  projectRevision: number
  catalogRevision: number
}>
export type SettingsMessage =
  | ({ kind: 'bootstrap'; language: PreferenceLanguage; theme: SettingsTheme } & SettingsHostIdentity)
  | ({ kind: 'qualification'; status: typeof SETTINGS_QUALIFICATION_STATUSES[number] } & SettingsHostIdentity)
  | { kind: 'reserve'; lease: SettingsLease; page: SettingsPage; section: BrowserSettingsSection | null }
  | { kind: 'paint'; lease: SettingsLease; presentationRevision: number }
  | { kind: 'input-lease'; lease: SettingsLease; mode: SettingsInputMode }
  | { kind: 'close'; lease: SettingsLease; reason: Exclude<SettingsCloseReason, 'explicit-close'>; sequenceId: string }
  | { kind: 'close'; lease: SettingsLease; reason: 'explicit-close' }
  | { kind: 'sequence-terminal'; lease: SettingsLease; sequenceId: string; terminal: SettingsSequenceTerminal }
  | { kind: 'suspend'; lease: SettingsLease; reason: SettingsSuspendReason }
  | { kind: 'revoke'; lease: SettingsLease; reason: SettingsRevokeReason }

type FieldParser = (value: unknown) => boolean
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string'
    || !('value' in Object.getOwnPropertyDescriptor(value, key)!))) return null
  return value as Record<string, unknown>
}
function uuid(value: unknown): boolean {
  return typeof value === 'string' && value.length === SETTINGS_ID_CHARACTERS && SETTINGS_UUID.test(value)
}
function counter(value: unknown, minimum: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}
const generation: FieldParser = value => counter(value, FIRST_GENERATION)
const revision: FieldParser = value => counter(value, INITIAL_REVISION)
function member(values: readonly string[]): FieldParser {
  return value => typeof value === 'string' && values.includes(value)
}
function parseFields(value: unknown, fields: Readonly<Record<string, FieldParser>>): Record<string, unknown> | null {
  const input = record(value)
  if (!input || Reflect.ownKeys(input).length !== Object.keys(fields).length
    || Object.entries(fields).some(([name, parse]) => !Object.hasOwn(input, name) || !parse(input[name]))) return null
  return Object.fromEntries(Object.keys(fields).map(name => [name, input[name]]))
}
const HOST_FIELDS = { ownerId: uuid, windowGeneration: generation, productDocumentGeneration: generation } as const
const LEASE_FIELDS = {
  ...HOST_FIELDS, sessionId: uuid, pageEpoch: generation, inputGeneration: generation, requestId: uuid,
  authGeneration: revision, backendGeneration: revision, projectRevision: revision, catalogRevision: revision
} as const
export function parseSettingsLease(value: unknown): SettingsLease | null {
  return parseFields(value, LEASE_FIELDS) as SettingsLease | null
}
const MESSAGE_FIELDS: Readonly<Record<SettingsMessage['kind'], Readonly<Record<string, FieldParser>>>> = {
  bootstrap: { ...HOST_FIELDS, language: member(PREFERENCE_LANGUAGES), theme: member(RESOLVED_THEMES) },
  qualification: { ...HOST_FIELDS, status: member(SETTINGS_QUALIFICATION_STATUSES) },
  reserve: { lease: value => parseSettingsLease(value) !== null, page: member(SETTINGS_VISIBLE_PAGES),
    section: value => value === null || member(BROWSER_SETTINGS_SECTIONS)(value) },
  paint: { lease: value => parseSettingsLease(value) !== null, presentationRevision: generation },
  'input-lease': { lease: value => parseSettingsLease(value) !== null, mode: member(SETTINGS_INPUT_MODES) },
  close: { lease: value => parseSettingsLease(value) !== null, reason: member(SETTINGS_CLOSE_REASONS), sequenceId: uuid },
  'sequence-terminal': { lease: value => parseSettingsLease(value) !== null, sequenceId: uuid, terminal: member(SETTINGS_SEQUENCE_TERMINALS) },
  suspend: { lease: value => parseSettingsLease(value) !== null, reason: member(SETTINGS_SUSPEND_REASONS) },
  revoke: { lease: value => parseSettingsLease(value) !== null, reason: member(SETTINGS_REVOKE_REASONS) }
}
export function parseSettingsMessage(value: unknown): SettingsMessage | null {
  const input = record(value)
  if (!input || typeof input.kind !== 'string' || !Object.hasOwn(MESSAGE_FIELDS, input.kind)) return null
  const kind = input.kind as SettingsMessage['kind']
  const fields = kind === 'close' && input.reason === 'explicit-close'
    ? { lease: MESSAGE_FIELDS.close.lease, reason: member(['explicit-close']) } : MESSAGE_FIELDS[kind]
  const parsed = parseFields(input, { kind: member([kind]), ...fields })
  if (!parsed) return null
  if (kind === 'reserve' && (parsed.page === 'browser'
    ? !member(BROWSER_SETTINGS_SECTIONS)(parsed.section) : parsed.section !== null)) return null
  if ('lease' in parsed) parsed.lease = parseSettingsLease(parsed.lease)
  return parsed as SettingsMessage
}
export function settingsLeaseMatches(value: unknown, current: unknown): boolean {
  const candidate = parseSettingsLease(value)
  const authoritative = parseSettingsLease(current)
  return candidate !== null && authoritative !== null
    && (Object.keys(LEASE_FIELDS) as (keyof SettingsLease)[]).every(field => candidate[field] === authoritative[field])
}
export function visibleSettingsPages(policy: { settingsAvailable(page: string): boolean }): readonly SettingsPage[] {
  return SETTINGS_VISIBLE_PAGES.filter(page => policy.settingsAvailable(page))
}
