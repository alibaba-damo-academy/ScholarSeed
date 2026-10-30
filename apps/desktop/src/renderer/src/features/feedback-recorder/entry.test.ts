import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const recorderSource = readFileSync(new URL('./Recorder.tsx', import.meta.url), 'utf8')

test('feedback entry docks between updates and notifications in the activity rail', () => {
  const railSource = readFileSync(new URL('../../shell/ActivityRail.tsx', import.meta.url), 'utf8')
  const homeSource = readFileSync(new URL('../home/HomeOverview.tsx', import.meta.url), 'utf8')
  assert.ok(railSource.indexOf('<UpdateEntry />') < railSource.indexOf('data-feedback-entry-host'))
  assert.ok(
    railSource.indexOf('data-feedback-entry-host') <
      railSource.indexOf('data-testid="activity-tasks"')
  )
  assert.doesNotMatch(homeSource, /data-feedback-entry-host/)
  assert.match(recorderSource, /data-feedback-entry-host/)
  assert.match(recorderSource, /createPortal\(entry, entryHost\)/)
  assert.match(recorderSource, /MessageCircleQuestion/)
  assert.match(recorderSource, /className=\{navigationRailButtonClassName\}/)
  assert.match(recorderSource, /onClick=\{openFeedbackForm\}/)
  const accountSource = readFileSync(
    new URL('../../components/business/AccountMenu.tsx', import.meta.url),
    'utf8'
  )
  assert.doesNotMatch(accountSource, /MENU_ACTION\.feedback|onFeedback/)
  assert.match(railSource, /ACTIVITY_BUTTON_CLASS_NAME = navigationRailButtonClassName/)
  assert.match(recorderSource, /entryHost \? 'right' : 'left'/)
  assert.match(recorderSource, /style=\{floating\.style\}/)
  assert.match(recorderSource, /\{\.\.\.floating\.handleProps\}/)
  assert.match(recorderSource, /ref=\{setEntrySurface\}/)
  assert.match(
    recorderSource,
    /phase === 'idle' \? FLOATING_EDGE_MARGIN_PX : FLOATING_PANEL_MARGIN_PX/
  )
  assert.match(recorderSource, /right-\[var\(--vds-space-4\)\]/)
  assert.match(recorderSource, /entryHost \|\| \(phase === 'idle' && !state.feedbackOpen\)/)
  assert.match(recorderSource, /background:var\(--vds-tooltip-bg\)/)
  assert.doesNotMatch(recorderSource, /vds-error/)
})
