const MESSAGES = [
  ['required', /^This field is required$/],
  ['choice', /^At least one option is required$/],
  ['email', /^Please enter a valid email$/],
  ['url', /^Please enter a valid URL$/],
  ['numeric', /^Must be a number$/],
  ['minLength', /^Must be at least (.+) characters$/],
  ['maxLength', /^Must be no more than (.+) characters$/],
  ['min', /^Must be at least (.+)$/],
  ['max', /^Must be no more than (.+)$/],
] as const

export function validationIssue(message: string): { code: typeof MESSAGES[number][0]; value?: string } | undefined {
  for (const [code, pattern] of MESSAGES) {
    const match = pattern.exec(message)
    if (match) return { code, ...(match[1] === undefined ? {} : { value: match[1] }) }
  }
  return undefined
}
