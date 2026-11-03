import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'

/** Observe OS creation before handing off a detached helper. This acknowledges
 * spawn only, not helper readiness, successful installation or process-family exit.
 */
export async function startDetachedProcess(
  executable: string,
  args: readonly string[]
): Promise<ChildProcess> {
  const child = spawn(executable, args, { detached: true, stdio: 'ignore' })
  await once(child, 'spawn')
  child.unref()
  return child
}

// subprocess.ts — 更新链全部外部命令的唯一异步收口点。
//
// 从 updater.ts 抽出：超时与取消是「任何一条系统命令挂起都不允许把安装变成无限等待」这条
// 不变量的强制层（bug 87253073：hdiutil/codesign/spctl 任一挂起即遮罩永久转圈）。收口在这里，
// 调用方只需声明上限，不能各自散落 spawn。

const WINDOWS_PLATFORM = 'win32'
const CHILD_KILL_WAIT_MS = 5_000
const childStops = new WeakMap<ChildProcess, Promise<void>>()

/** Wait for this owned child to exit; sending a signal is not an exit acknowledgement.
 * This does not certify that descendants have stopped. Activation owns that boundary.
 */
export function stopChildProcess(
  child: ChildProcess,
  graceMs: number,
  requestStop: () => void = () => {
    child.kill('SIGTERM')
  }
): Promise<void> {
  const pending = childStops.get(child)
  if (pending) return pending
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
    return Promise.resolve()
  }
  const stopped = new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      child.removeListener('error', onError)
    }
    const onExit = (): void => {
      cleanup()
      resolve()
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const kill = (): void => {
      timer = setTimeout(() => {
        onError(new Error(`child did not exit after SIGKILL: pid=${child.pid}`))
      }, CHILD_KILL_WAIT_MS)
      try {
        child.kill('SIGKILL')
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)))
      }
    }
    child.once('exit', onExit)
    child.once('error', onError)
    if (graceMs <= 0) {
      kill()
    } else {
      timer = setTimeout(kill, graceMs)
      try {
        requestStop()
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)))
      }
    }
  })
  childStops.set(child, stopped)
  // A failed attempt must remain retryable without creating an unhandled rejection.
  void stopped.then(
    () => childStops.delete(child),
    () => childStops.delete(child)
  )
  return stopped
}

// chcp.com 报的活动控制台代码页 → TextDecoder 标签。中文 Windows 是 936(GBK)；不在表里或探测
// 失败都退回 UTF-8。**这只影响日志/stderr 的可读性**：签名校验的判定输入走 `Set-Content -Encoding
// UTF8` 写出的报告文件（见 authenticode.ts parseAuthenticodeReport），与这里的探测结果无关，探测
// 失败不会再变成一次安全拦截。
const WINDOWS_CODE_PAGE_ENCODINGS: Readonly<Record<string, string>> = {
  '932': 'shift_jis',
  '936': 'gbk',
  '949': 'euc-kr',
  '950': 'big5',
  '1251': 'windows-1251',
  '1252': 'windows-1252',
  '65001': 'utf-8',
}
const FALLBACK_CONSOLE_ENCODING = 'utf-8'

export interface CommandOptions {
  input?: string
  env?: NodeJS.ProcessEnv
  windowsHide?: boolean
  /** 上限毫秒：到时 SIGKILL 子进程并 reject。缺省 = 不设上限，仅留给确有理由的调用方。 */
  timeoutMs?: number
  /** 外部取消信号：abort 时 SIGKILL 子进程并 reject。 */
  signal?: AbortSignal
}

export interface AsyncCommandResult {
  status: number | null
  stdout: string
  stderr: string
  /** 实际用来解码 stdout/stderr 的编码标签。落日志用：探测静默回退时这是唯一的现场证据。 */
  encoding: string
}

/**
 * 子进程输出该按哪种编码解码（带缓存）。
 *
 * Windows 控制台程序（powershell.exe 等）按 OEM 代码页输出，中文系统是 936(GBK)。Node 一律
 * `toString('utf8')` 会把 GBK 字节解成乱码——更新失败时的 PowerShell 中文报错进日志/弹窗就不可读
 * （bug 87042987）。这里探测一次活动代码页并缓存。`chcp.com` 是原生可执行、不经 PowerShell，
 * 因此不受受限语言模式影响。非 Windows 一律 UTF-8。
 */
let cachedConsoleEncoding: Promise<string> | null = null

export function consoleOutputEncoding(): Promise<string> {
  if (process.platform !== WINDOWS_PLATFORM) return Promise.resolve(FALLBACK_CONSOLE_ENCODING)
  if (!cachedConsoleEncoding) cachedConsoleEncoding = detectConsoleEncoding()
  return cachedConsoleEncoding
}

