# 系统入口与窗口生命周期候选构建依据

## 建设状态

资产修订 `system-shell/1`。本页只建立窗口、后台菜单、通知和更新的候选专项线索，不进入已采用基线或冒烟分母；新增 `SYSTEM-*-CAND-*` 是候选标识，历史 `NOTIFICATION-01@1` 的 `@1` 是资产修订，不是产品需求版本。目标 `0.3.2 / 202611121823 / preview` 的需求版本、产品采用与安装包适用性均待确认；原历史冻结和既有页面要求不变。

## 可回查的需求来源

- [窗口关闭与后台菜单 Owner](../../../docs/architecture/ownership.md#窗口关闭确认与后台菜单)记载 macOS 与 Windows 的关闭、真实退出及菜单导航边界，并明确真实非 headless Desktop 和各平台原生验收；该文中的 current 是源码或已知实现事实，required 是验收依据，不能据此宣称目标安装包已通过。
- 任务提醒及后台入口方案记录任务、通知和项目导航的关系；其中“需要确认的产品规则及建议默认值”明确是实施假设，未经确认不自动写成已批准判据。OS 通知权限、真实任务、已读状态及菜单导航属于不同操作。
- 更新轻量提示设计映射记录工作项 `87617772` 的不抢焦点和用户主动打开更新入口要求；真实更新就绪截图及跨平台验证在来源中列为缺口。实际安装、签名和渠道需遵循[构建与发布指南](../../../../../docs/runbooks/build.md)，其存在不授予安装或发布权限。

## 历史稳定点

从[历史 P2 冻结](../../frozen/p2-20261025-539af0794/freeze.json)所记 `sourceCommit` `539af079455cc821b976760728fc13dfedbb8b66` 回查 `apps/desktop/docs/scenarios/catalog.json` 和 `apps/desktop/eval-scenarios/exploratory/desktop-business/cases/settings.json`，其 SHA-256 分别为 `e4a029cce1e58db658acb2643ea05621f48c288d12209eb0df41f5a4329ec45f` 和 `372aee4969f44a7e9caafc93bdf4d3ee57990a7ada48b7d0db867bf7405e2ff2`。

`NOTIFICATION-01@1` 的历史目标是任务提醒与真实状态一致，标已读不改变任务；目录标记 `reviewState=pending`、`coverageEligibility=exploratory`，对应 `D6-SET-009` 的 `expectedStatus=candidate_unapproved`，且该点在 P2 冻结的 `excludedOutsideDefaultDirections` 中。不以 `status=active`、历史观察或现有[通知设置展示](./../notifications/requirements.md)推断目标包已采用、实际投递或评测通过。以上源可用 `git show 539af079455cc821b976760728fc13dfedbb8b66:<路径>` 回查，不恢复或修改冻结文件。

## 源码定位、截图与交接

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`，尚未与目标安装包建立可信同源关系。[tray.ts](../../../src/main/tray.ts) 持有托盘/关闭动作，SHA-256 `ffa937ecb90c8124ec589acf319213af41dde6b6f04fab28cb8d2de22f63fb5a`；[window.ts](../../../src/main/window.ts) 持有原生窗口生命周期，SHA-256 `fdee037c2cce16bb064ec9ea5e04be110fec65053303b973074c650dfb8427c3`；[Close.tsx](../../../src/renderer/src/shell/Close.tsx) 和 [Background.tsx](../../../src/renderer/src/shell/Background.tsx) 分别承载关闭确认和后台菜单交互，SHA-256 `28ca091740ff3d05593353d702e32a82e43aa902562c5b121c68ea44dda7ebc7`、`1eaad9f539aaa58abda917036e2f3968c64ac1f65be545a19d303a48c39c7d73`。这些是定位与副作用线索，不替代实际用户需求确认和真实产品观察。

目标制品线索为 macOS arm64 `0.3.2 / 202611121823 / preview`，先前记录的 ASAR SHA-256 为 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`；执行前须重新核实例及摘要。现有 `notifications/reference.png` 和此前设置页实图仅覆盖通知偏好，不证明 OS 通知或原生菜单。当前无目标版本、可追溯且获准复用的系统通知、关闭确认、托盘或更新就绪完整图；逐平台补采须具备真实产品及授权，不能用源代码或组件夹具代图。

后续先由需求 Owner 确认候选的产品需求版本、适用性和仍待决规则，再准备隔离任务、系统状态、平台与对应授权；风险较高的更新、安装、退出、系统设置与已读动作分别冻结。可恢复环境及来源不明时不执行，不通过修改产品规则或取消门槛制造通过。
