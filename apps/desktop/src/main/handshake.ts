// Windows 更新安装握手的线格式与纯判定（proposal 108 §5.1/§5.2）。
//
// 本模块不 import electron：协议逻辑全部可被 node --test 直测；编排（spawn、轮询、
// 文件读写、降级）在 updater.ts。
//
// 握手文件一律 UTF-16LE 带 BOM，而不是提案初稿写的「UTF-8 无 BOM」：NSIS Unicode build
// 没有原生 UTF-8 文件 I/O（FileRead/FileWrite 走 UTF-16LE 或系统代码页），而 request.ini
// 的 installDir 可能含中文。把编码押在代码页探测上正是 bug 87108457 的根因；UTF-16LE 是
// NSIS（FileWriteUTF16LE/FileReadUTF16LE）与 Node（'utf16le'）双方的原生确定编码，
// 两侧都不依赖系统代码页。

import { randomBytes, randomUUID } from 'crypto'
import { join } from 'path'

export const HANDSHAKE_SCHEMA_VERSION = '1'
export const REQUEST_FILE = 'request.ini'
export const READY_FILE = 'ready.ini'
export const DECISION_FILE = 'decision.ini'
export const INSTALL_SUBDIRNAME = 'install'
export const READY_POLL_INTERVAL_MS = 200
export const READY_TIMEOUT_MS = 30_000
/** NSIS 侧安装参数（$CMDLINE）。用 /NAME=value 形态，与 NSIS 惯用开关一致。 */
export const UPDATE_ID_ARGUMENT_PREFIX = '/SCHOLARSEED_UPDATE_ID='
/** spawn 安装器时传递已解析 home 与 nonce 的环境变量名。 */
export const HANDSHAKE_HOME_ENV = 'SCHOLARSEED_HOME'
export const HANDSHAKE_NONCE_ENV = 'SCHOLARSEED_UPDATE_NONCE'
export const HANDSHAKE_PID_ENV = 'SCHOLARSEED_HANDSHAKE_PID'

export type HandshakeDecision = 'commit' | 'cancel'

export const DECISION_COMMIT: HandshakeDecision = 'commit'
export const DECISION_CANCEL: HandshakeDecision = 'cancel'

/** 三类记录的字段顺序即线格式契约：NSIS 侧按同一顺序读写，序列化/解析都强制它。 */
export const REQUEST_KEYS = [
  'schemaVersion',
  'updateId',
  'nonce',
  'callerSid',
  'callerPid',
  'callerCreationLow',
  'callerCreationHigh',
  'fromVersion',
  'toVersion',
  'installDir'
] as const

export const READY_KEYS = [
  'schemaVersion',
  'updateId',
  'nonce',
  'installerPid',
  'installerCreationLow',
  'installerCreationHigh',
  'result'
] as const

export const DECISION_KEYS = ['schemaVersion', 'updateId', 'nonce', 'decision'] as const

export type HandshakeRequest = Record<(typeof REQUEST_KEYS)[number], string>
export type ReadyRecord = Record<(typeof READY_KEYS)[number], string>
export type DecisionRecord = Record<(typeof DECISION_KEYS)[number], string>

const UPDATE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const NONCE_PATTERN = /^[0-9a-f]{32}$/
const SID_PATTERN = /^S-\d+(-\d+)+$/
const DECIMAL_PATTERN = /^\d{1,20}$/
const SIGNED_INT32_PATTERN = /^-?\d{1,10}$/
const SIGNED_INT32_MIN = -2147483648n
const SIGNED_INT32_MAX = 2147483647n
const VERSION_PATTERN = /^[0-9A-Za-z.\-+]{1,64}$/
const RECORD_LINE_PATTERN = /^([A-Za-z]+)=([\s\S]*)$/
const UTF16LE_BOM = Buffer.from([0xff, 0xfe])
const MAX_INSTALL_DIR_LENGTH = 4096

export function newUpdateId(): string {
  return randomUUID()
}

export function newNonce(): string {
  return randomBytes(16).toString('hex')
}

export function isValidUpdateId(value: string): boolean {
  return UPDATE_ID_PATTERN.test(value)
}

/**
 * Windows FILETIME（100ns since 1601, uint64 十进制串）拆成两个有符号 32 位十进制串。
 * NSIS System 插件没有可靠的 int64 寄存器语义，比较用 CompareFileTime 按位进行，
 * 低/高位的十进制表示只是它的持久化形态。
 */
export function splitFiletime(filetime: string): { low: string; high: string } {
  if (!DECIMAL_PATTERN.test(filetime)) throw new Error('filetime must be a decimal uint64 string')
  const value = BigInt(filetime)
  const low = Number(BigInt.asIntN(32, value))
  const high = Number(value >> 32n)
  return { low: String(low), high: String(high) }
}

function isSignedInt32(value: string): boolean {
  if (!SIGNED_INT32_PATTERN.test(value)) return false
  const parsed = BigInt(value)
  return parsed >= SIGNED_INT32_MIN && parsed <= SIGNED_INT32_MAX
}

function assertSingleLine(value: string, key: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[\r\n]/.test(value)) throw new Error(`handshake value for ${key} contains a line break`)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`handshake value for ${key} contains control characters`)
}

export function serializeRecord(keys: readonly string[], values: Record<string, string>): string {
  const lines = keys.map((key) => {
    const value = values[key]
    if (typeof value !== 'string') throw new Error(`handshake record is missing ${key}`)
    assertSingleLine(value, key)
    return `${key}=${value}`
  })
  return `${lines.join('\r\n')}\r\n`
}

