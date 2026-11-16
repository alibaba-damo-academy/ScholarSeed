# Desktop 测试与验收规范

## Scope / Non-goals

覆盖规范门禁、unit、render、typecheck、Electron e2e 与真实产品验收的选择。不把 fixture 或直接内部调用冒充用户路径。

## Source of truth

以下 `pnpm ops` 命令均从仓库根目录执行；Desktop 的 package scripts 和 hooks 是领域内部配方，不作为第二套推荐用户入口。

`components/ui.render.test.ts` 默认使用 Playwright Chromium；本机已安装 Chrome 时可显式设置
`PLAYWRIGHT_CHANNEL=chrome` 选择该浏览器。此测试选择不安装浏览器、不改变产品宿主，
不能把 Chrome fixture 结果当作 Electron 或 Windows 验收。

`renderFixture` 使用 `@playwright/test` 持有的 Chromium；安装 Node 依赖不等于已下载浏览器。
缺少对应 revision 时，经下载授权后在仓库根目录执行
`node apps/desktop/node_modules/@playwright/test/cli.js install chromium`，再运行原测试。
不要改用独立 `playwright` 包的 CLI 推断测试框架所需 revision，两者可能属于不同版本。
归档 fixture 默认通过 Python Owner 的 `developmentPython` 解析当前仓库开发环境
（含 `VENV` / CI 上下文），不回退系统 `python3`；显式 `TEST_PYTHON` 仍由调用方负责。

源码格式化与生成物边界见 [仓库格式规范](formatting.md)。

`package.json` 的 scripts、`scripts/ci/` 的测试配方及就近 `__tests__/`、源码相邻 tests、`e2e/` 与 main 的 shoot/drive/workbench harness 是执行真源。
Desktop 默认使用仓库声明的 pnpm 与 `pnpm-lock.yaml`；`package-lock.json` 用于显式 npm 兼容路径，两者都是实际安装输入，依赖变更须同步维护。

### 工程脚本接口

**current（目录契约按需执行）**：`directory-test` 不属于默认质量/安全构建门禁。
只有显式运行 `pnpm ops ci test integration --scope desktop --suite native-contract`
时，入口才以 `runDirectoryContract: true` 请求该测试。普通原生编译的 `build.json`
记录 `contracts.directory: "not-requested"`，不将未执行记为通过；显式执行成功后才记
`passed`，任何失败（包括 SIGKILL）保持非零退出。其他原生契约、安全策略、签名和
制品校验保持原有要求。此为用户明确调整的触发政策，不是 SIGKILL 自动豁免。
macOS 已验证默认编译；Windows 的同一触发政策仍需对应宿主验收。

ops 负责用户参数和跨域编排，Desktop package scripts 是领域配方，不反向调用根 ops。
安装、开发、检查、测试、构建分组排列；生命周期钩子紧邻所修饰命令，分组不改变触发条件。

| 接口 | 执行真源 / 边界 |
| --- | --- |
| `pretest` | `scripts/ci/pretest.cjs` 顺序执行工具链、runtime/build 契约、standards、i18n 测试与检查，任一步失败停止 |
| `test` / `test:coverage` | `scripts/ci/test.cjs` 持有唯一文件清单与原生文件子集；`test` 执行全集，coverage 执行其补集，两者本地并发均为 1，coverage 不隐式增加 `pretest` |
| CI `desktop-unit` / `desktop-extra-node` | 根 CI 读取同一清单，覆盖率消费补集，已分层原生探针进入既有串行 `desktop-extra-node`，不经过 c8；两阶段遵守宿主串行策略，通用 CPU 配额不提高其文件并发；quarantine、报告和独立 pretest stage 保留 |
| `test:e2e:mr/live/update` | `scripts/ci/e2e.cjs` 先经工具链执行一次 `build`，再选择原 smoke/live/update 项目；通用 `test:e2e` 仍不构建 |
| `package` / `package:check` / `package:distribution` | 分别为本地包、候选检查、渠道构建；实际安装包共用构建器的固定冒烟，候选目录检查不执行；Desktop `package:dist` 负责分发依赖准备与委托 |

