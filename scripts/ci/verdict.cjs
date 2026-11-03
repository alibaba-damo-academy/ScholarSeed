const PLATFORMS = new Set(['darwin', 'win32'])
const COMMIT_SHA = /^[a-f0-9]{40}$/
const EXTERNAL_CASES = require('./external-cases.json')
const QUARANTINE = require('./quarantine.json')
const OFFLINE_STAGE_SKIPS = new Map([
  ['ci-skillhub-prerequisites', 'skillhub_config'],
  ['python-acceptance-all', 'real_model_config'],
  ['python-acceptance-p09', 'real_model_config'],
  ['python-integration-serve', 'real_model_config'],
  ['python-skillhub', 'skillhub_config']
])

function judgeRun(run) {
  const failures = []
  const add = (reason, stage = null, caseId = null) => failures.push({ reason, stage, caseId })
  if (!PLATFORMS.has(run.platform)) add('invalid_platform')
  if (!COMMIT_SHA.test(run.commit || '')) add('invalid_commit')
  if (run.profile && !['full', 'offline'].includes(run.profile)) add('invalid_profile')
  if (run.sourceClean !== true) add('dirty_source')
  if (run.reportsIntact !== true) add('report_evidence_changed')
  if (!Array.isArray(run.expected) || run.expected.length === 0) add('zero_planned')
  if (!Array.isArray(run.stages) || run.stages.length === 0) add('zero_stages')
  if (run.plannedStages !== undefined && (!Array.isArray(run.plannedStages) ||
      run.plannedStages.length !== (run.stages || []).length ||
      run.plannedStages.some((id, index) => !id || run.stages[index]?.id !== id) ||
      new Set(run.plannedStages).size !== run.plannedStages.length)) {
    add('stage_plan_mismatch')
  }

  const expected = new Set(run.expected || [])
  if (expected.size !== (run.expected || []).length) add('duplicate_expected')
  const observed = new Set()
  for (const stage of run.stages || []) {
    const stageId = stage.id || null
    const skipped = stage.status === 'skipped'
    const allowedSkip = run.profile === 'offline' &&
      (OFFLINE_STAGE_SKIPS.get(stageId) === stage.reason ||
        (run.quarantine === true && QUARANTINE.stages.some(item =>
          item.id === stageId && item.reason === stage.reason)))
    if (stage.platform !== run.platform) add('platform_mismatch', stageId)
    if (stage.commit !== run.commit) add('commit_mismatch', stageId)
    if (skipped && !allowedSkip) add('unexpected_stage_skip', stageId)
    if (skipped ? stage.exitCode !== null : stage.exitCode !== 0) add('command_failed', stageId)
    if (stage.timedOut) add('timeout', stageId)
    if (typeof stage.report !== 'string' || !stage.report.trim()) add('missing_report', stageId)
    if (!Array.isArray(stage.cases) || stage.cases.length === 0) add('zero_executed', stageId)
    for (const caseResult of stage.cases || []) {
      if (!caseResult || typeof caseResult.id !== 'string' || !caseResult.id) {
        add('invalid_case', stageId)
        continue
      }
      if (observed.has(caseResult.id)) add('duplicate_result', stageId, caseResult.id)
      observed.add(caseResult.id)
      if (!expected.has(caseResult.id)) add('unexpected_result', stageId, caseResult.id)
      const allowedExternalCase = run.profile === 'offline' && stageId === 'desktop-e2e' &&
        caseResult.status === 'skipped' && caseResult.reason === EXTERNAL_CASES.reason &&
        EXTERNAL_CASES.cases.some(item => item.project === caseResult.project &&
          item.file === caseResult.file && item.title === caseResult.title)
      const allowedQuarantineCase = run.profile === 'offline' && run.quarantine === true &&
        caseResult.status === 'skipped' &&
        ((stageId === 'python-run-all' && QUARANTINE.suites.some(item =>
          caseResult.id === `python-run-all:${item.id}` && caseResult.reason === item.reason)) ||
          (stageId === 'desktop-e2e' && QUARANTINE.playwright.some(item =>
            item.project === caseResult.project && item.file === caseResult.file &&
            item.title === caseResult.title && item.reason === caseResult.reason)) ||
          QUARANTINE.pytest.some(item => item.stage === stageId &&
            caseResult.id === `${stageId}:${item.id}` && caseResult.reason === item.reason) ||
          (caseResult.omissionMethod === 'node-test-skip-pattern' &&
            QUARANTINE.nodeCases.some(item => (item.stage || 'desktop-unit') === stageId && item.file === caseResult.file &&
              item.title === caseResult.title && item.reason === caseResult.reason)))
      const allowedNodeSkip = caseResult.status === 'skipped' && caseResult.omissionMethod === 'node-declared-skip' &&
        QUARANTINE.nodeSkips.some(item => item.stage === stageId && item.platform === run.platform &&
          item.title === caseResult.title && item.reason === caseResult.reason &&
          (!item.quarantine || (run.profile === 'offline' && run.quarantine === true)))
      if (caseResult.status !== 'passed' && !allowedExternalCase && !allowedQuarantineCase && !allowedNodeSkip &&
          !(allowedSkip && caseResult.status === 'skipped' &&
          caseResult.reason === stage.reason && caseResult.id === stageId && stage.cases.length === 1)) {
        add('case_not_passed', stageId, caseResult.id)
      }
      if (!Number.isInteger(caseResult.retries) || caseResult.retries !== 0) {
        add('retried_case', stageId, caseResult.id)
      }
    }
  }
  for (const caseId of expected) {
    if (!observed.has(caseId)) add('missing_result', null, caseId)
  }
  return { verdict: failures.length ? 'fail' : 'pass', failures }
}

module.exports = { judgeRun }
