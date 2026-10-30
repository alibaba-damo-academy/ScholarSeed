const { pathToFileURL } = require('node:url')
const HEADER = 'ci:node-start'
const FOOTER = 'ci:node-end'
const SCHEMA_VERSION = 1
const EVENTS = new Set(['test:start', 'test:pass', 'test:fail', 'test:summary'])
const RESULTS = new Set(['test:pass', 'test:fail'])
const CANCELLED = new Set(['cancelledByParent', 'testTimeoutFailure', 'testAborted'])
const STATUSES = ['passed', 'failed', 'cancelled', 'skipped', 'todo']
const COUNT_KEYS = ['tests', ...STATUSES, 'suites', 'topLevel']

function ensure(condition, message) {
  if (!condition) throw new Error(`Node observations: ${message}`)
}

function project(event) {
  const data = event.data
  if (event.type === 'test:summary') {
    return { type: event.type, data: { file: data.file, counts: data.counts,
      success: data.success, duration_ms: data.duration_ms } }
  }
  return { type: event.type, data: {
    file: data.file, line: data.line, column: data.column, name: data.name,
    nesting: data.nesting, testId: data.testId, testNumber: data.testNumber,
    skip: data.skip, todo: data.todo,
    ...(data.details ? { details: { type: data.details.type,
      duration_ms: data.details.duration_ms, errorCode: data.details.error?.code,
      failureType: data.details.error?.failureType, attempt: data.details.attempt } } : {})
  } }
}

async function* reporter(source) {
  yield `${JSON.stringify({ type: HEADER, schemaVersion: SCHEMA_VERSION, nodeVersion: process.version })}\n`
  for await (const event of source) {
    if (EVENTS.has(event.type)) yield `${JSON.stringify(project(event))}\n`
  }
  yield `${JSON.stringify({ type: FOOTER })}\n`
}

function summary(data) {
  ensure(data && typeof data === 'object', 'missing summary')
  ensure(typeof data.success === 'boolean', 'missing framework verdict')
  ensure(Number.isFinite(data.duration_ms) && data.duration_ms >= 0, 'invalid summary duration')
  const counts = Object.fromEntries(COUNT_KEYS.map(key => [key, data.counts?.[key]]))
  ensure(COUNT_KEYS.every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0),
    'invalid framework counts')
  ensure(STATUSES.reduce((total, key) => total + counts[key], 0) === counts.tests,
    'inconsistent framework counts')
  return { counts, success: data.success, durationMs: data.duration_ms }
}

