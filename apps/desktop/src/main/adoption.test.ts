import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ADOPTION_STAGE, reportAdoptionFailure } from './adoption.ts'

function diagnostic(stage: (typeof ADOPTION_STAGE)[keyof typeof ADOPTION_STAGE], error: unknown) {
  const lines: string[] = []
  reportAdoptionFailure((line) => lines.push(line), stage, error)
  assert.equal(lines.length, 1)
  return JSON.parse(lines[0].slice(lines[0].indexOf('{')))
}

test('Windows rename rejection retains stage and system error without credential paths', () => {
  const detail = diagnostic(
    ADOPTION_STAGE.refreshWrite,
    Object.assign(new Error('EPERM token=secret-refresh C:\\Users\\private\\auth-refresh.enc'), {
      code: 'EPERM',
      syscall: 'rename',
      systemCode: 5,
      path: 'private-path',
    })
  )
  assert.deepEqual(detail, {
    stage: 'refresh-write',
    code: 'EPERM',
    syscall: 'rename',
    systemCode: 5,
  })
})

test('workbench rejection is distinguished from storage and cookie errors', () => {
  assert.deepEqual(diagnostic(ADOPTION_STAGE.workbench, new Error('ERR_WORKBENCH_NOT_READY')), {
    stage: 'workbench',
    code: 'ERR_WORKBENCH_NOT_READY',
  })
  assert.deepEqual(diagnostic(ADOPTION_STAGE.cookie, new Error('Cookie secret-access rejected')), {
    stage: 'cookie-write',
    code: 'unknown',
  })
})

test('every adoption boundary has a distinct diagnostic stage', () => {
  const stages = Object.values(ADOPTION_STAGE)
  assert.equal(new Set(stages).size, stages.length)
  for (const stage of stages) {
    assert.equal(diagnostic(stage, new Error('failure')).stage, stage)
  }
})

test('untrusted error properties and primitive exceptions cannot disclose credentials', () => {
  for (const error of [
    null,
    'secret-token',
    {
      code: 'secret-code',
      message: 'secret-message',
      syscall: 'secret-syscall',
      systemCode: 'secret-system-code',
      stack: 'secret-stack',
      cause: 'secret-cause',
    },
  ]) {
    assert.deepEqual(diagnostic(ADOPTION_STAGE.identity, error), {
      stage: 'identity-notification',
      code: 'unknown',
    })
  }
})

test('failed diagnostic sink cannot replace the authentication failure', () => {
  assert.doesNotThrow(() =>
    reportAdoptionFailure(
      () => {
        throw new Error('logging unavailable')
      },
      ADOPTION_STAGE.refreshWrite,
      new Error('original')
    )
  )
  assert.doesNotThrow(() =>
    reportAdoptionFailure(() => {}, ADOPTION_STAGE.refreshWrite, {
      get code() {
        throw new Error('invalid error property')
      },
    })
  )
})

test('native writer failures preserve safe native code and numeric system detail', () => {
  assert.deepEqual(
    diagnostic(ADOPTION_STAGE.refreshWrite, {
      code: 'ERR_LEASE_PERMISSION',
      systemCode: 5,
    }),
    { stage: 'refresh-write', code: 'ERR_LEASE_PERMISSION', systemCode: 5 }
  )
  assert.deepEqual(
    diagnostic(ADOPTION_STAGE.refreshWrite, {
      code: 'ERR_LEASE_RELEASE',
      systemCode: NaN,
    }),
    { stage: 'refresh-write', code: 'ERR_LEASE_RELEASE' }
  )
})

test('main adoption catch persists diagnosis before its error is reduced to a boolean', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  const adoption = source.slice(
    source.indexOf('async function adoptAuthTokens('),
    source.indexOf('async function reportHandoffOutcome(')
  )
  for (const stage of [
    'workbench',
    'refreshRead',
    'refreshWrite',
    'identity',
    'cookie',
    'synchronize',
  ]) {
    assert.ok(adoption.includes(`ADOPTION_STAGE.${stage}`))
  }
  assert.match(adoption, /reportAdoptionFailure\(logWindowLifecycle, stage, e\)/)
  assert.match(adoption, /return \{ ok: false, error: String\(e\) \}/)
})
