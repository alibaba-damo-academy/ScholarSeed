import { homedir } from 'os'
import { join } from 'path'

const WINDOWS_PLATFORM = 'win32'
const MACOS_PLATFORM = 'darwin'
const LOCAL_APP_DATA_ENV = 'LOCALAPPDATA'
const XDG_CACHE_HOME_ENV = 'XDG_CACHE_HOME'
const WINDOWS_LOCAL_APP_DATA_SEGMENTS = ['AppData', 'Local'] as const
const MACOS_CACHE_SEGMENTS = ['Library', 'Caches'] as const
const LINUX_CACHE_DIRNAME = '.cache'

/**
 * 系统缓存根目录（不含调用方自己的子目录）。
 *
 * 需要跨进程重启存活、但可以随时重新获取的载荷放这里，不放 temp：temp 不承诺存活
 * （macOS 清理长期未访问项，Windows 存储感知扫 %TEMP%），而缓存目录本来就是系统与
 * 用户清理工具的管辖范围，用户要腾空间时找得到。
 *
 * 平台行为矩阵（与 electron-updater 的 getAppCacheDir 一致）：
 *
 * | 平台   | 环境变量        | 有值时         | 缺失/空时            |
 * |--------|-----------------|----------------|----------------------|
 * | win32  | LOCALAPPDATA    | 直接采用       | <home>/AppData/Local |
 * | darwin | 不读环境变量    | —              | <home>/Library/Caches|
 * | linux  | XDG_CACHE_HOME  | 直接采用       | <home>/.cache        |
 *
 * Windows 取 Local 而非 Roaming：待装安装包是数百 MB 的一次性载荷，Roaming 在域环境
 * 会被同步。三平台都返回绝对路径，且都不落在 temp 内。
 */
export function systemCacheDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  if (platform === WINDOWS_PLATFORM) {
    return env[LOCAL_APP_DATA_ENV] || join(home, ...WINDOWS_LOCAL_APP_DATA_SEGMENTS)
  }
  if (platform === MACOS_PLATFORM) {
    return join(home, ...MACOS_CACHE_SEGMENTS)
  }
  return env[XDG_CACHE_HOME_ENV] || join(home, LINUX_CACHE_DIRNAME)
}
