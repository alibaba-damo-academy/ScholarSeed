/** Self-authored document artwork lives in assets, independently of UI tokens.
 * The registry describes legacy spreadsheet icon semantics, not Office asset reuse
 * or pixel-identical Office artwork. It does not manufacture feature UI icons. */
export interface ConditionalIconAsset {
  readonly id: string
  readonly dataUrl: string
}
const DOCUMENT_GLYPH_SPRITE = new URL('../../../assets/office/conditional.svg', import.meta.url).href
function family(name: string, offset: number, count: number): readonly ConditionalIconAsset[] {
  return Array.from({ length: count }, (_, index) => ({ id: `${name}:${index}`, dataUrl: `${DOCUMENT_GLYPH_SPRITE}#glyph-${offset + index}` }))
}

/** Each source family maps to a view in the shipped document-image asset. */
export const CONDITIONAL_ICONS: Readonly<Record<string, readonly ConditionalIconAsset[]>> = {
  '3Symbols2': family('3Symbols2', 0, 3),
  '3Arrows': family('3Arrows', 3, 3),
  '3TrafficLights1': family('3TrafficLights1', 6, 3),
  '5Quarters': family('5Quarters', 9, 5),
}
