# Desktop Packaging

Desktop 的推荐入口是仓库根目录的 `pnpm ops`。开发、检查、
本地打包和发布打包都从仓库根目录执行；CLI协调原领域Owner与Desktop内部配方：

独立分发仓无需改命令：产品根保留`package:dist`、`package:check`和
`package:verify`接口及其探测的`scripts/desktop.cjs`。前两者分别映射到ops的
distribution构建和candidate目录检查，旧`--type`映射为`--channel`，结果路径仍可显式传入。
这不是完整旧行为恢复：`--skip-check`和旧checkpoint续跑在当前Owner无实现，
兼容入口在构建前明确拒绝，不静默丢弃参数、不重建冒充续跑。

```bash
pnpm ops dev
pnpm ops cd build local --stage app
pnpm ops cd build release --stage dir --candidate
pnpm ops cd build local
pnpm ops cd build release --workflow distribution
```

本地、直接发行、distribution 和 package-acceptance 的安装包构建均由 Desktop
构建器在准备依赖后执行一次固定冒烟。只有冒烟成功退出且源码仍与构建输入相同，
才开始生成安装包。app、backend、dir 及候选目录检查不运行安装包冒烟。
已登记的构建参数只传给构建器，不传入冒烟。
独立 `pnpm ops ci` / `pnpm ops ci test smoke` 不自动安装依赖，允许起始工作区有未提交修改但要求运行前后源码指纹一致；源码在运行中变化、依赖准备失败、测试失败或清理失败均会
阻断后续构建。smoke 在 darwin/win32 执行同一显式用例清单，不跳过 Windows 门禁。

