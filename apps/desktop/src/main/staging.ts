// staging.ts — 更新工作目录里暂存物的命名与回收判定。纯逻辑，不碰文件系统。

const PAYLOAD_PREFIX = 'scholarseed-'
const MOUNT_PREFIX = 'mount-'
const SCRIPT_PREFIX = 'install-'
const SCRIPT_SUFFIX = '.sh'
const WINDOWS_PLATFORM = 'win32'
const WINDOWS_INSTALLER_EXTENSION = '.exe'
const MACOS_INSTALLER_EXTENSION = '.dmg'

export type UpdateArtifactKind = 'payload' | 'mount' | 'script' | 'other'

/** 工作目录里的一个条目。`empty` 只对目录有意义，由调用方读目录时填。 */
export interface UpdateArtifactEntry {
  name: string
  directory: boolean
  empty: boolean
}

export interface UpdatePrunePlan {
  files: string[]
  directories: string[]
}

export function installerExtension(platform: NodeJS.Platform = process.platform): string {
  return platform === WINDOWS_PLATFORM ? WINDOWS_INSTALLER_EXTENSION : MACOS_INSTALLER_EXTENSION
}

/**
 * 暂存包文件名由发布身份确定性生成、不带随机后缀，这样一次失败后的重试才找得到上回
 * 下了一半的文件 —— 随机名等于每次都从零开始。
 */
export function stagedInstallerName(
  version: string,
  buildNumber: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (
    ![version, buildNumber].every(
      (value) => typeof value === 'string' && /^[A-Za-z0-9.+_-]{1,128}$/.test(value)
    )
  )
    throw new Error('Invalid staged release identity')
  return `${PAYLOAD_PREFIX}${version}-${buildNumber}${installerExtension(platform)}`
}

/** 只认领本模块命名的东西；认不出来的一律归 `other`，回收时不会被碰。 */
export function updateArtifactKind(name: string): UpdateArtifactKind {
  if (name.startsWith(MOUNT_PREFIX)) return 'mount'
  if (name.startsWith(SCRIPT_PREFIX) && name.endsWith(SCRIPT_SUFFIX)) return 'script'
  if (
    name.startsWith(PAYLOAD_PREFIX) &&
    (name.endsWith(WINDOWS_INSTALLER_EXTENSION) || name.endsWith(MACOS_INSTALLER_EXTENSION))
  ) {
    return 'payload'
  }
  return 'other'
}

/**
 * 一次更新最多只该留下一个暂存包：`keepPayload` 之外的那些身份都装不上了，留着只是白占
 * 几百 MB。空挂载点是 `hdiutil detach` 之后没人 rmdir 的残骸，一并回收。
 *
 * 有任何一个非空 `mount-*` 就整轮不动 —— 那说明一次安装还在跑， detached 之前脚本随时
 * 要用它带来的包。安装脚本自己会在两条退出路径上 `rm -f "$0"`，所以这里不碰它；用户
 * 放进来的其它文件同样不碰。
 */
export function planUpdatePrune(
  entries: readonly UpdateArtifactEntry[],
  keepPayload: string | null,
  retainedPayloads: readonly string[] = []
): UpdatePrunePlan {
  const installInFlight = entries.some(
    (entry) => entry.directory && !entry.empty && updateArtifactKind(entry.name) === 'mount'
  )
  if (installInFlight) return { files: [], directories: [] }
  const files: string[] = []
  const directories: string[] = []
  for (const entry of entries) {
    const kind = updateArtifactKind(entry.name)
    if (
      kind === 'payload' &&
      !entry.directory &&
      entry.name !== keepPayload &&
      !retainedPayloads.includes(entry.name)
    )
      files.push(entry.name)
    if (kind === 'mount' && entry.directory && entry.empty) directories.push(entry.name)
  }
  return { files, directories }
}
