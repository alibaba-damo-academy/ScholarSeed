import { Cognitive } from './model'

/** cognitive-category colors — single source across sidebar / recall / graph / memory */
export const TONE: Record<Cognitive, string> = {
  fact: 'var(--c-fact)',
  inference: 'var(--c-inference)',
  opinion: 'var(--c-opinion)',
  experience: 'var(--c-experience)',
  tension: 'var(--c-tension)'
}
