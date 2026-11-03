// storage.ts — 数据位置（SCHOLARSEED_HOME）桥接契约（proposal 112）。
//
// 与 src/updates.ts 同模式：跨 main → preload → renderer 的形状定义在顶层契约模块，
// 实现（解析/校验/写指针）在 src/main/storage.ts。renderer 不得 import electron 侧实现。

/** 数据位置只读概览，供设置页「数据存储」展示。home 运行期不可改。 */
export interface StorageConfig {
  /** 生效的产品家目录（绝对路径）。 */
  home: string
  /** 组件仓库根 = <home>/runtime；解析失败为 null（保留旧桥形状）。 */
  runtimeStore: string | null
  /** home 是否经用户配置（注册表 env / userData 指针），而非回落默认 ~/.scholarseed。 */
  configured: boolean
  /**
   * 平台是否允许写 userData 指针改 home。Windows 为 false：home 由安装向导写 HKCU env，
   * env 优先级高于指针，运行期改指针会被 env 覆盖而静默无效。非 Windows 也仅首启一次性
   * 「高级」入口可用（见 firstLaunchEligible），设置页永远只读。
   */
  canChangeDataHome: boolean
  /** mac/dev 首启一次性「高级」入口门控（proposal 112 §6.C）：打包 ∧ 无 env ∧ 无指针 ∧ 默认 home 空。 */
  firstLaunchEligible: boolean
}

/** mac「高级」/ dev 提交数据父目录的结果。失败原因码转 UI 文案。 */
export type CommitDataHomeResult =
  | { ok: true; home: string; restartRequired: boolean }
  | { ok: false; reason: 'invalid_shape' | 'not_writable' | 'unsupported' }
