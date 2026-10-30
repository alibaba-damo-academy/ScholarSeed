/**
 * 前端组合根（开发 7 拥有）。
 *
 * 架构文档 §3.7 与 §4.3 的核心约束：开发 7 只组合 `FeatureModule`，
 * **不在 App Shell 中根据文件扩展名、库类型或业务状态写硬编码分支**；
 * 新增功能应通过增加贡献项完成，而不是继续扩大 `App.tsx` 和全局 Store。
 *
 * 本文件是那句话的落地点。改造前 `ModulePanel` 与 `Workbench` 各有一串
 * `mainView === ...` / `switch (kind)` 分支；现在两者都只查这里的注册表。
 *
 * 每个 Feature 的贡献声明写在自己的 `feature.tsx` 里（开发 1～6 各自维护），
 * 本文件只做汇总 —— 因此加一个 Feature 不需要动 Shell 代码。
 */

import { withViewerBoundary } from './viewer'
import { availabilityPolicy } from './policy'

import {
  composeFeatures,
  type FeatureModule,
  type FeatureRegistry,
  type RouteKey,
} from '../contracts/features'
import { assistantFeature } from '../features/assistant/feature'
import { browserFeature } from '../features/browser/feature'
import { feedbackRecorderFeature } from '../features/feedback-recorder/feature'
import { literatureFeature } from '../features/literature/feature'
import { projectFeature } from '../features/project/feature'
import { skillsFeature } from '../features/skills/feature'
import { resourcesFeature } from '../features/resources/feature'
import { workbenchFeature } from '../features/workbench/feature'

/**
 * 装配顺序即优先级：靠前的 Feature 先注册，冲突时保留它的贡献。
 *
 * 顺序按架构文档的开发编号排：项目(1) → 资料库(2) → 文献库(3) → Workbench(4) →
 * AI(6)。这样冲突告警里的"谁覆盖了谁"与责任人编号一致，
 * 便于定位到该找哪位同事。
 */
const MODULES: readonly FeatureModule[] = [
  projectFeature(),
  skillsFeature(),
  resourcesFeature(),
  literatureFeature(),
  workbenchFeature(),
  assistantFeature(),
  ...(availabilityPolicy.browserEnabled ? [browserFeature()] : []),
  feedbackRecorderFeature(),
]

/**
 * viewer 的加载边界（装配期统一施加）。
 *
 * viewer 可以是按需加载的 chunk（Workbench 的六个 viewer 都是），所以渲染它们必须有
 * Suspense 和文档错误边界。放在这里而不是放进各 Feature 或 Shell 的消费点：装配是这件事唯一的
 * 汇聚处，一次施加就对现在和将来的所有 viewer 生效，Feature 作者不必记得包一层，
 * Shell 的两个消费点（Dock 的 DocumentView 与 Workbench）也不必各写一遍。
 *
 * fallback 沿用文档区既有的 `vds-viewer-empty` 安静文案 —— 对用户来说「等 chunk」和
 * 「等后端打开文档」是同一件事，不该长得不一样，更不该闪一张大卡片。
 */
function withViewerBoundaries(module: FeatureModule): FeatureModule {
  if (!module.viewerPlugins) return module
  return { ...module, viewerPlugins: module.viewerPlugins.map(withViewerBoundary) }
}

/**
 * 全局唯一的贡献注册表。
 *
 * 模块级常量而非 React context：Shell 的多个位置（ModulePanel、Workbench、
 * ActivityRail）都要读它，且它在运行期不变。走 context 只会多一层
 * Provider 而不带来任何好处。
 */
export const featureRegistry: FeatureRegistry = composeFeatures(MODULES.map(withViewerBoundaries))

/** 已注册的 Feature id，供诊断与验收 harness 断言。 */
export const registeredFeatureIds = MODULES.map((module) => module.id)

/**
 * 该视图是否声明了「必须有项目」。
 *
 * 活动栏要据此禁用入口，四区外壳要据此隐藏模块面板 —— 两处问的是同一个
 * 问题，答案只能有一处，且来自 Feature 的 `requiresProject` 声明。
 */
export function viewRequiresProject(view: RouteKey): boolean {
  return featureRegistry.activityItems.some(
    (item) => item.key === view && item.requiresProject === true
  )
}
