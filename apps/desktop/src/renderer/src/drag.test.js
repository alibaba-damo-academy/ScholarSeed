import { describe, expect, test } from 'bun:test'
import { hasDraggedFiles } from './drag'

describe('composer drag helpers', () => {
  test('detects real files in a drag payload', () => {
    expect(hasDraggedFiles({
      items: [{ kind: 'string' }, { kind: 'file' }],
      files: []
    })).toBe(true)
  })

  test('ignores non-file drag payloads', () => {
    expect(hasDraggedFiles({
      items: [{ kind: 'string' }],
      files: []
    })).toBe(false)
  })
})
