import { PREFERENCE_FIELDS } from '../../preference-diagnostics.ts'

const PREFERENCE_STATE_FIELDS = [
  ...PREFERENCE_FIELDS.filter((field) => field !== 'language'),
  'lang',
  'workbenchLayout',
]

export function preserveFrozenPreferences<State extends object>(
  current: State,
  next: State
): State {
  const preserved: Record<string, unknown> = {}
  for (const field of PREFERENCE_STATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(current, field))
      preserved[field] = Reflect.get(current, field)
  }
  return { ...next, ...preserved }
}
