/**
 * MathML Core does not implement legacy script-family mathvariant values.
 * Encode the font family explicitly using Unicode Mathematical Alphanumeric
 * Symbols and its Letterlike Symbols exceptions; never guess a run's role.
 */
const FAMILIES: Readonly<Record<string, readonly [number, number, number?]>> = {
  script: [0x1d49c, 0x1d4b6],
  fraktur: [0x1d504, 0x1d51e],
  'double-struck': [0x1d538, 0x1d552, 0x1d7d8],
  'sans-serif': [0x1d5a0, 0x1d5ba, 0x1d7e2],
  monospace: [0x1d670, 0x1d68a, 0x1d7f6],
}
const LETTERLIKE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  script: {
    B: 'ℬ',
    E: 'ℰ',
    F: 'ℱ',
    H: 'ℋ',
    I: 'ℐ',
    L: 'ℒ',
    M: 'ℳ',
    R: 'ℛ',
    e: 'ℯ',
    g: 'ℊ',
    o: 'ℴ',
  },
  fraktur: { C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' },
  'double-struck': { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' },
}

export function mathFontText(text: string, family: string | null): string {
  const ranges =
    family && Object.prototype.hasOwnProperty.call(FAMILIES, family) ? FAMILIES[family] : undefined
  if (!ranges) return text
  return Array.from(text, (character) => {
    const exception = LETTERLIKE[family ?? '']?.[character]
    if (exception) return exception
    const code = character.codePointAt(0)!
    if (code >= 65 && code <= 90) return String.fromCodePoint(ranges[0] + code - 65)
    if (code >= 97 && code <= 122) return String.fromCodePoint(ranges[1] + code - 97)
    if (ranges[2] !== undefined && code >= 48 && code <= 57)
      return String.fromCodePoint(ranges[2] + code - 48)
    return character
  }).join('')
}
