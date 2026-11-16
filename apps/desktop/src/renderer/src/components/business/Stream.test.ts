import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { expressions, jsxWithAttributes } from '../../../../test-helpers/syntax.ts'

const streamSource = readFileSync(new URL('./Stream.tsx', import.meta.url), 'utf8')

test('turn preview keeps navigation before the transcript and separates one-line input from three-line answer', () => {
  assert.ok(
    streamSource.indexOf('data-testid="turn-navigation"') < streamSource.indexOf('ref={streamRef}')
  )
  const question = jsxWithAttributes(streamSource, { 'data-testid': 'turn-preview-question' })
  const answer = jsxWithAttributes(streamSource, { 'data-testid': 'turn-preview-answer' })
  assert.match(question, /\btruncate\b/)
  assert.match(answer, /\bline-clamp-3\b/)
  assert.match(question, /--vds-fw-regular/)
  assert.match(question, /--vds-font-body-lv1/)
  assert.match(question, /--vds-text-primary/)
  assert.match(answer, /--vds-text-tertiary/)
  assert.match(answer, /--vds-fw-regular/)
  expressions(question)("turn.question || t('stream.navigation.emptyQuestion')")
  expressions(answer)('turn.answer || t(TURN_NAVIGATION_STATE_MESSAGES[turn.state])')
  assert.ok(!question.includes('stream.navigation.question'))
  assert.ok(!answer.includes('stream.navigation.answer'))
})

test('subagent progress reuses main agent thinking and tool presenters', () => {
  const progress = jsxWithAttributes(streamSource, { 'data-testid': 'subagent-progress' })
  const contains = expressions(progress)
  contains('TOOL_RUN_IO_STACK_CLASS')
  assert.match(progress, /<ThinkingActivityStep/)
  contains('false', { attribute: 'selectionEnabled' })
  assert.match(progress, /<ToolStep/)
  assert.match(progress, /<IoBlock\b/)
  contains('conversation(SUBAGENT_ACTION_KEYS[key].key)', { attribute: 'label' })
})

test('turn sources sit next to the answer before artifacts and copy actions', () => {
  const message = jsxWithAttributes(streamSource, { className: 'group/message' })
  const answer = message.indexOf('<AnnotatedAnswer')
  const sources = message.indexOf('{sourcesContent}')
  const artifacts = message.indexOf('{trailingContent}')
  const actions = message.indexOf('<MessageActions')
  assert.ok(answer >= 0 && sources > answer)
  assert.ok(artifacts > sources && actions > sources)
  expressions(message)('!item.turnId', { attribute: 'showSources' })
  expressions(message)('loadAnswerImage', { attribute: 'loadRemoteImage' })
  expressions(streamSource)('loadAnswerImage', { attribute: 'loadRemoteImage' })
})

test('turn sources use the final answer anchor with a card-only fallback', () => {
  const contains = expressions(streamSource)
  contains(
    'finalAgentRows.has(index) && row.item.turnId ? renderTurnSources(row.item.turnId) : undefined'
  )
  contains(
    'turnId && !turnsWithFinalAgent.has(turnId) && !rows.slice(index + 1).some((candidate) => rowTurnId(candidate) === turnId) && renderTurnSources(turnId)'
  )
  contains("thread.sessionId && thread.turnOutcomes?.[turnId] !== 'running'", 'renderTurnSources')
  assert.equal(streamSource.match(/<TurnCitationSources\b/g)?.length, 1)
})
