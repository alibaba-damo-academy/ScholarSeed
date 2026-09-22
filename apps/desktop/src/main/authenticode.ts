// authenticode.ts — Windows Authenticode 校验结果的纯判定。
//
// updater.ts 跑 Get-AuthenticodeSignature 拿到两个事实：Status 与 SignerCertificate.Subject；
// 本模块持有这两件事的**传输契约**（脚本写出的那份 JSON 报告怎么读才可信）与关于它们的
// 两个纯问题 —— 这个 Status 意味着什么、两个 Subject 串是不是同一个发布者。不导入 Node/Electron：
// 同一份判定必须能被 node --test 直接跑，而不是像 updater.ts 那样因为导不进来只能靠源码形状守卫
// 钉住。
//
// 为什么三分（本机不可判定 / 确证不可信 / 通过）：过去一切非 Valid 都归「签名不可信」并引导
// 「请从官方渠道重新获取安装包」—— 而安装包字节在下载时与安装前已两次被 HTTPS 下发的
// SHA-512 钉死，重新下载必然复现同一结果，引导是死路。NotTrusted / UnknownError 这类 Status
// 往往是**本机**的证书链/吊销状态（离线、缺中间 CA、企业裁剪根存储），签名者本身可能完全
// 正确；把它与「包级确证坏」混为一类，既说错话又给错出路。

/** Get-AuthenticodeSignature 的 SignatureStatus 里唯一表示校验通过的值。 */
export const AUTHENTICODE_VALID = 'Valid'

/**
 * 「确证坏」的 Status：全是**包级事实**，与校验机器的网络、根证书、吊销缓存无关，换机器或
 * 重试都不会改变。
 *
 * - `NotSigned`：根本没有签名；
 * - `HashMismatch`：字节与签名时字节不符；
 * - `NotSupportedFileFormat`：文件格式不可签名，即不是我们以为的那种产物。
 */
const AUTHENTICODE_CONDEMNED_STATUSES: ReadonlySet<string> = new Set([
  'NotSigned',
  'HashMismatch',
  'NotSupportedFileFormat'
])

/**
 * 校验结果的三档语义。
 *
 * - `valid`：Status 为 Valid；
 * - `condemned`：确证坏（包级事实）；
 * - `indeterminate`：本机无法判定可信性（链/吊销/兼容性），含未认识的未来 Status 值 ——
 *   fail-closed：没被明确判为 valid 的一切都不按通过处理。
 */
export type AuthenticodeVerdict = 'valid' | 'condemned' | 'indeterminate'

export function classifyAuthenticodeStatus(status: string): AuthenticodeVerdict {
  if (status === AUTHENTICODE_VALID) return 'valid'
  return AUTHENTICODE_CONDEMNED_STATUSES.has(status) ? 'condemned' : 'indeterminate'
}

/**
 * 校验脚本写出的那份 JSON 报告的键名。updater.ts 的 PowerShell 脚本用这三个值拼 hashtable，解析器用
 * 同样的值取，契约只在这里存一份。
 */
export const AUTHENTICODE_REPORT_KEYS = {
  languageMode: 'LanguageMode',
  status: 'Status',
  subject: 'Subject'
} as const

/** Windows PowerShell 5.1 的 `-Encoding UTF8` 写出的文件带 BOM。 */
const UTF8_BOM_CODE_UNIT = 0xfeff

/** Unicode 替换字符：任何一次编码降级的指纹。真实证书 DN 里不可能出现它。 */
const REPLACEMENT_CHARACTER = '\uFFFD'

export interface AuthenticodeReport {
  status: string
  subject: string
  languageMode: string
}

