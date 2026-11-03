import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'

import {
  DECISION_CANCEL,
  DECISION_COMMIT,
  DECISION_KEYS,
  ELEVATION_REQUIRED,
  ELEVATION_TIMEOUT_MS,
  InstallerReadiness,
  READY_TIMEOUT_MS,
  HANDSHAKE_SCHEMA_VERSION,
  REQUEST_KEYS,
  READY_KEYS,
  decodeRecord,
  encodeRecord,
  handshakeDirectory,
  isValidUpdateId,
  newNonce,
  newUpdateId,
  parseDecision,
  parseReady,
  parseRecord,
  parseRequest,
  readyPointsToLiveProcess,
  serializeRecord,
  splitFiletime,
  validateDecision,
  validateReady,
  validateRequest
} from './handshake.ts'
import type { DecisionRecord, HandshakeRequest, ReadyRecord } from './handshake.ts'

const UPDATE_ID = '0f0fd4b8-4b6f-4a5e-9c1c-2f0d5f8e6a11'
const NONCE = 'a1'.repeat(16)
const INSTALLER_PID = 4242

test('普通安装只有有效 ready 才完成交接', () => {
  const state = new InstallerReadiness(request(), INSTALLER_PID, 0)
  assert.equal(state.observe(null, 1), null)
  assert.equal(state.observe(ready(), READY_TIMEOUT_MS - 1), 'ready')
})

test('普通初始化超时不被迟到 ready 覆盖', () => {
  const state = new InstallerReadiness(request(), INSTALLER_PID, 0)
  assert.equal(state.observe(ready(), READY_TIMEOUT_MS), 'timeout')
})

test('提权状态仅延展授权预算，不能作为 ready 提交', () => {
  const state = new InstallerReadiness(request(), INSTALLER_PID, 0)
  const elevation = ready({ result: ELEVATION_REQUIRED })
  assert.equal(state.observe(elevation, 1), null)
  assert.equal(validateReady(elevation, request()), false)
  assert.equal(state.observe(null, READY_TIMEOUT_MS), null)
  assert.equal(state.observe(ready(), ELEVATION_TIMEOUT_MS), 'ready')
})

test('重复提权记录不能无限延长授权窗口', () => {
  const state = new InstallerReadiness(request(), INSTALLER_PID, 0)
  const elevation = ready({ result: ELEVATION_REQUIRED })
  assert.equal(state.observe(elevation, 1), null)
  assert.equal(state.observe(elevation, ELEVATION_TIMEOUT_MS), null)
  assert.equal(state.observe(elevation, ELEVATION_TIMEOUT_MS + 1), 'timeout')
})

test('过期初始化不能靠迟到提权记录复活', () => {
  const state = new InstallerReadiness(request(), INSTALLER_PID, 0)
  assert.equal(state.observe(ready({ result: ELEVATION_REQUIRED }), READY_TIMEOUT_MS), 'timeout')
})

for (const result of ['ready', ELEVATION_REQUIRED]) {
  for (const override of [{ nonce: 'b2'.repeat(16) }, { updateId: 'bad' }, { installerPid: '4243' }, { schemaVersion: '2' }]) {
    test(`${result} 拒绝错误的 ${Object.keys(override)[0]}`, () => {
      const state = new InstallerReadiness(request(), INSTALLER_PID, 0)
      assert.equal(state.observe(ready({ result, ...override }), 1), 'invalid-ready')
    })
  }
}

test('未知安装阶段立即拒绝', () => {
  const state = new InstallerReadiness(request(), INSTALLER_PID, 0)
  assert.equal(state.observe(ready({ result: 'installed' }), 1), 'invalid-ready')
})

test('提权阶段截断的记录继续等待，直到有限超时', () => {
  const state = new InstallerReadiness(request(), INSTALLER_PID, 0)
  assert.equal(state.observe(ready({ result: ELEVATION_REQUIRED }), 1), null)
  assert.equal(state.observe(parseReady(Buffer.from('partial')), 2), null)
  assert.equal(state.observe(null, ELEVATION_TIMEOUT_MS + 1), 'timeout')
})

function request(overrides: Partial<HandshakeRequest> = {}): HandshakeRequest {
  return {
    schemaVersion: HANDSHAKE_SCHEMA_VERSION,
    updateId: UPDATE_ID,
    nonce: NONCE,
    callerSid: 'S-1-5-21-111111111-2222222222-3333333333-1001',
    callerPid: '12092',
    callerCreationLow: '-123456789',
    callerCreationHigh: '31000000',
    fromVersion: '0.2.0',
    toVersion: '0.3.0-202609212016',
    installDir: 'C:\\Users\\书深\\AppData\\Local\\Programs\\ScholarSeed',
    ...overrides
  }
}

