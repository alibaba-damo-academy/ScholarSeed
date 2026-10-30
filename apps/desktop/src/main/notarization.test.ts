import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NotarizationError,
  notarizationHash,
  verifyNotarization,
  NOTARIZATION_TICKET_LIMIT,
} from './notarization.ts'

const hashes = [Buffer.alloc(20, 1)]
async function fixture(run: (path: string, ticket: string) => Promise<void>) {
  const path = await mkdtemp(join(tmpdir(), 'offline-ticket-'))
  try {
    await mkdir(join(path, 'Contents'))
    const ticket = join(path, 'Contents/CodeResources')
    await writeFile(ticket, 'exact attached ticket')
    await run(path, ticket)
  } finally {
    await rm(path, { recursive: true, force: true })
  }
}
const verdict = (expected: string) => (error: unknown) =>
  error instanceof NotarizationError && error.verdict === expected

test('code directory extraction requires a unique SHA-256 digest and handles CRLF', () => {
  const hash = 'ab'.repeat(20)
  assert.equal(
    notarizationHash(`Hash type=sha256 size=32\r\nCDHash=${hash}\r\n`).toString('hex'),
    hash
  )
  for (const metadata of [
    '',
    `Hash type=sha1 size=20\nCDHash=${hash}`,
    `Hash type=sha256 size=32\nCDHash=${hash}\nCDHash=${hash}`,
  ])
    assert.throws(() => notarizationHash(metadata), NotarizationError)
})

test('reads the exact attached bytes and awaits native verification', async () =>
  fixture(async (appPath) => {
    let completed = false
    await verifyNotarization({
      appPath,
      hashes,
      timeoutMs: 1000,
      native: {
        verifySignature: async () => {},
        verify: async (ticket, actualHashes) => {
          assert.equal(ticket.toString(), 'exact attached ticket')
          assert.deepEqual(actualHashes, hashes)
          await new Promise((resolve) => setTimeout(resolve, 5))
          completed = true
        },
      },
    })
    assert.equal(completed, true)
  }))

test('missing verifier is unavailable, never offline success', async () => {
  await assert.rejects(
    verifyNotarization({ appPath: '/unused', hashes, timeoutMs: 100, native: undefined }),
    verdict('unavailable')
  )
})

for (const code of ['ERR_NOTARIZATION_UNTRUSTED', 'ERR_NOTARIZATION_UNAVAILABLE', 'EIO']) {
  test(`native rejection ${code} is propagated without retry or bypass`, async () =>
    fixture(async (appPath) => {
      let calls = 0
      await assert.rejects(
        verifyNotarization({
          appPath,
          hashes,
          timeoutMs: 1000,
          native: {
            verifySignature: async () => {},
            verify: async () => {
              calls++
              throw Object.assign(new Error('rejected'), { code })
            },
          },
        }),
        verdict(
          code.endsWith('UNTRUSTED')
            ? 'untrusted'
            : code.endsWith('UNAVAILABLE')
              ? 'unavailable'
              : 'indeterminate'
        )
      )
      assert.equal(calls, 1)
    }))
}

for (const kind of ['missing', 'empty', 'oversize', 'symlink']) {
  test(`${kind} ticket cannot reach the trust evaluator`, async () =>
    fixture(async (appPath, ticket) => {
      if (kind === 'missing' || kind === 'symlink') await rm(ticket)
      if (kind === 'empty') await writeFile(ticket, '')
      if (kind === 'oversize') await writeFile(ticket, Buffer.alloc(NOTARIZATION_TICKET_LIMIT + 1))
      if (kind === 'symlink') await symlink('other-ticket', ticket)
      await assert.rejects(
        verifyNotarization({
          appPath,
          hashes,
          timeoutMs: 1000,
          native: {
            verifySignature: async () => {},
            verify: async () => assert.fail('must not verify'),
          },
        }),
        verdict('untrusted')
      )
    }))
}

test('timeout never grants trust even if the read-only worker later succeeds', async () =>
  fixture(async (appPath) => {
    let finish!: () => void
    await assert.rejects(
      verifyNotarization({
        appPath,
        hashes,
        timeoutMs: 20,
        native: {
          verifySignature: async () => {},
          verify: () =>
            new Promise<void>((resolve) => {
              finish = resolve
            }),
        },
      }),
      verdict('indeterminate')
    )
    finish()
  }))

test('cancellation propagates unchanged and cannot become a signature verdict', async () =>
  fixture(async (appPath) => {
    const controller = new AbortController()
    const reason = new Error('superseded')
    await assert.rejects(
      verifyNotarization({
        appPath,
        hashes,
        timeoutMs: 1000,
        signal: controller.signal,
        native: {
          verifySignature: async () => {},
          verify: async () => {
            controller.abort(reason)
          },
        },
      }),
      (error) => error === reason
    )
  }))
