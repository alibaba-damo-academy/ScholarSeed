import { Buffer } from 'node:buffer'

export const BADGE_SIZE = 16
const BADGE_RADIUS = 8
const BADGE_CENTER = 7.5
const BADGE_TEXT_TOP = 5
const BADGE_GLYPH_WIDTH = 3
const BADGE_GLYPH_HEIGHT = 5
const BADGE_GLYPH_SPACING = 1
const BADGE_COUNT_LIMIT = 99
const BADGE_BACKGROUND = [52, 43, 239, 255] as const
const BADGE_FOREGROUND = [255, 255, 255, 255] as const
const BADGE_RESTORE_EVENTS = ['show', 'restore'] as const
const BADGE_GLYPHS: Record<string, readonly string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
}

interface BadgeWindow {
  on(event: 'show' | 'restore', listener: () => void): unknown
  removeListener(event: 'show' | 'restore', listener: () => void): unknown
}

export function watchBadgeRestore(window: BadgeWindow, count: () => number, apply: (value: number) => void): () => void {
  const restore = () => {
    const value = count()
    if (value >= 0) apply(value)
  }
  for (const event of BADGE_RESTORE_EVENTS) window.on(event, restore)
  return () => {
    for (const event of BADGE_RESTORE_EVENTS) window.removeListener(event, restore)
  }
}

export function badgeLabel(count: number): string {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Invalid badge count')
  return count > BADGE_COUNT_LIMIT ? `${BADGE_COUNT_LIMIT}+` : String(count)
}

export function badgeBitmap(count: number): Buffer {
  const label = badgeLabel(count)
  const bitmap = Buffer.alloc(BADGE_SIZE * BADGE_SIZE * 4)
  if (!count) return bitmap
  for (let row = 0; row < BADGE_SIZE; row++) {
    for (let column = 0; column < BADGE_SIZE; column++) {
      if ((column - BADGE_CENTER) ** 2 + (row - BADGE_CENTER) ** 2 <= BADGE_RADIUS ** 2)
        bitmap.set(BADGE_BACKGROUND, (row * BADGE_SIZE + column) * 4)
    }
  }
  const width = label.length * (BADGE_GLYPH_WIDTH + BADGE_GLYPH_SPACING) - BADGE_GLYPH_SPACING
  const left = Math.floor((BADGE_SIZE - width) / 2)
  for (let digit = 0; digit < label.length; digit++) {
    const glyph = BADGE_GLYPHS[label[digit]]
    for (let row = 0; row < BADGE_GLYPH_HEIGHT; row++) {
      for (let column = 0; column < BADGE_GLYPH_WIDTH; column++) {
        if (glyph[row][column] !== '1') continue
        const pixel = (BADGE_TEXT_TOP + row) * BADGE_SIZE + left + digit * (BADGE_GLYPH_WIDTH + BADGE_GLYPH_SPACING) + column
        bitmap.set(BADGE_FOREGROUND, pixel * 4)
      }
    }
  }
  return bitmap
}