`standards`测试配方由`pretest` Owner持有；根CI即使启用临时用例隔离也实际执行它。
其聚合的`visual`/`git`只沿该入口执行，不在`extra`阶段重复登记。

**current**：已分层的构建/沙箱/菜单、插件、偏好持久化、DevTools、CDP relay、Browser及Agent/搜索DOM检查由
[原生子集声明](../../scripts/ci/test.cjs)收集。
原生存储身份与旧目录迁移的真实库断言同样归该子集，文件级沿编译Owner准备真实库，
不要求逻辑测试调用方手工设置库路径；原生编译缺前提按失败报告，不条件跳过。
其他历史混合文件仍需按职责核对，
不把覆盖率补集等同纯逻辑全集；原生依赖及跨平台验收仍由原Owner负责。
原生焦点检查需先核对未锁屏、可交互的宿主桌面；前提不可用时保留失败/缺证，
不自动解锁、模拟用户活动或放宽焦点断言。环境恢复后再复验，不反复重跑追绿。

纯逻辑等待/采样可使用[Node MockTimers](https://nodejs.org/download/release/v24.16.0/docs/api/test.html#class-mocktimers)。
已解构的builtin计时器绑定需在测试作用域用[syncBuiltinESMExports](https://nodejs.org/download/release/v24.16.0/docs/api/module.html#modulesyncbuiltinesmexports)
同步mock及恢复；保留边界、取消和清理断言，不用空延迟或为隔离改变生产等待/导入。
时钟辅助只作用于该逻辑测试文件，不据此声称原生真实时间或宿主验收；性能墙钟
从mock作用域外测量，不能以被mock的Date计算运行时间。

删除无独立职责和活消费者的 Desktop `package:installer`、`build:check`、`build:release`、
`release`；对应能力使用 `package`、`package:check`、`package:distribution`，用户从 ops 选择。
根 `package:dist`、`package:check`、`package:verify` 及 `scripts/desktop.cjs` 是既有外仓契约，
不是上述 Desktop 重复别名，不随之删除。签名、公证、冒烟与验收准入保持原 Owner。

工程回归包含真实 npm/pnpm 在空依赖临时包中的钩子调度，证明顺序、次数、失败短路和
参数边界；临时动作不执行产品，不能据此宣称 Electron、安装器或 Windows 原生验收通过。

macOS helper 的准备、清理、计时、admission 与 binding Native 契约保留 stdout/stderr 日志，并写入 schema-1 的
`*-test.result.json`，包含子进程 PID、退出状态、终止信号及 spawn error；PID 不可用时为 null。即使 stderr 为空，
构建失败信息也保留这些字段；信号、启动错误或非零退出仍阻断构建，不自动重跑或
延长既有预算。真实 repair bridge 的进程取证不确定仍是安全拒绝，不可改报成归档
失败或恢复成功；独立的归档接续契约不替代实机退出资格。结合精确 PID 与可执行文件
核对宿主诊断，不能仅凭 XProtect 的框架警告判定进程被终止的原因。

宿主终端安全可能在测试入口执行前拒绝新编译程序，即使 ad-hoc 签名严格校验通过；
签名有效不等于获准执行。单个程序的运行确认超时并默认拒绝，可表现为 SIGKILL 且
测试输出为空。应结合内核退出原因与安全软件中精确程序的决策记录定位，kqueue 没有
代码签名或内存错误标记本身不足以排除这类拒绝。

获得明确的人工运行确认授权前，冻结已审阅源码、程序路径和 SHA-256 清单，并核验
签名。只对这些精确制品使用全新私有 fixture 运行；拒绝仍记录失败，不自动重放。
随后重跑原始完整 helper 构建及全部 13 组契约，逐项核对新编译制品与清单一致。
确认单个测试程序运行不授权修改安全策略、增加宽泛例外、删除 provenance 或切换
启动器规避拒绝。无人值守任务需要具备相应执行授权的宿主；开发宿主的这套流程
不替代正式签名 App 更新或 Windows 产品验收。

### TypeScript 检查归属

`tsconfig.json.references` 是项目清单；`scripts/ci/types.cjs` 使用 TypeScript 原生配置解析
保留 JSONC 注释和尾逗号支持，国际化调用检查器共同读取该清单，
新增项目不能只改 package scripts 或只改扫描器。`typecheck` 串行失败短路；显式追加的
tsc 参数仍只传给末位 node 项目，保留原 web → node shell 链的参数落点。

| 配置 | 归属与环境 |
| --- | --- |
| `tsconfig.base.json` | 公共 strict/noEmit/composite、Bundler 解析等选项，不统一环境或 target |
| `tsconfig.node.json` | main/preload、原 Node 配置与测试，ES2022；原检查文件及环境保留 |
| `tsconfig.web.json` | renderer、模拟界面的浏览器入口及原就近测试，ES2020/DOM；保留现有 Node 类型兼容，不声称已是纯浏览器依赖图 |
| `tsconfig.tools.json` | 继承 web 检查环境，承接 preview Vite 插件、模拟服务、报告和校验；其真实类型/值依赖含 DOM，不能假装是纯 Node 模块 |
| `tsconfig.test.json` | 根测试、两套 Playwright 配置、Preview spec、E2E 和测试闭包；Node/Electron 与 DOM 混合测试宿主，ES2020 target，运行库类型按既有宿主补齐 |

原 src/main 与 renderer 的就近测试仍分别接受原 ES2022 / ES2020 检查，不为去重削减
环境验证。composite 要求测试导入的源码也有归属；test 配置显式列出所需 main 文件，
不把未被测试导入的主进程组合根和 preload 全集强放进 DOM 环境。新增测试依赖 main
文件时需维护该声明；`main/index.ts` 仍由 node 项目完整检查，非豁免类型检查。
覆盖回归以 compiler Program 的真实文件集合核验根配置、源码和测试，不能用单纯
include 字符串匹配或 `src/**/*` 一把覆盖替代归属判断。项目间共享契约闭包允许交叠。

本轮开发工具在 macOS 实测，Windows 做路径、Node 子进程和包管理器适配分析；这不
免除产品运行时、打包、安装器、签名和更新的 Windows 原生验收要求。

macOS 与 Windows 的 Electron asar 均为自包含产物：构建所需 npm 包放在 `devDependencies`，主进程与 preload 的非宿主依赖必须静态内联。不得声明运行时 npm 依赖、打入 `node_modules` 或放宽 closure 校验。`ws` 的可选原生扩展由构建配置禁用，不能依赖运行时动态加载。依赖分类变化须在干净提交上执行 `pnpm ops cd build release --stage dir --candidate`；普通构建和 closure 单测不替代真实 asar 验证，各平台结果分别记录。

依赖或 `overrides` 变更必须同时更新 Desktop 两份锁文件。使用仓库声明的 Node/pnpm，
从仓库根目录执行以下命令；npm 兼容路径使用已核对的 npm 环境：

```bash
pnpm --dir apps/desktop install --lockfile-only --ignore-scripts
pnpm --dir apps/desktop install --frozen-lockfile --lockfile-only --ignore-scripts
npm --prefix apps/desktop install --package-lock-only --ignore-scripts --no-audit --no-fund
npm --prefix apps/desktop ci --dry-run --ignore-scripts --no-audit --no-fund
git diff -- apps/desktop/package.json apps/desktop/pnpm-lock.yaml apps/desktop/package-lock.json
```

pnpm frozen-lockfile 校验与 npm dry-run 必须以退出码 0 结束且没有锁文件错误；已有 `node_modules`、单测通过或非 frozen 安装成功均不能替代它。CI 的 `desktop-lockfile` 作业重复 npm 检查；安装后的产品验收仍按受影响行为另行执行。

## Current / Required / Gap / Advisory

- **current**：`pnpm ops ci test --scope desktop` 聚合 main/renderer 确定性测试；`typecheck` 按 solution 覆盖 web/tools/test/node projects；e2e 与 Desktop harness 覆盖真实 Electron 路径。
- **current**：`scripts/ci/test.cjs` 为 `test`/`test:coverage` 显式声明根目录、`src/**`、`preview/` 与 `e2e/fixtures/` 的 TS 契约；仅 `src/**` 递归，CI 按相同作用域展开，不收集 `tmp/` 基准副本。fixture 契约不等于 Electron E2E，其他 `.cjs/.mjs` 入口仍按该清单执行。
- **current**：installer/runtime 两份 E2E fixture 契约在 `desktop-unit` 随覆盖率采集执行，不在 `desktop-extra-node` 再跑一遍；DMG 的既有隔离及 Windows 不适用分类跟随该唯一入口，不能据去重声称恢复原生挂载验收。
- **current**：`test`、`test:coverage` 与 CI `desktop-unit` 使用 Desktop 测试 Owner 的同一串行常量执行文件。聚合套件包含浏览器及 Vite/native 编译；通用 CPU 配额不能放大宿主文件并发，不能以放宽单项超时代替受控编排。纯逻辑与 API 独立阶段仍由各自 Owner 分配 CPU 配额。
- **required**：多文件 Desktop 测试 MUST 经 `pnpm ops ci test --scope desktop` 或域内 `node scripts/ci/test.cjs` 执行，文件并发由 `TEST_CONCURRENCY` 持有。MUST NOT 用裸 `node --test` 加 glob 自行拼「完整主命令」绕开该常量：Node 未显式传 `--test-concurrency` 时按 `os.availableParallelism() - 1` 派生并行子进程，而聚合套件含浏览器与 Vite/native 编译、单文件子进程可达 GB 级，满核并行会打穿小内存宿主的物理内存并触发系统级 jetsam，墙钟反而劣化。`pretest` 存量红挡住 `npm test` 时，正确绕法是直接调用 `scripts/ci/test.cjs`——它不含 `pretest`，仍注入串行常量并转发 `--test-skip-pattern` 等参数；单文件聚焦测试不受此限。
- **current**：显式配置优化缓存的 renderer Vite 测试通过 `src/test-helpers/render.ts` 的
  `renderServers` 登记文件级资源作用域。缓存位于 Desktop 的 `node_modules/.vite-tests/`
  随机自有目录，不位于 renderer 源码根；同文件仅按 root/cacheKey 复用编译缓存，
  不复用业务状态。原插件、服务参数和浏览器隔离不变，文件 after hook 等待创建、
  关闭全部登记服务并验证监听停止后删除自有缓存；清理失败报错并保留缓存供诊断。
  `renderFixture` 也使用源码外缓存。该规则不授权删除用户数据或其他 worktree 资源，
  也不通过排除源码清单、扩大 protected manifest 上限来容纳测试生成物。
- **current**：打包由 `scripts/cd/build.cjs` 在 Vite 后检查 main/preload 的完整模块闭包；`scripts/cd/verify.cjs` 对 exact App / 只读 DMG 再检查 asar、默认可选依赖边界和共享浏览器 Node。Node 的原始 hash 在签名前校验，签名后以去签名摘要、架构、版本和真实 driver transport 校验。
- **required**：renderer 构建依赖放 devDependencies；main/preload 必须是完整 bundle，仅外部引用 Electron/Node 内置模块。共享 Node 仅作用于 bundled Python，开发与显式外部 Python 不得受影响；浏览器技能的真实产品消费链需单独验收，transport 探针不替代它。
- **required**：每项变更 MUST 运行与受影响 artifact 成比例的确定性门禁；Desktop 依赖变更还 MUST 校验锁文件与 `npm ci --dry-run`；renderer 行为变化还 MUST 走真实产品路径并读取截图/DOM/落盘结果。
- **required**：规范/门禁变化 MUST 运行 `pnpm ops ci check docs desktop`、`pnpm ops ci test --scope desktop`、`pnpm ops ci check types desktop` 及对应领域回归。
- **required**：不得用 fake provider、静态 fixture、直接 dispatch 调用或手写 bridge JSONL 声称产品验收。
- **required**：源码文本正则断言（`readFileSync` + `match`）MUST NOT 超过单 feature 测试总数的 30%；正则 MUST 钉语义不变量（接线、channel 注册），不得钉空白或语句顺序，新测试 SHOULD 优先行为断言。
- **required**：新增测试 fixture、builder、eval scenario MUST 在引入的同一 MR 内拥有至少一个消费 spec；无消费者的测试基础设施不得合入。可测试性细则见[测试分层与共享契约](../architecture/testing-strategy.md#测试分层与共享契约)；模型评测机制另见[LLM 评测概要](../architecture/evaluation.md)。
- **gap**：并非所有 preview-grade 复杂组件都有完整 Electron 交互覆盖；缺证据时明确未验收。
- **advisory**：MAY 先跑 focused tests 快速反馈，最终仍要跑聚合入口；失败须报告命令、错误和缺少的前置条件。

## Ownership / Dependency

纯函数归相邻 unit test，组件契约归 render test，main/preload 边界归对应 test，用户可见跨层行为归 Electron/真实后端路径。测试不改变生产优先级或持久化语义换取隔离。

产品协作 Web + mock 场景工作台的分层验证边界见[预览架构](../architecture/preview.md#enforced-by)，
分期见[开发计划](../work/plan/preview.md)。预览场景回归、真实 Web 服务联调、真实 Electron
验收必须分别报告。全页面覆盖须关联页面清单、场景和消费 spec；原生外壳/替代区域与未接入项
不可计为完整交互通过。Mock 数据不证明真实执行、保存、安全授权或原生平台行为。

## 内置浏览器验收

- **required**：修改原生浮层或网页遮挡分类时，回归 `e2e/browser-cdp.spec.ts` 的 `native activity tooltips` 用例，覆盖文献全览悬停的微小相交、移出和重复切换。验证网页原生 bounds/visible、页面尺寸和滚动位置不变，同时检查原生提示内容、主题、几何和撤销。纯文本提示的失败展示须有确定性测试；不能只断言网页仍显示而遗漏提示被原生网页盖住。
- **current**：此回归在 macOS 中测得 `desktopCapturer.getSources()` 后主窗口失焦，原生提示按生命周期撤销，但主 renderer 的模拟 hover 仍可保留同一 DOM 节点。测试先断言契约、后截合成图；下一轮用真实窗口 focus 和鼠标移出/进入恢复交互。不得为了截图让生产浮层忽略失焦、放宽 stale revision，或只重复 hover 同一节点后延长超时。
- **current**：`src/main/browser.test.ts` 检查真实 Electron 视图、会话、网络隔离、外部 CDP 对 Agent 隔离标签的拒绝和销毁；`e2e/browser-cdp.spec.ts` 同时包含最小 Electron 协议探针与真实 Desktop 验收。真实 Desktop 用例覆盖左侧入口、地址导航、逐标签 DevTools、受限 browser-level CDP、同一产品实例中的公开表单 DOM/输入/点击/截图，以及 DevTools 冲突后的重连；双主体协议探针验证手动标签切换为 Agent 上下文时目标消失、旧会话失效，其他手动标签仍可被 Playwright 控制。`e2e/browser-workbench.spec.ts` 另检查深色主题、窄窗下的浏览器控件和独立设置页。探针本身不算产品验收。
- **required**：`e2e/browser-workbench.spec.ts` 和真实 Desktop 实例继续验证固定顶部标签、原生视图边界、遮挡与窗口生命周期；外部 Playwright 还须检查只发现浏览器网页目标、错误令牌和停用/重连。网络偶发失败不能由独立用例通过替代整组回归。
- **required**：最终截图必须是解锁桌面中真实产品窗口的合成画面，包含主 renderer 和原生 `WebContentsView`。`BrowserWindow.capturePage()` 只捕获 renderer、`webContents.capturePage()` 只捕获网页，都不能单独证明网页在产品内的视觉位置；保存后逐张打开检查。
- **required**：Windows 先运行 `pnpm ops cd build local --platform win32 --arch x86_64` 并核对 Velopack Setup/full 与 `release-result.json`，再在 Windows 真机重复导航、DevTools、外部 Playwright、窗口关闭/托盘恢复与截图。macOS 构建或测试不能替代该验收。
- **gap**：macOS 原生下载目录选择与重启持久化用例须在已解锁、无系统凭据弹窗的桌面以 `SCHOLARSEED_NATIVE_CHOOSER_E2E=1 npx playwright test e2e/browser-download.spec.ts --project=workbench -g 'chooser persists'` 显式运行；当前宿主的 Google Chrome for Testing 钥匙串提示遮挡目录选择器，不能把该用例的默认跳过当成通过。
- **gap**：当 macOS 锁屏、屏幕录制权限缺失或 Windows 主机不可用时，记录确切阻塞条件与已通过的独立验证，不降级使用协议探针或拆分截图冒充完整产品验收。

## 正反例

```text
正例：改 Dialog → render contract + Playwright keyboard/focus + 截图读取
反例：只调用 openDialog() 并断言 state=true，就称弹窗体验通过
```

## Enforced by

CI/本地入口为 `pnpm ops ci check docs desktop`、`pnpm ops ci test --scope desktop`、`pnpm ops ci check types desktop`、相关 Playwright 或 `scholarseed-desktop` harness。

## Update triggers

测试聚合入口、e2e project、harness flag、真实验收定义或规范门禁变化时更新。

## Desktop 布局验收

Desktop 布局验收的窗口范围遵守[窗口布局边界](../design/vibe-coding.md#desktop-窗口布局边界)。
引用 `src/window.ts` 的 `WORKSPACE_WINDOW_SIZE` 与 `WORKSPACE_WINDOW_MINIMUM`，
以真实主窗口缩放覆盖默认与最小支持尺寸；不要求低于原生下限的 480px / 600px 视口。
容器内分栏、长文本和文本放大仍在支持窗口范围内验证。macOS 与 Windows 分别取证，
不能把绕过原生约束的 `page.setViewportSize()` 截图当作产品支持范围。

## Stop condition

选定最小充分验证矩阵后转去测试源码；若产品验收被环境阻塞，保留确定性证据并明确未通过，不能降级宣称完成。

## 主界面就绪与启动截图

- **current**：`--shoot` 与 `--package-check` 使用 `showInactive()` 展示真实窗口但不抢焦点，避免隐藏窗口保留旧画面。`--shoot` 在场景前后等待真实工作区、导航控件已挂载且全屏加载/错误页消失，跨两个动画帧后复核，并要求连续两次探针通过。超时保存 `workspace-not-ready.png` 并以非零退出；诊断图不能作为成功验收。
- **current**：`--package-check <result.json>` 保留后端与 renderer 门禁，额外返回 `workbench` 和 `readyMs`，保存 `<result.json>.png`；未就绪返回失败并经既有退出路径清理后端。`readyMs` 只计主界面探针阶段，不代表完整冷启动耗时。
- **required**：人工查看最终截图，并通过真实页面交互确认首页可操作；DOM 就绪不能单独证明截图像素已更新。签名安装包、空 Store 首启、安全完整性验证继续由原有打包验收执行，开发模式截图不能替代这些门禁。