/**
 * 解析校验脚本写出的 JSON 报告文档。任何不满足契约的输入都返回 `null`，调用方据此按「校验没能执行」
 * fail-closed —— 绝不返回一个可能已被编码破坏的发布者身份。
 *
 * **为什么报告走文件而不走 stdout**：签名证书 DN 自带本地化非 ASCII 属性（线上证书的 `L=杭州市`、
 * `S=浙江省`、`OID.1.3.6.1.4.1.311.60.2.1.1=西湖区`），而 powershell.exe 的 stdout 按本机控制台代码页
 * 编码（中文 Windows 是 936/GBK）。裸传 DN 时只要 Node 侧解码与实际代码页不一致，这几个属性就变成
 * U+FFFD，与构建期冻结的期望串必然不符 —— 一次**解码降级**被误判成「发布者不符」的**安全拦截**，
 * 更新永久阻断且重试每次复现（bug 87108457：3 个安装包 9 次尝试全部 `Status=Valid` 却全部被拒）。
 *
 * 两条看起来更省事的出路都已被真机否掉：
 * - chcp 探测活动代码页再解码 —— 现场客户端**已含**该探测却仍回退到 UTF-8，且两条回退路径都不落
 *   日志、事后无法定论；安全判定不该架在 best-effort 探测上。
 * - `ConvertTo-Json` 把非 ASCII 转义成 `\uXXXX` 让 stdout 变纯 ASCII —— 真机实测 PS 5.1.17763 **不转义**
 *   （同一条 DN 仍原样输出 24 个非 ASCII 字节）。
 *
 * 所以让脚本用 `Set-Content -Encoding UTF8` 把报告写进一个一次性文件、Node 按 UTF-8 读：编码由 cmdlet
 * 参数显式决定，与控制台代码页和序列化器实现都无关。这里再把不变量钉死一次：文档里出现 U+FFFD 就
 * 说明某处仍发生了编码降级，判定输入不可信，返回 `null`。
 */
export function parseAuthenticodeReport(document: string): AuthenticodeReport | null {
  const text = (document.charCodeAt(0) === UTF8_BOM_CODE_UNIT ? document.slice(1) : document).trim()
  if (text.includes(REPLACEMENT_CHARACTER)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const report = parsed as Record<string, unknown>
  const status = report[AUTHENTICODE_REPORT_KEYS.status]
  const subject = report[AUTHENTICODE_REPORT_KEYS.subject]
  const languageMode = report[AUTHENTICODE_REPORT_KEYS.languageMode]
  // 三个字段都必须是在场的字符串：缺字段意味着脚本没跑完整，此时任何判定都不成立。
  if (typeof status !== 'string' || typeof subject !== 'string' || typeof languageMode !== 'string') {
    return null
  }
  return { status, subject, languageMode }
}

interface DistinguishedNameAttribute {
  key: string
  value: string
}

function pushAttribute(target: DistinguishedNameAttribute[], segment: string): void {
  const trimmed = segment.trim()
  if (!trimmed) return
  const separator = trimmed.indexOf('=')
  if (separator <= 0) return
  target.push({
    key: trimmed.slice(0, separator).trim().toUpperCase(),
    value: trimmed.slice(separator + 1).trim()
  })
}

/**
 * 把一条 Subject DN 串切成属性对，容忍值里的 `\,` 转义。
 *
 * .NET 的 X509Certificate2.Subject 形如 `K=V, K=V`，值内逗号转义为 `\,`；直接按逗号切会
 * 把这种值拦腰截断，让本来一致的发布者变成「不符」。
 */
function parseDistinguishedName(subject: string): DistinguishedNameAttribute[] {
  const attributes: DistinguishedNameAttribute[] = []
  let current = ''
  for (let index = 0; index < subject.length; index += 1) {
    const char = subject[index]
    if (char === '\\' && index + 1 < subject.length) {
      current += subject[index + 1]
      index += 1
      continue
    }
    if (char === ',') {
      pushAttribute(attributes, current)
      current = ''
      continue
    }
    current += char
  }
  pushAttribute(attributes, current)
  return attributes
}

/** 比较用规范形：属性按规范化后的键值对排序拼接，属性顺序与空格差异因此免疫。 */
function canonicalDistinguishedName(subject: string): string {
  return parseDistinguishedName(subject)
    .map((attribute) => `${attribute.key}=${attribute.value}`)
    .sort()
    .join(',')
}

/**
 * 两个 Subject 串是否指向同一发布者。
 *
 * 期望值在构建期冻结进 product.json（签名机上同一条 cmdlet 的输出），实际值在用户机器读回：
 * 同一张证书，但属性顺序/空格/键大小写可能随 .NET 版本与语言环境不同。整串相等会把任一格式
 * 差异变成「发布者不符」的安全拦截，所以按规范化后的属性集合比较。集合必须完全一致 —— 多一
 * 个或少一个属性都是另一个发布者。空 Subject 恒不等：签名者缺失不能被当成匹配放过。
 */
export function publisherSubjectsMatch(actual: string, expected: string): boolean {
  const left = canonicalDistinguishedName(actual)
  const right = canonicalDistinguishedName(expected)
  return left.length > 0 && left === right
}
