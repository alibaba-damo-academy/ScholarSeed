import { oldSourceTimings } from './profiling.mjs'

const STARTUP_HISTORY_CALLER = 'startup_resume'

function recoveryOutcome(prepare, { prepared, visibleAt, heartbeatAt }) {
  if (prepare) {
    if (prepared && visibleAt !== null) return 'profile_prepared'
    return 'prepare_failed'
  }
  if (heartbeatAt !== null) return 'heartbeat_observed'
  if (visibleAt !== null) return 'history_observed'
  return 'history_unobserved'
}

function historyProfile(
  records,
  oldTurn,
  { memory, firstInteraction, projectionPhases, visibleAt },
  fromStart
) {
  const clientReads = records
    .filter((row) => row.event === 'renderer_api_timing' && row.diagnosticEvent === 'body_decoded')
    .map((row) => {
      const transfer = records.find(
        (event) =>
          event.event === 'renderer_history_downloaded' &&
          event.serverRequestId === row.server_request_id
      )
      return {
        caller: row.caller,
        responseReadAndDecodeMs: row.body_elapsed_ms,
        requestId: row.server_request_id,
        encodedBytes: transfer?.encodedBytes ?? null,
        decodedAt: row.timestamp_ms,
        downloadedAt: transfer?.at ?? null,
      }
    })
  return {
    memory,
    clientReads,
    requestsBeforeVisible:
      visibleAt === null
        ? null
        : records.filter(
            (row) =>
              row.event === 'renderer_request' &&
              row.kind === 'history' &&
              row.startedAt <= visibleAt
          ).length,
    projectionPhases,
    olderSource: oldSourceTimings(records, oldTurn),
    failure: records.find((row) => row.event === 'run_failed')?.message ?? null,
    firstClickAfterStartMs: fromStart(firstInteraction?.inputAt ?? null),
    firstClickResponseAfterStartMs: fromStart(firstInteraction?.visibleAt ?? null),
    firstClickResponseMs: firstInteraction
      ? firstInteraction.visibleAt - firstInteraction.inputAt
      : null,
  }
}

export function buildRecoveryReport(options, records, state) {
  const { desktopStartedAt, heartbeatAt } = state
  const fromStart = (at) =>
    at === null || desktopStartedAt === null ? null : Math.round(at - desktopStartedAt)
  const counts = Object.fromEntries(
    ['history', 'sources', 'session-sse'].map((kind) => [
      kind,
      records.filter((row) => row.event === 'renderer_request' && row.kind === kind).length,
    ])
  )
  const sources = records.filter(
    (row) =>
      row.event === 'serve_request' &&
      row.phase === 'headers' &&
      row.record.route?.endsWith('/sources')
  )
  const countSourcesStartedBy = (cutoffMs) => {
    if (cutoffMs === null) return null
    return sources.filter(
      ({ record }) => Number.isFinite(record.started_at) && record.started_at * 1000 <= cutoffMs
    ).length
  }
  const open = records.find((row) => row.event === 'sse_attempt' && row.stage === 'live')
  const observerArmed = records.find((row) => row.event === 'renderer_observer_attached')
  const rendererObservationComplete = Boolean(
    observerArmed &&
    counts.history > 0 &&
    !records.some(
      (row) =>
        row.event === 'renderer_api_timing' &&
        row.diagnosticEvent === 'fetch_started' &&
        row.timestamp_ms < observerArmed.observedAt
    )
  )
  const rendererSourcesBeforeHeartbeat =
    heartbeatAt === null || !rendererObservationComplete
      ? null
      : records.filter(
          (row) =>
            row.event === 'renderer_request' &&
            row.kind === 'sources' &&
            row.startedAt <= heartbeatAt
        ).length
  return {
    revision: options.revision,
    rendererSha256: state.rendererSha256,
    outcome: recoveryOutcome(options.prepare, state),
    desktopStartedAt,
    historyVisibleMs: fromStart(state.visibleAt),
    ...(options.profileHistory
      ? { historyProfile: historyProfile(records, options.oldTurn, state, fromStart) }
      : {}),
    onOpenMs: fromStart(open?.observedAt ?? null),
    firstHeartbeatMs: fromStart(heartbeatAt),
    rendererObservationComplete,
    rendererSourcesBeforeHeartbeat,
    serveSourcesWithHeadersBeforeHeartbeat: countSourcesStartedBy(heartbeatAt),
    serveSourcesWithHeadersAtObservationEnd: countSourcesStartedBy(state.observationEndedAt),
    counts,
    backendSources: sources.length,
    healthMaxMs: Math.max(
      0,
      ...records
        .filter((row) => row.event === 'health' || row.event === 'health_error')
        .map((row) => row.elapsedMs)
    ),
    sseAttempts: records
      .filter((row) => row.event === 'sse_attempt')
      .map(({ stage, sequence, attempt, observedAt }) => ({
        stage,
        sequence,
        attempt,
        elapsedMs: fromStart(observedAt),
      })),
    runtime: state.runtime,
    ownedProcessesExited: state.ownedProcessesExited,
    samples: state.samples,
    successfulSamples: records.filter(
      (row) => row.event === 'sample_finished' && row.code === 0 && row.bytes > 0
    ).length,
  }
}

export function verifyHistoryProfile({ historyProfile: profile }, checkOldSources) {
  if (!profile) return
  if (
    profile.firstClickResponseMs === null ||
    (checkOldSources && !Number.isFinite(profile.olderSource?.serveHeadersMs)) ||
    !profile.memory?.rendererPeakKiB ||
    !profile.memory.processPeaks.some((row) => row.role === 'serve') ||
    profile.requestsBeforeVisible !== 1 ||
    profile.clientReads.filter((row) => row.caller === STARTUP_HISTORY_CALLER).length !== 1 ||
    !['projection', 'projectionToCommit'].every((phase) =>
      profile.projectionPhases?.some(
        (row) => row.caller === STARTUP_HISTORY_CALLER && row.phase === phase
      )
    )
  )
    throw new Error('Incomplete renderer history profile; inspect the timeline and summary')
}

export function verifySourceLimit({ rendererSourcesBeforeHeartbeat }, maxSources) {
  if (
    maxSources !== undefined &&
    (rendererSourcesBeforeHeartbeat === null || rendererSourcesBeforeHeartbeat > maxSources)
  )
    throw new Error(
      `Expected complete renderer observation and at most ${maxSources} source requests before the first heartbeat`
    )
}
