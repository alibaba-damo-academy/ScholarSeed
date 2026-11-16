<a id="windows-问题收集与解决方法"></a>
# Collecting and Resolving Windows Issues

This page records problems encountered in Windows development, startup, and troubleshooting, including symptoms, evidence, handling, and verification boundaries. It is not a permission-relaxation whitelist or a one-click repair script that applies to every machine.

Use the [build guide](build.md), [development entry point](development.md#工具链与支持入口), and actual Owner source as the authority for versions, toolchain sources, and build mechanisms. Real-product checks follow the [Desktop debugging engineering specification](development.md).

<a id="1-先判断卡在哪一层"></a>
## 1. First Identify Which Layer Is Stuck

| Last observed symptom | Check first | What you must not conclude from it |
| --- | --- | --- |
| `expected ... Install the declared ... version` | Actual Node/npm/uv paths and versions | This is not a missing npm dependency or a product Bug |
| `MethodInvocationNotSupportedInConstrainedLanguage` | Which script called a restricted method | It does not mean administrator privileges are needed; changing ExecutionPolicy does not remove language-mode restrictions |
| `writable or replaceable build state ACL` | Owners and effective write/replace permissions on the reported path and all its parent directories | Protecting only the leaf directory is insufficient; do not directly delete the reported ACE |
| `directory-test.exe 0` failure | The test's temporary root, actual exit status, and output | The command name alone does not establish which ACL branch failed |
| `backend startup failed pid=null`, `ERR_LEASE_PERMISSION` | Directory-qualification steps before backend-process creation | The same error code may come from different directories; this is not a model-authorization failure |
| `backend ready`, but the main window is not shown | Renderer loading, splash screen, and main-window visibility | A running process or successful health check does not mean the user can interact |
| Missing or disabled model list, or a rejected invocation | The real UI, built-in model catalog, personal connections, and each one's sign-in state | Missing `model_profiles.json` does not mean no built-in models are available |

Preserve the actual order of reported errors while troubleshooting. After handling each layer, observe the next one; do not treat later errors as the same problem, and do not report startup completion as acceptance of the model, tools, HIL, or original product Bug.

<a id="2-本次完整案例开发版从无法启动到显示主窗口"></a>
## 2. Complete Case: From a Development Build That Would Not Start to a Visible Main Window

<a id="环境与结论"></a>
### Environment and Conclusion

- Date: 2026-10-17; Windows x64; ran root `npm run dev` from `D:\DeepR_D`.
- Tools that passed checks at that time: Node 24.16.0, npm 11.13.0, uv 0.12.11; Python 3.12.13 and SQLite 3.53.1. These describe only that environment at that time; they are not future version requirements.
- At successful startup, the main workspace already had uncommitted changes to `build-state.cjs`, `cache.test.cjs`, and `BUILD.md`; the build ACL check among them had been changed to use PowerShell cmdlets compatible with ConstrainedLanguage. Troubleshooting did not overwrite or commit these pre-existing changes. Do not claim that the same environment variables would also make the old check implementation pass.
- Startup recovery used **environment variables scoped only to the startup process** to place the build cache, temporary root, and default workspace in dedicated directories that passed existing checks. It did not modify system language policy, existing shared-directory ACLs, or authorization rules.
- Preserved the original `C:\Users\gaoquan\.scholarseed` data and model configuration. No sign-in credentials were copied or injected, and no historical projects were migrated or existing sessions modified.

<a id="win-001默认-nodenpm-与仓库要求不一致"></a>
### WIN-001: Default Node/npm Does Not Match Repository Requirements

**Symptom**: The launcher reported actual Node 24.21.0, while the repository then declared 24.16.0; the default npm version also differed.

**Evidence**: Actual path/version checks in `.node-version`, `package.json`, and `scripts/pre/toolchain.cjs`.

**Handling in this case**: Reused matching toolchains already present on the machine, placed them at the front of this PowerShell process's `PATH`, then ran `node scripts/pre/toolchain.cjs check`. Did not change the system PATH, install unknown global tools, or change repository version declarations to fit the host.

**Verification**: The check reported actual Node/npm/uv paths and match results, then proceeded to `predev` and Python preparation.

<a id="win-002旧构建-acl-脚本不兼容-constrainedlanguage"></a>
### WIN-002: Legacy Build ACL Script Is Incompatible with ConstrainedLanguage

**Symptom**: `native.compile` in an early standalone Worktree called methods such as `WindowsIdentity.GetCurrent()` and returned `MethodInvocationNotSupportedInConstrainedLanguage`.

**Confirmed in this case**: Read `ConstrainedLanguage` from `$ExecutionContext.SessionState.LanguageMode`. This is a script/host-language-mode compatibility issue, not a cache-location issue.

**Handling boundary**: The main workspace that started successfully already had an implementation using compatible cmdlets. That was a prerequisite for later environment handling; changing the cache directory did not automatically fix the legacy script. See [build-state checks](../../apps/desktop/scripts/shared/build-state.cjs) and the [build guide](build.md) for the implementation and current boundary.

Do not obtain a green result by changing ExecutionPolicy, removing host restrictions, or deleting ACL checks. If the old implementation is still present, its Owner should fix compatibility and verify it separately. This run was not a clean baseline or complete acceptance of those pre-existing changes.

<a id="win-003默认构建缓存的父目录含额外写入主体"></a>
### WIN-003: The Default Build Cache Has an Additional Write Principal in a Parent Directory

**Symptom**: After the main workspace passed the language-mode error, the error changed to:

```text
writable or replaceable build state ACL: C:\Users\gaoquan\AppData\Local ...
```

**Evidence**: The build-state check verifies the target and all parent directories; the reported path had an ACE allowing an additional principal to write/replace it. Making only the `...\cache\build` leaf private does not remove the parent-directory replacement risk.

**Handling in this case**: First used the existing `assertPrivateDirectory` to check a candidate directory, then selected `$HOME\.cache\scholarseed-dev` through `SCHOLARSEED_BUILD_CACHE_ROOT`. The existing `ensurePrivateDirectory` created and protected the new directory, after which the original check continued.

**Verification**: `toolchains.cache-build` / `toolchains.cache-verify` passed and native tests began. The path is a local example; it does not mean every `.cache` or C-drive directory is safe. Recheck each machine.

<a id="win-004原生目录测试仍使用不合格的系统-temp"></a>
### WIN-004: Native Directory Tests Still Use an Unqualified System Temp

**Symptom**: After addressing the cache issue, the build continued to report `Command failed: ...\directory-test.exe 0`.

**Evidence**: The reclamation case in the [native test](../../apps/desktop/native/directory.test.c) reads `TMPDIR`, falls back to `TEMP`, and calls the real `directory_open`. The [native builder](../../apps/desktop/scripts/shared/native.cjs) also selects its test compilation working directory using `os.tmpdir()`.

**Handling in this case**: Set `TEMP`, `TMP`, and `TMPDIR` together for the same startup, pointing to the new private directory `$HOME\.cache\ss-dev-temp` after it passed checks. Did not change production directory policy or edit, delete, or reset ACLs on the original system Temp.

**Verification**: After rerunning root `npm run dev`, `native.compile` reported `status=passed`, then the main process and preload builds completed. This shows that the environment adjustment worked in this case. No finer-grained internal test error was collected for the original failure, so do not attribute every `directory-test.exe` failure to Temp permissions.

<a id="win-005后端启动前创建默认开发工作目录被拒绝"></a>
### WIN-005: Creating the Default Development Workspace Before Backend Startup Is Denied

**Symptom**: Electron showed the splash screen, but still reported:

```text
ERROR backend startup failed: Error: ERR_LEASE_PERMISSION
backend startup failed pid=null ... failure=startupFailed
```

**Evidence**: [backend](../../apps/desktop/src/main/backend.ts) calls `configureDesktopEnvironment` before creating the Serve process. When `storage.createWorkspace` is true, it uses the native writer to create the default workspace. The [storage Owner](../../apps/desktop/src/main/storage.ts) selects `tmp/desktop-workspace` under the repository as the default development path. The local D-drive directory chain failed the relevant qualification check, and there was no successful `desktop workspace=...` log before failure; Serve had not yet been created.

**Handling in this case**: Explicitly set the supported `SCHOLARSEED_DEFAULT_WORKSPACE` to the previously created and checked `$HOME\.cache\ss-dev-workspace`. The code still started from `D:\DeepR_D`; only the new instance's default workspace changed. The repository was not moved, the user's Home was not rewritten, and historical project registrations were not modified.

**Verification**: Startup logs showed, in order, an explicit workspace/home, the fixed Codex path, the Serve process, `backend healthy`, and `backend ready`; the window log then recorded main-window `visible=true`. `ERR_LEASE_PERMISSION` may also come from other directories or steps; locate the failing stage rather than applying this fix mechanically.

<a id="win-006把个人连接文件缺失误判为没有模型"></a>
### WIN-006: Mistaking a Missing Personal-Connection File for No Available Models

**Symptom**: The model field in root `config.json` was empty, and `model_profiles.json` did not exist.

**Correction**: Distinguish configuration sources using [model selection](../../apps/serve/service/chat/service/models.py), the [built-in catalog](../../apps/serve/service/settings/catalog.py), and [personal connections](../../apps/serve/service/settings/connections.py), then check models and sign-in state in the actual UI. The personal-connection file does not contain all built-in model configuration.

This troubleshooting corrected the premature conclusion that a missing file meant missing models; it did not ask the user to provide keys again or overwrite configuration. Startup recovery preserved the original configuration, but did not thereby prove that an upstream model request would succeed.

<a id="3-本例启动方法"></a>
## 3. Startup Procedure Used in This Case

The following commands apply only to **the current PowerShell process and its child processes**. Before running them, exit other instances that use the same Home normally; do not restart Serve during a real conversation. First confirm that the code includes the applicable build-check implementation, and verify tool sources using the [toolchain entry point](development.md#工具链与支持入口).

Set `$NodeDirectory` and `$UvDirectory` to locally verified tool directories. Do not install tools or resolve tools from unknown sources; use versions declared by the repository, and do not copy fixed versions from this case as future requirements. The two `Read-Host` prompts retain their original Chinese literals: “已核验的 Node 工具目录” means “verified Node tool directory,” and “已核验的 uv 工具目录” means “verified uv tool directory.” The `throw` messages likewise remain unchanged: “工具链校验失败，停止启动” means “Toolchain check failed; stopping startup,” and “目录资格检查失败，停止启动” means “Directory qualification failed; stopping startup.”

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

Directory helper methods may protect only directories newly created for this task and will continue to check ancestors. Do not reset ACLs on existing directories, system directories, or user assets to reuse this example. If any candidate path is denied, choose another dedicated location with a trusted parent-directory chain that is authorized for this use, or report the permission block first; do not change the allowed-principal list.

These paths were not written to system environment variables, the registry, or user settings; closing the startup terminal does not make them configuration for the next independent terminal. Close this instance normally; do not kill other Python/Electron processes by process name. Do not clean the cache, temporary root, or work files while the application is using them.

<a id="4-本次验证到什么程度"></a>
## 4. What Was Verified in This Case

The successful run on 2026-10-17 can be checked in `logs/window.log` under the original user's Home:

- At 20:26:19 China Standard Time, `backend ready` appeared (port 61730 in that run; the port is dynamic).
- At 20:26:42 China Standard Time, the window recorded `productAvailable=true` and `visible=true`, then the splash screen closed.
- Serve actually started from `D:\DeepR_D`; Home remained the original user directory, and the default workspace was the safe directory above.
- The actual Codex source was the reviewed vendor, at version 0.159.0 for that run's manifest, not an unknown CLI found on PATH.

This evidence supports the conclusion that “the development build's main window and backend started, and the instance was ready for the user to continue testing.” It **does not prove** that a real model turn, full-text authorization card, download, or other business flow passed; nor does it prove success on macOS, in an installed build, during upgrade/uninstall, or from a clean source baseline. No final runtime screenshot was captured in this case, so it cannot serve as feature or defect-fix acceptance evidence.

Diagnostic logs previously added for Bug 87807033 remain on a separate diagnostic branch. Do not report successful startup from the main workspace as a fix for that Bug or assume that unmerged logs are present in the current process.

<a id="5-后续问题如何补充"></a>
## 5. Adding Future Cases

Give each new case its own identifier and record the following; mark unknown items as “待确认” (pending confirmation) instead of inventing a root cause.

| Item | Required content |
| --- | --- |
| Scope | Windows version/architecture, development or installed build, entry point, task authorization boundary |
| Runtime identity | Branch/commit and relevant uncommitted changes, actual tool/interpreter sources; do not record only HEAD |
| Problem | User-visible symptom, failure stage, redacted original error, log time and locatable pointer |
| Cause | Proven failure conditions, inferred parts only, missing evidence, and responsible Owner |
| Handling | Actual code/environment actions, why they apply, and security boundaries left unchanged |
| Verification | Actual commands, exit status, real runtime result; attach locally saved screenshots that have been opened and inspected when acceptance requires them |
| Limitations | Items not run, platform gaps, whether only the environment was recovered, and unresolved product issues |

Maintain reusable long-term conclusions on this page. Do not commit detailed raw logs, credentials, screenshots, or runtime-state files to documentation.

<a id="win-007沙箱就绪但-powershell-cwd-回落到盘符根"></a>
### WIN-007: Sandbox Is Ready but PowerShell CWD Falls Back to the Drive Root

**Distinguish two permission layers**: A Windows development instance without a bundled tool manifest still needs non-inherited `FILE_READ_ATTRIBUTES` on its admitted workspace itself. Fixed-tool installation-admission SID checks must not wrongly block this preparation of an empty asset. At the same time, private ancestors outside the workspace may still prevent the sandbox from reading attributes. Both problems can appear as an OS cwd that is correct while `Get-Location` returns `C:\`, along with relative-path write, `Rename-Item`, or `Remove-Item` access-denied errors. Initialization readiness does not prove these operations work.

**Diagnosis**: In the same real sandbox and session, first compare `Get-Location` with `[Environment]::CurrentDirectory`. If they differ, stop relative-path writes. For each authorized directory chain, read attributes level by level using `Get-Item -LiteralPath <目录> -Force -ErrorAction Stop` (`目录` means “directory”) and record the first denied directory. Do not substitute results accessible from an administrator terminal for sandbox evidence; do not recursively enumerate directories or read file contents. Replay actual tool output through the Trace CLI and distinguish a working-directory error from an initialization race.

**Handling boundary**: Serve prepares workspace metadata itself; this does not automatically authorize its ancestors. For private-ancestor layouts, use a product-supported workspace setting or set `SCHOLARSEED_DEFAULT_WORKSPACE` for a new process to choose a location whose ancestors can be resolved. An existing product setting takes precedence; the environment variable does not override it. Do not change resolution precedence, migrate historical projects, copy credentials, or conceal failures by changing ACLs, using absolute paths, or replacing file APIs.

**Acceptance**: With official Codex, verify in a real session that the cwd values match and that relative-path create/read/rename/delete operations succeed and the target is ultimately absent. Separately confirm that listing the workspace root and reading files outside the project are still denied. Use a separate parent process for concurrency checks of cold/warm initialization, concurrent execution, and continued execution after another process exits; a single-session success cannot substitute for multi-process verification. Passing in the development client does not mean the signed installer passed.