function parseNodeEvents(output, stageId) {
  ensure(typeof output === 'string' && output.endsWith('\n'), 'incomplete transport')
  ensure(typeof stageId === 'string' && stageId.length > 0, 'missing stage identity')
  const events = output.trimEnd().split('\n').map(line => {
    try {
      return JSON.parse(line)
    } catch {
      throw new Error('Node observations: malformed JSON event')
    }
  })
  const header = events.shift()
  ensure(header?.type === HEADER && header.schemaVersion === SCHEMA_VERSION &&
    typeof header.nodeVersion === 'string' && header.nodeVersion.length > 0, 'invalid header')
  ensure(events.pop()?.type === FOOTER, 'missing completion marker')
  const active = []
  const records = []
  const occurrences = new Map()
  const fileSummaries = []
  let pending = []
  let cumulative = null
  for (const event of events) {
    ensure(event && EVENTS.has(event.type), 'unknown event')
    const data = event.data
    ensure(data && typeof data === 'object', 'missing event data')
    ensure(cumulative === null, 'event after cumulative summary')
    if (event.type === 'test:summary') {
      const value = summary(data)
      if (data.file !== undefined) {
        ensure(typeof data.file === 'string' && data.file.length > 0, 'invalid summary source')
        checkCounts(pending, value.counts)
        pending = []
        fileSummaries.push({ file: data.file, ...value })
      } else {
        ensure(cumulative === null, 'duplicate cumulative summary')
        cumulative = value
      }
      continue
    }
    ensure(Number.isSafeInteger(data.nesting) && data.nesting >= 0, 'invalid nesting')
    ensure(Number.isSafeInteger(data.testId) && data.testId >= 0, 'invalid runtime identity')
    ensure(typeof data.name === 'string', 'invalid case title')
    ensure(data.file === undefined || typeof data.file === 'string', 'invalid declared source')
    ensure([data.line, data.column].every(value => value === undefined ||
      (Number.isSafeInteger(value) && value > 0)), 'invalid source location')
    if (event.type === 'test:start') {
      ensure(data.nesting === active.length, 'missing parent or result')
      active.push({ name: data.name, file: data.file, testId: data.testId,
        titlePath: [...active.map(parent => parent.name), data.name] })
      continue
    }
    ensure(RESULTS.has(event.type), 'unexpected result event')
    const started = active[data.nesting]
    ensure(active.length === data.nesting + 1 && started &&
      started.name === data.name && started.file === data.file && started.testId === data.testId,
    'missing or mismatched case start')
    active.pop()
    ensure(data.details && Number.isFinite(data.details.duration_ms) && data.details.duration_ms >= 0,
      'invalid case duration')
    ensure(data.details.attempt === undefined, 'rerun attempts are not supported')
    ensure(data.details.type === undefined || ['test', 'suite'].includes(data.details.type),
      'unknown case type')
    ensure([data.skip, data.todo].every(value => value === undefined || typeof value === 'boolean' ||
      typeof value === 'string'), 'invalid directive')
    const directive = value => value === true || typeof value === 'string'
    const status = directive(data.skip) ? 'skipped' : directive(data.todo) ? 'todo'
      : CANCELLED.has(data.details.failureType) ? 'cancelled'
        : event.type === 'test:fail' ? 'failed' : 'passed'
    const logicalKey = JSON.stringify([data.file ?? null, data.line ?? null, data.column ?? null,
      started.titlePath])
    const occurrence = (occurrences.get(logicalKey) || 0) + 1
    occurrences.set(logicalKey, occurrence)
    records.push({ id: `${stageId}:node-observation-${records.length + 1}`,
      declaredSource: data.file ?? null, line: data.line ?? null, column: data.column ?? null,
      runtimeId: data.testId, nesting: data.nesting, titlePath: started.titlePath, logicalKey,
      occurrence, kind: data.details.type || 'test', status, durationMs: data.details.duration_ms,
      ...(data.skip !== undefined ? { skipReason: data.skip } : {}),
      ...(data.todo !== undefined ? { todoReason: data.todo } : {}),
      ...(data.details.failureType ? { failureType: data.details.failureType } : {}) })
    const record = records.at(-1)
    const source = record.declaredSource?.replaceAll('\\', '/')
    const title = record.titlePath[0].replaceAll('\\', '/')
    const fileResult = record.nesting === 0 && record.line === 1 && record.column === 1 &&
      (source === title || source?.endsWith('/' + title))
    if (!fileResult) pending.push(record)
  }
  ensure(cumulative !== null && active.length === 0, 'missing totals or unfinished cases')
  ensure(pending.length === 0, 'missing file completion summary')
  checkCounts(records, cumulative.counts)
  return { available: true, schemaVersion: SCHEMA_VERSION, nodeVersion: header.nodeVersion,
    sourceAttribution: 'declared-source-only', durationBasis: 'node-test-framework',
    frameworkSuccess: cumulative.success, counts: cumulative.counts,
    durationMs: cumulative.durationMs, records, fileSummaries }
}

function checkCounts(records, counts) {
  const tests = records.filter(record => record.kind !== 'suite')
  ensure(tests.length === counts.tests &&
    records.length - tests.length === counts.suites &&
    records.filter(record => record.nesting === 0).length === counts.topLevel,
  'missing or duplicate result records')
  for (const status of STATUSES) {
    ensure(tests.filter(record => record.status === status).length === counts[status],
      'result status count mismatch')
  }
}

function nodeReporterArgs(args, destination) {
  const position = args.indexOf('--test')
  if (position < 0) return null
  ensure(!args.some(argument => /^--test-reporter(?:-destination)?(?:=|$)/.test(argument)),
    'command already configures a reporter')
  const result = [...args]
  result.splice(position + 1, 0, '--test-reporter=spec', '--test-reporter-destination=stdout',
    `--test-reporter=${pathToFileURL(__filename).href}`, `--test-reporter-destination=${destination}`)
  return result
}

module.exports = reporter
module.exports.parseNodeEvents = parseNodeEvents
module.exports.nodeReporterArgs = nodeReporterArgs