function ready(overrides: Partial<ReadyRecord> = {}): ReadyRecord {
  return {
    schemaVersion: HANDSHAKE_SCHEMA_VERSION,
    updateId: UPDATE_ID,
    nonce: NONCE,
    installerPid: '4242',
    installerCreationLow: '987654321',
    installerCreationHigh: '31000001',
    result: 'ready',
    ...overrides
  }
}

function decision(value: string): DecisionRecord {
  return {
    schemaVersion: HANDSHAKE_SCHEMA_VERSION,
    updateId: UPDATE_ID,
    nonce: NONCE,
    decision: value
  }
}

function roundTrip(keys: readonly string[], values: Record<string, string>): Buffer {
  return encodeRecord(serializeRecord(keys, values))
}

test('request 记录序列化→编码→解码→解析全程往返，含非 ASCII 安装目录', () => {
  const original = request()
  const parsed = parseRequest(roundTrip(REQUEST_KEYS, original))
  assert.deepEqual(parsed, original)
})

test('ready 与 decision 记录往返', () => {
  assert.deepEqual(parseReady(roundTrip(READY_KEYS, ready())), ready())
  assert.deepEqual(parseDecision(roundTrip(DECISION_KEYS, decision(DECISION_COMMIT))), decision(DECISION_COMMIT))
})

test('缺 BOM 的字节流拒绝解码：编码降级必须是 fail-closed 而不是碰巧能读', () => {
  const bytes = Buffer.from(serializeRecord(DECISION_KEYS, decision(DECISION_COMMIT)), 'utf16le')
  assert.equal(decodeRecord(bytes), null)
  assert.equal(parseDecision(bytes), null)
})

test('UTF-8 字节冒充 UTF-16LE 时产生 U+FFFD 指纹并被拒绝', () => {
  const utf8 = Buffer.from(serializeRecord(DECISION_KEYS, decision(DECISION_COMMIT)), 'utf8')
  const spoofed = Buffer.concat([Buffer.from([0xff, 0xfe]), utf8])
  assert.equal(decodeRecord(spoofed), null)
})

test('奇数字节体拒绝解码', () => {
  const buffer = roundTrip(DECISION_KEYS, decision(DECISION_COMMIT))
  assert.equal(decodeRecord(buffer.subarray(0, buffer.length - 1)), null)
})

test('值里带换行在序列化时即抛出，注入不出现在线格式里', () => {
  assert.throws(
    () => serializeRecord(REQUEST_KEYS, request({ installDir: 'C:\\ok\r\ndecision=commit' })),
    /line break/
  )
})

test('值里带控制字符在序列化时即抛出', () => {
  assert.throws(() => serializeRecord(REQUEST_KEYS, request({ nonce: `${NONCE.slice(0, 31)}\u0007` })), /control/)
})

test('字段乱序、缺失、重复、未知键都解析为 null', () => {
  const text = serializeRecord(DECISION_KEYS, decision(DECISION_COMMIT))
  const swapped = text.replace('schemaVersion=1', 'schemaVersion=1').split('\r\n')
  // 乱序：交换前两行
  const outOfOrder = [swapped[1], swapped[0], ...swapped.slice(2)].join('\r\n')
  assert.equal(parseRecord(outOfOrder, DECISION_KEYS), null)
  // 缺失
  assert.equal(parseRecord(swapped.slice(1).join('\r\n'), DECISION_KEYS), null)
  // 重复（顶掉一个既有键位）
  const duplicated = [swapped[0], swapped[0], ...swapped.slice(2)].join('\r\n')
  assert.equal(parseRecord(duplicated, DECISION_KEYS), null)
  // 未知键
  const unknown = [...swapped.slice(0, 3), 'extra=1', ...swapped.slice(3)].join('\r\n')
  assert.equal(parseRecord(unknown, DECISION_KEYS), null)
})