export function encodeRecord(text: string): Buffer {
  return Buffer.concat([UTF16LE_BOM, Buffer.from(text, 'utf16le')])
}

/**
 * 解码握手文件字节。任何编码降级指纹都返回 null（fail-closed，同 parseAuthenticodeReport
 * 的纪律）：缺 BOM、奇数字节、U+FFFD、非常规控制字符，一律按「记录不可用」处理。
 */
export function decodeRecord(buffer: Buffer): string | null {
  if (buffer.length < 2 || buffer[0] !== UTF16LE_BOM[0] || buffer[1] !== UTF16LE_BOM[1]) return null
  const body = buffer.subarray(2)
  if (body.length === 0 || body.length % 2 !== 0) return null
  const text = body.toString('utf16le')
  if (text.includes('\uFFFD')) return null
  // 放行 \t \r \n（行分隔与值内制表），其余控制字符视为降级指纹。
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return null
  return text
}

/**
 * 解析 key=value 行记录。字段必须与 keys 完全同序、不多不少：乱序/缺失/重复/未知键
 * 都返回 null，让「格式不对」永远不可能被解释成半个有效握手。
 */
export function parseRecord(text: string, keys: readonly string[]): Record<string, string> | null {
  const lines = text.split(/\r?\n/)
  if (lines.length !== keys.length + 1 || lines[keys.length] !== '') return null
  const record: Record<string, string> = {}
  for (let index = 0; index < keys.length; index += 1) {
    const match = lines[index].match(RECORD_LINE_PATTERN)
    if (!match || match[1] !== keys[index]) return null
    record[match[1]] = match[2]
  }
  return record
}

export function parseRequest(buffer: Buffer): HandshakeRequest | null {
  const text = decodeRecord(buffer)
  if (text === null) return null
  const record = parseRecord(text, REQUEST_KEYS)
  if (record === null) return null
  return validateRequest(record as HandshakeRequest) ? (record as HandshakeRequest) : null
}

export function validateRequest(record: HandshakeRequest): boolean {
  return (
    record.schemaVersion === HANDSHAKE_SCHEMA_VERSION &&
    isValidUpdateId(record.updateId) &&
    NONCE_PATTERN.test(record.nonce) &&
    SID_PATTERN.test(record.callerSid) &&
    DECIMAL_PATTERN.test(record.callerPid) &&
    isSignedInt32(record.callerCreationLow) &&
    isSignedInt32(record.callerCreationHigh) &&
    VERSION_PATTERN.test(record.fromVersion) &&
    VERSION_PATTERN.test(record.toVersion) &&
    record.installDir.length > 0 &&
    record.installDir.length <= MAX_INSTALL_DIR_LENGTH
  )
}

/**
 * ready 记录必须与本轮 request 的 updateId+nonce 完全一致才算数：nonce 是只有
 * 「spawn 时拿到 env 的安装器进程」与主进程知道的共享秘密，防止别的进程往目录里
 * 丢一个 ready.ini 冒充握手对端。
 */
export function validateReady(record: ReadyRecord, request: Pick<HandshakeRequest, 'updateId' | 'nonce'>): boolean {
  return (
    record.schemaVersion === HANDSHAKE_SCHEMA_VERSION &&
    record.updateId === request.updateId &&
    record.nonce === request.nonce &&
    DECIMAL_PATTERN.test(record.installerPid) &&
    isSignedInt32(record.installerCreationLow) &&
    isSignedInt32(record.installerCreationHigh) &&
    record.result === 'ready'
  )
}

export function parseReady(buffer: Buffer): ReadyRecord | null {
  const text = decodeRecord(buffer)
  if (text === null) return null
  const record = parseRecord(text, READY_KEYS)
  return record as ReadyRecord | null
}

/**
 * ready 记录指向的安装器是否仍是记录里那个活进程：PID 相同**且**创建时刻一致。
 * 创建时刻是 PID 复用的判据——只比 PID 会把别的进程认成挂着的安装器，闸门就永久误拦。
 * 调用方负责把 pid 的当前创建时刻探出来传入；探不到（进程已退/探针不可用）自然不匹配。
 */
export function readyPointsToLiveProcess(
  record: ReadyRecord,
  pid: number,
  creationLow: string,
  creationHigh: string
): boolean {
  return (
    Number(record.installerPid) === pid &&
    record.installerCreationLow === creationLow &&
    record.installerCreationHigh === creationHigh
  )
}

export function validateDecision(
  record: DecisionRecord,
  request: Pick<HandshakeRequest, 'updateId' | 'nonce'>,
  expected: HandshakeDecision
): boolean {
  return (
    record.schemaVersion === HANDSHAKE_SCHEMA_VERSION &&
    record.updateId === request.updateId &&
    record.nonce === request.nonce &&
    record.decision === expected
  )
}

export function parseDecision(buffer: Buffer): DecisionRecord | null {
  const text = decodeRecord(buffer)
  if (text === null) return null
  const record = parseRecord(text, DECISION_KEYS)
  return record as DecisionRecord | null
}

/**
 * 握手目录路径。updateId 必须先过 UUID 形状校验再参与 join —— 它是路径的最后一段，
 * 这是防路径穿越的唯一闸（NSIS 侧有同样的校验义务）。
 */
export function handshakeDirectory(baseDirectory: string, updateId: string): string {
  if (!isValidUpdateId(updateId)) throw new Error('refusing to build a handshake path from an invalid updateId')
  return join(baseDirectory, updateId)
}
