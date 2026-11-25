import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRecoveryReport, verifyHistoryProfile } from './report.mjs'

const STARTUP_CALLER = 'startup_resume'
const FIRST_VISIBLE_AT = 1_800
const completeProjection = ['projection', 'projectionToCommit'].map((phase) => ({
  caller: STARTUP_CALLER,
  phase,
}))

function historyRequest(startedAt) {
  return { event: 'renderer_request', kind: 'history', startedAt }
}

function decodedHistory(caller) {
  return { event: 'renderer_api_timing', diagnosticEvent: 'body_decoded', caller }
}

function profileReport(records, projectionPhases = completeProjection) {
  return buildRecoveryReport({ profileHistory: true }, records, {
    desktopStartedAt: 1_000,
    heartbeatAt: null,
    observationEndedAt: 2_000,
    visibleAt: FIRST_VISIBLE_AT,
    memory: { rendererPeakKiB: 100, processPeaks: [{ role: 'serve' }] },
    firstInteraction: { inputAt: 1_850, visibleAt: 1_900 },
    projectionPhases,
  })
}

test('a startup history decode, projection and commit satisfy the cold history profile', () => {
  const report = profileReport([
    historyRequest(1_200),
    decodedHistory(STARTUP_CALLER),
    historyRequest(FIRST_VISIBLE_AT + 1),
    decodedHistory('resume'),
  ])

  assert.doesNotThrow(() => verifyHistoryProfile(report, false))
  assert.equal(report.historyProfile.requestsBeforeVisible, 1)
  assert.throws(() => verifyHistoryProfile(report, true), /Incomplete renderer history profile/)
})

test('the profile rejects a second history read before the cold transcript becomes visible', () => {
  const report = profileReport([
    historyRequest(1_200),
    historyRequest(1_400),
    decodedHistory(STARTUP_CALLER),
  ])

  assert.equal(report.historyProfile.requestsBeforeVisible, 2)
  assert.throws(() => verifyHistoryProfile(report, false), /Incomplete renderer history profile/)
})

test('the startup projection needs a matching decode and a matching commit', () => {
  const reportWithoutStartupDecode = profileReport([
    historyRequest(1_200),
    decodedHistory('resume'),
  ])
  const reportWithoutStartupCommit = profileReport(
    [historyRequest(1_200), decodedHistory(STARTUP_CALLER)],
    [completeProjection[0], { caller: 'transcript', phase: 'projectionToCommit' }]
  )

  for (const report of [reportWithoutStartupDecode, reportWithoutStartupCommit])
    assert.throws(() => verifyHistoryProfile(report, false), /Incomplete renderer history profile/)
})
