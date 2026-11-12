# 参与书深贡献

[English](CONTRIBUTING.md) · **中文** · [返回 README](README_zh.md)

本指南介绍科研插件的开发与测试贡献路径，以及源码环境准备、本地开发、排错、测试和原生打包。产品功能及模型配置请先阅读 [README](README_zh.md)。

## 开发与测试科研插件

你可以将科研工作流制作成插件参与贡献，无需修改书深应用本身的代码。插件接口目前处于**开发者预览阶段**，请先核对目标书深版本的兼容性。

### 1. 选择开发路径

- **通过书深创建：**在已安装书深、且已启用 `plugin-create` 的应用中，通过会话说明科研场景、输入、预期产出和所需工具。安装前先审阅生成的源码与安装包。这条路径不要求克隆或构建整个应用。
- **手动开发：**按[创建教程](doc/plugins/create.zh.md)完成论文阅读笔记插件示例。如需从源码开发书深应用本身，再按[环境准备](#环境准备)和[安装与启动](#安装与启动)操作。

插件源码放在独立目录中，通常包含 `SKILL.md`、`.scholarseed-plugin.json` 及所需脚本与资源。会话卡片及其预览场景是可选项；一个 Skill 不会自动拥有自定义卡片。

### 2. 按支持的接口实现

以现有指南作为技术参考，不复制应用内部接口：

| 指南 | 用途 |
| --- | --- |
| [插件总览](doc/plugins.zh.md) | 插件概念、支持范围与安装方式 |
| [创建插件](doc/plugins/create.zh.md) | 源码结构、完整示例与打包 |
| [会话卡片](doc/plugins/cards.zh.md) | 可选自定义卡片、状态与交互 |
| [运行机制](doc/plugins/runtime.zh.md) | 执行、权限与生命周期 |
| [API 参考](doc/plugins/api.zh.md) | 宿主契约与支持的能力 |
| [测试指南](doc/plugins/testing.zh.md) | 校验、预览、安装与真实任务验证 |

按指南声明插件标识、版本、兼容性和依赖，使用支持的宿主 API；声明某项能力不等于已经实现对应处理逻辑。卡片的 iframe 隔离不等于 Skill 脚本拥有通用安全沙箱。

### 3. 校验与打包

手动开发时，在包含**与目标书深版本匹配的后端**的 Python 环境中运行以下命令；仅安装系统 Python 并不足够。[创建教程](doc/plugins/create.zh.md)说明了这里使用的插件描述文件和 `request.json`。

```bash
python -m service.cli.plugins describe
python -m service.cli.plugins validate ./paper-reading-notes/.scholarseed-plugin.json ./request.json
python -m service.cli.plugins pack ./paper-reading-notes --name paper-reading-notes --version 0.1.0 --output ./paper-reading-notes-0.1.0.zip
python -m service.cli.plugins check ./paper-reading-notes-0.1.0.zip
```

将示例路径、名称和版本替换为自己的插件信息，输出 ZIP 应放在源码目录之外。打包工具会生成包含文件大小和哈希的完整性清单；不要手写 `.scholarseed-package.json`，也不要在修改源码后沿用旧哈希。修改后重新打包，更新已分发的插件时递增版本。

校验或安装包检查成功，**不代表**安装成功或科研任务已完成。`capabilities_unchecked` 仍需在真实应用中验证。

### 4. 在真实应用中测试

1. 打开技能中心，添加 ZIP，核对标识、版本和校验报告，确认安装并启用。
2. 使用有权限的模型创建新会话，请它使用该插件完成一个小型、可分享的科研任务。
3. 核对真实结果：所需工具实际执行、预期产出实际生成，涉及的文件或引用能指向正确内容。
4. 验证缺少输入、取消及一种预期失败场景，不能编造结果或隐藏未成功的操作。
5. 包含卡片时，验证卡片操作、状态保存和历史记录；按适用范围检查中英文、明暗主题、窄窗口与键盘操作。
6. 验证对已安装版本的更新。记录书深版本、系统及架构、模型、已执行检查和未验证项；分别验证受影响的 macOS 与 Windows 行为，一个平台通过不代表另一个也通过。

模型和服务调用使用自己获授权的凭据，并可能产生费用。示例和证据中不得包含凭据或私有科研数据。

### 5. 准备贡献材料

提供一组精简、可复现的材料：

- 插件 ID、版本、科研场景、作者、许可证和源码版本。
- 支持的书深版本、依赖、模型／服务要求，以及不含密钥的配置说明。
- 可分享的示例输入、预期输出，以及实际校验和真实任务结果，注明已知限制与未验证平台。
- 源码、带版本的安装 ZIP（如提供），以及维护地址和更新说明。

分享前审阅生成代码，排除 API Key、密码、签名凭据、`.env`、登录缓存和私有科研数据，保留 [Apache-2.0 许可证](LICENSE)及适用的第三方声明。分享插件本身不等于替其他用户安装，也不等于自动发布到市场。

## 环境准备

| 工具 | 要求 |
| --- | --- |
| Git | 在终端可用；使用 Git 克隆，不使用源码 ZIP |
| Node.js | **24.16.0**，包含 npm/npx |
| pnpm | **12.14.0**，在 PATH 中可通过 `pnpm` 调用 |
| uv | **≥ 0.12.11**，已加入 PATH |
| 原生工具 | macOS：Xcode Command Line Tools 或可用的完整 Xcode 工具链；Windows x64：脚本自动准备固定版本 LLVM-MinGW 编译器 |

桌面命令会下载固定版本 Python 并准备 `.venv`，默认流程无需另外安装 Python。运行时制品从清单中审核过的 HTTPS 地址下载，校验大小与 SHA-256 后缓存到本机，不依赖 Git LFS。首次准备需要联网获取 JavaScript／Python 依赖和运行时制品。

### macOS

不要求安装 Homebrew。从源码启动时也会编译原生模块，不是只有构建 DMG 才需要这些工具。先安装 [Apple 命令行工具](https://developer.apple.com/documentation/xcode/installing-the-command-line-tools/)，按系统弹窗完成后再继续；已有可用的 Xcode 工具链时无需重复安装：

```bash
xcode-select --install
```

使用 [Node.js 官方 macOS 安装包](https://nodejs.org/download/release/v24.16.0/node-v24.16.0.pkg) 安装 **24.16.0**，然后重新打开终端。不带版本的 `brew install node` 或 `brew install pnpm` 可能安装本仓库不接受的版本。

安装 Node 后，一次性安装 pnpm：

```bash
npm install --global pnpm@12.14.0
```

按 [uv 官方安装方式](https://docs.astral.sh/uv/getting-started/installation/)安装：

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
```

在后续启动应用的同一个终端确认工具：

```bash
git --version
node --version
npm --version
pnpm --version
uv --version
xcode-select -p
```

Node 必须显示 `v24.16.0`。如果显示其他版本，请先通过版本管理器切换或调整 PATH。若 uv 安装器尚未处理后续终端的 PATH，请将其安装目录加入相应配置。

### Windows

使用 Windows x64 电脑和 PowerShell。先通过 [Node.js 官方 Windows x64 安装包](https://nodejs.org/download/release/v24.16.0/node-v24.16.0-x64.msi) 安装 **24.16.0**，保留 npm 和加入 PATH 的安装选项，不要改用最新版 Node。

尚未安装 Git 和 uv 时，按 [Git for Windows](https://git-scm.com/install/windows) 和 [uv 官方说明](https://docs.astral.sh/uv/getting-started/installation/#winget)执行：

```powershell
winget install --id Git.Git -e --source winget
winget install --id astral-sh.uv -e --source winget
```

如果没有 WinGet，改用上述链接中的 Git 安装包和 uv 安装方式。工具安装完成后重新打开 PowerShell，再检查：

```powershell
git --version
node --version
npm.cmd --version
npm.cmd install --global pnpm@12.14.0
pnpm.cmd --version
uv --version
```

Node 必须显示 `v24.16.0`，uv 不低于 `0.12.11`，pnpm 显示 `12.14.0`。后续安装与开发命令中的 `pnpm`，Windows 用户可写为 `pnpm.cmd`，避免调用 PowerShell 的 `pnpm.ps1` 包装脚本，无需修改全局脚本执行策略。

原生构建入口会自动下载并校验固定版本的 LLVM-MinGW 编译器及相关输入，无需为这些模块另行安装 Visual Studio 或编译器。不要在 Windows 执行 `xcode-select` 或 macOS 的 shell 安装命令。这些要求针对源码开发，不适用于直接运行已构建的安装包；本说明不代表已完成纯净 Windows 环境的端到端验收。

## 安装与启动

在可写的本地目录执行：

```bash
git clone https://github.com/alibaba-damo-academy/ScholarSeed.git
cd ScholarSeed
pnpm ops pre
pnpm ops dev
```

后续命令均在仓库根目录执行。首次安装和启动需要下载依赖，请等待完成。使用应用时保持终端运行，在该终端按 Ctrl+C 停止。启动后，在设置中配置模型连接，或登录书深账号。文献服务和模型调用需要相应访问权限。

`pnpm ops pre` 检查工具链，按锁文件安装 Desktop 依赖与固定版本 Python 环境，将 `skills/community/` 编译到 Git 忽略的运行目录 `apps/serve/service/capabilities/skills/`，准备 Office 资源并检查环境。它不安装全局工具、不改用户凭据，也不依赖私有开发者 Skill 链接。Git 中包含技能源码，不包含生成的技能包。

`pnpm ops dev` 启动隔离的 Electron 调试实例。依赖与技能源码未变时，后续只需执行这条启动命令。拉取依赖或技能变更、或遇到“未找到技能”时，先停止当前实例，再依次执行 `pnpm ops pre` 和 `pnpm ops dev`。

使用 pnpm 12.14.0，不要直接使用 Homebrew 或 Corepack 默认选中的其他版本。如不方便安装 pnpm，可将命令中的 `pnpm` 替换为 `npx --yes pnpm@12.14.0`，仅作为备用方式。

pnpm 是推荐方式，不是强制绑定。项目不设置 `packageManager`，保留已有的 npm／Yarn 命令路径。使用 npm 时，对应的准备和启动命令为：

```bash
npm run ops -- pre
npm run ops -- dev
```

## 常见问题

| 现象 | 处理方法 |
| --- | --- |
| `ERR_PNPM_NO_LOCKFILE` | 确认当前位于仓库根目录，`package.json` 旁有 `pnpm-lock.yaml`。旧克隆先执行 `git pull --ff-only`，再冻结安装；不要去掉 `--frozen-lockfile` 自行生成替代锁文件。 |
| `pnpm ... expected 12.14.0` | 安装／切换到 pnpm 12.14.0，确认 `pnpm --version` 后重试。 |
| 找不到 Node 或 Node 版本错误 | 完成 Node 24.16.0 安装，重新打开终端，检查 PATH 或版本管理器。 |
| `uv: command not found` | 将 uv 安装目录加入 PATH，在启动应用的终端确认 `uv --version`。 |
| 未找到内置技能 | 先停止 Electron，再依次执行 `pnpm ops pre` 和 `pnpm ops dev`。全新克隆不能跳过准备步骤，也不要将用户技能手工复制进内置技能包。 |
| 下载失败 | 根据日志中的失败 URL 检查网络／代理，恢复访问后重跑原命令，不绕过摘要校验。 |
| 安装停在 `scripts/pre/electron.cjs` / `Running...` | 见 [Windows 下载排查](#windows-下载排查)。此阶段会单独下载 Electron 二进制，不是 npm 包下载已完成就能启动。 |
| Windows 报 `stale ACL policy outputs` | 见 [Windows 检出换行](#windows-检出换行)。不要为消除报错而重新生成已审核的安全产物。 |
| `native.compile` 报 `writable or replaceable private state ACL` | 见 [Windows 私有构建目录](#windows-私有构建目录)。这是实际文件系统权限被拒绝，与换行不匹配不同。 |
| 构建提示环境被占用 | 先在开发终端按 Ctrl+C 停止实例，再打包；不要删除活跃进程的锁。 |

可通过 `SCHOLARSEED_ARTIFACT_CACHE` 指定运行时制品缓存目录。`pnpm ops dev` 默认启用 DevTools 和会话 ID 复制按钮，可设置 `SCHOLARSEED_DEVTOOLS=0` 关闭。排错时不要删除用户数据或覆盖模型凭据。

### Windows 下载排查

`Packages ... done` 不代表安装结束：Electron 的 postinstall 还会下载对应平台的二进制，pnpm 可能折叠内层日志。GitHub 克隆超时与 Electron release 下载超时是两个独立的网络故障；npm 的 `email` 警告、可选 Playwright Skill 的审批提示，都不能证明是下载卡住的原因。

如果原安装仍在运行，先按 Ctrl+C 停止该命令，再重试。在仓库根目录的 PowerShell 中显示下载 URL，并保留展开的日志：

```powershell
$env:DEBUG = '@electron/get*'
pnpm.cmd install --frozen-lockfile --reporter=append-only
```

根据日志中的 URL 检查已获准使用的网络／代理。如果无法访问 GitHub release 下载，且组织允许使用 npm 镜像，可在同一个 PowerShell 会话中设置以下变量，再重试安装命令：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
```

仅修改 npm 包 registry 不会改变 Electron 二进制的下载 URL。这些设置仅影响当前终端及其子进程，不修改全局配置；新开的 PowerShell 不会继承这些临时覆盖。保留固定 pnpm 版本、生命周期脚本和摘要校验。安装成功退出后，执行 `pnpm ops pre` 和 `pnpm ops dev`。首次启动还会构建原生模块与前端，应先查看阶段日志，而不是仅凭等待时间判断卡死。

### Windows 检出换行

已审核的 ACL 策略文件及生成产物需要逐字节匹配。旧 Windows 克隆在 `core.autocrlf=true` 时，可能将审核记录要求的 LF 转成 CRLF。当前 `.gitattributes` 已为这些文件固定 LF；不要全局关闭 `core.autocrlf`，也不要移除安全检查。

保存本地工作后，在干净的克隆中执行 `git pull --ff-only` 更新，再检查：

```powershell
git ls-files --eol -- apps/desktop/native/security.json apps/desktop/native/security.outputs.json apps/desktop/native/security.h apps/desktop/updater/internal/security/evaluate.go apps/serve/service/platform/security.py packages/adapters/codex/scholarseed_codex/permissions.py scripts/shared/security.cjs
node apps/desktop/scripts/pre/security.cjs --check
```

工作区预期显示 `w/lf`。旧克隆即使拉取了新属性，也可能保留 `w/crlf`；Git 认为未变化的文件，执行恢复命令也不保证重新写入字节。最稳妥且不破坏原目录的恢复方式，是将最新仓库克隆到一个**新的、尚未使用的目录**，再按本指南安装。保留旧目录中的本地改动和恢复材料，不要把旧 `node_modules`、`.venv` 或生成的安全产物复制到新克隆。如果文件已为 LF 仍然失败，应排查具体策略／产物差异，而不是重写审核记录或跳过校验。

### Windows 私有构建目录

原生编译要求构建目录私有，且祖先目录不可被不受信任的账户替换。如果错误指向 `%TEMP%`，先在 PowerShell 查看权限：

```powershell
Get-Acl -LiteralPath $env:TEMP | Format-List Owner,AccessToString
```

部分开发工具会向其他账户授予用户临时目录的写权限。即使当前用户是所有者，这种目录也不适合保存私有编译状态。不要删除其他工具的 ACL 条目、改用管理员运行或关闭权限检查。应先停止失败的开发命令，再在同一终端使用已有的原生构建目录配置：

```powershell
$env:SCHOLARSEED_NATIVE_BUILD_ROOT = Join-Path $HOME '.ss-debug\native-build'
pnpm.cmd ops pre
pnpm.cmd ops dev
```

构建会创建并保护新目录，仍然检查所有者、权限和祖先路径。此设置仅影响当前终端及其子进程，不修改系统临时目录或全局 ACL。如果所选位置也被拒绝，保留报错并与管理员选择真正私有的本地位置，不要放宽策略。此步骤只处理原生构建目录选择，不代表模型认证或应用全部功能已验收。

### Windows 应用程序控制策略

如果原生编译报 `spawnSync ... installation-test.exe UNKNOWN`，保留可执行文件路径、退出信息和 `native-command` 输出。仅凭 `UNKNOWN` 不能判断原因；如果 Windows 明确提示管理员策略阻止运行，应由管理员通过组织既有的应用程序控制流程审核已校验的构建产物。更换构建目录不会覆盖应用程序控制策略，不要关闭安全软件或策略，也不要反复重装依赖。

构建失败后，临时文件仍被占用时可能追加 `[native-cleanup]`。原始编译或执行错误保留在前，清理错误只是补充信息，不应被误判为根因。重试前保留诊断日志。原生构建被策略阻止时，桌面启动和发布验收均不能算通过。

## 开发与测试

检查本机工具链：

```bash
pnpm ops pre doctor
```

仅构建桌面前端，不生成安装包：

```bash
pnpm ops cd build local --stage app
```

安装依赖后，运行桌面测试与类型检查：

```bash
pnpm --dir apps/desktop test
pnpm --dir apps/desktop run typecheck
```

按修改范围选择测试，并在真实应用中操作受影响流程。构建或类型检查成功，不代表模型调用、登录或工具执行已通过。真实模型测试需自行配置有权限的凭据，并可能产生费用。

科研技能源码位于 `skills/community/`，通过 `pnpm ops cd build local --target skills` 构建。开发者预览版插件接口见[插件指南](doc/plugins.zh.md)。

## 打包

先停止开发实例，再在本机生成开发版安装包：

```bash
pnpm ops cd build local
```

| 本机环境 | 安装包 |
| --- | --- |
| Apple Silicon macOS | arm64 DMG |
| Intel macOS | x86_64 DMG |
| Windows x64 | x86_64 EXE |

不支持跨平台打包。具体制品路径和状态以本次构建在 `apps/desktop/release/` 下生成的 `release-result.json` 为准，不要将旧安装包当成本轮结果。本地开发包不等于正式签名发行包。

如需构建并检查未打包为安装器的候选应用、且不使用发布签名凭据，请在干净、已提交的检出上执行：

```bash
pnpm ops cd build release --stage dir --candidate
```

正式分发入口为 `pnpm ops cd build release --workflow distribution`，需要发布配置和签名凭据，macOS 正式发布还需要公证。凭据应通过受保护的 CI 变量或安全凭据存储提供，不得提交到仓库。候选检查和本地开发包不能代替原生安装包验收，也不代表已获发布授权。

## 项目地图

| 路径 | 用途 |
| --- | --- |
| `apps/desktop/` | Electron 桌面客户端与研究工作台 |
| `apps/serve/` | FastAPI 本地产品服务 |
| `packages/runtime/` | Runtime 接口与 Gateway |
| `packages/adapters/codex/` | Codex 执行适配层 |
| `packages/damoatrace/` | 执行追踪与调试工具 |
| `skills/community/` | 科研技能与工作流 |
| `scripts/` | 工具链、配置和构建脚本 |
| `tests/` | 跨包集成与验收测试 |
| `product.json` | 产品与运行时配置 |
