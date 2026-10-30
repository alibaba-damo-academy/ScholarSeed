// codesign.ts — macOS 代码签名身份的纯解析与离线信任判定（Windows 侧对应 authenticode.ts）。
//
// updater.ts 跑 `codesign -d --verbose=4` 拿到签名元数据文本；本模块持有两件事的判定：这段文本
// 怎么解析才可信，以及解析出的身份是否满足「同一 Developer ID 签名者」的离线信任锚。不导入
// Node/Electron：同一份判定必须能被 node --test 直接跑，而不是像 updater.ts 那样导不进来只能靠
// 源码形状守卫钉住。
//
// 为什么是离线锚（bug 87435837）：客户端过去在替换 app 前跑 `spctl --assess --type execute` 作硬门，
// 而 spctl 会触发 syspolicyd 的**在线**公证 ticket 查询/证书吊销检查。企业管控网对 Apple 域名做 TLS
// 拦截时，这条在线查询失败 → Gatekeeper fail-closed 判 rejected（`lack of matching active rule` /
// -67018），对一个签名+公证+staple 齐全的合法产物也照拒，且每次重试必然复现。业界（Sparkle /
// Squirrel.Mac）安装前不跑在线 Gatekeeper：信任锚是**离线**的「同签名身份 + 完整性 + 字节钉死」，
// 公证/吊销交 OS。本模块即那套离线锚的判定：Developer ID 三级链 + TeamIdentifier 相等 + 硬化运行时 +
// 安全时间戳 + 签名 Identifier 一致。整包字节另由 SHA-512（对 HTTPS 下发的发布元数据）钉死，公证由
// 随包票据的 Apple 专用证书链、ECDSA 签名与各架构 CDHash 绑定由原生离线验证器检查，见 notarization.ts。
//
// 承重判据是 TeamIdentifier 相等：`codesign -d` 的 Authority 行是**自报文本、可被伪造链拼出**，只有
// TeamIdentifier（来自真实 Apple 签发证书的 OU）与 原生严格签名校验 的链校验一起才不可伪造。故
// TeamIdentifier 为空或 `not set` 一律判不可信，绝不放宽。

/** `codesign -d --verbose=4` 对 ad-hoc 签名打印的 TeamIdentifier 值。 */
const TEAM_IDENTIFIER_NOT_SET = 'not set'

/** Apple 公证/硬化运行时相关的证书链与标志字面量（codesign 输出里的固定串）。 */
const DEVELOPER_ID_LEAF_PREFIX = 'Developer ID Application:'
const DEVELOPER_ID_CA = 'Developer ID Certification Authority'
const APPLE_ROOT_CA = 'Apple Root CA'
const HARDENED_RUNTIME_FLAG = 'runtime'
const TIMESTAMP_NONE = 'none'

export interface CodesignIdentity {
  /** 签名覆盖的 bundle Identifier（`^Identifier=`，非 TeamIdentifier）。 */
  identifier: string
  /** 签名者 Team ID（来自证书 OU）；ad-hoc 为 `not set`。 */
  teamIdentifier: string
  /** 证书链上所有 `Authority=` 行，按输出顺序。 */
  authorities: string[]
  /** `Developer ID Application: ...` 叶子证书行；缺失即非 Developer ID 签名。 */
  developerIdAuthority: string
  /** 链中是否含 Developer ID Certification Authority。 */
  hasDeveloperIdCa: boolean
  /** 链中是否含 Apple Root CA。 */
  hasAppleRootCa: boolean
  /** flags=0x…(…) 括号内是否含 runtime（硬化运行时）。 */
  hardenedRuntime: boolean
  /** 是否有有效安全时间戳（Timestamp= 存在且 != none）。 */
  hasSecureTimestamp: boolean
  /** CDHash（仅审计/日志用，缺失不影响判定）。 */
  cdhash: string
}

function firstMatch(text: string, pattern: RegExp): string {
  const match = text.match(pattern)
  return match ? match[1].trim() : ''
}

function allMatches(text: string, pattern: RegExp): string[] {
  const values: string[] = []
  for (const match of text.matchAll(pattern)) values.push(match[1].trim())
  return values
}

