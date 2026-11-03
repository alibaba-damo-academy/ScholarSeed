import assert from 'node:assert/strict'
import test from 'node:test'
import { PREVIEW_CONVERSATION, previewConversationPolicy, previewConversationStream, previewConversationTool } from './conversation.ts'
import type { PreviewConversationPolicy } from './conversation.ts'

test('raw public scenes resolve through the registry without interpreting catalog identities', () => {
  for (const mode of ['chat', 'tools', 'approval', 'failure', 'streaming'] as const) {
    assert.deepEqual(previewConversationPolicy(undefined, mode), { mode })
  }
  for (const scene of [undefined, 'empty', 'unknown', 'page-home', 'conversation-stream', '__proto__', 'constructor']) {
    assert.deepEqual(previewConversationPolicy(undefined, scene), { mode: 'chat' })
  }
})

test('explicit policies are independent snapshots and take precedence over raw scenes', () => {
  const input: PreviewConversationPolicy = { mode: 'streaming', stream: 'interruptible', disconnectAfterDeltas: 3 }
  const first = previewConversationPolicy(input, 'tools')
  assert.deepEqual(first, input)
  assert.notEqual(first, input)
  input.disconnectAfterDeltas = 1
  first.stream = 'normal'
  assert.deepEqual(previewConversationPolicy({ mode: 'approval' }, 'failure'), { mode: 'approval' })
  assert.equal(first.disconnectAfterDeltas, 3)
  assert.deepEqual(previewConversationPolicy(undefined, 'streaming'), { mode: 'streaming' })
  const raw = previewConversationPolicy(undefined, 'tools')
  raw.mode = 'failure'
  assert.deepEqual(previewConversationPolicy(undefined, 'tools'), { mode: 'tools' })
})

test('default text and normal stream preserve the current service sample bytes and cadence', () => {
  assert.equal(PREVIEW_CONVERSATION.tickMs, 25)
  assert.equal(PREVIEW_CONVERSATION.reasoning, '正在准备模拟结果；不会调用真实模型。')
  assert.equal(PREVIEW_CONVERSATION.answer, '## 模拟回答\n\n这里复用真实产品组件与事件投影。\n\n- 支持主题、语言和布局检查\n- 数据仅保存在当前预览实例\n\n**这不是模型或原生能力验收。**')
  const stream = previewConversationStream({ mode: 'streaming' })
  assert.deepEqual(stream, { chunks: ['这是', '模拟流式', '回答。'], intervalMs: 25 })
  assert.equal(stream.chunks.join(''), '这是模拟流式回答。')
  assert.deepEqual(previewConversationStream({ mode: 'streaming', stream: 'normal' }), stream)
})

test('interruptible stream gives designers a visible bounded interaction window', () => {
  const stream = previewConversationStream({ mode: 'streaming', stream: 'interruptible' })
  assert.equal(stream.intervalMs, 1000)
  assert.ok(stream.chunks.length >= 12)
  assert.equal(stream.chunks[0], '开始模拟长回答。')
  assert.equal(stream.chunks.at(-1), '模拟长回答已完成。')
  assert.ok(stream.chunks.every(chunk => chunk.trim().length > 0))
  assert.ok(new Set(stream.chunks).size >= 12)
  assert.ok((stream.chunks.length - 1) * stream.intervalMs >= 11_000)
})

test('stream arrays never share mutable state across consumers or the registry', () => {
  for (const stream of ['normal', 'interruptible'] as const) {
    const policy: PreviewConversationPolicy = { mode: 'streaming', stream }
    const first = previewConversationStream(policy)
    const original = [...first.chunks]
    first.chunks.splice(0, first.chunks.length, 'changed by consumer')
    assert.deepEqual(previewConversationStream(policy).chunks, original)
  }
  assert.ok(Object.isFrozen(PREVIEW_CONVERSATION))
  assert.ok(Object.isFrozen(PREVIEW_CONVERSATION.normalChunks))
  assert.ok(Object.isFrozen(PREVIEW_CONVERSATION.interruptibleChunks))
})

test('failure recovery streams the exact default answer in independent paragraph chunks', () => {
  const policy: PreviewConversationPolicy = { mode: 'failure' }
  const first = previewConversationStream(policy)
  assert.ok(first.chunks.length > 1)
  assert.equal(first.chunks.join(''), PREVIEW_CONVERSATION.answer)
  assert.equal(first.intervalMs, PREVIEW_CONVERSATION.normalIntervalMs)
  const expected = [...first.chunks]
  first.chunks.splice(0, first.chunks.length, 'consumer mutation')
  assert.deepEqual(previewConversationStream(policy).chunks, expected)
  assert.equal(previewConversationStream({ mode: 'failure', stream: 'interruptible' }).chunks.join(''), PREVIEW_CONVERSATION.answer)
})

