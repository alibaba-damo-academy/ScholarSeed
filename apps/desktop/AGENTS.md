# apps/desktop 工作约定

本文件是进入 Desktop 子系统后的导航入口。详细规范的唯一权威位于
[`docs/`](docs/README.md)；动态组件、token 与债务数量以源码和生成库存为准。
只编辑实际的 `AGENTS.md`，不要维护另一份规则副本。

## 开始前必读

- 改 renderer feature、shell、状态或组合前，读 [`docs/architecture/renderer.md`](docs/architecture/renderer.md) 与 [`docs/architecture/ownership.md`](docs/architecture/ownership.md)。涉及页面、面板、组件或交互视觉时，再读[组件复用、归属及棘轮契约](docs/design/components.md)，并使用 `ui-component-reuse` skill / `npm run ui-find Q="<意图>"`。
- 改样式、token 或 UI 组件：读 [`docs/design/foundations.md`](docs/design/foundations.md)、[`docs/design/components.md`](docs/design/components.md) 与 [`docs/design/interaction.md`](docs/design/interaction.md)，并先使用 `ui-component-reuse` skill / `npm run ui-find Q="<意图>"`。
- 改 main、preload、IPC、测试或验收：读 [`docs/quality/testing.md`](docs/quality/testing.md)，涉及边界时同时读 renderer/ownership 规范。
- 改 package scripts、生命周期或 TypeScript 配置：先读[工程脚本接口](docs/quality/testing.md#工程脚本接口)与[检查归属](docs/quality/testing.md#typescript-检查归属)，再核实际配方、唯一清单及消费者。
- 改主窗口 CSP、Session 响应回调或退出竞争：必须读[主窗口 CSP 生命周期](docs/architecture/ownership.md#主窗口-csp-生命周期)，不通过移除策略或吞异常绕过问题。

- 国际化、文案资源、语言偏好或编辑器语言联动：先读 [`docs/architecture/i18n.md`](docs/architecture/i18n.md) 与[接入规范](docs/architecture/localization.md)，遵循已锁定的 i18next / react-i18next 方案；按[验证规范](docs/quality/testing.md)核对本次验收，不将历史计划或勾选状态作为当前实现与验收证明。

## 高频硬约束

- 修改 `package.json` 中的依赖、`overrides` 或安装配置时，默认使用仓库指定的 Node/pnpm，同步维护 `pnpm-lock.yaml`，并保留 npm 兼容所需的 `package-lock.json`；不能只依赖已有 `node_modules` 的测试结果。按[测试与验收规范](docs/quality/testing.md)执行两条安装路径的锁文件校验，确认干净检出能安装后再交付。
- 后续新增、修改、联调功能时遵循[国际化接入规范](docs/architecture/localization.md)：新增/修改可见文案及本次触及 UI 单元的直接相关历史文案同步补齐中英资源、参数和校验；涵盖 aria/tooltip/错误/toast。不得因改一个文件就扩大到整页，不覆盖无关修改；只读任务或用户禁止页面修改时不扩大授权。运行 根目录 `pnpm ops ci check i18n --base <ref>` 与适用真实验证，禁止新增旧字典消费者。用户内容、协议、日志和代码不翻译。


- 消费域只能从 `components/ui` barrel 导入 UI 能力；禁止深导入 UI 实现。
- `components/ui` 不得依赖 app、shell、feature、业务组件、API 或 store；业务变化通过 contracts/feature contributions 组合。
- 页面禁止新增原生 `button/input/select/textarea/table`；不得手写 SVG 图标或在 feature 内自造同类设计系统组件。
- 复用棘轮逐文件 counts 只能降低，未列文件预算为零；禁止扩大 `reuse.policy.json` 或手改 `reuse.baseline.json` 凑绿，缺能力按[组件 Owner 契约](docs/design/components.md)扩展与登记。
- 页面开发先查[组件资产与复用指南](docs/design/assets.md)及[自动资产列表](docs/_generated/components.md)，复用前核对 props、依赖和运行示例。
- 无业务稿件的新页面先按 [Vibe Coding 页面契约](docs/design/vibe-coding.md) 选择页面类型和 `Page` 组合；PageBody 不得与宿主重复创建滚动容器。
- 自有页面/组件能用 Tailwind CSS 表达的样式全部使用 Tailwind；手写选择器 CSS 仅用于必要的第三方内部样式覆盖。设计 token/字体/必要 keyframes 由 design 持有；边界与存量迁移见[样式规范](docs/design/foundations.md)。
- CSS新增/更改规则由身份棘轮约束；必要第三方覆盖须在 `scripts/ci/css.exceptions.json` 精确登记容器、选择器、库、原因和验证方式，不能扩大历史库存。
- 后续页面开发仅整改本次新增或修改的相关 UI，不要求重写整页，不扩大到其他 owner；基础代码合并不会自动迁移页面。
- 新视觉值使用 `--vds-*` token；禁止新增固定颜色、固定 Tailwind 色或纯视觉 inline style。动态几何与用户数据值须说明来源。
- 浮层层级按 `design/zindex.css` 语义角色选择：项目/视图导航使用 `--vds-z-inline-flyout`，局部命中控件使用 `--vds-z-local-control`，常驻工作区面板/会话内滚动控制/回退确认分别使用 `--vds-z-surface-panel`、`--vds-z-scroll-control`、`--vds-z-session-confirm`，嵌套危险确认使用 `AlertDialog` 与 dialog family 的嵌套 token；禁止页面私有裸 z-index，新增引用须能由 `visual.mjs` 解析到真实 token 定义。
- renderer 不得获得 Node/Electron 能力；能力沿 main → preload → typed renderer contract 暴露。
- 文档状态词必须区分 `current`、`required`、`gap`、`advisory`，不得把目标状态写成当前能力。

## 跨平台构建硬约束

修改 main、打包脚本、Runtime 组装、文件系统或子进程启动时，必须同时检查 macOS 与 Windows：

- 用 `path.join` / `path.resolve` 构造路径，用 `path.delimiter` 构造 `PATH`，解析命令输出时兼容 LF 与 CRLF。
- 不得假设命令没有扩展名；分别确认 `.exe`、`.cmd`、`.bat` 的启动方式，且不得把不可信参数交给 shell。
- 目标 Python 的命令目录通过该解释器的 `sysconfig.get_path("scripts")` 获取，不得假设它与 `python.exe` 同目录。
- 不得以宿主 Python、宿主 npm、宿主 PATH 或源码目录证明安装包内 Runtime 可用。
- 文件权限按普通文件/可执行文件语义归一化，不得直接用 Windows 的 POSIX mode 表象做完整性判断。
- 修改上述逻辑时补充 macOS/Windows 行为矩阵和对应契约测试。Windows 验证至少运行 根目录 `pnpm ops cd build local --platform win32 --arch x86_64`，确认 Velopack Setup/full 生成且 `release-result.json` 为 `status: passed`。
- `electron-builder` 精确锁定版本，不要写成 `^` 范围。新版本的 dmg-builder 默认运行时下载 dmgbuild；本仓库将 `dmgbuild==1.6.7` 锁为 macOS 构建期依赖，DMG 入口必须验证本地程序并设置 `CUSTOM_DMGBUILD_PATH`，缺失时拒绝构建而不是联网回退。不要仅凭上游源码分支声称 `hdiutil` 错误码 `16` 的强制卸载已生效；需真实故障验证。
- DMG 容量与拷贝失败由 `scripts/image.py` 持有；修改该路径先读[构建指南](../../docs/runbooks/build.md)，执行 `node --test apps/desktop/scripts/image.test.cjs` 并验证真实镜像，不以 DMG 校验和合法证明内容完整。

## 设计对齐

- Public design requirements and mappings live in `docs/architecture/design-map.md`; read the relevant states and constraints before changing UI.
- Use [design tooling](docs/design/tooling.md) and the public `ui-component-reuse` skill. A private design service is optional, never a prerequisite.
- Distinguish current behavior, confirmed requirements, gaps and advisory guidance. Design evidence and static checks do not prove real product acceptance.

## Windows 更新权限维护

- Windows 安装和更新由固定版本 Velopack 管理，仅交付个人安装 Setup EXE，暂不支持全局安装，不构建或分发 MSI；macOS 保留 Squirrel.Mac。修改此边界先读 [Windows 更新契约](updater/README.md#windows-velopack)。
- 更新包必须通过离线签名、完整成员清单和路径预检；在线候选授权与安装身份一致。官方 Velopack 持有应用替换；独立薄 helper 在提权后使用安装根下的 packages 暂存，准备缺失组件并由原用户协调器恢复启动。不得恢复旧应用 store、健康回滚或常驻恢复器。
- Windows 的 Python、TeX Live、PowerShell、Codex、Office 按签名清单独立下载 ZIP；Setup/full/delta 仅携带程序和 runtime.json，首次安装需要联网。组件按独立版本在安装根 runtime 下展开和复用。首次展开验证完整库存，已有版本核对身份、完成凭据及关键入口；不能把快速复用描述为全盘损坏检测。macOS 布局保持不变。
- 更新前先 quiesce，并确认本应用拥有的 backend/runtime 进程族已经退出。交接前失败恢复原版本运行；不做健康失败回滚、不迁移旧更新目录。
- 不按进程名杀进程，不清理其他安装仍可能使用的共享 runtime 组件；仅当前清单不足以授权回收共享组件。
- 正式签名和上传仅由 CI 执行。本地未签名安装、单测或框架探针不能作为正式签名更新/UAC 验收。
- 真机需覆盖个人安装、delta/full、runtime 退出恢复、卸载和路径/签名拒绝。源码检查不能代替安装后的产品启动与截图。

## Windows 公司元数据

- 控制面板 Publisher 与 EXE CompanyName 使用 `package.json` 的 `author.name`：`Alibaba Damo (Hangzhou) Technology Co., Ltd.`；不改变证书 Subject 或自动更新签名校验。
- electron-builder 的作者规范化会将括号视为 URL，即使 author 是对象也会截断名称；`build.cjs` 必须通过规范化后的 `extraMetadata.author` 透传原始对象。

## 完成前

- 更新后的 CDP 参数由 `src/main/debuglaunch.ts` 统一校验，只保留显式合法的本机端口，无参数不开启调试，不透传任意 argv。Windows 在 `receipt.update.lock` 中随 user-data-dir 传递；macOS 经 `relaunch.ts` 一次性上下文保存，由 `index.ts` 在 app ready 前恢复，显式新端口/pipe 优先。定向测试：`node --experimental-transform-types --test src/main/debuglaunch.test.ts src/main/relaunch.test.ts`。真实 Squirrel 升级需源、目标均包含该协议；Windows 需原生实机验证，单测与 Electron 探针不替代安装版验收。

- Windows 托盘无响应先取 `$SCHOLARSEED_HOME/logs/window.log`，默认在用户主目录 `.scholarseed/logs/`；同时确认主进程是否仍存在。该文件只在带窗口诊断的版本首次触发相关操作后创建。不得用单元测试中的事件触发或 macOS 窗口恢复证明 Windows 系统托盘已验收。
- Windows 托盘图标使用 `resources/windows.ico` / `windows-tray.ico`；用 `Tray.setContextMenu` 绑定原生右键菜单，确保窗口隐藏时无需等待渲染进程回复即可选择退出。菜单展开期间收到的快照在关闭后应用，保留当次菜单项的点击行为。

- 窗口关闭确认由 `src/main/tray.ts` 持有请求和系统动作，通过 `src/window.ts` 的 IPC 契约交给 `src/renderer/src/shell/Close.tsx` 组合统一 UI；不要重新引入固定尺寸的 data URL HTML 弹窗。平台矩阵见 `docs/architecture/ownership.md`。定向检查：`node --experimental-transform-types --test src/main/tray.test.ts src/main/menu.test.ts`；真实关闭验收：构建后 `npx playwright test e2e/close.spec.ts --project=smoke`，不能使用会绕过关闭逻辑的 `--drive` / headless 启动证明关闭行为。

```bash
# 在仓库根目录执行
pnpm ops ci check docs desktop
pnpm ops ci test --scope desktop
pnpm ops ci check types desktop
```

规范、源码或门禁变化时运行 根目录 `pnpm ops ci check docs desktop --write` 更新派生库存，再运行上述检查。该命令不会改 baseline；baseline 只能在独立、明确审查的债务收紧变更中更新，不得用于掩盖新增债务。