固定 smoke 的总预算由 `scripts/ci/smoke.json` 持有，为 900 秒（15 分钟），为较慢宿主保留余量；包含 smoke 内部
前置检查、收集、执行、报告和锁清理，不包含外层依赖安装及后续构建/签名。
冒烟命令与 Desktop 构建器分别核总墙钟，超限即非零退出且不得开始打包；
超限后不再启动新的阶段，已经持有的资源仍须正常收敛，异常清理超时不记通过。
`quality.json` 是锁释放前的结果快照，锁释放及进程退出的最后成本以命令终态 JSON
和调用方墙钟为准，不只读取快照的 pass 判断整次调用通过。固定冒烟不是 Playwright
smoke project 或 PDFE UI 全量，也不替代构建后的载荷清单、摘要及安装包验收。
冒烟不替代完整 CI、签名安装包或真实发布验收。范围和报告见 [CI 指南](../../scripts/ci/README.md#冒烟检查)。

`pnpm ops dev` 和 `pnpm ops cd build local --stage app` 会通过 `prepare:python` 自动准备 Python 归档与
`.venv` 构建期依赖；用户不需要手动先跑 `pnpm ops pre install python`。

首次检出先在根目录运行 `pnpm install --frozen-lockfile`，按根目录及 Desktop 的 pnpm lockfile 安装依赖；npm/Yarn 兼容安装分别使用 `npm ci` 或 `yarn install`。
Worktree 自动初始化同样默认使用 pnpm，共用 store 而不共享整个 `node_modules`。
缺失或版本不符时先停止；[工具链与授权安装流程](development.md#worktree-初始化与-pnpm-前提)
说明经用户批准后由 AI 安装精确版本的方法，初始化不会静默安装全局工具。
所有 npm 打包命令都会通过 `prepare:python` 准备 Python 归档和 `.venv` 构建期依赖，
再经 `apps/desktop/scripts/cd/package.cjs` 调用实际打包器 `apps/desktop/scripts/cd/build.cjs`。
不再提供 Python 包装入口。外部 CI 使用根目录Node入口及显式包管理器/已登记CI配方，
不依赖已删除的根别名；Desktop内部scripts仍由所选包管理器运行，保留其hook及参数分隔语义。
异常退出遗留的构建锁会在确认原进程不存在后自动清理；活跃构建仍会阻止并发打包。

macOS DMG 使用该开发环境中的
`dmgbuild==1.6.7`，入口通过目标 Python 的 `sysconfig.get_path("scripts")` 定位并校验程序，
设置 `CUSTOM_DMGBUILD_PATH` 后再调用 Electron Builder。它不在安装包的 Python 运行依赖中；
完成 Python 环境准备后，DMG 构建不会为了获取 dmgbuild 而联网。缺失或版本不符时构建失败，
不会退回到 Electron Builder 的在线下载。Windows Velopack 不需要该 macOS 工具。

DMG 适配层记录首次卸载失败时目标卷的 `lsof` 与相关 PID/PPID、用户和程序路径，
不采集进程环境或完整参数；诊断命令限时 10 秒，每项最多保留 64 KiB，失败或截断
显式记录。证据写入本轮 `dmg-copy.log`，构建日志仍回显该文件路径和有界尾部。
普通卸载最多尝试 5 次；仅资源忙允许强制卸载，强制操作前按本次 attach 的镜像路径
与设备核对归属，成功后再读回设备/镜像已消失才继续转换。其他错误、身份变化、
无法读回或镜像仍挂载继续失败。不清理其他镜像，不关闭宿主 Spotlight。

两种 macOS 架构的原生回归入口是使用带锁定 dmgbuild 的 Python 执行
`apps/desktop/scripts/cd/__tests__/detachment.py <空的任务证据目录>`：真实文件句柄
持卷，先验证上游失败，再验证恢复、占用 PID 取证、DMG 校验与只读挂载内容。
这项定向回归不签名、不发布，也不替代正式 CI 的完整安装包验收。

DMG 入口用 `apps/desktop/scripts/cd/image.py` 适配锁定的 dmgbuild，按文件分配块、
逐项元数据、至少 128 MiB 或载荷 10% 的余量，加上 GPT/EFI 与尾部保留区预算容量。
容量写入解析后的 options；dmgbuild 1.6.7 的 JSON loader 会忽略 JSON 中的 `size`，
因此只配置 `build.dmg.size` 不能解决此问题。上游 `ditto` 拷贝被检查返回码及超时，
失败立即终止；容量、剩余空间和原始拷贝错误保存在目标目录 `dmg-copy.log`，
成功与失败都会在构建日志回显有界尾部。签名、公证、现有验包及分发端最终镜像验收不跳过。

| 行为 | macOS | Windows |
| --- | --- | --- |
| 镜像生成 | 经本地 Python 适配器调用锁定 dmgbuild；拷贝失败拒绝出包 | 不执行 DMG 适配器，保留 Velopack 路径 |
| 定向回归 | `node --test apps/desktop/scripts/cd/image.test.cjs`，含真实 ditto 与 Python loader | macOS 专用用例显式跳过；有界日志测试仍执行，不能替代原生 Setup 验收 |

完整构建仍要求干净工作区；重用已签名 app 验证 DMG 修复，只证明镜像重建、内容和
挂载后启动，不等于新源码完整构建、重新签名、公证、上传或 Windows 验收。

Windows 应用构建由 `apps/desktop/scripts/cd/vpk.cjs` 在构建早期准备官方 Velopack
1.2.161 CLI、同版本 C ABI DLL 和构建期私有 .NET 8.0.32 runtime；固定来源、大小及
SHA-256 由相邻 `vpk.json` 持有，下载复用 `SCHOLARSEED_ARTIFACT_CACHE`。缓存未命中时
优先读取清单中的 OSS vendor 镜像，失败后回退官方源；两处必须通过同一大小和 SHA-256 校验。
官方原包分别位于 `vendor/velopack/` 与 `vendor/dotnet/`，更新镜像须先上传并匿名读回校验，
再修改清单。不依赖
runner 全局 `vpk`、SDK、PATH 或 .NET 安装，不向用户安装 .NET；macOS 和 backend-only
构建不准备这些工具。CLI 的完整 vendor 目录必须保留，实际调用
`dotnet.exe tools/net8.0/any/vpk.dll -h` 确认版本后才进入后续构建。
NuGet 与 GitHub 同名 nupkg 的归档摘要不同，不作为同一摘要的互换镜像。
工具准备失败立即终止，不能跳过签名、完整库存检查或安装验收。

## 构建类型

本地 `pnpm ops cd` / `pnpm ops cd build local`（`type=dev`）允许未提交修改，
但开始/结束的HEAD、暂存区与实际源码指纹必须一致，构建中修改源码仍失败。
结果保留真实dirty状态和源码身份，不把未提交代码仅标记为HEAD，也不因此获得发布资格。
preview/release（含candidate）及完整安装包验收工作流仍要求干净工作区；本地放宽不取消
库存、原生平台、受保护资源或macOS必要ad-hoc签名检查。

| Type | 用途 | 签名 |
|---|---|---|
| `dev` | 本地开发包 | macOS ad-hoc；Windows 不签名；执行所选 stage 的校验 |
| `preview` | 对外预览渠道 | 必须正式签名；macOS 还需公证；完整安装验收 |
| `release` | 对外正式渠道 | 与 preview 使用相同签名和完整安装验收流程 |

preview/release 缺少签名能力时默认失败。显式添加 `--candidate` 才能生成
`preview-candidate` 或 `release-candidate`。candidate 会执行完整功能自检，但上传器拒绝发布。

### MVP v0.1 本地包限定

准备 MVP 本地包、签名包、CICD 上传或版本发布前，必须读取本节、下方
「CICD 渠道与发布职责」及「构建结果」中的版本身份契约。本文是操作前提，不授予
安装、构建、上传、签名、发布、渠道/用户配置或凭据变更权限；历史命令不继承为授权。

- MVP 安装包必须先将最新远程 `shushen_release/mvp_v0.1` 合入开发分支，完成冲突解决、
  `uv.lock`/workspace 同步与真实验收，再将开发分支合回并推送该分支。
- MVP 构建必须在 `shushen_release/mvp_v0.1`：工作区干净、workspace lock 与各成员声明
  一致、本地 HEAD 与远程一致。不得从 dev、旧 Veda 的 `release/v0.1` / `release/v0.1.1`
  或未提交工作区交付；交付后仍须同步开发者指定目标分支的本地与远端，或报告精确阻塞。
- `build.cjs --type release` 进入发布签名流程，不切分支、不合并代码、不发布线上版本；
  用户要求发布不等于授权构建或安装。此 MVP 特殊约束不被通用 CICD 分支规则、当前
  根 `AGENTS.md` 规定的集成/MR 目标替代，不自行统一两者。

旧 `.ai/09.deploy/书深MVP安装包构建与部署流程.md` 在当前工作树不存在。现有命令、
签名契约和 package-check 不证明对应版本的安装版验收/回滚方案已具备；执行前须补齐
方案并确认授权。仅编写或更新文档不授权实际构建、重装或发布。
当前 `build.cjs` 对 preview/release/candidate 检查清洁工作区，本地 dev 可使用稳定的未提交源码；
均记录 branch/commit、真实 clean 状态及初末源码指纹。它未实现
上述 MVP 专属分支、远端一致与整合顺序检查；这些仍是必需前提，不因源码缺检查而取消。

## 平台

| Platform | Arch | 发布 `arch_type` | Installer | 构建环境 |
|---|---|---|---|---|
| `darwin` | `arm64` / `x86_64` | `darwin-arm64` / `darwin-x86_64` | DMG | 对应架构的原生 macOS |
| `win32` | `x86_64` | `windows-amd64` | Velopack Setup EXE（个人安装） | Windows x64 Runner |

`arch_type` 是上传布局、更新服务与安装包文件名共用的规范架构名，全小写，事实源是
`apps/desktop/scripts/shared/target.cjs`。它刻意不同于 Node 拼写：Windows 发布为 `windows-amd64`，
而 Node/Electron 仍叫 `win32`/`x64`，`target.cjs` 的查表 key 也仍是 `win32-x86_64`。

不支持跨平台或跨架构构建。

## 常用命令

## 统一开发入口

| 命令 | 用途 | 签名/凭证 |
|---|---|---|
| `pnpm ops dev` | 启动 Electron 开发模式 | 不需要 |
| `pnpm ops cd build local --stage app` | 构建 renderer/main/preload 前端产物 | 不需要 |
| `pnpm ops cd build release --stage dir --candidate` | 构建 unpacked App 并做产品打包验证，停在签名/安装器前 | 不需要；缺省使用占位更新 URL |
| `pnpm ops cd build local` | 构建本机 dev 安装包 | 不需要发布凭证；macOS 为本地用途 |
| `pnpm ops cd build release --workflow distribution` | 固定冒烟通过后构建发布安装包；直接构建用 `pnpm ops cd build release`，两者不是同义别名 | 需要 Git CI 或本机环境变量注入签名/公证凭证 |

发布凭证只从环境读取，不写入仓库：

| 变量 | 平台 | 用途 |
|---|---|---|
| `SCHOLARSEED_UPDATE_BASE_URL` | macOS / Windows | 发布更新服务 HTTPS 根地址 |
| `SCHOLARSEED_MACOS_TEAM_ID` 或 `APPLE_TEAM_ID` | macOS | Developer ID Team ID |
| `SCHOLARSEED_NOTARY_KEYCHAIN_PROFILE` | macOS | `xcrun notarytool` keychain profile |
| `SCHOLARSEED_APPLE_API_KEY` / `SCHOLARSEED_APPLE_API_KEY_ID` / `SCHOLARSEED_APPLE_API_ISSUER` | macOS | Apple API 公证凭据，未使用 keychain profile 时需要 |
| `SCHOLARSEED_WINDOWS_SIGN_CLIENT` / `SCHOLARSEED_WINDOWS_SIGN_SERVER` / `SCHOLARSEED_WINDOWS_SIGN_USER` / `SCHOLARSEED_WINDOWS_SIGN_KEY` / `SCHOLARSEED_WINDOWS_SIGN_DOMAIN` / `SCHOLARSEED_WINDOWS_SIGN_PUBLISHER` | Windows | Windows 签名服务与发布者 |

GitLab/GitHub CI 应把这些变量配置为 protected/masked secrets。开源仓库只提交变量名、
示例和文档，不提交证书、profile、私钥或内部上传地址。

## 平台与参数示例

macOS dev：

```bash
pnpm ops cd build local --platform darwin --arch arm64

# 在 Intel macOS 原生终端运行
pnpm ops cd build local --platform darwin --arch x86_64
```

Windows dev：

```powershell
pnpm ops cd build local --platform win32 --arch x86_64
```

不发布的 release 候选检查：

```bash
pnpm ops cd build release --stage dir --candidate \
  --update-base-url https://updates.example.com
```

正式包使用 `pnpm ops cd build release --workflow distribution`，签名、公证和更新服务配置由上述环境变量注入。
已登记的 preview 直接构建使用 `pnpm ops cd build release --channel preview`，沿同一安装包冒烟门禁。
preview 候选检查使用 `pnpm ops cd build release --channel preview --stage dir --candidate`；
保留冒烟前置的预览发行构建使用 `pnpm ops cd build release --channel preview --workflow distribution`。
两者均沿原 Owner，接线验证不等于已完成正式签名或两平台发行验收；不能改写成 `local --type preview`。

统一 CLI 不提供 `--install`，默认本地打包不会自动安装。构建完成后依据本次结果中的
安装包路径、另获授权后手动安装。原 `apps/desktop/scripts/cd/build.cjs` 的 `--install` 和
`installResult()` 保留为安装 Owner 能力，不代表 `pnpm ops cd build local --install` 可执行；
CLI 安装入口暂缓，权限、活跃实例与数据保护仍须单独核对，不删除这项安装需求。

统一 CLI 的常用构建参数（以所属命令帮助及登记契约为准）：

```text
cd build local|release
--target desktop|web|backend|wheels|trace|skills   仅local支持非Desktop目标
--stage app|dir|installer                        app仅local；其他约束按命令登记
--channel preview|release                       仅release构建类别；direct/distribution均支持
--workflow direct|distribution|package-acceptance
--platform darwin|win32
--arch arm64|x86_64
--version X.Y.Z
--build-number YYYYMMDDHHMM   缺省取 HEAD 提交时刻的北京时间
--candidate
--result <new-result.json>
```

local 的 workflow 为 direct/package-acceptance，release 为 direct/distribution；不能任意组合。
`--type`、底层 `--stage backend` 和 `--install` 属于构建 Owner 的原生接口，不是 CLI 原生透传选项。
CLI 通过 local/release、channel 和 target 选择对应配方，拒绝未登记参数，不能用 `--` 绕过。

`--version` 只接受三段式 SemVer，缺省取 `apps/desktop/package.json` 的 `version`；带 `v` 前缀或
内嵌时间戳的旧写法会被拒绝。`--build-number` 必须是 12 位 `YYYYMMDDHHMM`。

preview/release 还需要 `--update-base-url`；签名的 macOS preview/release 还需要 `--team-id`，
签名的 Windows preview/release 还需要 `--windows-publisher`。

### CICD 渠道与发布职责

Public source owns local build, package verification, channel behavior and artifact contracts.
Use `preview/<x.y.z>` or `release/<x.y.z>` for three-part release lines, and pass the channel
explicitly to the product build commands. Branch names alone do not authorize signing or publishing.
The optional distribution service owns signing credentials, uploads and hosted publication; public
contributors do not need its checkout or credentials for source checks and ordinary local builds.
A release record must identify the exact product commit, relevant document revision, artifact hashes,
platform, channel and real acceptance results. Routine development does not require paired repository SHAs.

No hosted pipeline, signing, upload or release has been validated merely by checking a local command
plan. Preserve existing native package and installed-product acceptance requirements below.

## 构建结构

```text
build.cjs
├── target.cjs       平台、架构、Runtime路径和安装包类型
├── bundle.cjs       组装CPython后端、Python wheels、Codex和ripgrep
├── sign.cjs         macOS ad-hoc签名
├── notarize.cjs     macOS Developer ID公证
├── verify.cjs       App、安装包和真实Electron自检
├── electron-builder 生成macOS App/DMG或Windows unpacked
└── velopack.cjs     Windows vpk 1.2.161 Setup/full/delta + 签名清单
```

`electron-vite build` 生成：

```text
apps/desktop/out/main
apps/desktop/out/preload
apps/desktop/out/renderer
```

Electron Builder 将 main/preload 写入 `app.asar`，将 renderer、backend、defaults 和
`product.json` 放入平台资源目录。

### Electron 入口闭包与浏览器驱动 Node

[closure.cjs](../../apps/desktop/scripts/cd/closure.cjs) 要求 Electron 入口自包含：除宿主模块
外，main/preload 的依赖必须进入可静态核验的构建闭包。最终 asar 拒绝
`node_modules`、重复的 `out/renderer` 及声明 runtime npm dependencies 的 package
manifest；不通过放宽门禁或复制依赖目录解决失败。仅把依赖移入 devDependencies
不证明运行时已可用，还须确认最终 bundle 包含实现、静态引用可解析，以及没有
非字面量加载、`createRequire`、`eval` 或 `Function` 绕过闭包检查。

[browser.cjs](../../apps/desktop/scripts/cd/browser.cjs) 负责已安装 Playwright/Patchright
驱动的共享 Node；它不是产品内置浏览器的功能开关或 Chromium sidecar。
保留两套 JS driver、许可和元数据，只对已经核验的重复 Node 执行去重；来源必须
位于产品 staging，驱动实际选中共享可执行文件并能初始化协议。签名/搬迁后的
完整性依据由该 Owner 与 [digest.cjs](../../apps/desktop/scripts/shared/digest.cjs) 维护，不把
签名前文件 hash、Node 版本输出或删除字节数单独当作安装包正确性证明。

依赖或 Electron 构建配置变化后运行根 `pnpm ops cd build release --stage dir --candidate`，并核对实际制品
闭包与原始退出状态；普通 build/typecheck 不能替代打包路径。该命令可能准备依赖、
构建和启动验证，仍须先核对本页的执行前提与授权。最终签名安装包、驱动调用及真实
产品验收是另外的证据，unsigned 检查通过不等于发布或全平台验收通过。

## 第三方声明与对应源码

随源码公开的 [notices](../../apps/desktop/resources/notices/README.md) 包含 certifi、tqdm、
pypdf、pycparser、lightningcss 的原始许可和固定版本源码获取说明，以及 Pillow 三个发布平台 wheel 的
完整附带许可。lightningcss 即使只参与构建也保留声明，不因 `devDependencies` 排除。
这是指定组件的许可材料，不是全产品 SBOM 或法务放行证明。

`resources/notices/manifest.json` 记录制品 URL、摘要、源码归档 URL/摘要和原始许可成员路径。
`scripts/cd/notices.cjs` 在构建组装时离线核对锁定版本、制品摘要和许可证文件，冻结整个目录；
Electron Builder 使用冻结副本，App、DMG/Velopack 的现有内容检查再逐字节核对，缺失或变化即失败。
升级这些依赖时必须重新核验对应制品并更新声明，不能只更新锁文件。

| 平台 | 随包目录 | Pillow 审查制品 |
| --- | --- | --- |
| macOS arm64 | `ScholarSeed.app/Contents/Resources/notices/` | CPython 3.12 macOS 11 arm64 wheel |
| macOS x86_64 | `ScholarSeed.app/Contents/Resources/notices/` | CPython 3.12 macOS 10.13 x86_64 wheel |
| Windows x86_64 | `<安装目录>/resources/notices/` | CPython 3.12 Windows amd64 wheel |

路径通过 `node:path` 处理；锁文件接受 LF/CRLF。首次提取声明仅将 CRLF 统一为 LF，
manifest 分别记录原始成员和随包副本的摘要；构建按副本字节校验，不再做平台换行转换。
三个平台使用相同声明目录（保留三份 Pillow 原文），但各自原生构建/安装验收仍须分别执行；
跨平台目录 fixture 和远程 wheel 静态审查不替代原生安装验收。

源码链接面向公众、绑定版本或提交，不使用内部 Git 地址或移动的 `main` 分支。变更第三方
源码后，分发者必须同步提供实际修改后的对应源码，不能继续以未修改上游归档代替。

## 内置制品

| 制品 | 用途 |
|---|---|
| python-build-standalone | 运行本地 Serve 后端 |
| 官方 Codex Runtime | Agent 会话和工具执行 |
| ripgrep | 文件内容搜索 |
| PowerShell 7 portable | Windows 隔离组件载荷；真实编码验收前不注入 Agent `PATH` |
| Office WASM | Office 文档预览和编辑 |
| `skills/community` | 随产品交付的技能 |

Codex 版本及平台来源以 `scripts/vendor/codex/manifest.json` 为准，不在启动或构建时
解析 npm latest，也不安装开发者全局 CLI。`apps/desktop/runtime/codex.cjs` 按平台
包的完整 vendor 子树保留文件布局、包元数据和逐文件摘要，不仅提取主 `codex`
可执行文件：能运行 `--version` 不证明 code-mode host、资源或工具执行链完整。
制品获取由 `scripts/shared/artifacts.cjs` 管理，当前是按清单恢复，不再依赖旧 Git LFS 包；
归档 SHA-256 与 npm integrity、缓存字节及版本探测是不同检查，旧 receipt 不是
跳过校验的理由。缓存、发布与探测失败不能静默改用其他版本。

开发 Desktop 等待固定制品解析后启动；macOS 安装版从包内 `backend/codex-runtime/bin`
选择可执行文件，缺失失败，不进入开发下载路径。Windows 安装版按签名 runtime.json
下载缺失组件，再从安装根 runtime 下的精确组件版本选择 Codex。修改此链路须分别核对最终载荷、
真实进程路径/版本及真实工具回合，普通版本探测或受控契约不能证明已交付。
DMG 工具不联网回退的规则仅限定已准备的 dmgbuild，不代表制品恢复、依赖准备、
签名或公证全过程离线；历史分支合并、回退与发布顺序不授予当前 Git 操作权限。

Python 与 SQLite 的精确版本、发行批次、平台路径、下载地址、字节数和 SHA-256 由
`scripts/vendor/python-build-standalone/manifest.json` 指定。`scripts/shared/python.cjs` 是开发安装和打包的共享解析/校验入口；构建准备和最终安装包
都会实际运行目标 Python，检查 `sqlite3.sqlite_version`。默认 `pnpm ops pre install python` 使用同一归档
创建开发 `.venv`，`pnpm ops pre doctor --scope interpreter` 可检查其版本及真实 base 路径；不同于 Python 库的
版本锁 `uv.lock`。切换运行时前须先停止使用该 venv 的进程。

Windows x64 使用：

```text
scripts/vendor/python-build-standalone/*-x86_64-pc-windows-msvc-*.tar.gz
scripts/vendor/ripgrep/x86_64-pc-windows-msvc/rg.exe
scripts/vendor/powershell/PowerShell-*-win-x64.zip
```

macOS x86_64 使用：

```text
scripts/vendor/python-build-standalone/*-x86_64-apple-darwin-*.tar.gz
scripts/vendor/codex/*-darwin-x64.tgz
scripts/vendor/ripgrep/x86_64-apple-darwin/rg
```

这些路径均为按需恢复的本地文件，不再纳入 Git 或 Git LFS。`scripts/shared/artifacts.cjs`
按清单下载到用户级缓存，核对文件大小与 SHA-256 后再原子恢复到工作区。默认缓存位置为
macOS/Linux 的 `~/.cache/scholarseed/artifacts` 与 Windows 的
`%LOCALAPPDATA%\ScholarSeed\cache\artifacts`，可通过 `SCHOLARSEED_ARTIFACT_CACHE` 覆盖。
Python、Codex、ripgrep、PowerShell、TeX Live、Go SDK 和 Office WASM/data 使用公共读 OSS 制品，无需下载凭据：
`https://deep-rd.oss-cn-hangzhou.aliyuncs.com/scholarseed-vendor/vendor`。
五份 vendor manifest、Office manifest 与 `apps/desktop/updater/toolchain.json` 的 `url` 是默认下载地址的唯一来源；更新制品时先上传并校验，再更新清单。
Office 制品位于 `vendor/office/zeta-20250513/`，由现有 Office 资源校验入口下载和校验。
Windows 的 Office 与其他 runtime 一起独立交付；完整应用包只携带签名组件清单，未变组件复用已展开文件。
Windows Office 打包使用独立暂存树，只有 `THIRD_PARTY_NOTICES.md` 的换行统一为已审核
组件使用的 CRLF；其余 vendor 文件逐字节保持不变，源码工作树不改写。Git attributes 同时
固定该通知文件的检出换行；暂存步骤覆盖既有 LF 工作树与源码导出，避免宿主平台或
`core.autocrlf` 改变已绑定的组件树及 ZIP 摘要。
Office 组件身份覆盖完整文件树，包括通知文件和 manifest；仅修改通知中的构建命令
也会改变组件内容。此类变更须比较新旧 ZIP 的完整成员清单，提升
`apps/desktop/runtime/versions.json` 中 Office 修订并绑定实测树及 ZIP 摘要，
不得覆盖旧修订或跳过版本绑定校验。Office 就近测试离线核对源码通知、manifest
及已锁定 vendor 摘要与树绑定的一致性；真实 ZIP 和 Windows 原生构建仍须单独验证。
OSS 只供构建取材，
安装后的 Office 请求仍由本机 Serve 同源提供，不从 OSS 在线加载。

Desktop 原生模块为 `lease.node` 与 `fonts.node`，Windows 另外冻结官方 `velopack.node`，清单位于
`apps/desktop/native/libraries.cjs`。两者独立编译，共用现有工具链、签名和冻结证据，
编译与签名清单分别记录每个模块的 SHA256。ASAR 只允许该平台清单内的 main 模块解包，
preload 和独立 inspection 入口不得直接或间接加载它们。Windows 两库均保留
当前可执行文件的 delay-load hook；字体枚举使用 DirectWrite，不依赖注册表路径推测。
不得覆盖已被清单引用的制品；内容变化时使用新对象路径，并重新审核大小与摘要。
Windows 保留组件 registry、规范 ZIP 与冻结库存控制。Python、TeX Live、PowerShell、Codex、Office 和 Electron 的 ZIP 由签名 CI 独立发布，只有签名清单进入 `current/resources/components`。组件版本与内容摘要绑定，首次或变化时联网下载并展开到 `<安装根>/runtime/<kind>/<component-version>`，未变组件复用。vpk full/delta 只交付程序代码、资源、原生模块和最小 launcher/helper；缺 delta 基准时仍回退 full，不重下未变 runtime。macOS 布局和更新行为不变。

Windows 的 `ScholarSeed.exe` 是原生启动器，先处理官方 Velopack C ABI 钩子，再通过共享 helper 的受限 bootstrap 准备 Electron。引擎原始 PE 只改文件名，不改字节或签名；固定 bootstrap 加载 `current/resources/app.asar` 并设置真实程序版本/路径。`process.execPath/resourcesPath` 仍表示引擎，程序资源与稳定启动器由 `src/main/resources.ts` 定位。其余组件沿用应用中的下载准备界面，更新继续先准备全部目标组件再退出后端。

`runtime/electron.json` 固定上游版本、长度和 SHA256。Windows 构建取用的官方 Electron ZIP 优先命中本地缓存，其次读取 `vendor/electron/` OSS 镜像，失败时回退 GitHub；所有来源使用同一大小及摘要校验，镜像不改变组件内容或版本。bootstrap 变更也必须更新 `runtime/versions.json` 的已审核组件修订及实测树/ZIP 摘要。官方 C ABI DLL 以最终字节摘要编入 launcher；原生启动器先写图标/版本再签名冻结，electron-builder 不再二次改写 PE。包内签名、完整文件库存、路径预算、原生模块、后端、首次联网、重启与 Setup/卸载门禁全部保留。未发布的新组件会阻止本地首次安装验收，不允许通过预置 runtime 或临时关闭验证伪造通过；正式签名安装与更新仍须合并后 CI 验证。

打包在准备目标 Python 后、组装依赖和编译前执行原生目录预检。预检使用正式验收的目录生成器，
检查构建输出、隔离 home 和 workspace；失败立即停止，最终 App/安装器启动验收仍执行。
macOS 隔离状态使用 `/private/tmp` 物理路径，避免 `/tmp` 符号链接；Windows 新建构建输出和验收目录
仅授予当前用户、SYSTEM 和 Administrators 写权限，包内配置种子目录继承此 ACL。
权限拒绝不会自动修复已有目录；Windows 日志输出拒绝路径、ACE principal、mask 和 ancestor 信息。

CI 应跨任务保留上面的用户级制品缓存、npm 缓存和 uv 缓存；完整正式 Mac 构建仍需等待 Apple 公证。
快速检查可先运行 `pnpm ops cd build release --stage dir --candidate`，正式签名构建与完整安装验收通过后才能发布。

新工作区直接运行：

```bash
pnpm ops pre install python
npm --prefix apps/desktop run build
```

## Python 发行依赖来源

构建工具使用 `.node-version`、Desktop `toolchain.defaultPackageManager` 与根 `tool.uv.required-version`
声明的精确版本。`scripts/pre/toolchain.cjs` 是 Make、Python launcher、打包入口的共享检查与
pnpm/npm/Yarn 安装实现；`pnpm ops pre doctor` 输出实际版本和路径。开发 Codex 也固定使用仓库制品。

构建机需提供支持根配置的独立 uv（可用 `UV=/absolute/path/to/uv` 指定），不能使用
即将同步的内置 Python 环境中的 uv。开发安装和发行运行依赖都来自根 `uv.lock`。

1. 根 `desktop` dependency group 包含技能 registry 的精确 Python pin、vendored wheel
   及 pip。`scripts/shared/dependencies.py export` 检查 registry 与 group/source 一致后，使用
   `uv export --locked --all-packages --extra serve --group desktop --no-default-groups`
   导出闭包，保留平台 marker 和哈希，排除 workspace 包及本地技能 wheel 行。
2. 原生目标 Python 通过 `uv pip sync --require-hashes` 安装该闭包；workspace wheel
   统一由 `scripts/cd/wheel.py --builder pip` 清理残留后构建，再以 `--no-deps --no-index` 安装。
3. 技能预制只检查已安装的 registry pin，并离线安装已审核 wheel；不再解析或下载依赖。
   wheel 的传递依赖（含 Windows 的 `msvc-runtime`）已包含在 lock/export 中。
4. 内置 Python 保留 `python-requirements.txt`、`python-dependencies.json` 与
   `dependencies.py`。预制结束和最终 App 校验都检查完整包名/版本清单、摘要并执行
   `pip check`；缺包、多包、版本变化或冻结文件变更均失败。

macOS 在技能依赖 provision 完成后、冻结构建 context 与签名前，用实际打包 Python
生成 optimize=0、相对文件名的 hash 字节码。范围由该解释器的 sysconfig 决定并限制在
受控 Python 树内；source/cache 精确库存摘要写入 context，最终 App/DMG 校验只读重算。
保留运行期禁止写入字节码，不在用户安装树补缓存。Windows 继续使用既有组件冻结、
normalize 与 RECORD 顺序；依赖版本检查不代替字节码库存或签名验证。

修改依赖时更新对应 pyproject/registry，执行 `uv lock` 并提交锁文件。过期 lock 会在
安装前失败。该约束固定运行依赖；PEP 517 隔离构建工具仍由各包的 build-system 声明，
并不保证 wheel 构建字节可复现。

Serve 精确依赖的 `apps/serve/vendor/` wheel 由 `dependencies.product_inputs()`
核对 workspace source、版本和 lock 中的字节摘要，export 单列 `product_wheels`，
不混入第三方 registry requirements。snapshot 拒绝导出后缺失或变化的 wheel；
Desktop 将其与 workspace wheel 一起交付，Windows 进入每次重建的 `pylibs`，
macOS 离线安装到产品解释器。预置技能沿 `scholarseed-skill-python` 使用产品
解释器；普通任务 venv 仍隔离，不继承这些包。本机制的源码和契约不替代原生打包验收。

| 行为 | macOS | Windows |
| --- | --- | --- |
| uv 与目标 Python | 外部 uv、内置 `bin/python3` | 外部 `uv.exe`、内置 `python.exe` |
| 依赖选择 | 本机 Python/平台 marker | 本机 marker，包括 `msvc-runtime` |
| 执行与路径 | 参数数组，系统路径分隔符 | 参数数组、`.exe`、CRLF 和驱动器路径 |
| 必需验证 | 原生构建、App package-check、真实 turn | 原生构建、隔离 Velopack 安装、package-check、真实 turn |

### 产品 Skill 冻结与制品核验

产品 Skill 源码、prebundle、依赖、pack、安装或发行变更前，必须读取本节与
[适配指南](../../skills/ADAPTATION.md#4-验证真实边界)。既有根 npm 入口、原生目标 Python、
隔离 run 目录及离线依赖契约继续适用，不另建构建流程。`skills/community/` 为 bundled
源码；`skills/registry.json` 持有依赖政策。评审检查源码、依赖声明和打包规则；产物验收清单
不提交到 Git。用户技能和用户状态不得进入 bundled pack 或 DMG，失败或不完整扫描不得改 SAFE。

编译器从复制后的载荷生成 `.scholarseed.json.inventory` 和 `.scholarseed-package.json`，
只写入产物。脚本运行不把出厂清单当作准入门槛，仍检查路径和适用的会话权限。
`python -m service.cli.prebundle --diagnose-local-skill "<预置 Skill 目录>"` 可只读诊断
文件新增、缺失和内容变化，不执行或修改脚本。差异不等于故障原因。

`build.cjs` 输出 `backend/skills.lock.json`，供依赖安装和独立的 `--verify-installed` 消费。
安装态校验不依赖源码 checkout，仍核对文件集合、摘要、大小、权限和生成元数据。
构建不创建复制前源码快照，保留 Bridge 契约检查和 pack 原子替换。

制品验收绑定同次构建的 `release-result.json`，不扫描旧产物。macOS 核验实际 App 和
只读挂载的同次 DMG；Windows 核验原生 Velopack 安装后的制品。Python 闭包、签名和镜像
检查不能代替独立安装态 Skill 校验，也不证明真实产品调用通过。

## 跨平台实现注意事项

涉及路径、权限、进程、文件锁、归档或可执行文件发现的修改，必须记录 macOS/Windows
行为矩阵并在目标平台运行真实构建。已知边界如下：

- Windows 普通文件的 `stat.S_IMODE()` 常显示为 `0666`，不能直接与 POSIX `0644`
  比较；技能 payload 和生成的 `.scholarseed.json` 必须走同一个权限归一化入口。
- Windows 的 Python console scripts 位于目标解释器的 `Scripts` 目录；使用目标 Python
  的 `sysconfig.get_path("scripts")` 获取，不得从 `python.exe` 父目录猜测。
- Node 启动 `.cmd` / `.bat` 与 `.exe` 的语义不同；仅对受控命令脚本使用 Windows
  支持的启动方式，不得把不可信参数拼进 shell 命令。
- 外部命令输出可能使用 CRLF，成员清单和逐行输出必须兼容 LF/CRLF。
- Windows 自带 `bsdtar` 支持当前归档操作。不要改用 Git GNU tar，它可能把 `C:`
  盘符识别为远端归档语法。
- `fcntl` / `flock`、Unix socket、符号链接和 POSIX signal 需要明确的 Windows 实现
  和对应测试，不能作为跨平台可用性假设。

## Package Check

所有类型在 dir/installer stage 都会启动最终 Electron 应用：

```text
ScholarSeed --package-check <result.json>
```

应用确认以下状态后写入 JSON 并退出：

- Electron 主进程启动；
- 内置 Python 后端健康；
- renderer 页面加载完成。

App 启动日志保存在构建目标目录的 `package-check-unpacked.log`；Windows installer
stage 还会隔离安装并再次启动，日志为 `package-check-installed.log`。macOS 校验 DMG，
不会自动安装到 `/Applications`，只有显式 `--install` 才安装。检查失败时终端回显应用
输出并报告日志路径；不要只根据外层 `ETIMEDOUT` 判断根因。

该自检不调用 LLM，不需要账号凭据。

验收环境由 `apps/desktop/scripts/cd/verify.cjs` 构造。Windows 保留宿主 `USERPROFILE`，
不将整个 OS 用户配置文件重定向到一次性产品目录，避免输入法等宿主辅助进程把
长期持有的状态写入待清理目录。产品状态仍通过显式 `SCHOLARSEED_HOME`、
`--user-data-dir`、工作区及私有 AppData/临时目录隔离；macOS 的既有 Home 隔离保持不变。
首次、复开与卸载共用同一产品状态根。不能通过修改输入法、结束宿主进程、放宽 ACL、
延长清理期限或忽略清理失败来使验收通过；独立原生对照不替代完整包的最终结果。

## 签名

macOS 最终 DMG 使用受控 `dmgbuild` 入口，`ditto` 非零退出立即阻断构建。
该入口在 JSON 设置加载后按 4 KiB 对齐的文件大小、每成员 4 KiB 元数据预算、
至少 128 MiB 或载荷 10% 的文件系统余量，以及 329 MiB GUID 分区预算计算容量。
GUID 默认布局含 200 MiB EFI 和约 128 MiB 尾部保留区，不能只按文件大小加 128 MiB。
锁定的 dmgbuild 1.6.7 忽略 JSON 的 `size`，因此不能通过 `build.dmg.size` 覆盖此策略；
容量由 `image.py` 在解析后的设置中赋值。`dmg-copy.log` 记录预算、请求大小和复制前后的
目标卷总量与可用空间；此策略仅用于 macOS DMG，Windows Velopack 流程不经过此入口。
复制的原始输出和退出码保存在本轮 `dmg-copy.log`；CI 输出日志路径及最多 16 KiB
尾部，包含截断标记，不输出签名凭据。失败诊断须随本轮构建记录留存。
最终镜像只读挂载后，与已签名源应用比较完整文件内容、类型、权限及符号链接库存，
再执行包内应用的签名、内容和真实启动检查。卸载失败同样阻断通过结果。
`artifacts.dmg.installed_check` 记录 `source: mounted-dmg`、库存摘要、启动结果和卸载状态，
并以 `sha256` 绑定最终 DMG；unpacked 应用的检查结果不能替代该证据。
Windows 保持 Velopack 安装验收，不调用 macOS 镜像入口。

macOS preview/release：

- Developer ID Application；
- Apple notarization；
- staple；
- Gatekeeper。

公证凭据使用 `SCHOLARSEED_NOTARY_KEYCHAIN_PROFILE`，或 Apple API Key、Key ID、Issuer。

Windows x64 正式构建通过 `apps/desktop/scripts/cd/windows-sign.cjs` 接入受管远程签名工具，
调用方需提供 `--windows-publisher`，并在受控构建环境注入：

```text
SCHOLARSEED_WINDOWS_SIGN_CLIENT
SCHOLARSEED_WINDOWS_SIGN_SERVER
SCHOLARSEED_WINDOWS_SIGN_USER
SCHOLARSEED_WINDOWS_SIGN_KEY
SCHOLARSEED_WINDOWS_SIGN_DOMAIN
SCHOLARSEED_WINDOWS_SIGN_PUBLISHER
```

这些值不得写入仓库、构建上下文、结果文件或日志。Windows 签名白名单仅包含 ScholarSeed 主程序、
独立 handoff helper、Velopack Update/启动桩/Setup；Codex、Python、Electron、ripgrep 等第三方二进制保持上游字节。macOS
保留 Codex 和 Node 的上游 Developer ID 签名，并使用 ScholarSeed Developer ID 签署未正式签名的 ripgrep。
签名服务返回后必须在 Windows 本机验证 Authenticode 状态和完整 Publisher，再替换待签文件。
Windows 原生模块在全部编译摘要核对后通过同一次目录请求批量签名。批次内每个返回文件
必须唯一且全部验签成功，才复制回编译目录；复制后仍逐文件验签并冻结摘要。
helper、应用和 Setup 的既有单文件调用继续使用同一签名入口。

| 平台 | Runtime 签名行为 | 验证 |
| --- | --- | --- |
| macOS | 保留 Codex、Node 的上游 Developer ID 签名；使用产品 Developer ID 签署 ripgrep | 校验 ripgrep 的 Developer ID、Team ID、secure timestamp、Hardened Runtime，并执行 Apple 公证、staple、Gatekeeper |
| Windows | 保持第三方 Runtime 字节不变，仅签署 ScholarSeed 所有的可执行文件 | 校验安装器和产品可执行文件的 Authenticode Publisher |

Windows 应用内更新继续使用 `/api/v1/updates` 的发布和授权控制面，添加
`update_engine=velopack`，通过逐版本固定 feed 交给官方 SDK 下载 delta/full。
无基准或 delta 不可用时允许 full 回退。离线 Ed25519 发布清单绑定产品、版本、构建、渠道、
包摘要和完整成员清单；delta 重建后验证成员内容，不假定重建 ZIP 容器逐字节相同。
准备完成后先退出本安装拥有的 runtime 进程族，再由薄协调器提权、复核授权并调用官方 Velopack 替换 current；缺失组件单独准备，已有展开目录复用。应用由原用户协调器重启。
签名、路径或退出失败不得继续应用更新。取消健康失败自动回滚和旧目录迁移；macOS 不变。

## 构建结果

每个构建目标使用固定目录 `apps/desktop/release/<type>-<platform>-<arch>/`。开始新构建时
只清理并覆盖同一类型、平台和架构的旧目录，不影响其他目标；失败现场保留到下一次同目标
构建。成功后输出安装包和 `release-result.json` 的精确路径，例如：

```text
apps/desktop/release/dev-win32-x86_64/artifacts/velopack/<app-id>-preview-Setup.exe
apps/desktop/release/dev-win32-x86_64/release-result.json
apps/desktop/release/dev-darwin-arm64/artifacts/scholarseed-<version>-darwin-arm64.dmg
apps/desktop/release/dev-darwin-arm64/release-result.json
```

macOS 安装包文件名仍为 `scholarseed-<version>-<arch_type>.dmg`，不含渠道段。
Windows Velopack 的 full/delta/Setup 文件名由固定 vpk 生成，实际路径从
`release-result.json` 读取，不按旧 NSIS 命名猜测。发布架构仍为 `windows-amd64`。

版本身份是两个独立字段：`version` 是三段式 SemVer（不带 `v` 前缀），`build_number` 是
`YYYYMMDDHHMM` 北京时间、缺省取本次构建对应 commit 的提交时刻，因此同一 commit 重复构建
幂等，Damoclaw-Server 也能在构建结束前预测出草稿身份。同一个 version 允许多个
build。`app.getVersion()` 只返回三段式版本号，所以 `build_number` 会一并冻结进打包后的
`product.json`，供客户端排序同版本的多个构建。

结果记录：

- Git branch/commit；
- version/build_number/type/channel/candidate/lane/platform/arch/arch_type；
- App 与安装包路径、SHA-256、SHA-512 和大小；
- Runtime、技能、Python 依赖清单摘要和签名信任证据；
- package-check 结果。

安装包在 `artifacts` 下按自身扩展名占位，因此 macOS 读 `artifacts.dmg.{path,sha256,sha512,size}`、
Windows 读 `artifacts.exe.*`。`sha512` 无条件计算：更新服务靠它入库，客户端靠它校验下载，
缺了这个构建就无法分发。

Windows `artifacts.exe` 仍为 Setup 的路径、摘要、大小及安装验收证据；新增
`artifacts.velopack`：`schema: 1`、`tool_version`、`pack_version`、`app_id`、`channel`、
`base_version`、`manifest_path`、`feed_path`、`full_path`、`delta_path`、`setup_path`、
`assets`、`files` 和 `signed`。不生成 MSI，也不输出 MSI 产物字段。
`artifacts.runtime` 为 `{manifest_path, components}`；每项组件为
`{kind, version, archiveSha256, archiveBytes, path}`，与包内签名清单精确对应。
`manifest_path` 指向冻结的 runtime.json，`path` 指向独立组件 ZIP。

`assets` 每项为 `{FileName, Version, Type, Size, SHA256, path}`，包含一个 Full 和至多一个 Delta。
`files` 是最终 full nupkg 的完整、唯一、排序的 `{path, size, sha256}` 成员清单。
不再生成应用 payload ZIP 或应用对象 store；原生 launcher 只负责官方钩子、Electron 准备和启动。

Windows 打包工具固定 vpk **1.2.161**。`--vpk <absolute-executable>` 或
`SCHOLARSEED_VPK` 可显式选择工具并强制检查版本；缺省由构建入口提前准备
经过长度和 SHA256 校验的官方 vpk、C ABI DLL 与私有 .NET 8，不依赖全局 PATH、
全局 dotnet 或 latest 解析。也可显式传入 vpk.dll，仍由已准备的私有 .NET 执行。可选 `--velopack-base <previous-full.nupkg>`
或 `SCHOLARSEED_VELOPACK_BASE` 提供同应用的前一版完整包；缺少则只生成 full。
构建端保留现有组件缓存、registry 配方身份和 ZIP 控制。缓存命中仍执行本轮验证；
Windows 独立组件 ZIP 冻结在构建目录的 `runtime-components/`，不进入应用 pack input。
应用资源 `components/` 只含签名 `runtime.json`；首次启动从更新服务联网下载缺失组件，
现有组件按可读版本复用。准备后对完整文件库存和 Python/TeX Live/PowerShell 实际探针
重新验证。运行中的解释器来自当前安装根 runtime，不迁移、不删除旧外置组件目录。

Windows vpk 显式传入 `--exclude '(?!)' --noDefaultExclude`，分别关闭默认 `.pdb`
正则过滤和独立的内建排除规则，完整保留已冻结的程序成员。独立组件的文件取舍仍由组件配方负责，
不能在安装验收时忽略缺失文件来补偿打包过滤；macOS 不使用这些参数。

产品版本保持三段式，Velopack 技术版本为 `<version>-build.<YYYYMMDDHHMM>`，
不使用不参与排序的 `+` metadata。Windows 交付带原生目录选择页的 Setup EXE，内部仍由未修改的官方 Velopack Setup 执行个人安装。
默认目录为 Shell 解析的 `%LOCALAPPDATA%/scholarseed`，首次安装可选择可写的本地目录；已有安装核验身份后锁定原目录，换位置需先卸载。不传 `--msi` 或 `--instLocation`，暂不支持全局安装。
`apps/desktop/scripts/cd/setup.cjs` 在官方 Setup 生成后内嵌其精确字节，写入目录预算与中英文资源，再编译、品牌化、签名外层 Setup。正式 CI 先签内层、再签外层；`setup_path` 和安装验收均指向外层。静默 `--silent --installto` 仍执行相同目录预检。
官网继续使用既有 `download-latest/windows/amd64?channel=release` 入口，
分发文件名仍为 `scholarseed-<version>-windows-amd64.exe`。

正式 Windows 签名仅在 CI 执行，并要求：

- `--payload-public-keys`：key ID → raw Ed25519 base64 公钥表，冻结为 `product.update_package_keys`，不得与在线激活公钥复用。
- `--payload-key-id`：本次发布签名对应的内嵌公钥 ID。
- `--payload-private-key`：Ed25519 PKCS8 PEM，仅由构建签名步骤读取，不进子进程环境、安装包、上下文或结果。
- 现有 `--activation-public-keys` 与 Windows Authenticode 配置仍需提供。

npm 对应变量保持 `SCHOLARSEED_UPDATE_PAYLOAD_PUBLIC_KEYS`、
`SCHOLARSEED_UPDATE_PAYLOAD_KEY_ID`、`SCHOLARSEED_UPDATE_PAYLOAD_PRIVATE_KEY`。
不再要求 payload activation keys、launcher/updater capability 或 data rollback compatibility。
`velopack.json` envelope 为 `{schema:1,key_id,manifest,signature}`，manifest 是精确 JSON
字节的 base64，signature 为 Ed25519 签名。dev/candidate 记录空签名并标记不可发布。
正式签名、安装启动通过和实际旧版到新版更新验收是独立证据。

不要扫描 `release/` 猜测最新制品，应读取目标目录中的 `release-result.json`。

文件系统主程序和 macOS App 保持英文品牌名 `ScholarSeed`；Windows 安装根目录由
Velopack app ID 和安装范围确定，不包含旧版的哈希 store 层级。Windows 桌面与开始菜单
快捷方式显示「书深」。macOS 保持英文显示名，并在 Bundle 元数据中登记「书深」作为
中文检索别名。npm/Python 包名、命令、协议和内部 ID 继续使用小写 `scholarseed`；界面
展示名仍由 `product.json` 的 `product_name` 控制，可显示「书深」。

## 验证

electron-builder 的 `afterPack` 中间校验只检查冻结输入、文件权限、摘要、原生库与
依赖库存，不执行包内 Node、Python 或 TeX；此时整个 App 尚未完成签名、公证。
中间回执的 `imports` 保持空值，不冒充运行验收。最终 `verifyApplication` 仍执行
全部运行探针与适用的 package-check；Windows 保持组件库存检查及真实准备后的探针。

macOS 正式包先执行 seal、stapled ticket 和 `spctl` 策略检查，再等待包内 Node
的固定首次执行握手。`spctl` 成功不等于内核首次执行扫描已经结束；macOS 13 上
两条检查路径可能分别触发评估。握手仅输出就绪标记，不加载驱动或业务代码，
先核对冻结的可执行内容摘要，并使用独立的 300 秒首次就绪预算；就绪后须在
30 秒内以零退出码结束。失败、缺失/多余输出或超时都阻断验收，不重试掩盖错误。
随后仍执行原有 30 秒 Node/driver 探针与完整应用自检。`[mac-execution]` 记录
PID、首次就绪耗时和退出状态，结果保存在 `trust.execution`；不修改系统策略、
清空缓存或强制卸载卷。macOS ad-hoc lane 也在完成签名后执行同一握手，
但不将其作为 Developer ID 或公证通过的证据；Windows 与显式 unsigned candidate lane 不执行。

冷执行验收须保存新的文件系统身份及对应系统扫描起止日志，不能将重跑同一
已评估实例当作冷启动。复用 CI 签名应用的隔离副本可验证执行扫描路径，但不等于
全新机器的下载隔离/首次安装验收，也不能替代合并后正式 CI 新制品验证。

```bash
npm --prefix apps/desktop exec -- node --test scripts/cd/__tests__/build.test.cjs runtime/codex.test.cjs
pnpm ops ci check types desktop

.venv/bin/python -m apps.serve.tests.contract_desktop_config
.venv/bin/python -m unittest apps.serve.tests.contract_desktop_release
pnpm ops ci format
pnpm ops ci check docs workspace
```

Windows 最终验收必须在 Windows x64 Runner 上构建 Velopack Setup EXE、运行安装器，并启动安装后的
真实应用执行 package-check。

## Windows 组件缓存与验收续跑

`pnpm ops cd build release --channel preview --component-cache <absolute-directory>`
显式开启构建侧稳定 Python/TeXLive/PowerShell/Codex/Office ZIP 缓存。缓存根属于当前 CI 用户，
使用私有 ACL，精确输入和配方键；每次命中仍完整扫描归档并执行当轮产品门禁。
缓存损坏会失败，不降级为命中；不用缓存参数则每轮完整组装。
Codex/Office 缓存键绑定真实输入树、入口、归档配方、目标和打包 Python 归档摘要，
命中只跳过压缩，仍核对完整 ZIP 清单及最终 runtime 版本绑定。Python 配方由
`assembly.cjs` 持有依赖同步、规范化、字节码和归档步骤，不再绑定整个 `bundle.cjs`；
解释器、requirements、完整 uv.lock、skill wheels 和 uv 版本仍参与身份。缓存不复用测试、
验签或安装验收结果，macOS 不使用此路径。

Windows Python 组件未命中缓存时，在私有短目录中同步依赖，成功后通过 Node 文件系统
复制回最终组件目录；安装失败不替换原解释器树，临时目录在成功/失败后均清理。优先
使用 `--verification-root` 指定的短根，否则使用宿主临时根。复制模式与锁定哈希校验保持
启用，规范化阶段额外检查临时安装路径没有进入组件内容；macOS 保持原安装路径，但同样逐源码包消费锁定构建约束并禁止隐式构建。
验证时使用与 CI 相同或更深的目录及独立空 Python 组件缓存，确认实际 miss、依赖安装
与本地安装包结果通过。缓存命中、短路径单包安装或仅添加扩展前缀不能代替该验证。
macOS/Windows 源码构建依赖在根 `pyproject.toml` 的 `component-build-<源码包名>` 依赖组声明，
由同一 `uv.lock` 锁定版本和哈希。互斥组允许不同源码包使用不同构建器版本，不能用
`--all-groups` 同时安装。导出 Owner 从锁中读取运行源码的版本/哈希，并逐组执行
`uv export --locked --only-group` 生成构建约束，不再维护独立的源码哈希清单。
预安装使用完整导出配方隔离的短路径 uv 缓存；最终同步禁止隐式源码构建。
新增源码依赖时须声明构建组并更新锁；无运行源码、缺少 sdist 或未预构建即失败。
运行依赖的锁不会自动约束隔离构建环境，打包必须显式传入导出的构建约束。
修改构建组或锁必须复核最终 ZIP，不能只看安装成功。
不要通过删除配方输入来掩盖缓存失效后暴露的问题。归档写入器在 Windows 上为输入和
输出保留扩展路径，ZIP 成员名仍为相对路径；长路径验收应覆盖安装和最终归档。

该示例使用已登记的 preview 直接构建；preview/release 均可显式选择带固定冒烟的 distribution 配方。
本仓配方已接线，不等于外仓调用已迁移；跨仓调用和续跑的未闭合接口见跨仓库构建与发布 (non-public execution/provenance record omitted)。

Velopack 构建验收使用隔离目录安装 Setup，首次启动及重开均执行真实 package-check，
最后通过 Update.exe 卸载并确认 current 已删除。现存同产品 HKCU 安装会阻止隔离验收，
不能覆盖开发者安装。Windows 验收共享机器级互斥锁，不按进程名结束其他任务。
只有本轮完整安装、联网准备、启动、退出和清理通过才写 `status: passed`。

更新服务的精确组件下载路由必须先部署，再运行依赖它的 Windows CI 验收。
正式 Windows CI 在应用验收前发布不可变组件，分发仓注入
`SCHOLARSEED_RUNTIME_PUBLISH_COMMAND`（JSON 参数数组），构建器追加
`--manifest <冻结 runtime.json> --directory <runtime-components>`。仅正式签名 CI
调用该命令；缺失或发布失败即中止，不将待发布组件塞回应用包。应用版本最后分发时，
再次核对全部独立组件对象可用，才写版本发布标记。组件先上传不等于应用版本已发布。

本地 dev/candidate 不调用组件发布命令；Windows product.json 和 helper 均冻结
同一 runtime 清单摘要，本地 lane 的初次准备只接受这份精确未签名清单。正式包及
应用更新始终要求签名，不增加环境开关。真实启动通过正常更新服务取得已有的
精确组件。未发布组件、缺少服务入口或网络不可用会阻止安装验证，不能通过复制
本地组件到验收 runtime 或增加测试专用回退来冒充安装通过。首次安装联网是产品
契约，EXE 不再具备单包离线安装能力。macOS 的随包运行时及验收流程保持不变。

旧 NSIS 验收续跑实现已移除；Velopack 不消费旧 checkpoint。
根`package:verify`只保留外部协议及明确失败诊断，不代表恢复续跑能力。
当前失败保留日志后重跑完整构建。正式发布前还必须完成个人安装更新、delta、full回退、
相同版本不同构建、runtime退出与整体更新、签名/路径拒绝的真机验收。

### CI 阶段耗时与缓存

打包日志以 `[stage]` JSON 行记录阶段开始、结束、状态和单调时钟秒数；嵌套阶段不能相加。
涵盖 npm 安装、后端组装、技能门禁、组件打包、原生模块、前端、Velopack full/delta、远端签名、安装器、静默安装、首次/重开、卸载与清理。日志不记录命令参数或环境值。

Windows 工具链展开与产品 wheel 缓存位于 `SCHOLARSEED_BUILD_CACHE_ROOT/build/`；未配置
该根时使用制品缓存的同级 `build/`。Go SDK、LLVM、Node headers、Velopack 与私有 .NET 按已审核归档摘要复用
展开结果，每轮仍校验原始归档和缓存文件完整库存。Go 只共享 SDK 摘要隔离的 `GOCACHE`，
`go vet`、`go test -count=1`、helper/launcher 编译、策略核对及签名均重新执行。
产品 wheel 绑定项目源码/数据、uv.lock、Python 归档与 pip 版本、构建配方、固定
`uv.lock` 导出的 `wheel-build` 工具环境和固定 ZIP 时间；两个平台均在私有短目录创建构建环境，带哈希同步全部工具后使用 `pip wheel --no-build-isolation`，禁止联网补充构建依赖。构建环境成功或失败后都清理。首次通过现有 wheel.py 构建，后续核对完整缓存
库存再复制。后端工具从摘要锁定的 wheel 安装，禁止隔离构建重新解析在线最新版本。
macOS 工具展开保持原路径，产品 wheel 与源码依赖构建使用上述统一锁定入口。
源码依赖的私有 uv 缓存同时绑定锁定 sdist/构建依赖、目标解释器版本/ABI/架构/GIL 模式、
uv 版本、组装配方及已声明的编译/SDK/部署目标环境摘要；探针失败时不进入安装。
变更这些输入会使用新缓存，不删除旧缓存；环境摘要不记录原值或无关凭据。
这些缓存键不证明编译器二进制未原地变化，也不证明 wheel 或内嵌原生文件符合最低系统版本，
最终原生载荷、平台下限和真实安装验收仍须独立核验。

Python 候选通过 `scripts/shared/platform.cjs` 同时固定 macOS 部署下限和显式 uv
`--python-platform`，开发环境与产品组装复用该规则，不依赖 uv 隐式读取环境变量。
FastCDC 的 Mac 源码目标在 `source-build-repairs` 登记：使用锁定 builder 构建带哈希 sdist，
再由锁定 delocate 检查真实架构、依赖和最低系统，生成与载荷一致的 wheel；高于 13.0
须失败，不能仅重命名标签。修复结果以完整库存缓存在私有树，并通过哈希 wheelhouse
安装，不制造 direct URL 元数据或覆盖原始源码缓存。

macOS 浏览器驱动使用 `apps/desktop/scripts/cd/browser.json` 冻结的官方 Node 22.23.4
原包及许可证，原包大小/SHA-256、实际架构/版本、每个驱动的 engines 和真实协议初始化
均须核验。此为应用内浏览器 Node，不改变开发 Node 24.16.0 或 Electron。原驱动携带的
Node 24 实际要求 macOS 13.5，不再作为产品共享 Node；仅删除已核对的 staging 副本。
组装及最终制品检查都扫描真实 Mach-O 下限，包含标为纯 Python 的包内嵌载荷；轮子标签
不能代替此检查。没有 macOS 13 真机结果时，静态下限通过也不能称最低系统实测通过。

Codex 的 macOS 打包副本排除尚未接入的 `codex-resources/voice/`，不改变官方原包、
缓存或二进制最低版本。随包收据记录来源与排除清单；Windows 保留完整载荷。
完整的原生最低版本检查仍适用于随包内容。

The macOS Codex staging copy excludes the unused `codex-resources/voice/` component
without changing the upstream archive, cache, or binary minimum versions. The staged
receipt records provenance and exclusions; Windows retains the complete payload.
Full native minimum-version checks still cover the staged payload.

Windows 构建私有状态通过 `Get-Acl`、`ConvertFrom-SddlString` 和当前用户 SID 检查所有者、
DACL 与各级祖先的替换权限，兼容受限 PowerShell；不要求或切换 FullLanguage。
缺失 DACL、无法识别的 ACE、外部写入或替换权限均拒绝。祖先不安全时改用合格的隔离根，
不能通过跳过检查或修改共享磁盘权限继续构建。

组件 ZIP 每轮仍完整解析一次成员清单；只在本进程内复用该清单，复制到最终目录后再次
核对归档 SHA-256/长度。持久化组件 receipt 格式不变，远端组件核对、签名清单与实际
安装后的独立验证保留。`toolchains.cache-*`、`wheels.cache-*`、`wheel.*`、`handoff.*`、
`launcher.compile`、`native.compile`、`components.inventory` 和 `components.tree-inventory`
用于区分命中校验、首次构建、测试与扫描成本；均不能与父阶段重复相加。

根 postinstall、Desktop 入口和打包器共用锁文件摘要 + Node/包管理器版本安装标记，
避免同次入口重复安装；锁文件或构建工具缺失会重新安装。
默认 pnpm 的 store 位于构建缓存根的 `pnpm-store/`，metadata cache 与 state 目录同级。
pnpm 只识别 `pnpm_config_*` 环境变量，`npm_config_store_dir` 不生效；store 与 checkout
不同卷时安装退化为复制并输出警告。npm 回退仍使用 `npm-installed/` 已安装依赖快照，
可用 `SCHOLARSEED_NPM_INSTALLED_CACHE` 指定私有目录。输入键包含 lock、安装脚本与
配置摘要、Node/npm/ABI/平台；file/link 本地依赖与外部 Electron dist 不使用快照。
命中恢复独立 node_modules，核对完整库存并实际执行 npm graph/Electron/esbuild
探针；失败完整 npm ci。不会共享硬链接，也不缓存产品构建和验收结果。
`npm.cache-*` 记录命中恢复/库存/探针/发布成本；`[native-stage]` 是原生 stderr
内部阶段日志，保存在 package-check 日志中；验收结束后也输出到 CI stdout，
`check` 字段区分 unpacked、installed-velopack-first 和 installed-velopack-reopen。
仅输出 stage/event/status/seconds 计时字段，不输出其他子进程诊断；不能与外层阶段重复相加。

原生编译与自检的命令失败由 `apps/desktop/scripts/native.cjs` 保留原异常，并在
错误消息追加 `[native-command]`：可执行文件、参数、退出码、信号及系统错误码，
随后为完整捕获的 stdout/stderr。成功命令不额外回显，环境变量不写入诊断。
沿用每条命令既有的 4 MiB 输出捕获上限；触及上限时明确标记
`outputMayBeTruncated`，不把被截断的输出宣称完整。该诊断不改变失败码、超时、
自检或签名门禁。

Codex 解包后的 runtime 位于 `SCHOLARSEED_BUILD_CACHE_ROOT/codex-runtime/`，
可用 `SCHOLARSEED_CODEX_RUNTIME_CACHE` 指定私有目录；两者均未配置时保留
Desktop `node_modules/.cache/scholarseed/codex` 开发缓存路径。缓存按版本、平台和
受审归档 SHA-256 键控，与 npm 安装快照独立。命中时校验路径、文件摘要及真实
`codex --version`；损坏时重新从受审归档构建。完成文件校验和版本探针后，将
完整 runtime 与 receipt 一起原子发布，避免下一次干净 checkout 重复解包。

Windows Velopack 验收不启动旧 store/launcher 的 Go 会话或 retirement。
仅清理当前验收拥有的安装目录和隔离 HOME；卸载失败保留现场并使验收失败。

## 启动诊断与存储维护资格

Desktop 捕获的后端启动输出继续实时进入 console/IPC。`backend.log` 的文件写入在
后端健康检查通过前缓冲，避免日志 writer 的 HOME 祖先资格与首次初始化的维护
独占资格互斥。健康检查通过后按原始行时间戳批量回放；启动失败时，等子进程
输出管道关闭后回放并等待日志压缩完成，正常退出证据仍绑定本轮新增字节。
缓冲最多保留当前日志文件大小上限（默认 50 MiB）及 4096 个块；超限时回放
明确的容量诊断，console/IPC 输出继续保留。缓存、资格锁及安装验收不跳过。

### Windows uninstall entry

Windows 的 reviewed Go 编译会话同时构建 `Uninstall.exe`；与启动器一起进行 PE 品牌化、
CI Authenticode 签名、摘要冻结和打包后读回。Velopack 安装/更新钩子将其发布到安装根，
安装验收校验根入口与冻结字节一致，并使用该入口静默卸载、等待整个安装目录删除。
更新包缓存统一到安装根 `packages`。安装根外的交接 helper 及历史缓存清理边界见
[Windows 更新 Owner](../../apps/desktop/updater/README.md#windows-velopack)。
macOS 不生成此入口。正式签名包及完整安装/更新/卸载结果仍须由合并后的 CI 验证。


### 安装失败诊断与留存

Windows Velopack 安装验收显式传递独立的 `--log` 文件路径；每次调用使用不同文件名，
避免验收续跑覆盖或误读上一次原生日志。卸载入口保持原有参数，不向仅支持
`--silent` 的卸载 wrapper 追加安装参数。

`installation.cjs` 在返回失败前记录退出码、signal、启动错误、stdout/stderr 和原生日志。
原生日志缺失（例如 wrapper 在启动 engine 前拒绝）或读取失败有独立错误字段；
最多读取尾部 4 MiB，并记录原大小及截断标志。失败时 `[installer-diagnostic]` 将每个
输出流脱敏后的尾部最多 16 KiB 写入 CI stdout，记录来源和截断状态；JSON 转义控制字符，
不打印 argv 或环境。成功时不回显普通输出。脱敏覆盖敏感环境值、常见凭据字段、
HTTP 认证和 URL 查询参数，但本地完整证据仍按私有诊断材料管理。

失败证据的 JSON 同时复制到 `SCHOLARSEED_INSTALLER_DIAGNOSTICS_ROOT/failure-<随机值>/`。
未配置此变量而配置了 `SCHOLARSEED_BUILD_CACHE_ROOT` 时，默认使用缓存目录的同级
`installer-diagnostics/`，不进入缓存子树。当前 Windows 分发 CI 设置了持久缓存根，
所以构建 checkout 清理不会删除这份留存。两者均未配置时只保留构建目录证据及 CI
stdout，并明确输出 `retention-unconfigured`。自定义持久根必须是绝对路径、由当前
构建用户控制，不能指向临时 checkout。日志输出精确留存路径；每次失败独立建目录，
Windows 叶目录使用私有 ACL，macOS 目录/文件为 0700/0600。

留存 JSON 包含完整的已捕获 stdout/stderr，以及上述有界原生日志、原构建日志路径和
时间。它在安装验收临时目录清理前写入；归档或主日志写入失败会单独报告，不能替换
原始安装失败或把失败转成通过。该目录不自动删除其他任务证据：问题验收后按 CI
日志中的精确目录清理，CI stdout 按平台保留策略留存。

定向验证：`node --test apps/desktop/scripts/cd/__tests__/installation.test.cjs`。真实子进程契约覆盖
退出、超时、日志留存、脱敏、截断和归档失败；这不替代 Windows 签名安装/产品验收。


### Windows 安装验收注册表预检查

安装验收在机器级验证锁内、创建临时安装目录和运行 Setup 前执行
`verification.installation-preflight`。查询 HKCU/HKLM 的 32/64 位视图，同时检查
当前 Velopack 卸载项及历史 NSIS GUID 的安装项、卸载项。默认只读，任一项存在
都阻止隔离安装；访问失败或非法查询结果同样失败。

CI 可显式配置 `SCHOLARSEED_CI_REGISTRATION_ROOT`，允许自动回收该根目录下
历史 `apps/desktop/release/{dev,preview,release}-win32-x86_64/native-install/app`
验收安装留下的完整 NSIS 注册对。仅当目录已不存在、卸载命令和安装范围精确匹配、
无相关进程、无子键、路径祖先无重解析点时执行。删除前重新读取完整注册值并核对，
非递归删除后读回；失败立即阻止安装。配置为空时禁用自动回收；不接受盘符根目录、
UNC、相对路径或不可访问的目录。分发仓库负责提供私有 CI 根目录。

`[installer-preflight]` 输出回收状态及 hive/view/kind。已有安装、Velopack 注册、
不完整或无法确认归属的残留继续阻断，需单独处理。代码不运行卸载器或删除安装文件，
不绕过原用户/提权迁移保护。macOS 不调用 Windows 注册表预检查。

定向检查：`node --test apps/desktop/scripts/cd/__tests__/registration.test.cjs`，同时注册在
构建契约聚合入口中。Windows 原生集成测试使用随机测试注册表命名空间，覆盖自动回收、
幂等和保护边界；不以测试或预检查通过替代完整签名安装验收。
