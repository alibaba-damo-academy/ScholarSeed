import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

interface OfficeClipboardPolicy {
  install: (
    clipboard: { writeText: (text: string) => Promise<void> },
    rejected: (error: unknown) => void
  ) => void
}

function policy(): OfficeClipboardPolicy {
  const context: Record<string, unknown> = {}
  runInNewContext(
    readFileSync(new URL('./clipboard.js', import.meta.url), 'utf8'),
    context
  )
  return context.ScholarSeedOfficeClipboard as OfficeClipboardPolicy
}

test('Office user copy still reaches the browser clipboard', async () => {
  const subject = policy()
  const writes: string[] = []
  const clipboard = {
    async writeText(text: string): Promise<void> {
      assert.equal(this, clipboard)
      writes.push(text)
    }
  }
  subject.install(clipboard, error => assert.fail(String(error)))

  await clipboard.writeText('user copy')

  assert.deepEqual(writes, ['user copy'])
})

test('Office browser clipboard rejection is diagnosed without escaping as an unhandled rejection', async () => {
  const subject = policy()
  const failures: unknown[] = []
  const denied = new Error('Document is not focused')
  const clipboard = {
    async writeText(_text: string): Promise<void> {
      throw denied
    }
  }
  subject.install(clipboard, error => failures.push(error))

  await clipboard.writeText('user copy')

  assert.deepEqual(failures, [denied])
})
