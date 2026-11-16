# Windows 问题收集与解决方法

本页收集 Windows 开发、启动和排查中实际遇到的问题，记录现象、依据、处理办法与
验证边界。它不是放宽权限的白名单，也不是所有机器都适用的一键修复脚本。

版本、工具链来源和构建机制以[构建指南](build.md)、
[开发入口](development.md#工具链与支持入口)及实际 Owner 源码为准；
真实产品检查遵循[Desktop 调试 工程规范](development.md)。

## 1. 先判断卡在哪一层

| 最后看到的现象 | 优先检查 | 不能据此下的结论 |
| --- | --- | --- |
| `expected ... Install the declared ... version` | Node/npm/uv 的实际路径和版本 | 不是 npm 依赖缺失，也不是业务 Bug |
| `MethodInvocationNotSupportedInConstrainedLanguage` | 哪段脚本调用了受限方法 | 不等于需要管理员权限；改 ExecutionPolicy 不等于解除语言模式 |
| `writable or replaceable build state ACL` | 报错路径及其全部父目录的 owner、有效写入/替换权限 | 不能只保护叶目录，或直接删除报错 ACE |
| `directory-test.exe 0` 失败 | 测试的临时根、实际退出状态与输出 | 命令名本身不能证明具体 ACL 分支失败 |
| `backend startup failed pid=null`、`ERR_LEASE_PERMISSION` | 后端进程创建之前的目录资格步骤 | 同一错误码不一定来自同一目录；不是模型授权失败 |
| `backend ready`，主窗口未显示 | renderer 加载、启动屏、主窗口可见状态 | 进程或 health 成功不等于用户已经能交互 |
| 模型列表缺失、置灰或调用被拒绝 | 真实 UI、内置模型目录、个人连接及各自登录状态 | 缺 `model_profiles.json` 不等于没有可用内置模型 |

排查保留实际报错顺序。每处理一层重新观察下一层，不把后续错误当成同一问题，也不
把启动完成写成模型、工具、HIL 或原业务 Bug 已验收。

## 2. 本次完整案例：开发版从无法启动到显示主窗口

### 环境与结论

- 日期：2026-10-17；Windows x64；从 `D:\DeepR_D` 执行根 `npm run dev`。
- 当次通过检查的工具：Node 24.16.0、npm 11.13.0、uv 0.12.11；Python 3.12.13、
  SQLite 3.53.1。这里只记录当次环境，不作为后续版本要求。
- 成功启动时，主工作区已有 `build-state.cjs`、`cache.test.cjs`、`BUILD.md` 的未提交改动，
  其中构建 ACL 检查已改用兼容 ConstrainedLanguage 的 PowerShell cmdlet。
  排查没有覆盖或提交这些既存改动；不能声称相同环境变量能使旧版检查代码也通过。
- 本次启动恢复采用**仅作用于启动进程的环境变量**，将构建缓存、临时根和默认工作目录
  放到经过现有校验的专属目录。没有修改系统语言策略、既有共享目录 ACL 或授权规则。
- 保留原 `C:\Users\gaoquan\.scholarseed` 数据和模型配置；没有复制或注入登录凭证，
  没有迁移历史项目或修改已有会话。

### WIN-001：默认 Node/npm 与仓库要求不一致

**现象**：启动器报告实际 Node 24.21.0，但当时仓库声明为 24.16.0；默认 npm 也不同。

**依据**：`.node-version`、`package.json` 和 `scripts/pre/toolchain.cjs` 的实际路径/版本检查。

**本次处理**：复用机器上已经存在的匹配工具链，将它们放到本次 PowerShell 的 `PATH`
前部，再执行 `node scripts/pre/toolchain.cjs check`。没有修改系统 PATH、安装未知全局工具，
也没有改仓库版本声明来适配宿主。

**验证**：检查返回 Node/npm/uv 的实际路径及匹配结果，随后进入 `predev` 和 Python 准备阶段。

### WIN-002：旧构建 ACL 脚本不兼容 ConstrainedLanguage

**现象**：早期独立 Worktree 的 `native.compile` 调用
`WindowsIdentity.GetCurrent()` 等方法时，返回
`MethodInvocationNotSupportedInConstrainedLanguage`。

**本次确认**：通过 `$ExecutionContext.SessionState.LanguageMode` 读回
`ConstrainedLanguage`。这属于脚本与宿主语言模式的兼容问题，不是缓存位置问题。

**处理边界**：成功运行的主工作区已有兼容 cmdlet 的实现；这是后续环境处理的前提，
不是切换缓存目录自动修复了旧脚本。具体实现及当前边界查看
[构建状态检查](../../apps/desktop/scripts/shared/build-state.cjs)和[构建指南](build.md)。

不通过修改 ExecutionPolicy、解除宿主限制或删除 ACL 校验来获得绿色结果；旧实现仍存在时，
应由对应 Owner 修正兼容性并单独验证。本次运行不是干净基线或该既存改动的完整验收。

### WIN-003：默认构建缓存的父目录含额外写入主体

**现象**：主工作区越过语言模式错误后，报错变为：

```text
writable or replaceable build state ACL: C:\Users\gaoquan\AppData\Local ...
```

**依据**：构建状态检查会核验对象及全部父目录；报错中存在允许额外主体写入/替换的 ACE。
只把 `...\cache\build` 的叶目录设为私有，不能消除父目录替换风险。

**本次处理**：先调用已有 `assertPrivateDirectory` 检查候选目录，再通过
`SCHOLARSEED_BUILD_CACHE_ROOT` 选用 `$HOME\.cache\scholarseed-dev`。
新目录由已有 `ensurePrivateDirectory` 创建并保护，然后继续执行原校验。

**验证**：`toolchains.cache-build` / `toolchains.cache-verify` 通过，进入原生测试。
路径只是本机可用示例，不代表所有 `.cache` 或所有 C 盘目录都安全；每台机器重新校验。

### WIN-004：原生目录测试仍使用不合格的系统 Temp

**现象**：缓存问题处理后，构建继续报 `Command failed: ...\directory-test.exe 0`。

**依据**：[原生测试](../../apps/desktop/native/directory.test.c)的 reclamation 用例读取
`TMPDIR`，没有时读取 `TEMP`，并走真实 `directory_open`。测试编译工作目录也由
[native builder](../../apps/desktop/scripts/shared/native.cjs)的 `os.tmpdir()` 选择。

**本次处理**：为同一次启动同时设置 `TEMP`、`TMP`、`TMPDIR`，指向经过校验的新私有目录
`$HOME\.cache\ss-dev-temp`。不修改生产目录策略，不编辑、删除或重设原系统 Temp 的 ACL。

**验证**：重新执行根 `npm run dev` 后，`native.compile` 为 `status=passed`，随后主进程和
preload 构建完成。这证明该环境调整在本例有效；原失败未额外采集测试内部的细分错误，
不能将所有 `directory-test.exe` 失败都归为 Temp 权限问题。

### WIN-005：后端启动前创建默认开发工作目录被拒绝

**现象**：Electron 已显示启动屏，但仍报：

```text
ERROR backend startup failed: Error: ERR_LEASE_PERMISSION
backend startup failed pid=null ... failure=startupFailed
```

**依据**：[backend](../../apps/desktop/src/main/backend.ts)在创建 Serve 进程前调用
`configureDesktopEnvironment`；当 `storage.createWorkspace` 为真时，会通过原生 writer
创建默认工作目录。默认开发路径由[storage Owner](../../apps/desktop/src/main/storage.ts)
选择为仓库下的 `tmp/desktop-workspace`。本机 D 盘目录链不满足相应资格检查，且失败前
没有成功的 `desktop workspace=...` 日志，Serve 尚未创建。

**本次处理**：显式设置支持的 `SCHOLARSEED_DEFAULT_WORKSPACE`，指向事先创建、校验的
`$HOME\.cache\ss-dev-workspace`。仍从 `D:\DeepR_D` 启动代码，只改变新启动实例的默认
工作目录，不移动仓库、不重写用户 Home，也不修改历史项目登记。

**验证**：启动日志依次出现明确的 workspace/home、固定 Codex 路径、Serve 进程、
`backend healthy` 和 `backend ready`；窗口日志随后记录主窗口 `visible=true`。
`ERR_LEASE_PERMISSION` 也可能来自其他目录或步骤，必须结合失败阶段定位，不能机械套用。

### WIN-006：把个人连接文件缺失误判为没有模型

**现象**：根 `config.json` 的模型字段为空，且不存在 `model_profiles.json`。

**纠正方法**：按[模型选择](../../apps/serve/service/chat/service/models.py)、
[内置目录](../../apps/serve/service/settings/catalog.py)与
[个人连接](../../apps/serve/service/settings/connections.py)区分配置来源，
再从实际 UI 核对模型和登录状态。个人连接文件并不承担全部内置模型配置。

本次排查撤回了“缺文件即缺模型”的过早判断，没有要求用户重新提供密钥或覆盖配置。
启动恢复保留原配置，但没有由此证明上游模型请求一定成功。

## 3. 本例启动方法

以下命令只用于**当前调用的 PowerShell 进程及其子进程**。运行前正常退出使用同一
Home 的其他实例；不要在真实对话期间重启 Serve。先确认代码包含适用的构建检查实现，
并按[工具链入口](development.md#工具链与支持入口)核验工具来源。

`$NodeDirectory`、`$UvDirectory` 应填入本机已核验工具目录，不安装或解析未知来源；
版本取仓库声明，不复制本次案例中的固定版本作为未来要求。

```powershell
$Repo = 'D:\DeepR_D'
Set-Location $Repo
$NodeDirectory = Read-Host '已核验的 Node 工具目录'
$UvDirectory = Read-Host '已核验的 uv 工具目录'
$env:PATH = "$NodeDirectory;$UvDirectory;$env:PATH"
$env:PYTHONIOENCODING = 'utf-8'

node scripts/pre/toolchain.cjs check
if ($LASTEXITCODE -ne 0) { throw '工具链校验失败，停止启动' }

$env:SCHOLARSEED_BUILD_CACHE_ROOT = Join-Path $HOME '.cache\scholarseed-dev'
$env:TEMP = Join-Path $HOME '.cache\ss-dev-temp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
$env:SCHOLARSEED_DEFAULT_WORKSPACE = Join-Path $HOME '.cache\ss-dev-workspace'

node -e 'const state=require("./apps/desktop/scripts/shared/build-state.cjs"); for(const name of ["SCHOLARSEED_BUILD_CACHE_ROOT","TEMP","SCHOLARSEED_DEFAULT_WORKSPACE"]) console.log(state.ensurePrivateDirectory(process.env[name]));'
if ($LASTEXITCODE -ne 0) { throw '目录资格检查失败，停止启动' }

npm.cmd run dev
```

目录辅助方法只允许保护本次新建的目录，并会继续校验祖先；不得为复用该示例去重设
既有目录、系统目录或用户资产的 ACL。任一候选路径被拒绝时，选另一个具备可信父目录链
且本次获准使用的专属位置，或先报告权限阻塞，不修改允许主体列表。

这组路径没有写入系统环境变量、注册表或用户设置；关闭启动终端后不会自动成为下一次
独立终端的配置。关闭本实例应走正常退出，勿按进程名批量杀掉其他 Python/Electron。
不要在应用仍使用这些目录时清理缓存、临时根或工作文件。

## 4. 本次验证到什么程度

2026-10-17 的成功运行可由原用户 Home 下的 `logs/window.log` 核对：

- 北京时间 20:26:19，出现 `backend ready`（当次端口 61730，端口是动态值）。
- 北京时间 20:26:42，窗口记录 `productAvailable=true`、`visible=true`，随后启动屏关闭。
- 实际 Serve 从 `D:\DeepR_D` 启动，Home 仍为原用户目录，默认 workspace 为上述安全目录。
- 实际 Codex 来源为受审 vendor，版本为当次 manifest 对应的 0.159.0，不是 PATH 上的未知 CLI。

这些证据支持“开发版主窗口和后端已启动，可交给用户继续测试”。它们**不证明**：
真实模型回合、全文授权卡片、下载或其他业务已经通过；也不证明 macOS、安装版、
升级/卸载或干净源码基线通过。本次没有最终运行截图，不能当作功能或缺陷修复验收。

此前为 Bug 87807033 增加的诊断日志仍在独立诊断分支；不能把主目录启动成功写成该 Bug
已修复，或假定未合入的日志已经出现在当前运行进程。

## 5. 后续问题如何补充

每个新案例沿用一个独立编号，记录以下内容；未知项标为“待确认”，不要编造根因。

| 项目 | 必填内容 |
| --- | --- |
| 范围 | Windows 版本/架构、开发或安装版、触发入口、任务授权边界 |
| 运行身份 | 分支/提交及相关未提交改动、实际工具/解释器来源；不只写 HEAD |
| 问题 | 用户可见现象、失败阶段、脱敏原始错误、日志时间和可定位指针 |
| 原因 | 已证实的失败条件、仅为推断的部分、缺失证据及责任 Owner |
| 处理 | 实际采取的代码/环境动作、为何适用、没有改变的安全边界 |
| 验证 | 实际命令、退出状态、真实运行结果；需要验收时附已打开检查的本地截图 |
| 限制 | 未执行项、平台缺口、是否仅恢复环境、尚未修复的业务问题 |

长期可复用结论维护在本页；详细原始日志、凭据、截图和运行态文件不要提交到文档。

### WIN-007：沙箱就绪但 PowerShell cwd 回落到盘符根

**区分两层权限**：无 bundled tool manifest 的 Windows 开发实例也需要准备已准入
workspace 自身的非继承 `FILE_READ_ATTRIBUTES`；固定工具的安装准入 SID 校验不能
误拦这项空资产准备。同时，工作区之外的私有祖先可能仍不允许沙箱读取属性。
这两类问题都可能表现为 OS cwd 正确，而 `Get-Location` 返回 `C:\`，并伴随
相对路径写入、`Rename-Item` 或 `Remove-Item` 拒绝访问。初始化 ready 不证明这些操作可用。

**诊断**：在同一真实沙箱、同一会话中先比较 `Get-Location` 与
`[Environment]::CurrentDirectory`。不一致时停止相对路径写入。对已授权的目录链
逐级使用 `Get-Item -LiteralPath <目录> -Force -ErrorAction Stop` 读取属性，记录首次
拒绝的目录；不要用管理员终端的可访问结果代替沙箱证据，不递归列举或读取文件内容。
通过 Trace CLI 回放真实工具输出，并区分运行目录错误和初始化竞争。

**处理边界**：工作区自身元数据由 Serve 准备；不自动授权其上方祖先。私有祖先布局
应通过产品支持的工作区设置或新进程的 `SCHOLARSEED_DEFAULT_WORKSPACE` 选择祖先
可解析的位置。已有产品设置优先，环境变量不会覆盖它；不改解析优先级、不迁移历史
项目、不复制凭据，也不以改 ACL、绝对路径或替换文件 API 掩盖失败。

**验收**：使用官方 Codex，在实际会话中验证 cwd 相等、相对路径创建/读取/重命名/
删除及最终不存在，并单独确认工作区根列目录与项目外文件读取仍拒绝。并发另用独立
父进程测试冷/热初始化、同时执行和其他进程退出后的持续执行；不能用单会话成功
代替多进程验证。开发客户端通过不等于签名安装包通过。
