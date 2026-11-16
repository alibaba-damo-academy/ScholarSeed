import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { win32 } from 'node:path'
import { promisify } from 'node:util'
import { FEEDBACK_LIMITS } from '../feedback.ts'

const SANDBOX_SCAN_BYTES = 512 * 1024
const SANDBOX_RECORD_MAX_CHARS = 4096
const TIMESTAMP = String.raw`\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}`
const SANDBOX_LOGGER = String.raw`scholarseed_runtime\.resources\.sandbox`
const RUNNER_PIPE_STAGE = 'runner_pipe_connect'
const MISSING_NATIVE_FIELD = 'None'
const RUNNER_WINDOW_MS = 60_000
const RUNNER_EVENT_LIMIT = 16
const RUNNER_QUERY_TIMEOUT_MS = 3_000
const RUNNER_QUERY_MAX_BYTES = 64 * 1024
const RUNNER_EVENT_ID = 26
const RUNNER_STATUS_VALUE = '0x[c-f][0-9a-f]{7}'
const RUNNER_STATUS = new RegExp(`\\((${RUNNER_STATUS_VALUE})\\)`, 'i')
const RUNNER_STATUS_TOKEN = new RegExp(`^${RUNNER_STATUS_VALUE}$`, 'i')
const RUNNER_LOG = 'System'
const RUNNER_EVENT_PROVIDER = 'Application Popup'
const RUNNER_TITLE = /^codex-command-runner(?:-\d+(?:\.\d+){2})?\.exe(?: - [^\r\n]+)?$/i
const EVENT_LOG_UTILITY = ['System32', 'wevtutil.exe']
const EVENT_LIST = /^<Events>([\s\S]*?)<\/Events>$/
const EVENT_FRAME =
  /<Event xmlns=(['"])http:\/\/schemas\.microsoft\.com\/win\/2004\/08\/events\/event\1>([\s\S]*?)<\/Event>/g
const EVENT_FIELDS = /^<System>([\s\S]*?)<\/System>\s*<EventData>([\s\S]*?)<\/EventData>$/
const EVENT_TIMESTAMP = /<TimeCreated SystemTime=(['"])([0-9T:.Z-]+)\1\s*\/>/
const EVENT_RECORD_ID = /<EventRecordID>(\d{1,16})<\/EventRecordID>/
const EVENT_DATA = /<Data Name=(['"])(Caption|Message)\1>([^<]*)<\/Data>/g
const runFile = promisify(execFile)
const SANDBOX_RPC = new RegExp(
  String.raw`^(?<timestamp>${TIMESTAMP}) WARNING:scholarseed_codex\.rpc:codex_rpc_rejected method=command/exec code=-32603 ` +
    String.raw`request_id=(?<requestId>\d{1,16}) generation=(?<generation>\d{1,16}) pid=(?<pid>\d{1,10}|None) latency_ms=(?<latency>\d{1,16})` +
    String.raw`(?: native_stage=(?<stage>runner_[a-z_]{1,40}|setup(?:_[a-z_]{1,40})?|None) native_code_type=(?<codeType>win32|None) native_code=(?<code>\d{1,10}|None))?` +
    String.raw` reason=(?:windows_sandbox_[a-z_]{1,40}|unspecified)` +
    String.raw`(?: (?:timeout_ms=\d{1,8}|pipe=(?:in|out)|os_error=\d{1,10}))* rpc:length=\d{1,16}:sha256=[0-9a-f]{12}$`
)
const SANDBOX_EXECUTION = new RegExp(
  String.raw`^${TIMESTAMP} (?:INFO:${SANDBOX_LOGGER}:windows_sandbox_execution_check event=(?:started|ready)(?: probe=(?:bootstrap|thread))?` +
    String.raw`|WARNING:${SANDBOX_LOGGER}:windows_sandbox_execution_check event=failed probe=(?:bootstrap|thread) outcome=(?:timeout|rpc|validation) ` +
    String.raw`generation=\d{1,16} pid=(?:\d{1,10}|None) rpc_request_id=(?:\d{1,16}|None) exit_code=(?:-?\d{1,10}|None))$`
)
const SANDBOX_TOOL_FAILURE = new RegExp(
  String.raw`^${TIMESTAMP} WARNING:${SANDBOX_LOGGER}:windows_sandbox_tool_check event=failed kind=[a-z_]{1,20} entry=\d{1,4} ` +
    String.raw`stage=(?:rpc|validation) error_type=[A-Za-z]{1,40} exit_code=(?:-?\d{1,10}|None) rpc_request_id=(?:\d{1,16}|None) ` +
    String.raw`rpc_code=(?:-?\d{1,10}|None) pid=(?:\d{1,10}|None) generation=(?:\d{1,16}|None) rpc_latency_ms=(?:\d{1,16}|None) ` +
    String.raw`native_reason=[a-z_]{0,64} native_stage=(?:runner_[a-z_]{1,40}|setup(?:_[a-z_]{1,40})?|None) ` +
    String.raw`native_code_type=(?:win32|None) native_code=(?:\d{1,10}|None)$`
)
const SANDBOX_SETUP = new RegExp(
  String.raw`^(${TIMESTAMP} INFO:${SANDBOX_LOGGER}:windows_sandbox_initialization )(\{[^\r\n]+\})$`
)
const SETUP_UNKNOWN = 'unknown'
const SETUP_ENUM_FIELDS: Readonly<Record<string, readonly string[]>> = {
  event: [
    'started',
    'readiness',
    'ready',
    'setup_accepted',
    'completion',
    'disconnected',
    'timeout',
    'cancelled',
    'failed',
  ],
  stage: ['readiness', 'setup_start', 'completion', 'readback'],
  status: ['ready', 'updateRequired', SETUP_UNKNOWN],
  mode: ['elevated', SETUP_UNKNOWN],
}
const SETUP_NUMERIC_FIELDS = [
  'generation',
  'pid',
  'elapsed_ms',
  'account_update_code',
  'native_system_code',
  'error_length',
]
const SETUP_RESULT_FIELDS = ['started', 'success']
const SETUP_BOOLEAN_FIELDS = ['error_present', 'error_is_string']

function setupEvidence(line: string): string {
  const match = SANDBOX_SETUP.exec(line)
  if (!match) return ''
  try {
    const data = JSON.parse(match[2]) as Record<string, unknown>
    const { event, stage, setup_attempt_id: attempt } = data
    if (
      typeof event !== 'string' ||
      !SETUP_ENUM_FIELDS.event.includes(event) ||
      typeof stage !== 'string' ||
      !SETUP_ENUM_FIELDS.stage.includes(stage) ||
      typeof attempt !== 'string' ||
      !/^[0-9a-f]{32}$/.test(attempt)
    )
      return ''
    const clean: Record<string, unknown> = { event, stage, setup_attempt_id: attempt }
    for (const [field, options] of Object.entries(SETUP_ENUM_FIELDS)) {
      const value = data[field]
      if (typeof value === 'string' && options.includes(value)) clean[field] = value
    }
    for (const field of SETUP_NUMERIC_FIELDS) {
      const value = data[field]
      if (
        value === null ||
        (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      )
        clean[field] = value
    }
    for (const field of SETUP_BOOLEAN_FIELDS) {
      const value = data[field]
      if (typeof value === 'boolean') clean[field] = value
    }
    for (const field of SETUP_RESULT_FIELDS) {
      const value = data[field]
      if (typeof value === 'boolean' || value === SETUP_UNKNOWN) clean[field] = value
    }
    if (
      typeof data.native_code === 'string' &&
      /^(?:unknown|(?:helper|orchestrator)_[a-z_]{1,64})$/.test(data.native_code)
    )
      clean.native_code = data.native_code
    if (
      typeof data.native_stage === 'string' &&
      /^setup(?:_[a-z_]{1,40})?$/.test(data.native_stage)
    )
      clean.native_stage = data.native_stage
    if (data.native_code_type === 'win32') clean.native_code_type = data.native_code_type
    if (typeof data.error_sha256 === 'string' && /^[0-9a-f]{64}$/.test(data.error_sha256))
      clean.error_sha256 = data.error_sha256
    return match[1] + JSON.stringify(clean)
  } catch {
    return ''
  }
}

type RunnerEventQuery = (startMs: number, endMs: number) => Promise<unknown>

export function parseRunnerExitEvents(xml: string) {
  const body = xml.trim().match(EVENT_LIST)?.[1]
  if (!body) return []
  const events = Array.from(body.matchAll(EVENT_FRAME))
  if (events.length >= RUNNER_EVENT_LIMIT || body.replace(EVENT_FRAME, '').trim()) return []
  return events.flatMap(([, , frame]) => {
    const fields = frame.match(EVENT_FIELDS)
    if (!fields) return []
    const [, system, data] = fields
    const entries = Array.from(data.matchAll(EVENT_DATA))
    if (entries.length !== 2 || data.replace(EVENT_DATA, '').trim()) return []
    const caption = entries.find((entry) => entry[2] === 'Caption')?.[3]
    const status = entries.find((entry) => entry[2] === 'Message')?.[3].match(RUNNER_STATUS)?.[1]
    const timestamp = system.match(EVENT_TIMESTAMP)?.[2]
    const eventRecordId = Number(system.match(EVENT_RECORD_ID)?.[1])
    if (
      !caption ||
      !RUNNER_TITLE.test(caption) ||
      !status ||
      !timestamp ||
      !Number.isSafeInteger(eventRecordId) ||
      eventRecordId <= 0
    )
      return []
    return [{ eventRecordId, timestamp, status }]
  })
}

export const queryWindowsRunnerExitEvents: RunnerEventQuery = async (startMs, endMs) => {
  const systemRoot = process.env.SystemRoot
  if (process.platform !== 'win32' || !systemRoot || !win32.isAbsolute(systemRoot)) return []
  if (
    !Number.isSafeInteger(startMs) ||
    !Number.isSafeInteger(endMs) ||
    startMs < 0 ||
    endMs <= startMs ||
    endMs - startMs > RUNNER_WINDOW_MS
  )
    return []
  const start = new Date(startMs).toISOString()
  const end = new Date(endMs).toISOString()
  const filter =
    `*[System[Provider[@Name='${RUNNER_EVENT_PROVIDER}'] and EventID=${RUNNER_EVENT_ID} and ` +
    `TimeCreated[@SystemTime >= '${start}' and @SystemTime <= '${end}']]]`
  const { stdout } = await runFile(
    win32.join(systemRoot, ...EVENT_LOG_UTILITY),
    [
      'qe',
      RUNNER_LOG,
      `/q:${filter}`,
      '/f:xml',
      '/e:Events',
      '/uni:true',
      `/c:${RUNNER_EVENT_LIMIT}`,
    ],
    {
      encoding: 'utf16le',
      timeout: RUNNER_QUERY_TIMEOUT_MS,
      maxBuffer: RUNNER_QUERY_MAX_BYTES,
      windowsHide: true,
    }
  )
  return stdout.trim() ? parseRunnerExitEvents(stdout) : []
}

async function runnerExitEvidence(
  rpc: Record<string, string>,
  query: RunnerEventQuery
): Promise<string> {
  const end = Date.parse(rpc.timestamp.replace(' ', 'T'))
  const latency = Number(rpc.latency)
  if (!Number.isFinite(end) || latency <= 0 || latency > RUNNER_WINDOW_MS) return ''
  const start = end - latency
  const rows: unknown = await query(start, end).catch(() => null)
  if (!Array.isArray(rows) || rows.length >= RUNNER_EVENT_LIMIT) return ''
  const matches = rows.flatMap((row: unknown) => {
    if (!row || typeof row !== 'object') return []
    const { eventRecordId, status, timestamp } = row as Record<string, unknown>
    if (
      typeof eventRecordId !== 'number' ||
      !Number.isSafeInteger(eventRecordId) ||
      eventRecordId <= 0 ||
      typeof status !== 'string' ||
      status !== status.trim() ||
      !RUNNER_STATUS_TOKEN.test(status) ||
      typeof timestamp !== 'string'
    )
      return []
    const time = Date.parse(timestamp)
    return time >= start && time <= end ? [{ eventRecordId, status, time }] : []
  })
  if (matches.length !== 1) return ''
  const [event] = matches
  return (
    'windows_sandbox_runner_exit ' +
    JSON.stringify({
      correlation: 'request_window',
      source: 'windows_system_event',
      status_type: 'ntstatus',
      status: event.status.toLowerCase(),
      event_record_id: event.eventRecordId,
      event_timestamp: new Date(event.time).toISOString(),
      request_id: Number(rpc.requestId),
      generation: Number(rpc.generation),
      app_server_pid: Number(rpc.pid),
    }) +
    '\n'
  )
}

/** Read complete lines from a bounded tail without following a log symlink. */
async function readFeedbackLog(path: string, maximum: number): Promise<string> {
  try {
    const entry = await lstat(path)
    if (!entry.isFile()) return ''
    const file = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    )
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino) return ''
      const length = Math.min(stat.size, maximum)
      const start = stat.size - length
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await file.read(buffer, 0, length, start)
      const tail = buffer.subarray(0, bytesRead)
      const firstNewline = start > 0 ? tail.indexOf(10) : -1
      if (start > 0 && firstNewline < 0) return ''
      return tail.subarray(firstNewline + 1).toString('utf8')
    } finally {
      await file.close()
    }
  } catch {
    return ''
  }
}

export function readFeedbackUpdateLog(path: string): Promise<string> {
  return readFeedbackLog(path, FEEDBACK_LIMITS.updateLogBytes)
}

export async function readFeedbackSandboxLog(
  path: string,
  queryRunnerEvents: RunnerEventQuery = queryWindowsRunnerExitEvents
): Promise<string> {
  const tail = await readFeedbackLog(path, SANDBOX_SCAN_BYTES)
  const lines = tail.split(/\r?\n/)
  lines.pop()
  const evidence: string[] = []
  let runnerFailure: { fields: Record<string, string>; evidenceIndex: number } | undefined
  let bytes = 0
  for (const line of lines.reverse()) {
    if (line.length > SANDBOX_RECORD_MAX_CHARS) continue
    const rpc = SANDBOX_RPC.exec(line)
    const clean =
      rpc || SANDBOX_EXECUTION.test(line) || SANDBOX_TOOL_FAILURE.test(line)
        ? line
        : setupEvidence(line)
    if (!clean) continue
    const record = clean + '\n'
    const recordBytes = Buffer.byteLength(record)
    if (bytes + recordBytes > FEEDBACK_LIMITS.hostBytes) break
    bytes += recordBytes
    evidence.push(record)
    const fields = rpc?.groups
    if (
      !runnerFailure &&
      fields?.stage === RUNNER_PIPE_STAGE &&
      fields.codeType === MISSING_NATIVE_FIELD &&
      fields.code === MISSING_NATIVE_FIELD &&
      fields.pid !== MISSING_NATIVE_FIELD
    )
      runnerFailure = { fields, evidenceIndex: evidence.length - 1 }
  }
  const nativeExit = runnerFailure
    ? await runnerExitEvidence(runnerFailure.fields, queryRunnerEvents)
    : ''
  if (nativeExit && runnerFailure) {
    bytes += Buffer.byteLength(nativeExit)
    for (
      let oldest = evidence.length - 1;
      oldest >= 0 && bytes > FEEDBACK_LIMITS.hostBytes;
      oldest--
    ) {
      if (oldest === runnerFailure.evidenceIndex) continue
      bytes -= Buffer.byteLength(evidence[oldest])
      evidence.splice(oldest, 1)
    }
  }
  return evidence.reverse().join('') + nativeExit
}