/**
 * 解析 `codesign -d --verbose=4` 的输出（该命令把元数据写到 stderr，调用方传入的应是 stdout+stderr
 * 合并文本）。纯文本解析、不校验签名有效性——签名 seal 的完整性由 Security.framework 的严格、嵌套、全架构离线校验
 * 在调用方另行强制。CRLF 归一为 LF 后再解析（跨平台输出纪律）。
 */
export function parseCodesignIdentity(output: string): CodesignIdentity {
  const text = output.replace(/\r\n/g, '\n')
  const authorities = allMatches(text, /^Authority=(.+)$/gm)
  const flags = firstMatch(text, /^CodeDirectory\b.*flags=0x[0-9a-fA-F]+\(([^)]*)\)/m)
  const timestamp = firstMatch(text, /^Timestamp=(.+)$/m)
  return {
    identifier: firstMatch(text, /^Identifier=(.+)$/m),
    teamIdentifier: firstMatch(text, /^TeamIdentifier=(.+)$/m),
    authorities,
    developerIdAuthority: authorities.find((a) => a.startsWith(DEVELOPER_ID_LEAF_PREFIX)) ?? '',
    hasDeveloperIdCa: authorities.includes(DEVELOPER_ID_CA),
    hasAppleRootCa: authorities.includes(APPLE_ROOT_CA),
    hardenedRuntime: flags
      .split(',')
      .map((flag) => flag.trim())
      .includes(HARDENED_RUNTIME_FLAG),
    // Timestamp= 整行缺失（ad-hoc）或值为 none 都算没有安全时间戳。
    hasSecureTimestamp: timestamp !== '' && timestamp.toLowerCase() !== TIMESTAMP_NONE,
    cdhash: firstMatch(text, /^CDHash=([0-9a-fA-F]+)$/m),
  }
}

/** 期望身份：来自随签名封存的 product.json（expectedTeamId/bundleId）与发布元数据（metaTeamId）。 */
export interface ExpectedMacosIdentity {
  expectedTeamId: string
  expectedBundleId: string
  metaTeamId: string
}

export type MacosTrustVerdict = { trusted: true } | { trusted: false; reason: string }

function untrusted(reason: string): MacosTrustVerdict {
  return { trusted: false, reason }
}

/**
 * 离线信任锚判定：这个即将替换用户现有 app 的 bundle，是否确由期望的 Developer ID 签名者签发。
 *
 * 全部判据离线、确定性；任一不满足即 fail-closed（不可信）。承重判据是 TeamIdentifier 相等——
 * Authority 文本可伪造，TeamIdentifier 来自真实证书 OU 且受 原生严格签名校验 链校验保护，故
 * 空/`not set` 一律拒。返回的 reason 只进日志与错误诊断，不进用户可见文案（用户文案由 updater.ts
 * 的结构化 fallback 分类决定）。
 */
export function classifyMacosTrust(
  identity: CodesignIdentity,
  expected: ExpectedMacosIdentity
): MacosTrustVerdict {
  if (identity.developerIdAuthority === '') {
    return untrusted('no Developer ID Application authority (ad-hoc or non-Developer-ID signature)')
  }
  if (!identity.hasDeveloperIdCa || !identity.hasAppleRootCa) {
    return untrusted('Developer ID certificate chain does not reach Apple Root CA')
  }
  if (
    identity.teamIdentifier === '' ||
    identity.teamIdentifier === TEAM_IDENTIFIER_NOT_SET ||
    identity.teamIdentifier !== expected.expectedTeamId
  ) {
    return untrusted('signed Team Identifier differs from packaged product policy')
  }
  if (expected.metaTeamId !== expected.expectedTeamId) {
    return untrusted('release metadata team_id differs from packaged product policy')
  }
  if (!identity.hardenedRuntime) {
    return untrusted('hardened runtime flag is missing')
  }
  if (!identity.hasSecureTimestamp) {
    return untrusted('secure timestamp is missing')
  }
  if (identity.identifier !== expected.expectedBundleId) {
    return untrusted('signed Identifier differs from packaged bundle id')
  }
  return { trusted: true }
}
