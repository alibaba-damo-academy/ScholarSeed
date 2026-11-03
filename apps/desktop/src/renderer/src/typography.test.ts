import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const streamSource = readFileSync(
  new URL('./components/business/Stream.tsx', import.meta.url),
  'utf8'
)
const composerSource = readFileSync(
  new URL('./components/business/Composer.tsx', import.meta.url),
  'utf8'
)
const executionSource = readFileSync(
  new URL('./components/business/Execution.tsx', import.meta.url),
  'utf8'
)
const artifactsSource = readFileSync(
  new URL('./components/business/SessionArtifacts.tsx', import.meta.url),
  'utf8'
)

function classNameForTestId(source: string, testId: string): string {
  return (
    source.match(new RegExp(`<[^>]+className="([^"]*)"[^>]+data-testid="${testId}"[^>]*>`))?.[1] ??
    ''
  )
}

test('conversation product counts and durations use the default font', () => {
  for (const testId of ['tool-run-step-duration', 'turn-duration']) {
    const className = classNameForTestId(
      testId === 'tool-run-step-duration' ? executionSource : streamSource,
      testId
    )
    assert.notEqual(className, '')
    assert.doesNotMatch(className, /font-mono|tabular-nums/)
  }
  assert.doesNotMatch(
    composerSource,
    /skillCandidates\.length[\s\S]{0,500}font-variant-numeric:tabular-nums/
  )
  assert.doesNotMatch(
    artifactsSource,
    /TASK_BLOCK_COUNT_CLASS_NAME\s*=\s*'[^']*(?:font-mono|tabular-nums)/
  )
})

test('subagent progress reuses main agent thinking and tool presenters', () => {
  const progress = streamSource.slice(
    streamSource.indexOf('{progress.length ? ('),
    streamSource.indexOf('function WebSearchStep(')
  )
  assert.match(
    progress,
    /className=\{TOOL_RUN_IO_STACK_CLASS\}[\s\S]*?data-testid="subagent-progress"/
  )
  assert.match(progress, /<ThinkingActivityStep/)
  assert.match(progress, /selectionEnabled=\{false\}/)
  assert.match(progress, /<ToolStep/)
  assert.match(progress, /<IoBlock label=\{t\('stream.details'\)\}/)
})