test('validateRequest 逐字段拒绝坏值：每一道守卫单独证伪', () => {
  assert.equal(validateRequest(request()), true)
  assert.equal(validateRequest(request({ schemaVersion: '2' })), false)
  assert.equal(validateRequest(request({ updateId: 'not-a-uuid' })), false)
  assert.equal(validateRequest(request({ updateId: UPDATE_ID.toUpperCase() })), false)
  assert.equal(validateRequest(request({ nonce: NONCE.slice(0, 31) })), false)
  assert.equal(validateRequest(request({ callerSid: 'Administrators' })), false)
  assert.equal(validateRequest(request({ callerPid: '-1' })), false)
  assert.equal(validateRequest(request({ callerPid: '1'.repeat(21) })), false)
  assert.equal(validateRequest(request({ callerCreationLow: '4294967296' })), false)
  assert.equal(validateRequest(request({ fromVersion: '0.2.0; rm -rf /' })), false)
  assert.equal(validateRequest(request({ installDir: '' })), false)
  assert.equal(validateRequest(request({ installDir: 'x'.repeat(4097) })), false)
  // 解析层也拒绝：坏记录不会以 HandshakeRequest 形态流出
  assert.equal(parseRequest(roundTrip(REQUEST_KEYS, request({ updateId: 'evil' }))), null)
})

test('validateReady 必须与本轮 request 的 updateId+nonce 双双一致', () => {
  const original = request()
  assert.equal(validateReady(ready(), original), true)
  assert.equal(validateReady(ready({ updateId: newUpdateId() }), original), false)
  assert.equal(validateReady(ready({ nonce: newNonce() }), original), false)
  assert.equal(validateReady(ready({ result: 'almost' }), original), false)
  assert.equal(validateReady(ready({ installerPid: 'x' }), original), false)
})

test('validateDecision 区分 commit/cancel 且绑定本轮身份', () => {
  const original = request()
  assert.equal(validateDecision(decision(DECISION_COMMIT), original, DECISION_COMMIT), true)
  assert.equal(validateDecision(decision(DECISION_CANCEL), original, DECISION_COMMIT), false)
  assert.equal(validateDecision(decision(DECISION_COMMIT), original, DECISION_CANCEL), false)
  assert.equal(validateDecision(decision('maybe'), original, DECISION_COMMIT), false)
  assert.equal(
    validateDecision(decision(DECISION_COMMIT), { ...original, nonce: newNonce() }, DECISION_COMMIT),
    false
  )
})

test('handshakeDirectory 拒绝非 UUID 形态的 updateId（路径穿越闸）', () => {
  assert.equal(
    handshakeDirectory('/tmp/updates/install', UPDATE_ID),
    join('/tmp/updates/install', UPDATE_ID)
  )
  assert.throws(() => handshakeDirectory('/tmp/updates/install', '..'), /invalid updateId/)
  assert.throws(() => handshakeDirectory('/tmp/updates/install', `x${UPDATE_ID.slice(1)}`), /invalid updateId/)
})

test('splitFiletime 按位拆分 uint64 十进制串为两个有符号 32 位十进制串', () => {
  assert.deepEqual(splitFiletime('0'), { low: '0', high: '0' })
  assert.deepEqual(splitFiletime('4294967295'), { low: '-1', high: '0' })
  assert.deepEqual(splitFiletime('4294967296'), { low: '0', high: '1' })
  assert.deepEqual(splitFiletime('13398765432198765432'), { low: '-1090675848', high: '3119643179' })
  assert.throws(() => splitFiletime('-1'), /decimal uint64/)
  assert.throws(() => splitFiletime('0x10'), /decimal uint64/)
})

test('isValidUpdateId 只认小写 UUID 形状', () => {
  assert.equal(isValidUpdateId(UPDATE_ID), true)
  assert.equal(isValidUpdateId(newUpdateId()), true)
  assert.equal(isValidUpdateId(UPDATE_ID.toUpperCase()), false)
  assert.equal(isValidUpdateId(`${UPDATE_ID}/..`), false)
})

test('readyPointsToLiveProcess 用 PID+创建时刻双判据识别 PID 复用', () => {
  const record = ready()
  assert.equal(readyPointsToLiveProcess(record, 4242, '987654321', '31000001'), true)
  // PID 还在但创建时刻对不上 = PID 已被复用，挂着的安装器早就退了，闸门不能误拦。
  assert.equal(readyPointsToLiveProcess(record, 4242, '987654322', '31000001'), false)
  assert.equal(readyPointsToLiveProcess(record, 4242, '987654321', '31000002'), false)
  // 创建时刻对但 PID 不同 = 探到的是别的进程。
  assert.equal(readyPointsToLiveProcess(record, 4243, '987654321', '31000001'), false)
  // installerPid 非数字时 Number() 得 NaN，恒不匹配（fail-closed 到「没有活安装器」之外，
  // 由调用方的探针取不到创建时刻兜住；这里只钉形状判据本身）。
  assert.equal(readyPointsToLiveProcess(ready({ installerPid: 'not-a-pid' }), NaN, '987654321', '31000001'), false)
})