function detectConsoleEncoding(): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('chcp.com', [], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('ascii')
    })
    child.on('error', () => resolve(FALLBACK_CONSOLE_ENCODING))
    // chcp 输出形如 "Active code page: 936"（纯 ASCII），取第一个数字查表。
    child.on('close', () => {
      const match = out.match(/\d+/)
      resolve(
        match
          ? (WINDOWS_CODE_PAGE_ENCODINGS[match[0]] ?? FALLBACK_CONSOLE_ENCODING)
          : FALLBACK_CONSOLE_ENCODING
      )
    })
  })
}

function decodeConsoleOutput(buffer: Buffer, encoding: string): string {
  try {
    return new TextDecoder(encoding).decode(buffer).trim()
  } catch {
    // 极少数 ICU 不识别的代码页标签退回 UTF-8，至少 ASCII 部分仍可读。
    return buffer.toString('utf8').trim()
  }
}

/**
 * 异步跑一条命令，绝不阻塞主进程事件循环。
 *
 * Electron 主进程与 macOS 的 AppKit 主线程是同一个：任何 spawnSync 都会把整条事件循环冻住，
 * 期间原生窗口控件（红绿灯）收不到点击——macOS 安装链的 ditto 拷贝整包 + codesign --deep /
 * spctl / stapler 校验动辄十几到几十秒，用户就点不动最小化/关闭。改成异步 spawn 后，
 * 等命令期间事件循环照常转，窗口保持可响应。Windows 侧的签名校验同理由它承载。
 *
 * 超时与取消都落到 SIGKILL 本进程：hdiutil/codesign 等命令挂起时（Gatekeeper 在线校验、
 * diskarbitration 忙）不会自己退出，没有上限就没有恢复路径。被 kill 后子进程的 'close' 仍会
 * 触发，settled 标志保证它不会覆盖已经成立的超时/取消结论。
 *
 * 输出按 consoleOutputEncoding() 解码、且**收齐字节再整体解码**：逐块 toString 会把跨块的多字节
 * 字符（UTF-8 中文、GBK 双字节）截断成乱码。
 */
export function runCommandAsync(
  executable: string,
  args: string[],
  options: CommandOptions = {}
): Promise<AsyncCommandResult> {
  return new Promise((resolve, reject) => {
    const { timeoutMs, signal, input, ...spawnOptions } = options
    if (signal?.aborted) {
      reject(new Error(`command aborted before start: ${executable}`))
      return
    }
    const child = spawn(executable, args, { windowsHide: true, ...spawnOptions })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const onAbort = (): void => {
      fail(new Error(`command aborted: ${executable}`))
    }
    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      void stopChildProcess(child, 0).then(
        () => reject(error),
        (stopError: unknown) =>
          reject(new Error(`${error.message}; child termination failed: ${String(stopError)}`))
      )
    }
    if (timeoutMs !== undefined) {
      timer = setTimeout(
        () => fail(new Error(`command timed out after ${timeoutMs}ms: ${executable}`)),
        timeoutMs
      )
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    child.on('error', (error) => fail(error instanceof Error ? error : new Error(String(error))))
    if (input !== undefined) {
      child.stdin.on('error', (error) => fail(error))
      child.stdin.end(input)
    }
    child.on('close', (status) => {
      if (settled) return
      settled = true
      cleanup()
      void consoleOutputEncoding().then((encoding) => {
        resolve({
          status,
          stdout: decodeConsoleOutput(Buffer.concat(stdoutChunks), encoding),
          stderr: decodeConsoleOutput(Buffer.concat(stderrChunks), encoding),
          encoding,
        })
      })
    })
  })
}

/**
 * requireCommand 的异步版：非 0 退出抛错（fail-closed 语义不变），返回 stdout+stderr 合并文本 ——
 * 与旧同步版逐字一致，因为 codesign -d 把元数据写到 stderr、plutil 写到 stdout，调用方依赖合并结果。
 * 启动失败、超时、取消同样抛错并带上 label：日志里必须能读出是哪一步没了。
 */
export async function requireCommandAsync(
  executable: string,
  args: string[],
  label: string,
  options: CommandOptions = {}
): Promise<string> {
  let result: AsyncCommandResult
  try {
    result = await runCommandAsync(executable, args, options)
  } catch (error) {
    const wrapped = new Error(
      `${label} failed: ${error instanceof Error ? error.message : String(error)}`
    )
    // 透传 spawn 的 errno code（如 ENOENT）：调用方据此区分「校验工具缺失＝本机无法执行校验」与
    // 「校验执行了但结果不可信」，不从错误文本反推（见 updates.ts 的 errorFallback 纪律，bug 87435837）。
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (typeof code === 'string') (wrapped as NodeJS.ErrnoException).code = code
    throw wrapped
  }
  const output = `${result.stdout}\n${result.stderr}`.trim()
  if (result.status !== 0) throw new Error(`${label} failed: ${output}`)
  return output
}