test('tool policies preserve original normal sample and provide bounded running and failure data without new statuses', () => {
  const normal = previewConversationTool({ mode: 'tools' })
  assert.deepEqual(normal, { name: 'read_file', runMs: 25, success: true, input: { path: 'readme.md' }, output: '模拟文件内容', answer: '已完成模拟工具调用，可检查工具展开与结果布局。', chunks: ['模拟文件内容'] })
  assert.deepEqual(previewConversationTool({ mode: 'tools', tool: 'normal' }), normal)
  assert.equal(PREVIEW_CONVERSATION.toolRunMs, 2_000)
  assert.equal(PREVIEW_CONVERSATION.submissionDelayMs, 2_000)
  const delayed = previewConversationTool({ mode: 'tools', tool: 'delayed' })
  assert.deepEqual(delayed, { ...normal, runMs: PREVIEW_CONVERSATION.toolRunMs, chunks: [...PREVIEW_CONVERSATION.toolOutputChunks] })
  const failed = previewConversationTool({ mode: 'tools', tool: 'failed' })
  assert.equal(failed.runMs, PREVIEW_CONVERSATION.toolRunMs)
  assert.equal(failed.success, false)
  assert.equal(failed.output, PREVIEW_CONVERSATION.toolFailedOutput)
  assert.equal(failed.answer, PREVIEW_CONVERSATION.toolFailureAnswer)
  assert.ok(failed.output.includes('模拟'))
  assert.ok(failed.answer.includes('模拟'))
  assert.equal(PREVIEW_CONVERSATION.submissionCancelled, 'preview_submission_cancelled')
  assert.equal(delayed.chunks.length, 2)
  assert.equal(delayed.chunks.join(''), delayed.output)
  assert.equal(failed.chunks.length, 2)
  assert.equal(failed.chunks.join(''), failed.output)
  assert.equal(Object.prototype.hasOwnProperty.call(failed, 'status'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(failed, 'turnOutcome'), false)
})

test('tool inputs and explicit submission policies cannot mutate another consumer or the sample registry', () => {
  const policy: PreviewConversationPolicy = { mode: 'tools', tool: 'delayed', submission: 'delayed' }
  const copied = previewConversationPolicy(policy)
  policy.tool = 'failed'
  policy.submission = 'normal'
  assert.deepEqual(copied, { mode: 'tools', tool: 'delayed', submission: 'delayed' })
  const first = previewConversationTool(copied)
  first.input.path = 'consumer mutation'
  first.output = 'consumer mutation'
  first.chunks.splice(0, first.chunks.length, 'consumer mutation')
  const second = previewConversationTool(copied)
  assert.deepEqual(second.input, { path: 'readme.md' })
  assert.equal(second.output, '模拟文件内容')
  assert.equal(second.chunks.join(''), second.output)
  const failed = previewConversationTool({ mode: 'tools', tool: 'failed' })
  failed.chunks.splice(0, failed.chunks.length)
  assert.equal(previewConversationTool({ mode: 'tools', tool: 'failed' }).chunks.join(''), PREVIEW_CONVERSATION.toolFailedOutput)
  assert.ok(Object.isFrozen(PREVIEW_CONVERSATION.toolInput))
  assert.ok(Object.isFrozen(PREVIEW_CONVERSATION.toolOutputChunks))
  assert.ok(Object.isFrozen(PREVIEW_CONVERSATION.toolFailedOutputChunks))
  assert.deepEqual(previewConversationPolicy(undefined, 'tools'), { mode: 'tools' })
})

test('approval resume delay is independent policy data without changing the default approval registry', () => {
  const policy: PreviewConversationPolicy = { mode: 'approval', approvalResume: 'delayed' }
  const copied = previewConversationPolicy(policy)
  policy.approvalResume = 'normal'
  assert.deepEqual(copied, { mode: 'approval', approvalResume: 'delayed' })
  assert.equal(PREVIEW_CONVERSATION.approvalResumeDelayMs, 2000)
  assert.equal(PREVIEW_CONVERSATION.tickMs, 25)
  assert.deepEqual(previewConversationPolicy(undefined, 'approval'), { mode: 'approval' })
})
