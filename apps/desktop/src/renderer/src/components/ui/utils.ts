export function cx(...values: Array<false | null | string | undefined>): string {
  return values.filter(Boolean).join(' ')
}

const OVERRIDABLE_CLASS_GROUPS = [
  /^!?w-/,
  /^!?gap(?:-[xy])?-/,
  /^!?flex-(wrap|nowrap|wrap-reverse)$/
]

function classGroup(value: string): number {
  return OVERRIDABLE_CLASS_GROUPS.findIndex((pattern) => pattern.test(value))
}

export function cxWithOverrides(
  defaults: string,
  className?: false | null | string
): string {
  if (!className) return defaults

  const overrideGroups = new Set(
    className
      .split(/\s+/)
      .map(classGroup)
      .filter((group) => group >= 0)
  )

  if (overrideGroups.size === 0) return cx(defaults, className)

  return cx(
    defaults
      .split(/\s+/)
      .filter((value) => !overrideGroups.has(classGroup(value)))
      .join(' '),
    className
  )
}
