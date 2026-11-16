import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { isComposerSubmissionRejectedBeforeEnqueue, turnAdmissionFeedback } from './input.ts'
import { SESSION_OPEN_UNKNOWN } from './contracts/feedback.ts'
import { MODEL_SELECTION_UNCONFIRMED } from './api.ts'
import { runtimePreparationFailure } from './preparation.ts'

for (const [name, delivered, rejected, preparationMessage] of [
  [
    'model selection fence',
    { code: MODEL_SELECTION_UNCONFIRMED, submissionOutcome: 'rejected' },
    true,
  ],
  ['unknown-open refusal', { code: SESSION_OPEN_UNKNOWN, submissionOutcome: 'rejected' }, true],
  [
    'legacy preparation refusal',
    { preparation_error: true, submissionOutcome: 'rejected' },
    true,
    'runtimePreparation.failed',
  ],
  [
    'unsupported preparation',
    { preparation_error: true, preparation_state: 'unsupported', submissionOutcome: 'rejected' },
    true,
    'runtimeSwitch.unsupported',
  ],
  [
    'restart required preparation',
    {
      preparation_error: true,
      preparation_state: 'restart_required',
      submissionOutcome: 'rejected',
    },
    true,
    'runtimeSwitch.restartRequired',
  ],
  ['unknown transport', { code: SESSION_OPEN_UNKNOWN, submissionOutcome: 'unknown' }, false],
] as const) {
  test(`submission cleanup preserves admission evidence: ${name}`, async () => {
    const source = readFileSync(
      new URL('./components/business/Composer.tsx', import.meta.url),
      'utf8'
    )
    const parsed = ts.createSourceFile(
      'Composer.tsx',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    )
    let branch = ''
    function visit(node: ts.Node): void {
      if (
        ts.isIfStatement(node) &&
        node.expression.getText(parsed).includes('MODEL_SELECTION_UNCONFIRMED')
      )
        branch = node.getText(parsed)
      ts.forEachChild(node, visit)
    }
    visit(parsed)
    assert.ok(branch)
    const thread = {
      queuedMessages: [{ queuedMessageId: 'message' }, { queuedMessageId: 'other' }],
      conversation: ['message', 'other'],
    }
    let restored = false
    let released = false
    let launch: unknown = 'preparing'
    let foregroundError: unknown
    const context = {
      delivered,
      isComposerSubmissionRejectedBeforeEnqueue,
      turnAdmissionFeedback,
      runtimePreparationFailure,
      MODEL_SELECTION_UNCONFIRMED,
      targetSessionId: 'session',
      targetThreadId: 'thread',
      clientUserMessageId: 'message',
      releaseQueuedOutbox: () => {
        released = true
      },
      patchThread: (_id: string, update: (value: typeof thread) => object) =>
        Object.assign(thread, update(thread)),
      removeOptimisticUserMessage: (items: string[], id: string) =>
        items.filter((item) => item !== id),
      restoreDraft: () => {
        restored = true
      },
      set: (value: { turnLaunch: unknown; foregroundError: unknown }) => {
        launch = value.turnLaunch
        foregroundError = value.foregroundError
      },
      feedback: (_namespace: string, key: string) => key,
    }
    const script = ts.transpileModule(`(async () => { ${branch} return true })()`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText
    assert.equal(await runInNewContext(script, context), !rejected)
    assert.equal(released, rejected)
    assert.equal(restored, rejected)
    assert.equal(launch, rejected ? null : 'preparing')
    if (preparationMessage)
      assert.deepEqual(foregroundError, {
        ns: 'components',
        key: preparationMessage,
        values: undefined,
      })
    assert.deepEqual(
      thread.queuedMessages,
      rejected
        ? [{ queuedMessageId: 'other' }]
        : [{ queuedMessageId: 'message' }, { queuedMessageId: 'other' }]
    )
    assert.deepEqual(thread.conversation, rejected ? ['other'] : ['message', 'other'])
  })
}
