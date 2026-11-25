# Desktop Packaging

The recommended entry point for Desktop is `pnpm ops` at the repository root. Run
development, checks, local packaging, and release packaging from the repository root;
the CLI coordinates the original domain Owners with Desktop's internal recipes:

The separate distribution repository does not need command changes: the product root
retains the `package:dist`, `package:check`, and `package:verify` interfaces and their
`scripts/desktop.cjs` probe. The first two map to the ops distribution build and
candidate-directory check, respectively; legacy `--type` maps to `--channel`, and the
result path can still be passed explicitly. This does not restore all legacy behavior:
the current Owner does not implement `--skip-check` or resuming an old checkpoint. The
compatibility entry point explicitly rejects these before building; it neither silently
drops the arguments nor rebuilds while pretending to resume.

```bash
pnpm ops dev
pnpm ops cd build local --stage app
pnpm ops cd build release --stage dir --candidate
pnpm ops cd build local
pnpm ops cd build release --workflow distribution
```

Local, direct-release, distribution, and package-acceptance installer builds each run one
fixed smoke check through the Desktop builder after preparing dependencies. Packaging
starts only if the smoke check exits successfully and the source still matches the build
inputs. The `app`, `backend`, and `dir` stages, and candidate-directory checks, do not run
the installer smoke check. Registered build arguments are passed only to the builder,
not to the smoke check.
Standalone `pnpm ops ci` / `pnpm ops ci test smoke` does not install dependencies
automatically. It allows uncommitted changes in the initial worktree, but requires the
source fingerprint to match before and after the run. Any source change during the run,
dependency preparation failure, test failure, or cleanup failure blocks subsequent
builds. Smoke runs the same explicit test list on darwin/win32; it does not skip the
Windows gate.

The total budget for the fixed smoke check is 900 seconds (15 minutes), defined in
`scripts/ci/smoke.json` with headroom for slower hosts. It includes the smoke check's
internal prechecks, collection, execution, reporting, and lock cleanup, but excludes
outer dependency installation and subsequent build/signing work. The smoke command and
the Desktop builder each check total wall-clock time. Exceeding the limit exits nonzero
and packaging must not start. No new stage starts after a timeout; resources already
acquired must still be released normally, and a cleanup timeout is not a pass.
`quality.json` is a result snapshot taken before the lock is released. The final cost of
lock release and process exit is determined by the command's terminal JSON and the
caller's wall clock; do not judge the whole call as passed from the snapshot alone. The
fixed smoke check is not the Playwright smoke project or the full PDFE UI suite, and it
does not replace the post-build payload inventory, digests, or installer acceptance.
Smoke does not replace full CI, signed-installer acceptance, or real release acceptance.
See the [CI guide](../../scripts/ci/README.md#冒烟检查) for its scope and report.

`pnpm ops dev` and `pnpm ops cd build local --stage app` automatically prepare the Python
archive and `.venv` build-time dependencies through `prepare:python`; users do not need
to run `pnpm ops pre install python` first.

For a first checkout, run `pnpm install --frozen-lockfile` at the repository root to
install dependencies from the root and Desktop pnpm lockfiles; use `npm ci` or
`yarn install` for compatible npm/Yarn installs, respectively. Worktree initialization
also defaults to pnpm and shares the store, but not the entire `node_modules` directory.
If a tool is missing or its version does not match, stop first. The [toolchain and
authorized installation procedure](development.md#worktree-初始化与-pnpm-前提) explains
how AI can install exact versions after user approval; initialization does not silently
install global tools.
All npm packaging commands prepare the Python archive and `.venv` build-time dependencies
through `prepare:python`, then call the actual packager,
`apps/desktop/scripts/cd/build.cjs`, through `apps/desktop/scripts/cd/package.cjs`.
There is no longer a Python packaging entry point. External CI uses the repository-root
Node entry point with an explicit package manager or registered CI recipe; it does not
depend on the removed root aliases. Desktop internal scripts still run through the
selected package manager, preserving its hooks and argument-separator semantics.
Build locks left by an abnormal exit are cleaned up automatically after confirming the
original process no longer exists; an active build still blocks concurrent packaging.

macOS DMG builds use `dmgbuild==1.6.7` from this development environment. The entry
point locates and verifies the executable through the target Python's
`sysconfig.get_path("scripts")`, sets `CUSTOM_DMGBUILD_PATH`, and then calls Electron
Builder. It is not a Python runtime dependency in the installer. After the Python
environment is prepared, a DMG build does not access the network to obtain dmgbuild. If
it is missing or its version does not match, the build fails rather than falling back to
Electron Builder's online download. Windows Velopack does not need this macOS tool.

The DMG adapter records `lsof` output for the target volume and the related PID/PPID,
user, and executable paths on the first detach failure. It does not collect process
environments or full arguments. Diagnostic commands have a 10-second limit and retain
at most 64 KiB per item; failures and truncation are recorded explicitly. Evidence is
written to this run's `dmg-copy.log`, and the build log still prints that file's path and
a bounded tail. Normal detach is attempted at most 5 times. Forced detach is allowed
only when the resource is busy. Before forcing it, ownership is checked against the
image path and device attached in this run; after success, the device/image must be read
back as gone before conversion continues. Other errors, identity changes, failure to
read back, or an image that remains mounted continue to fail. Do not clean up other
images or disable the host's Spotlight.

For both macOS architectures, the native regression entry point is run with Python that
has the pinned dmgbuild: `apps/desktop/scripts/cd/__tests__/detachment.py <空的任务证据目录>`
(where the argument is an empty task-evidence directory). A real file handle keeps the volume busy; the test first verifies
the upstream failure, then recovery, evidence for the process holding it, DMG
verification, and read-only mounted contents. This focused regression does not sign or
publish, and does not replace full installer acceptance in formal CI.

The DMG entry point uses `apps/desktop/scripts/cd/image.py` to adapt the pinned dmgbuild.
It budgets capacity from allocated file blocks, per-item metadata, at least 128 MiB or
10% of the payload for filesystem headroom, plus GPT/EFI and trailing-reserve space.
Capacity is written to the parsed options; dmgbuild 1.6.7's JSON loader ignores `size`
in JSON, so setting only `build.dmg.size` does not solve this. The upstream `ditto`
copy's exit code and timeout are checked, and any failure stops the build immediately.
Capacity, available space, and the original copy error are saved in the target
directory's `dmg-copy.log`; a bounded tail is printed in the build log on both success
and failure. Signing, notarization, existing package checks, and final distribution-side
image acceptance are not skipped.

| Behavior | macOS | Windows |
| --- | --- | --- |
| Image creation | Call pinned dmgbuild through the local Python adapter; reject packaging if copying fails | Do not run the DMG adapter; retain the Velopack path |
| Focused regression | `node --test apps/desktop/scripts/cd/image.test.cjs`, including real ditto and the Python loader | Explicitly skip macOS-only cases; bounded-log tests still run and do not replace native Setup acceptance |

Full builds still require a clean worktree. Reusing a signed app to verify a DMG fix proves
only image rebuilding, its contents, and launch after mounting; it does not prove a full
build from new source, re-signing, notarization, upload, or Windows acceptance.

Windows app builds use `apps/desktop/scripts/cd/vpk.cjs` to prepare the official Velopack
1.2.161 CLI, the same-version C ABI DLL, and the private build-time .NET 8.0.32 runtime
early in the build. The adjacent `vpk.json` pins their sources, sizes, and SHA-256
digests; downloads reuse `SCHOLARSEED_ARTIFACT_CACHE`. On a cache miss, the build first
tries the OSS vendor mirror in the manifest and falls back to the official source if
that fails. Both sources must pass the same size and SHA-256 checks. The original
official packages are stored under `vendor/velopack/` and `vendor/dotnet/`, respectively.
Upload and anonymously read back a mirror to verify it before updating the manifest.
The build does not depend on runner-global `vpk`, an SDK, PATH, or a .NET installation,
and does not install .NET for the user. macOS and backend-only builds do not prepare
these tools. Retain the CLI's complete vendor directory, and confirm its version by
actually running `dotnet.exe tools/net8.0/any/vpk.dll -h` before continuing the build.
The same-named nupkg archives from NuGet and GitHub have different digests and cannot be
interchanged as mirrors of the same digest. Tool preparation failure stops immediately;
signing, the complete inventory check, and installer acceptance cannot be skipped.

<a id="构建类型"></a>
## Build Types

Local `pnpm ops cd` / `pnpm ops cd build local` (`type=dev`) allows uncommitted changes,
but the starting and ending HEAD, index, and actual source fingerprints must match; source
changes during the build still cause failure. Results preserve the actual dirty state and
source identity: uncommitted code is not represented as HEAD alone and does not thereby
gain release eligibility. `preview`/`release` (including candidates) and full installer
acceptance workflows still require a clean worktree. The local relaxation does not waive
inventory, native-platform, protected-resource, or required macOS ad-hoc-signing checks.

For `preview`/`release`, including unsigned candidates, a source branch named
`preview/<x.y.z>` or `release/<x.y.z>` must match the effective build version
(`--version`, then `SCHOLARSEED_DESKTOP_VERSION`, then Desktop `package.json`).
This check runs before dependency preparation, signing, and packaging. For detached
CI checkouts, `CI_COMMIT_REF_NAME` is checked only when `CI_COMMIT_SHA` matches the
captured source commit; a supplied but unbound CI ref is rejected. Without a CI ref,
detached checkouts use versioned local/origin refs that point exactly at the source
commit; conflicting version lines are rejected until the intended branch is selected.
Ordinary task branches and detached commits without a versioned ref keep their existing
source contract; the builder does not infer a version branch from a timestamp. Local `dev` builds
remain available for work on a different version line. These checks do not replace
verification of the exact commit and installed package payload.

`preview`/`release`（包括未签名候选包）的源码分支若命名为 `preview/<x.y.z>` 或
`release/<x.y.z>`，必须与实际构建版本一致；版本依次取 `--version`、
`SCHOLARSEED_DESKTOP_VERSION`、Desktop `package.json`。检查发生在依赖准备、签名和
打包之前。CI 分离检出只有在 `CI_COMMIT_SHA` 与已捕获的源码提交一致时，才采用
`CI_COMMIT_REF_NAME` 进行检查；传入但未绑定提交的 CI ref 会被拒绝。没有 CI ref 时，
分离检出检查精确指向源码提交的本地和 origin 版本 ref；版本线冲突时，须先选定实际分支。
普通任务分支和没有版本 ref 的分离提交沿用既有源码契约，不从时间戳推断版本分支。本地 `dev` 构建仍可
用于其他版本线的开发。这些检查不替代精确提交和已安装包内容的验证。

| Type | Purpose | Signing |
|---|---|---|
| `dev` | Local development package | macOS ad-hoc; Windows unsigned; validate the selected stage |
| `preview` | Public preview channel | Formal signing required; macOS also requires notarization; full installer acceptance |
| `release` | Public release channel | Same signing and full installer acceptance process as preview |

`preview`/`release` builds fail by default if signing capability is unavailable. Add
`--candidate` explicitly to produce `preview-candidate` or `release-candidate`. A
candidate runs the full functional self-check, but the uploader rejects it for release.

<a id="mvp-v01-本地包限定"></a>
### MVP v0.1 Local Package Restrictions

Before preparing an MVP local package or signed package, uploading through CI/CD, or
releasing a version, read this section and the version-identity contract in the
“CI/CD Channels and Release Responsibilities” and “Build Results” sections below. This
document states prerequisites; it does not authorize installation, building, uploading,
signing, releasing, channel/user configuration, or credential changes. Historical
commands do not carry authorization forward.

- Before building an MVP installer, merge the latest remote `shushen_release/mvp_v0.1`
  into the development branch, resolve conflicts, synchronize `uv.lock`/workspace, and
  complete real acceptance; then merge the development branch back and push that branch.
- Build the MVP on `shushen_release/mvp_v0.1`: the worktree must be clean, the workspace
  lock must match each member's declaration, and local HEAD must match the remote. Do
  not deliver from `dev`, the old Veda `release/v0.1` / `release/v0.1.1`, or an
  uncommitted worktree. After delivery, synchronize the local and remote versions of the
  developer-specified target branch, or report the exact blocker.
- `build.cjs --type release` enters the release-signing flow; it does not switch
  branches, merge code, or publish an online release. A user request to release does not
  authorize building or installing. These MVP-specific constraints are not replaced by
  general CI/CD branch rules or the integration/MR target in the current root
  `AGENTS.md`; do not reconcile the two rules yourself.

The old `.ai/09.deploy/书深MVP安装包构建与部署流程.md` is not present in the current
worktree. Existing commands, signing contracts, and package-check do not prove that
installer acceptance/rollback procedures exist for the corresponding version; complete
the procedures and confirm authorization before execution. Writing or updating this
document alone does not authorize an actual build, reinstall, or release.
The current `build.cjs` checks for a clean worktree for preview/release/candidates, while
local dev builds may use stable uncommitted source; all record the branch/commit, actual
clean state, and initial/final source fingerprints. It does not implement the MVP-only
branch, remote parity, or integration-order checks above. These remain required
prerequisites even though the source does not check them.

<a id="平台"></a>
## Platforms

| Platform | Arch | Release `arch_type` | Installer | Build environment |
|---|---|---|---|---|
| `darwin` | `arm64` / `x86_64` | `darwin-arm64` / `darwin-x86_64` | DMG | Native macOS for the corresponding architecture |
| `win32` | `x86_64` | `windows-amd64` | Velopack Setup EXE (per-user install) | Windows x64 Runner |

`arch_type` is the canonical, lowercase architecture name shared by upload layout,
update service, and installer filenames. Its source of truth is
`apps/desktop/scripts/shared/target.cjs`. It intentionally differs from Node's naming:
Windows releases use `windows-amd64`, while Node/Electron still use `win32`/`x64`, and
the lookup key in `target.cjs` remains `win32-x86_64`.

Cross-platform and cross-architecture builds are not supported.

<a id="常用命令"></a>
## Common Commands

<a id="统一开发入口"></a>
## Unified Development Entry Point

| Command | Purpose | Signing/credentials |
|---|---|---|
| `pnpm ops dev` | Start Electron in development mode | Not required |
| `pnpm ops cd build local --stage app` | Build renderer/main/preload frontend artifacts | Not required |
| `pnpm ops cd build release --stage dir --candidate` | Build an unpacked App and run product packaging checks; stop before signing/installer creation | Not required; uses a placeholder update URL by default |
| `pnpm ops cd build local` | Build a local dev installer | No release credentials; for local use on macOS |
| `pnpm ops cd build release --workflow distribution` | Build a release installer after the fixed smoke check passes; use `pnpm ops cd build release` for a direct build; these are not aliases | Signing/notarization credentials injected through Git CI or local environment variables are required |

Release credentials are read only from the environment and are not written to the repository:

| Variable | Platform | Purpose |
|---|---|---|
| `SCHOLARSEED_UPDATE_BASE_URL` | macOS / Windows | HTTPS base URL of the release update service |
| `SCHOLARSEED_MACOS_TEAM_ID` or `APPLE_TEAM_ID` | macOS | Developer ID Team ID |
| `SCHOLARSEED_NOTARY_KEYCHAIN_PROFILE` | macOS | `xcrun notarytool` keychain profile |
| `SCHOLARSEED_APPLE_API_KEY` / `SCHOLARSEED_APPLE_API_KEY_ID` / `SCHOLARSEED_APPLE_API_ISSUER` | macOS | Apple API notarization credentials; required when a keychain profile is not used |
| `SCHOLARSEED_WINDOWS_SIGN_CLIENT` / `SCHOLARSEED_WINDOWS_SIGN_SERVER` / `SCHOLARSEED_WINDOWS_SIGN_USER` / `SCHOLARSEED_WINDOWS_SIGN_KEY` / `SCHOLARSEED_WINDOWS_SIGN_DOMAIN` / `SCHOLARSEED_WINDOWS_SIGN_PUBLISHER` | Windows | Windows signing service and publisher |

Configure these variables as protected/masked secrets in GitLab/GitHub CI. The open-source
repository commits only variable names, examples, and documentation—not certificates,
profiles, private keys, or internal upload addresses.

<a id="平台与参数示例"></a>
## Platform and Parameter Examples

macOS dev:

```bash
pnpm ops cd build local --platform darwin --arch arm64

# 在 Intel macOS 原生终端运行
pnpm ops cd build local --platform darwin --arch x86_64
```

Windows dev:

```powershell
pnpm ops cd build local --platform win32 --arch x86_64
```

Release candidate check without publishing:

```bash
pnpm ops cd build release --stage dir --candidate \
  --update-base-url https://updates.example.com
```

Use `pnpm ops cd build release --workflow distribution` for a formal package; inject
signing, notarization, and update-service configuration through the environment variables
above. For the registered direct preview build, use
`pnpm ops cd build release --channel preview`, which uses the same installer smoke gate.
For a preview candidate check, use
`pnpm ops cd build release --channel preview --stage dir --candidate`; for a preview
distribution build that retains the smoke prerequisite, use
`pnpm ops cd build release --channel preview --workflow distribution`. Both follow the
original Owner. Verifying wiring does not mean formal signing or release acceptance on
both platforms is complete; do not rewrite either command as `local --type preview`.

The unified CLI does not provide `--install`; local packaging does not install
automatically by default. After the build, use the installer path in this run's result
and install it manually if separately authorized. The original
`apps/desktop/scripts/cd/build.cjs` `--install` and `installResult()` remain capabilities
of the installation Owner; this does not mean `pnpm ops cd build local --install` is
available. The CLI installation entry point is deferred; permissions, active instances,
and data protection still require separate checks, and this installation need is not
removed.

Common build parameters for the unified CLI (subject to the owning command's help and
registered contract):

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

For `local`, workflows are `direct`/`package-acceptance`; for `release`, they are
`direct`/`distribution`. They cannot be combined arbitrarily. `--type`, the underlying
`--stage backend`, and `--install` are native interfaces of the build Owner, not native
CLI passthrough options. The CLI selects the corresponding recipe through local/release,
channel, and target; it rejects unregistered arguments, and `--` cannot bypass this.

`--version` accepts only three-part SemVer and defaults to the `version` in
`apps/desktop/package.json`; legacy forms with a `v` prefix or embedded timestamp are
rejected. `--build-number` must be 12 digits in `YYYYMMDDHHMM` format.

`preview`/`release` also require `--update-base-url`; signed macOS `preview`/`release`
builds also require `--team-id`, and signed Windows `preview`/`release` builds also
require `--windows-publisher`.

### macOS installers and automatic updates

Signed macOS distribution builds produce both the installer DMG and
`scholarseed-update.zip` from the same application. Website downloads and
clients that only understand the installer protocol use the ordinary DMG.
Installing that release adds ZIP support. Subsequent automatic updates prefer
the CI-built ZIP and fall back to the DMG when the selected release has no ZIP.

The existing Release rule for build `202611181656` on arm64 and x86_64 is an
exception. This client cannot scan an ASAR in a mounted update. It first takes
the already published directory-layout bridge DMG `0.3.2-202611192102`. That
bridge then takes the ordinary DMG to gain ZIP support. For signed acceptance
on each architecture, verify the ordinary DMG-to-ZIP path and this historical
route, including a previously failed update and the original workspace after
restart.

CI measures the level 1 ZIP that older clients create from the DMG. For
distribution it creates a level 6 ZIP from the same mounted application,
including AppleDouble metadata when the bundle contains resource forks or
extended-attribute code signatures. Both archives must pass Squirrel's size
and structure checks. CI verifies the Developer ID signature, stapled ticket
and identity of the app extracted from the level 6 ZIP, and records its size
and digests in `artifacts.macos_update_zip`. The desktop verifies the app
and ticket on Squirrel's existing extraction. If ticket verification is
temporarily inconclusive, it can retry the same bound request. Installation
requires a fresh online grant.

The macOS distribution build can reuse signed Electron Framework, third-party
Python Mach-O files and TeX Live Mach-O files as three separate groups. CI signs
the Mantle, ReactiveObjC and Squirrel frameworks on every build. An app-code-only
build restores each matching cache group before running the signer. The cache key
binds the group's input bytes, target architecture, Developer ID Application
policy, Team ID, entitlements and signing tools. CI checks
the restored code against the current inputs and verifies its signature on every
architecture. It signs the current outer app and runs notarization and installer
acceptance for each release. The private distribution runner shares this cache
across machines by default. Use `--no-shared-components` for local reuse. The
signer logs `[sign-cache]` with `miss`, `local` or `registry` for each group.
Both platforms use `scholarseed-components/v3/<target>/<kind>/<version>/` in the private CI registry.
Each version owns `receipt.json` and `<kind>.zip`. CI reads the receipt by version and verifies
the full input SHA, archive digest and size. A warm runner can repopulate a missing version from
its verified local copy. A conflicting input requires an explicit private revision, such as
`SCHOLARSEED_CI_CACHE_VERSION_DARWIN_X86_64_CODEX=0.171.0-r2`. This only selects the build cache.
On macOS, run the signed-sample acceptance against the distribution app with
`SCHOLARSEED_SIGNED_RUNTIME_SAMPLE=/path/to/ScholarSeed.app node --test apps/desktop/scripts/cd/__tests__/signed-sample.acceptance.cjs`.
Default CI exercises cache and policy regressions without a distribution sample.

Component-capable clients request `macos_components=1` on the selected ZIP's
download endpoint. On the first component update the client fetches all required
objects. Later updates reuse SHA-256-verified objects from the profile's cache.
When only app code changes, this downloads the app object and the ZIP layout.
For signed Mach-O files in frameworks, Python and TeX, CI compresses the code
and its signing envelope independently inside the ZIP. New signatures travel
with the app object. Python wheel installation timestamps, source URLs and the
wheel records that hash them also travel with the app object. The client fetches
a new runtime object when its contents change.
The client reconstructs the published ZIP,
checks its release SHA-512, and hands it to the existing Squirrel preparation
flow. A missing sidecar or failed object transfer uses the same release's full ZIP.

Each release stores `app.bin`, `layout.gz` and `macos-zip-components-v3.json` alongside
`scholarseed-update.zip` in `<channel>/<arch>/<version>-<build_number>/`. The app object
includes Mantle, ReactiveObjC and Squirrel. The entire bundled
`site-packages/service/capabilities/skills/` tree also belongs to `app.bin`,
including its generated manifests and bytecode. The first macOS Python revision
with this split is `3.14.10-r2`. The publisher uses `workspace_wheels` in
`backend/python-dependencies.json` to identify product wheels such as `deep-rnd-l1`.
Pinned third-party Skill dependencies stay in the shared Python component, which
can be reused when only a bundled Skill changes.

The accepted build records versions for the five shared runtimes (browser, Codex, Electron,
Python and TeX Live) in `artifacts.macos_update_zip.component_versions`.
Both macOS architectures store those runtimes in `components/<arch>/<kind>/<version>/`, with an immutable
`identity.json` and a subdirectory named for the full SHA-256. For example,
`components/darwin-arm64/codex/0.171.0-r1/<sha256>/codex.bin` holds the Codex ZIP
fragments. Runtime versions use the pinned
upstream version and a packaging revision from `apps/desktop/scripts/cd/mac-component-versions.cjs`.
Bump the affected revision when packaged runtime bytes change at the same upstream version.

macOS 签名分发构建从同一份应用生成安装 DMG 和更新 ZIP。官网下载和只支持安装器协议的
旧客户端都使用普通 DMG。安装这个普通版本后，后续自动更新优先使用 CI 生成的 ZIP。
选定的发布没有 ZIP 时使用 DMG。

arm64 和 x86_64 上的 Release 构建 `202611181656` 是已有过渡规则的例外。这个客户端
无法扫描挂载包中的 ASAR，因此先安装已发布的目录布局过渡 DMG `0.3.2-202611192102`，
再通过普通 DMG 获得 ZIP 更新能力。两个架构的正式签名验收都应覆盖普通 DMG 到 ZIP 的
路径和这条历史路径，包括曾经更新失败的客户端以及重启后原工作区是否可用。

CI 从挂载的 DMG 按旧客户端的方式生成 1 级 ZIP。正式分发时，从同一份应用生成
6 级 ZIP。应用含有资源分支或存于扩展属性中的代码签名时，发布 ZIP 使用 AppleDouble
保留这些数据。两份归档都须通过 Squirrel 的大小和结构检查。CI 解开 6 级 ZIP，
校验 Developer ID 签名、公证票据及应用身份，并在 `artifacts.macos_update_zip`
记录发布 ZIP 的大小和摘要。客户端复用 Squirrel 解出的应用校验身份和
票据。票据暂无法判定时可以重试同一笔已绑定的请求。正式安装仍需重新获取在线授权。

macOS 正式构建支持复用已签名的 Electron Framework、Python 第三方 Mach-O 和 TeX Live Mach-O，
共三组缓存。Mantle、ReactiveObjC 和 Squirrel 框架在每次构建中签名。
仅改应用代码时，CI 在签名前恢复命中的组。缓存键绑定该组输入、目标架构、Developer ID
Application 签名策略、Team ID、entitlements 和签名工具。恢复时比对本次构建的代码，并逐架构验签。每次发布仍会签署
本次外层应用，执行公证与安装器验收。私有分发 CI 默认跨机器共享缓存，也可用
`--no-shared-components` 切换到本机复用。日志中每组的 `[sign-cache]` 行会给出
`miss`（首次签名）、`local`（本机命中）或 `registry`（共享库命中）。
macOS 和 Windows 共用私有目录 `scholarseed-components/v3/<平台>/<组件>/<版本>/`。
每版保存 `receipt.json` 和 `<组件>.zip`。CI 按版本读取收据，核对完整输入 SHA、归档摘要和大小。
远端版本目录缺失时，热构建机可从已校验的本机副本补库。输入冲突时显式指定新的私有修订，例如
`SCHOLARSEED_CI_CACHE_VERSION_DARWIN_X86_64_CODEX=0.171.0-r2`。此设置只选择构建缓存。

恢复时逐架构校验 Apple 信任链、Developer ID Application 证书类型、配置的 Team ID，
以及代码标识、指定要求、安全时间戳、hardened runtime 和 entitlements。使用不同证书的同团队
构建机可在其他缓存输入一致时共享签名结果。
签名策略文件或 Team ID 变化会改变缓存键。若旧任务和新任务需要并行，请为每个受影响组配置
未占用的私有缓存修订号，并在共享同一输入的新任务之间使用相同修订。
若要沿用旧修订，先停止使用旧输入的任务，完成签名策略和输入切换，再清理对应平台、组件和修订
前缀下的收据及 ZIP，由新任务重新填充。

Cache restore verifies the Apple trust chain, Developer ID Application certificate type, configured
Team ID, code identifier, designated requirement, secure timestamp, hardened runtime, and entitlements
for every architecture. Runners using different certificates from the same team can share results
when all other cache inputs match. Policy source or Team ID changes alter the cache key. To run old and new jobs
in parallel, allocate an unused private revision per affected component and share it across new
jobs with identical inputs.
To reuse an existing revision, stop jobs that can publish the former input and coordinate the
policy and input cutover before clearing the receipt and ZIP under that exact version prefix.

在 macOS 上用正式分发包运行签名样本验收：
`SCHOLARSEED_SIGNED_RUNTIME_SAMPLE=/path/to/ScholarSeed.app node --test apps/desktop/scripts/cd/__tests__/signed-sample.acceptance.cjs`。
默认 CI 独立运行缓存与签名策略回归。

支持组件的客户端在所选 ZIP 的下载接口请求 `macos_components=1`。首次组件更新需要获取全部对象。
后续按 SHA-256 校验并复用当前用户配置的缓存。如果只有应用代码变化，仅需下载应用组件和 ZIP 布局。
对框架、Python 和 TeX 中受支持的已签名 Mach-O，CI 将代码与签名数据分段压缩。重新签名的字节、
Python wheel 安装时间、来源 URL 和引用它们的 RECORD 随应用组件传输。运行时组件的内容发生变化时，客户端会下载该组件的新版本。客户端重组发布 ZIP，核对该版本的 SHA-512，
再交给原有 Squirrel 准备安装。清单缺失或组件传输失败时，客户端回退到同一候选的完整 ZIP。

每次发布在 `<渠道>/<架构>/<版本>-<构建号>/` 下存放 `app.bin`、`layout.gz`、
`macos-zip-components-v3.json` 和 `scholarseed-update.zip`。`app.bin` 包含 Mantle、
ReactiveObjC 和 Squirrel。
内置 Skill 的整棵 `site-packages/service/capabilities/skills/` 目录及其中生成的清单和字节码也随
`app.bin` 发布。采用此划分的首个 macOS Python 组件版本是 `3.14.10-r2`。发布器按
`backend/python-dependencies.json` 的 `workspace_wheels` 识别 `deep-rnd-l1` 等产品 wheel。
锁定的第三方 Skill 依赖随共享 Python 组件交付，单独修改内置 Skill 时可复用该组件。

通过验收的构建在 `artifacts.macos_update_zip.component_versions` 中记录 browser、Codex、
Electron、Python 和 TeX Live 五组共享运行时的版本。两种 macOS 架构都按
`components/<架构>/<组件>/<版本>/` 存放这些运行时，每个版本下有不可变的
`identity.json` 和以完整 SHA-256 命名的子目录。例如
`components/darwin-arm64/codex/0.171.0-r1/<sha256>/codex.bin` 存放 Codex 的 ZIP 数据片段。
运行时版本取自锁定的上游依赖，打包修订号由
`apps/desktop/scripts/cd/mac-component-versions.cjs` 维护。同一上游版本的运行时字节发生变化时，
递增对应组件的修订号。

<a id="cicd-渠道与发布职责"></a>
### CI/CD Channels and Release Responsibilities

Public source owns local build, package verification, channel behavior and artifact contracts.
Use `preview/<x.y.z>` or `release/<x.y.z>` for three-part release lines, and pass the channel
explicitly to the product build commands. Branch names alone do not authorize signing or publishing.
The optional distribution service owns signing credentials, uploads and hosted publication; public
contributors do not need its checkout or credentials for source checks and ordinary local builds.
A release record must identify the exact product commit, relevant document revision, artifact hashes,
platform, channel and real acceptance results. Routine development does not require paired repository SHAs.

No hosted pipeline, signing, upload or release has been validated merely by checking a local command
plan. Preserve existing native package and installed-product acceptance requirements below.

<a id="构建结构"></a>
## Build Structure

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

Electron Builder writes main/preload into `app.asar` and places renderer, backend,
defaults, and `product.json` in the platform resources directory.

<a id="electron-入口闭包与浏览器驱动-node"></a>
### Electron Entry Closure and Browser Driver Node

[closure.cjs](../../apps/desktop/scripts/cd/closure.cjs) requires Electron entry points to
be self-contained: except for host modules, main/preload dependencies must be included in
a build closure that can be checked statically. The final asar rejects `node_modules`, a
duplicate `out/renderer`, and package manifests declaring runtime npm dependencies. Do
not resolve a failure by weakening the gate or copying dependency directories. Moving a
dependency to `devDependencies` alone does not prove that it is available at runtime;
also verify that the final bundle contains the implementation, static references resolve,
and no non-literal loading, `createRequire`, `eval`, or `Function` bypasses the closure
check.

[browser.cjs](../../apps/desktop/scripts/cd/browser.cjs) provides the shared Node used by
the installed Playwright/Patchright drivers; it is not a feature switch for the product's
built-in browser or a Chromium sidecar. Retain both JS drivers, their licenses, and
metadata; deduplicate only a verified duplicate Node. Its source must be in product
staging, and the drivers must actually select the shared executable and initialize the
protocol. This Owner and [digest.cjs](../../apps/desktop/scripts/shared/digest.cjs)
maintain the integrity basis after signing/relocation. Do not treat a pre-signing file
hash, Node version output, or number of bytes removed alone as proof that the installer
is correct.

After dependency or Electron build-configuration changes, run
`pnpm ops cd build release --stage dir --candidate` from the repository root, and check
the actual artifact closure and original exit status; an ordinary build/typecheck cannot
replace the packaging path. This command may prepare dependencies, build, and start
verification, so first check this page's execution prerequisites and authorization. A
final signed installer, driver invocation, and real product acceptance are separate
evidence; passing an unsigned check does not mean a release or all-platform acceptance
has passed.

<a id="第三方声明与对应源码"></a>
## Third-Party Notices and Corresponding Source

The [notices](../../apps/desktop/resources/notices/README.md) published with the source
contain the original licenses and instructions for obtaining the pinned source versions
of certifi, tqdm, pypdf, pycparser, and lightningcss, as well as the complete bundled
licenses for Pillow wheels on all three release platforms. Retain the lightningcss notice
even though it is used only during the build; do not exclude it because it is in
`devDependencies`. These are license materials for specified components, not a
whole-product SBOM or legal clearance.

`resources/notices/manifest.json` records artifact URLs and digests, source archive URLs
and digests, and the member paths of the original licenses. During build assembly,
`scripts/cd/notices.cjs` checks pinned versions, artifact digests, and license files
offline, then freezes the entire directory. Electron Builder uses the frozen copy, and
existing content checks for the App and DMG/Velopack compare it byte for byte; missing or
changed content fails. When upgrading these dependencies, re-verify the corresponding
artifacts and update the notices; updating only the lockfile is insufficient.

| Platform | Bundled directory | Pillow audited artifact |
| --- | --- | --- |
| macOS arm64 | `ScholarSeed.app/Contents/Resources/notices/` | CPython 3.12 macOS 11 arm64 wheel |
| macOS x86_64 | `ScholarSeed.app/Contents/Resources/notices/` | CPython 3.12 macOS 10.13 x86_64 wheel |
| Windows x86_64 | `<安装目录>/resources/notices/` (install directory) | CPython 3.12 Windows amd64 wheel |

Paths are handled through `node:path`; the lockfile accepts LF/CRLF. On the first
extraction, only CRLF in the notices is normalized to LF. The manifest records digests
for both the original members and bundled copies; builds verify the copied bytes and no
longer convert line endings by platform. All three platforms use the same notices
directory (retaining the three original Pillow notices), but each still requires native
build and installer acceptance. Cross-platform directory fixtures and static review of
remote wheels do not replace native installer acceptance.

Source links must be public and pinned to a version or commit; do not use internal Git
addresses or the moving `main` branch. After changing third-party source, distributors
must also provide the corresponding source with the actual modifications; an unmodified
upstream archive is no longer sufficient.

<a id="内置制品"></a>
## Bundled Artifacts

| Artifact | Purpose |
|---|---|
| python-build-standalone | Run the local Serve backend |
| Official Codex Runtime | Agent sessions and tool execution |
| ripgrep | Search file contents |
| PowerShell 7 portable | Isolated Windows component payload; do not add it to the Agent `PATH` before real encoding acceptance |
| `skills/community` | Skills delivered with the product |

The Codex version and platform source are defined by `scripts/vendor/codex/manifest.json`;
do not resolve npm `latest` at startup or build time, or install a developer-global CLI.
`apps/desktop/runtime/codex.cjs` preserves the complete platform package's vendor
subtree, including file layout, package metadata, and per-file digests; it does not
extract only the main `codex` executable. Being able to run `--version` does not prove
that the code-mode host, resources, or tool-execution chain is complete. Artifact
retrieval is managed by `scripts/shared/artifacts.cjs` and currently restores from the
manifest rather than relying on the old Git LFS package. Archive SHA-256, npm integrity,
cached bytes, and version probing are distinct checks; an old receipt is not a reason to
skip validation. Cache, publication, or probe failures must not silently switch to a
different version.

The development Desktop starts after waiting for fixed artifact resolution. The macOS
installed app selects its executable from `backend/codex-runtime/bin` inside the package;
if it is missing, startup fails and does not enter the development download path. The
Windows installed app downloads missing components according to the signed runtime.json,
then selects Codex from the exact component version under the installation root's
runtime directory. When changing this chain, separately verify the final payload, actual
process path/version, and a real tool turn; an ordinary version probe or controlled
contract does not prove delivery.
The no-network-fallback rule for the DMG tool applies only to an already-prepared
dmgbuild; it does not mean artifact restoration, dependency preparation, signing, or
notarization are fully offline. Historical branch merges, reverts, and release ordering
do not authorize current Git operations.

The exact Python and SQLite versions, release batch, platform paths, download URLs, byte
sizes, and SHA-256 digests are specified in
`scripts/vendor/python-build-standalone/manifest.json`. `scripts/shared/python.cjs` is
the shared resolution/validation entry point for development installs and packaging;
build preparation and the final installer both actually run the target Python and check
`sqlite3.sqlite_version`. By default, `pnpm ops pre install python` uses the same archive
to create the development `.venv`; `pnpm ops pre doctor --scope interpreter` can check
its version and actual base path. This is separate from the Python library version lock
in `uv.lock`. Stop processes using the venv before switching runtimes.

For Windows x64:

```text
scripts/vendor/python-build-standalone/*-x86_64-pc-windows-msvc-*.tar.gz
scripts/vendor/ripgrep/x86_64-pc-windows-msvc/rg.exe
scripts/vendor/powershell/PowerShell-*-win-x64.zip
```

For macOS x86_64:

```text
scripts/vendor/python-build-standalone/*-x86_64-apple-darwin-*.tar.gz
scripts/vendor/codex/*-darwin-x64.tgz
scripts/vendor/ripgrep/x86_64-apple-darwin/rg
```

These paths are local files restored on demand and are no longer tracked by Git or Git
LFS. `scripts/shared/artifacts.cjs` downloads them from the manifest into a user-level
cache, verifies file size and SHA-256, and then atomically restores them to the worktree.
The default cache paths are `~/.cache/scholarseed/artifacts` on macOS/Linux and
`%LOCALAPPDATA%\ScholarSeed\cache\artifacts` on Windows; override them with
`SCHOLARSEED_ARTIFACT_CACHE`. Python, Codex, ripgrep, PowerShell, TeX Live and Go SDK
archives use publicly readable OSS artifacts and require no download credentials:
`https://deep-rd.oss-cn-hangzhou.aliyuncs.com/scholarseed-vendor/vendor`。
The vendor manifests and `url` in `apps/desktop/updater/toolchain.json` own default download URLs.
macOS and Windows no longer deliver or download Office WASM. DOCX, PPTX and XLSX use local read-only previews; CSV retains its local editor. Legacy DOC, XLS and PPT use external applications or exported copies. New Windows component manifests exclude Office. Existing signed manifests, archives and caches remain intact for older versions.

Desktop native modules are declared in `apps/desktop/native/libraries.cjs`. They
are compiled separately and use the existing toolchain, signing, and frozen evidence;
the build and signing manifests record each module's SHA256 separately. ASAR may unpack
only the platform's main modules listed in its manifest. Preload and standalone
inspection entry points must not load them directly or indirectly. Windows
libraries retain the current executable's delay-load hook; font enumeration uses
DirectWrite and does not infer paths from the registry. Do not overwrite artifacts
referenced by a manifest. If content changes, use a new object path and re-audit size and
digest.
Windows retains its component registry, canonical ZIP, and frozen-inventory controls.
Signed CI publishes the Python, TeX Live, PowerShell, Codex and Electron ZIPs
separately; only the signed manifest enters `current/resources/components`. Component
versions are bound to content digests. On first use or when content changes, components
are downloaded and expanded to `<安装根>/runtime/<kind>/<component-version>` (the installation root);
unchanged components are reused. vpk full/delta packages deliver only program code,
resources, native modules, and the minimal launcher/helper. If no delta base is available,
the build still falls back to full and does not re-download unchanged runtimes. macOS
layout and update behavior are unchanged.

Windows `ScholarSeed.exe` is a native launcher. It first handles the official Velopack
C ABI hooks, then prepares Electron through the shared helper's restricted bootstrap.
The engine's original PE is renamed only; its bytes and signature do not change. The
fixed bootstrap loads `current/resources/app.asar` and sets the real product
version/path. `process.execPath/resourcesPath` still refer to the engine; `src/main/resources.ts`
locates the product resources and stable launcher. Other components continue to use the
download-preparation UI in the app, and updates still prepare all target components
before exiting the backend.

`runtime/electron.json` pins the upstream version, size, and SHA256. For Windows builds,
the official Electron ZIP is taken from the local cache when available, otherwise from
the `vendor/electron/` OSS mirror, and falls back to GitHub if that fails. All sources
use the same size and digest checks; the mirror does not change component content or
version. Bootstrap changes must also update the audited component revision and measured
tree/ZIP digests in `runtime/versions.json`. The launcher embeds the official C ABI DLL
using its final-byte digest. The native launcher writes its icon/version before signing
and freezing; electron-builder no longer rewrites the PE afterward. Retain all existing
gates for packaged signatures, full file inventory, path budget, native modules,
backend, first network access, restart, and Setup/uninstall. An unpublished new component
blocks local first-install acceptance. Do not fake a pass by pre-populating runtime or
temporarily disabling verification; signed installation and update must still be
verified by CI after merge.

After preparing the target Python and before assembling dependencies or compiling,
packaging runs a native-directory preflight. It uses the directory generator from formal
acceptance to check build output, isolated home, and workspace; any failure stops
immediately, while final App/installer launch acceptance still runs.
macOS isolated state uses the physical `/private/tmp` path to avoid the `/tmp` symlink.
On Windows, newly created build-output and acceptance directories grant write access
only to the current user, SYSTEM, and Administrators; the bundled configuration seed
directory inherits this ACL. Permission denials do not automatically repair existing
directories. Windows logs the denied path, ACE principal, mask, and ancestor details.

CI should preserve the user-level artifact, npm, and uv caches above across tasks; a full
formal Mac build still has to wait for Apple notarization. For a quick check, first run
`pnpm ops cd build release --stage dir --candidate`. Release only after the formal signed
build and full installer acceptance pass.

For a new worktree, run:

```bash
pnpm ops pre install python
npm --prefix apps/desktop run build
```

<a id="python-发行依赖来源"></a>
## Python Distribution Dependency Sources

Build tools use the exact versions declared by `.node-version`, Desktop's
`toolchain.defaultPackageManager`, and the root `tool.uv.required-version`.
`scripts/pre/toolchain.cjs` provides the shared checks and pnpm/npm/Yarn installation
implementation for Make, the Python launcher, and packaging entry points;
`pnpm ops pre doctor` reports actual versions and paths. Development Codex is also pinned
to a repository artifact.

The build host must provide a standalone uv that supports the root configuration (set
`UV=/absolute/path/to/uv` to specify it). Do not use uv from the built-in Python
environment that is about to be synchronized. Development installs and release runtime
dependencies both come from the root `uv.lock`.

1. The root `desktop` dependency group contains exact Python pins from the skill
   registry, vendored wheels, and pip. After checking that the registry matches the
   group/source, `scripts/shared/dependencies.py export` uses
   `uv export --locked --all-packages --extra serve --group desktop --no-default-groups`
   to export the closure, preserving platform markers and hashes while excluding
   workspace packages and local skill-wheel entries.
2. The native target Python installs this closure with `uv pip sync --require-hashes`.
   All workspace wheels are built by `scripts/cd/wheel.py --builder pip` after stale
   artifacts are cleaned up, then installed with `--no-deps --no-index`.
3. Skill prebundling checks only the installed registry pins and installs audited wheels
   offline; it no longer resolves or downloads dependencies. Wheel transitive
   dependencies (including Windows `msvc-runtime`) are already included in the
   lock/export.
4. The bundled Python retains `python-requirements.txt`, `python-dependencies.json`, and
   `dependencies.py`. Both the end of prebundling and final App verification check the
   complete package-name/version inventory and digests, and run `pip check`. Missing or
   extra packages, version changes, or changes to frozen files all fail.

On macOS, after skill dependencies are provisioned and before the build context is frozen
and signing begins, the actual packaging Python generates hash-based bytecode with
`optimize=0` and relative filenames. The interpreter's sysconfig determines the scope,
which is restricted to the controlled Python tree. Exact source/cache inventory digests
are written into the context; final App/DMG verification only recomputes them read-only.
Runtime bytecode writes remain prohibited, and no cache is added to the user's install
tree. Windows continues to use the existing component freeze, normalization, and RECORD
ordering; dependency-version checks do not replace bytecode inventory or signature
verification.

Before writing each cache, the compiler keeps a preparation compilation alive through
the final pass. This stabilizes CPython's constant interning and marshal reference
encoding across different import/compilation histories (CPython #129724). Regressions
compare independent interpreter histories; source hashes alone do not prove identical
cache bytes. Component version and archive-digest checks remain mandatory.

每个缓存写入前，编译器保留一次准备编译的代码对象直至最终编译完成，稳定不同导入和编译历史下的
CPython 常量驻留与 marshal 引用编码（CPython #129724）。回归需比较独立解释器历史；源码哈希相同
不代表缓存字节相同。组件版本绑定和归档摘要校验仍为必需检查。

When changing dependencies, update the relevant pyproject/registry, run `uv lock`, and
commit the lockfile. A stale lock fails before installation. This constraint pins runtime
dependencies; PEP 517 isolated build tools are still declared by each package's
build-system and this does not guarantee reproducible wheel-build bytes.

Exact-dependency wheels in `apps/serve/vendor/` are checked by
`dependencies.product_inputs()` against workspace source, versions, and byte digests in
the lock. Export lists them separately as `product_wheels` rather than mixing them into
third-party registry requirements. A snapshot rejects any wheel that is missing or
changed after export. Desktop delivers these alongside workspace wheels; Windows places
them in the `pylibs` rebuilt each time, while macOS installs them offline into the product
interpreter. Prebundled skills use the product interpreter through
`scholarseed-skill-python`; ordinary task venvs remain isolated and do not inherit these
packages. The source and contract for this mechanism do not replace native packaging
acceptance.

| Behavior | macOS | Windows |
| --- | --- | --- |
| uv and target Python | External uv, bundled `bin/python3` | External `uv.exe`, bundled `python.exe` |
| Dependency selection | Host Python/platform markers | Host markers, including `msvc-runtime` |
| Execution and paths | Argument arrays, system path separator | Argument arrays, `.exe`, CRLF, and drive paths |
| Required verification | Native build, App package-check, real turn | Native build, isolated Velopack install, package-check, real turn |

<a id="产品-skill-冻结与制品核验"></a>
### Product Skill Freezing and Artifact Verification

Before changing product Skill source, prebundling, dependencies, pack, installation, or
distribution, read this section and the [adaptation guide](../../skills/ADAPTATION.md#4-验证真实边界).
The existing root npm entry point, native target Python, isolated run directory, and
offline dependency contract still apply; do not create another build process.
`skills/community/` contains bundled source; `skills/registry.json` holds dependency
policy. Reviews check source, dependency declarations, and packaging rules; artifact
acceptance inventories are not committed to Git. User skills and user state must not
enter the bundled pack or DMG, and failed or incomplete scans must not change the result
to SAFE.

The compiler generates `.scholarseed.json.inventory` and `.scholarseed-package.json`
from the copied payload and writes them only to the artifact. Script execution does not
use the shipped inventory as an admission gate; it still checks paths and applicable
session permissions. `python -m service.cli.prebundle --diagnose-local-skill "<预置 Skill 目录>"`
(where the argument is the prebundled Skill directory) can read-only diagnose added,
missing, or changed files; it does not execute or modify scripts. A difference does not
by itself identify the cause of a failure.

`build.cjs` outputs `backend/skills.lock.json` for dependency installation and the
standalone `--verify-installed` check. Installed-state verification does not depend on a
source checkout; it still checks the file set, digests, sizes, permissions, and generated
metadata. The build does not create a pre-copy source snapshot and retains Bridge
contract checks and atomic pack replacement.

Artifact acceptance is bound to the `release-result.json` from the same build; it does
not scan old artifacts. macOS verifies the actual App and the same build's read-only
mounted DMG; Windows verifies artifacts after a native Velopack install. Python closure,
signature, and image checks do not replace standalone installed-state Skill verification
or prove that a real product invocation succeeds.

<a id="跨平台实现注意事项"></a>
## Cross-Platform Implementation Notes

Changes involving paths, permissions, processes, file locks, archives, or executable
discovery must document a macOS/Windows behavior matrix and run a real build on the
target platform. Known boundaries:

- Windows regular files often show `0666` through `stat.S_IMODE()`; do not compare this
  directly with POSIX `0644`. Skill payloads and generated `.scholarseed.json` must use
  the same permission-normalization entry point.
- Windows Python console scripts are in the target interpreter's `Scripts` directory;
  get this path with the target Python's `sysconfig.get_path("scripts")`. Do not infer
  it from the parent directory of `python.exe`.
- Node startup semantics differ for `.cmd`/`.bat` and `.exe`. Use a Windows-supported
  launch method only for controlled command scripts; never interpolate untrusted
  arguments into a shell command.
- External command output may use CRLF; member inventories and line-by-line output must
  support both LF and CRLF.
- Windows includes `bsdtar` for the current archive operations. Do not switch to Git's
  GNU tar, which may interpret the `C:` drive prefix as remote-archive syntax.
- `fcntl`/`flock`, Unix sockets, symlinks, and POSIX signals require explicit Windows
  implementations and corresponding tests; do not assume they are cross-platform.

## Package Check

All build types launch the final Electron app in the `dir`/`installer` stage:

```text
ScholarSeed --package-check <result.json>
```

The app writes JSON and exits after confirming:

- The Electron main process has started;
- the bundled Python backend is healthy;
- the renderer page has loaded.

The App startup log is saved in the build target directory as
`package-check-unpacked.log`. The Windows `installer` stage also installs in isolation
and starts the app again, with logs in `package-check-installed.log`. macOS verifies the
DMG but does not automatically install it to `/Applications`; installation occurs only
when `--install` is explicitly supplied. On failure, the terminal echoes app output and
reports the log path; do not infer the root cause from an outer `ETIMEDOUT` alone.

This self-check does not call an LLM and does not need account credentials.

The acceptance environment is created by `apps/desktop/scripts/cd/verify.cjs`. Windows
preserves the host `USERPROFILE` rather than redirecting the entire OS user profile to a
disposable product directory, preventing host helpers such as input methods from writing
long-lived state into a directory scheduled for cleanup. Product state remains isolated
through explicit `SCHOLARSEED_HOME`, `--user-data-dir`, the workspace, and private
AppData/temp directories; existing macOS Home isolation is unchanged. First launch,
reopen, and uninstall share the same product-state root. Do not make acceptance pass by
changing input methods, terminating host processes, weakening ACLs, extending cleanup
deadlines, or ignoring cleanup failures. An independent native comparison does not
replace the final result for the complete package.

<a id="签名"></a>
## Signing

The final macOS DMG uses the controlled `dmgbuild` entry point; a nonzero `ditto` exit
immediately blocks the build. After loading JSON settings, this entry point calculates
capacity using 4 KiB-aligned allocated file sizes, a 4 KiB metadata budget per member,
filesystem headroom of at least 128 MiB or 10% of the payload, and a 329 MiB GUID
partition budget. The default GUID layout includes a 200 MiB EFI partition and about
128 MiB of trailing reserved space; capacity cannot be calculated by adding only 128 MiB
to the file size. The pinned dmgbuild 1.6.7 ignores JSON `size`, so `build.dmg.size`
cannot override this policy; `image.py` assigns capacity in the parsed settings.
`dmg-copy.log` records the budget, requested size, and target-volume total and free space
before and after copying. This policy applies only to macOS DMGs; Windows Velopack does
not use this entry point. The raw copy output and exit code are saved in this run's
`dmg-copy.log`; CI prints the log path and up to a 16 KiB tail, including a truncation
marker, without printing signing credentials. Keep failure diagnostics with this build's
records.
After mounting the final image read-only, compare its complete file contents, types,
permissions, and symlink inventory with the signed source app, then check the bundled
app's signature, contents, and actual launch. A detach failure also blocks acceptance.
`artifacts.dmg.installed_check` records `source: mounted-dmg`, inventory digest, launch
result, and detach status, and binds them to the final DMG with `sha256`; checks of an
unpacked app cannot replace this evidence. Windows retains Velopack installer
acceptance and does not use the macOS image entry point.

macOS preview/release:

- Developer ID Application；
- Apple notarization；
- staple；
- Gatekeeper。

Use `SCHOLARSEED_NOTARY_KEYCHAIN_PROFILE` for notarization credentials, or provide the
Apple API Key, Key ID, and Issuer.

Formal Windows x64 builds connect to the managed remote signing tool through
`apps/desktop/scripts/cd/windows-sign.cjs`. The caller must provide
`--windows-publisher` and inject the following in the controlled build environment:

```text
SCHOLARSEED_WINDOWS_SIGN_CLIENT
SCHOLARSEED_WINDOWS_SIGN_SERVER
SCHOLARSEED_WINDOWS_SIGN_USER
SCHOLARSEED_WINDOWS_SIGN_KEY
SCHOLARSEED_WINDOWS_SIGN_DOMAIN
SCHOLARSEED_WINDOWS_SIGN_PUBLISHER
```

Do not write these values to the repository, build context, result files, or logs. The
Windows signing allowlist includes only the ScholarSeed main executable, standalone
handoff helper, and Velopack Update/launcher stub/Setup; third-party binaries such as
Codex, Python, Electron, and ripgrep retain their upstream bytes. macOS retains the
upstream Developer ID signatures on Codex and Node, and signs unsigned ripgrep with the
ScholarSeed Developer ID.
After the signing service returns, verify Authenticode status and the complete Publisher
on Windows before replacing the files to be signed. After checking all compilation
digests, sign Windows native modules in one batch using one directory request. Each file
returned in the batch must be unique and pass signature verification before being
copied back to the compilation directory; verify each signature again after copying and
freeze its digest. Existing single-file calls for the helper, app, and Setup continue to
use the same signing entry point.

| Platform | Runtime signing behavior | Verification |
| --- | --- | --- |
| macOS | Retain upstream Developer ID signatures on Codex and Node; sign ripgrep with the product Developer ID | Verify ripgrep's Developer ID, Team ID, secure timestamp, and Hardened Runtime; perform Apple notarization, stapling, and Gatekeeper checks |
| Windows | Preserve third-party Runtime bytes; sign only executables owned by ScholarSeed | Verify the Authenticode Publisher on the installer and product executables |

Windows in-app updates continue to use the `/api/v1/updates` release and authorization
control plane. They add `update_engine=velopack` and hand a version-pinned feed to the
official SDK to download delta/full updates. A full update is allowed when there is no
base or a delta is unavailable. The offline Ed25519 release manifest binds the product,
version, build, channel, package digest, and complete member inventory. After rebuilding
a delta, verify member contents; do not assume the rebuilt ZIP container is byte-for-byte
identical. Once preparation is complete, first exit the runtime process family owned by
this installation. A thin coordinator then elevates privileges, rechecks authorization,
and invokes official Velopack to replace `current`; prepare missing components
separately and reuse existing expanded directories. The original user coordinator
restarts the app.
Do not apply an update if signing, path, or exit checks fail. Automatic rollback on
health-check failure and migration of old directories have been removed; macOS is
unchanged.

<a id="构建结果"></a>
## Build Results

Each build target uses a fixed directory, `apps/desktop/release/<type>-<platform>-<arch>/`.
At the start of a new build, clean and replace only the old directory for the same type,
platform, and architecture; do not affect other targets. Preserve failure artifacts until
the next build for that same target. On success, report the exact paths to the installer
and `release-result.json`, for example:

```text
apps/desktop/release/dev-win32-x86_64/artifacts/velopack/<app-id>-preview-Setup.exe
apps/desktop/release/dev-win32-x86_64/release-result.json
apps/desktop/release/dev-darwin-arm64/artifacts/scholarseed-<version>-darwin-arm64.dmg
apps/desktop/release/dev-darwin-arm64/release-result.json
```

The macOS installer filename remains `scholarseed-<version>-<arch_type>.dmg`, without a
channel segment. Fixed vpk generates the Windows Velopack full/delta/Setup filenames;
read their actual paths from `release-result.json` rather than guessing from old NSIS
naming. The release architecture remains `windows-amd64`.

Version identity has two independent fields: `version` is three-part SemVer (without a
`v` prefix), and `build_number` is Beijing time in `YYYYMMDDHHMM` format. By default, it
uses the commit time corresponding to this build, so rebuilding the same commit is
idempotent and Damoclaw-Server can predict the draft identity before the build ends.
Multiple builds may share the same version. Since `app.getVersion()` returns only the
three-part version, `build_number` is also frozen into the packaged `product.json` so
clients can order builds of the same version.

The result records:

- Git branch/commit；
- version/build_number/type/channel/candidate/lane/platform/arch/arch_type；
- App and installer paths, SHA-256, SHA-512, and sizes;
- Runtime, skill, and Python dependency-inventory digests, and signature trust evidence;
- package-check results.

Installer fields under `artifacts` use the file's own extension as the placeholder. Thus,
macOS reads `artifacts.dmg.{path,sha256,sha512,size}`, while Windows reads
`artifacts.exe.*`. Always calculate `sha512`: the update service uses it for ingestion
and the client uses it to verify downloads; without it, the build cannot be distributed.

Windows `artifacts.exe` remains the Setup path, digest, size, and installer-acceptance
evidence. Add
`artifacts.velopack`：`schema: 1`、`tool_version`、`pack_version`、`app_id`、`channel`、
`base_version`, `manifest_path`, `feed_path`, `full_path`, `delta_path`, `setup_path`,
`assets`, `files`, and `signed` to `artifacts.velopack`. No MSI is generated, and no MSI
artifact fields are emitted. `artifacts.runtime` is `{manifest_path, components}`; each
component is `{kind, version, archiveSha256, archiveBytes, path}`, matching the signed
manifest inside the package exactly. `manifest_path` points to the frozen runtime.json;
`path` points to a standalone component ZIP.

Each `assets` entry is `{FileName, Version, Type, Size, SHA256, path}` and includes one
Full and at most one Delta. `files` is the complete, unique, sorted
`{path, size, sha256}` member inventory for the final full nupkg. No application payload
ZIP or application object store is generated; the native launcher handles only the
official hooks, Electron preparation, and startup.

The Windows packaging tool is pinned to vpk **1.2.161**. `--vpk <absolute-executable>` or
`SCHOLARSEED_VPK` can explicitly select the tool and requires a version check. By default,
the build entry point prepares the official vpk, C ABI DLL, and private .NET 8 in advance,
verifying their lengths and SHA256; it does not depend on global PATH, global dotnet, or
`latest` resolution. You may also explicitly pass `vpk.dll`; it is still run by the
prepared private .NET. Optionally provide the previous full package for the same app with
`--velopack-base <previous-full.nupkg>` or `SCHOLARSEED_VELOPACK_BASE`; if none is
provided, only a full package is generated.
The build retains the existing component cache, registry recipe identity, and ZIP
controls. A cache hit still runs this build's verification. Windows standalone component
ZIPs are frozen in the build directory's `runtime-components/` and are not included in
the application pack input. Application resources under `components/` contain only the
signed `runtime.json`; on first launch, missing components are downloaded from the update
service, while existing components are reused by readable version. After preparation,
re-verify the complete file inventory and actual Python/TeX Live/PowerShell probes. The
running interpreter comes from the runtime under the current installation root; do not
migrate or delete old external component directories.

Windows vpk is explicitly passed `--exclude '(?!)' --noDefaultExclude` to disable the
default `.pdb` regex filter and the separate built-in exclusion rules, respectively,
preserving all frozen program members. Component recipes still control which files are
included in standalone components; do not ignore missing files during installer
acceptance to compensate for packaging filters. macOS does not use these parameters.

The product version remains three-part, while the Velopack technical version is
`<version>-build.<YYYYMMDDHHMM>`; do not use `+` metadata, which does not participate in
ordering. Windows ships a Setup EXE with a native directory-selection page; the
unmodified official Velopack Setup inside it still performs per-user installation.
The default directory is `%LOCALAPPDATA%/scholarseed`, resolved by the shell. For a first
install, the user may select a writable local directory; an existing install locks its
original directory after identity verification, and must be uninstalled before changing
locations. Do not pass `--msi` or `--instLocation`; per-machine installation is not yet
supported.
After generating the official Setup, `apps/desktop/scripts/cd/setup.cjs` embeds its exact
bytes, adds the directory budget and Chinese/English resources, then compiles, brands,
and signs the outer Setup. Formal CI signs the inner Setup first and the outer Setup
second; `setup_path` and installer acceptance both refer to the outer one. Silent
`--silent --installto` follows the same directory preflight.
The website continues to use the existing `download-latest/windows/amd64?channel=release`
entry point, and the distributed filename remains
`scholarseed-<version>-windows-amd64.exe`.

Formal Windows signing runs only in CI and requires:

- `--payload-public-keys`: a key ID → raw Ed25519 base64 public-key map, frozen as
  `product.update_package_keys`; it must not reuse online-activation public keys.
- `--payload-key-id`: the embedded public-key ID corresponding to this release signature.
- `--payload-private-key`: Ed25519 PKCS8 PEM, read only by the build-signing step; it
  must not enter subprocess environments, the installer, build context, or result.
- The existing `--activation-public-keys` and Windows Authenticode configuration are
  still required.

The corresponding npm variables remain `SCHOLARSEED_UPDATE_PAYLOAD_PUBLIC_KEYS`,
`SCHOLARSEED_UPDATE_PAYLOAD_KEY_ID`、`SCHOLARSEED_UPDATE_PAYLOAD_PRIVATE_KEY`。
`SCHOLARSEED_UPDATE_PAYLOAD_KEY_ID`, and `SCHOLARSEED_UPDATE_PAYLOAD_PRIVATE_KEY`.
Payload activation keys, launcher/updater capability, and data rollback compatibility
are no longer required. The `velopack.json` envelope is
`{schema:1,key_id,manifest,signature}`; `manifest` is base64 of the exact JSON bytes,
and `signature` is an Ed25519 signature. Dev/candidate builds record an empty signature
and are marked unreleasable. Formal signing, successful install/startup, and real
old-to-new update acceptance are separate evidence.

Do not scan `release/` to guess the latest artifact; read `release-result.json` from the
target directory.

The on-disk main executable and macOS App retain the English brand name `ScholarSeed`.
The Windows installation root is determined by the Velopack app ID and install scope,
without the old hash-store hierarchy. Windows desktop and Start menu shortcuts display
「书深」. macOS retains its English display name and registers 「书深」 as a Chinese search
alias in Bundle metadata. npm/Python package names, commands, protocols, and internal IDs
continue to use lowercase `scholarseed`; the interface display name remains controlled
by `product.json`'s `product_name` and may display 「书深」.

<a id="验证"></a>
## Verification

The electron-builder `afterPack` intermediate check inspects only frozen inputs, file
permissions, digests, native libraries, and the dependency inventory. It does not execute
the packaged Node, Python, or TeX; at this point, the full App has not completed signing
or notarization. The intermediate receipt keeps `imports` empty and does not represent
runtime acceptance. Final `verifyApplication` still runs all runtime probes and the
applicable package-check; Windows retains component-inventory checks and probes after
real preparation.

Formal macOS packages first run seal, stapled-ticket, and `spctl` policy checks, then
wait for the packaged Node's pinned first-execution handshake. A successful `spctl`
check does not mean the kernel's first-execution scan has finished; on macOS 13, the two
check paths may trigger separate assessments. The handshake emits only a ready marker
and does not load drivers or business code. First verify the frozen executable-content
digest, then use a separate 300-second first-readiness budget; after readiness, the
process must exit with code zero within 30 seconds. Failure, missing or extra output, or
timeout blocks acceptance; do not retry to mask the error. Then run the existing 30-
second Node/driver probes and full application self-check. `[mac-execution]` records the
PID, time to first readiness, and exit status; the result is saved in `trust.execution`.
Do not change system policy, clear caches, or force-detach the volume. The macOS ad-hoc
lane runs the same handshake after signing, but this is not evidence of Developer ID or
notarization success. Windows and the explicitly unsigned candidate lane do not run it.

Cold-execution acceptance must save a new filesystem identity and the corresponding
system-scan start/end logs; rerunning the same already-assessed instance does not count
as a cold start. An isolated copy of a CI-signed app can verify the execution-scan path,
but it is not equivalent to download-quarantine/first-install acceptance on a new
machine and does not replace post-merge CI verification of a new artifact.

```bash
npm --prefix apps/desktop exec -- node --test scripts/cd/__tests__/build.test.cjs runtime/codex.test.cjs
pnpm ops ci check types desktop

.venv/bin/python -m apps.serve.tests.contract_desktop_config
.venv/bin/python -m unittest apps.serve.tests.contract_desktop_release
pnpm ops ci format
pnpm ops ci check docs workspace
```

Final Windows acceptance must build the Velopack Setup EXE on a Windows x64 Runner, run
the installer, and launch the installed real app to execute package-check.

<a id="windows-组件缓存与验收续跑"></a>
## Windows Component Cache and Acceptance Reruns

`pnpm ops cd build release --channel preview --component-cache <absolute-directory>`
Explicitly enable the build-side stable Python/TeXLive/PowerShell/Codex ZIP cache
with this command. The cache root belongs to the current CI user and uses a private ACL,
exact inputs, and a recipe key; every cache hit still fully scans the archive and runs
this round's product gates. A corrupt cache fails rather than being treated as a hit;
without the cache option, the full assembly runs each time.
Codex cache keys bind the actual input tree, entry point, archive recipe, target,
and packaging-Python archive digest. A hit skips only compression; it still checks the
complete ZIP inventory and final runtime-version binding. The Python recipe is owned by
`assembly.cjs` for dependency sync, normalization, bytecode and archive steps. Go cache
and temporary directory permissions are managed outside this recipe. Its inputs include the interpreter, exported runtime
requirements, locked source-build dependencies and build constraints, Skill wheels and uv version.
The Windows TeX Live and PowerShell keys include the vendor archive digest and the
archive writer. TeX Live also binds its build-time normalization script and the
installed PE library. Runtime staging options such as window visibility are outside
these keys.
Application version bumps and unrelated development dependencies can reuse both caches.
Each build still runs its tests, signature verification and installer acceptance.
Before publishing under the default private cache version, Windows checks the file tree
and ZIP against the hashes in `versions.json`. If only the ZIP encoding differs, CI
retrieves the reviewed archive and verifies its file inventory before caching it.

Windows Python 使用导出的运行时依赖及源码包构建约束。Go 缓存和临时目录权限独立管理，
无需进入 Python 缓存键。Windows 的 TeX Live 和 PowerShell 缓存键包含上游归档摘要
和归档生成脚本。TeX Live 还校验构建规范化脚本和实际安装的 PE 库。窗口显示等运行时
准备选项不进入这两个缓存键。
只改应用版本或无关开发依赖时，两组均可复用已有缓存，每次构建仍执行测试、验签和安装验收。
写入默认私有缓存版本前，Windows 会核对 `versions.json` 中的文件树和 ZIP 摘要。
如果只有 ZIP 编码不同，CI 会取回该版本已审核的归档，逐文件核对通过后再写入缓存。

On a Windows Python-component cache miss, synchronize dependencies in a private short
directory, then copy them to the final component directory through the Node filesystem
after success. A failed install does not replace the original interpreter tree; clean
the temporary directory after both success and failure. Prefer the short root specified
by `--verification-root`, otherwise use the host temporary root. Keep copy mode and
locked-hash verification enabled; normalization additionally checks that the temporary
install path did not enter component contents. macOS retains its original install path,
but likewise consumes locked build constraints per source package and prohibits implicit
builds.
For verification, use directories at least as deep as those in CI and an independent,
empty Python-component cache; confirm an actual cache miss, dependency installation, and
successful local installer result. A cache hit, installing one package into a short
path, or merely adding an extended-length path prefix does not replace this verification.
Declare macOS/Windows source-build dependencies in root `pyproject.toml` groups named
`component-build-<源码包名>` (where the placeholder is the source package name); the same
`uv.lock` pins versions and hashes.
Mutually exclusive groups allow different source packages to use different builder
versions; do not install them all together with `--all-groups`. The export Owner reads
the runtime source version/hash from the lock and runs
`uv export --locked --only-group` for each group to generate build constraints. There is
no separate source-hash inventory. Pre-installation uses a short-path uv cache isolated
by the complete export recipe; final synchronization prohibits implicit source builds.
Declare a build group and update the lock when adding a source dependency; fail if there
is no runtime source, an sdist is missing, or the dependency was not prebuilt. A
runtime-dependency lock does not automatically constrain an isolated build environment,
so packaging must explicitly pass the exported build constraints. After changing a
build group or lock, recheck the final ZIP; installation success alone is insufficient.
Do not hide a problem exposed by cache invalidation by deleting recipe inputs. The
archive writer preserves extended paths for inputs and outputs on Windows, while ZIP
member names remain relative paths; long-path acceptance must cover both installation
and the final archive.

This example uses the registered direct preview build; both preview and release can
explicitly select the distribution recipe with the fixed smoke check. The recipe is
wired up in this repository, but this does not mean calls from the external repository
have been migrated. For unresolved cross-repository call and rerun interfaces, see
Cross-Repository Build and Release (non-public execution/provenance record omitted).

Velopack build acceptance installs Setup in an isolated directory, runs a real package-check
on both first launch and reopen, then uninstalls through Update.exe and confirms that
`current` has been deleted. An existing HKCU installation of the same product blocks
isolated acceptance; do not overwrite a developer's installation. Windows acceptance
uses a machine-level mutex and does not terminate other tasks by process name. Write
`status: passed` only when this run's complete installation, network preparation, startup,
exit, and cleanup all pass.

Deploy the update service's exact component-download route before running Windows CI
acceptance that depends on it. Formal Windows CI publishes immutable components before
app acceptance. The distribution repository injects
`SCHOLARSEED_RUNTIME_PUBLISH_COMMAND` (a JSON argument array), and the builder appends
`--manifest <冻结 runtime.json> --directory <runtime-components>` (the frozen runtime manifest
and runtime-components directory). Only formal signed
CI calls this command. If it is missing or publishing fails, stop; do not put components
pending publication back into the app package. When distributing the app version last,
check again that all standalone component objects are available before writing the
version-release marker. Uploading components first does not mean the app version has
been released.

Local dev/candidate builds do not call the component-publishing command. Windows
`product.json` and the helper both freeze the same runtime-manifest digest; the local
lane's initial preparation accepts only this exact unsigned manifest. Formal packages
and app updates always require signatures; do not add an environment switch. Real
startup obtains existing exact components through the normal update service.
Unpublished components, a missing service route, or unavailable network access blocks
installer verification. Do not fake a successful install by copying local components
into the acceptance runtime or adding a test-only fallback. Network access on first
install is a product contract; the EXE no longer supports a standalone offline install.
The bundled runtimes and acceptance process on macOS remain unchanged.

The old NSIS acceptance-rerun implementation has been removed; Velopack does not consume
old checkpoints. Root `package:verify` retains only the external protocol and explicit
failure diagnostics; it does not restore rerun capability. On a failure, retain the logs
and rerun the full build. Before a formal release, real-machine acceptance must still
cover per-user install updates, delta, full fallback, different builds of the same
version, runtime exit and full update, and signing/path rejection.

<a id="ci-阶段耗时与缓存"></a>
### CI Stage Timing and Caches

Packaging logs record stage start, end, status, and monotonic-clock seconds in `[stage]`
JSON lines; do not add nested-stage times together. Stages cover npm installation,
backend assembly, skill gates, component packaging, native modules, frontend, Velopack
full/delta, remote signing, installer creation, silent install, first launch/reopen,
uninstall, and cleanup. Logs do not record command arguments or environment values.

Windows toolchain extraction and product-wheel caches are under
`SCHOLARSEED_BUILD_CACHE_ROOT/build/`; if that root is unset, use the sibling `build/`
directory next to the artifact cache. Reuse extracted Go SDK, LLVM, Node headers,
Velopack, and private .NET according to audited archive digests, while still checking the
original archives and complete cache-file inventory on every run. Go shares only a
`GOCACHE` isolated by SDK digest; rerun `go vet`, `go test -count=1`, helper/launcher
compilation, policy checks, and signing every time.
Product wheels are keyed by project source/data, uv.lock, Python archive and pip versions,
build recipe, the `wheel-build` tool environment exported from the pinned `uv.lock`, and a
fixed ZIP timestamp. On both platforms, create the build environment in a private short
directory, synchronize all tools with hashes, then use `pip wheel --no-build-isolation`;
do not fetch missing build dependencies from the network. Clean the build environment
after both success and failure. Build the first wheel using the existing wheel.py; for
later runs, verify the complete cache inventory before copying. Install backend tools
from digest-pinned wheels; isolated builds must not resolve the latest online versions
again. macOS tool extraction keeps its original paths; product wheels and source
dependencies use the unified pinned entry point above.
Private uv caches for source dependencies are also keyed by the pinned sdist/build
dependencies, target interpreter version/ABI/architecture/GIL mode, uv version, assembly
recipe, and declared compiler/SDK/deployment-target environment digest. Do not begin
installation if a probe fails. Changing these inputs creates a new cache without deleting
the old one; environment digests do not record raw values or unrelated credentials.
These cache keys do not prove that compiler binaries were not modified in place or that a
wheel or embedded native file meets the minimum OS version. Independently verify the
final native payload, platform minimum, and real installer acceptance.

Python candidates use `scripts/shared/platform.cjs` to pin both the macOS deployment
minimum and explicit uv `--python-platform`; development and product assembly share this
rule rather than relying on uv to read environment variables implicitly. The FastCDC Mac
source target is registered in `source-build-repairs`: build a hash-pinned sdist with a
pinned builder, then use pinned delocate to check the actual architecture, dependencies,
and minimum OS and produce a wheel matching the payload. Fail if the minimum exceeds
13.0; renaming the tag alone is insufficient. Cache repairs in a private tree with a
complete inventory and install through a hashed wheelhouse; do not create direct-URL
metadata or overwrite the original source cache.

macOS browser drivers use the official Node 22.23.4 archive and license pinned in
`apps/desktop/scripts/cd/browser.json`. Verify the archive size/SHA-256, actual
architecture/version, each driver's engines, and real protocol initialization. This is
the in-app browser Node and does not change development Node 24.16.0 or Electron. Node 24
bundled with the original drivers actually requires macOS 13.5 and is no longer the
product's shared Node; delete only the verified staging copy. Assembly and final-artifact
checks scan actual Mach-O minimums, including embedded payloads in packages labeled as
pure Python; wheel tags do not replace this check. Without a real-machine result on
macOS 13, a static minimum-version pass cannot be called a verified minimum-system pass.

The macOS Codex packaging copy excludes the not-yet-integrated
`codex-resources/voice/` component without changing the official archive, cache, or binary
minimum versions. The bundled receipt records provenance and the exclusion list; Windows
retains the full payload. Full native minimum-version checks still apply to the bundled
contents.

The macOS Codex staging copy excludes the unused `codex-resources/voice/` component
without changing the upstream archive, cache, or binary minimum versions. The staged
receipt records provenance and exclusions; Windows retains the complete payload.
Full native minimum-version checks still cover the staged payload.

Windows checks owners, DACLs, and replacement permissions on every ancestor of private
build state using `Get-Acl`, `ConvertFrom-SddlString`, and the current user's SID; this
works with constrained PowerShell and does not require or switch to FullLanguage. Reject
missing DACLs, unrecognized ACEs, or external write/replacement permissions. If an
ancestor is unsafe, use a qualifying isolated root; do not continue the build by skipping
checks or changing shared-disk permissions.

Parse each component ZIP's member inventory in full once per run; reuse that inventory
only within the process, then check the archive SHA-256/length again after copying it to
the final directory. Keep the persistent component receipt format unchanged, as well as
remote component checks, signed manifests, and independent verification after actual
installation. `toolchains.cache-*`, `wheels.cache-*`, `wheel.*`, `handoff.*`,
`launcher.compile`, `native.compile`, `components.inventory`, and
`components.tree-inventory` distinguish cache-hit checks, first builds, tests, and scan
costs; do not add them again to parent-stage totals.

Root postinstall, the Desktop entry point, and the packager share an install marker made
from the lockfile digest and Node/package-manager versions to avoid reinstalling during
the same invocation. Reinstall if the lockfile or build tools are missing.
The default pnpm store is under `pnpm-store/` at the build-cache root; the metadata
cache is alongside the state directory. pnpm recognizes only `pnpm_config_*` environment
variables; `npm_config_store_dir` has no effect. When the store and checkout are on
different volumes, installation falls back to copying and emits a warning. The npm
fallback still uses an installed-dependency snapshot under `npm-installed/`; use
`SCHOLARSEED_NPM_INSTALLED_CACHE` to specify a private directory. Its input key includes
lock, install-script and configuration digests, Node/npm/ABI/platform; local file/link
dependencies and external Electron dist do not use the snapshot. A hit restores a
separate `node_modules`, checks its complete inventory, and runs npm graph/Electron/esbuild
probes. On failure, run a full `npm ci`. Do not share hard links or cache product builds
and acceptance results.
`npm.cache-*` records cache-restore/inventory/probe/publication costs. `[native-stage]`
is an internal phase log from native stderr; it is stored in the package-check log and
also printed to CI stdout after acceptance. The `check` field distinguishes unpacked,
installed-velopack-first, and installed-velopack-reopen. Output only stage/event/status/
seconds timing fields, not other subprocess diagnostics; do not add these values to
outer-stage totals again.

For native compilation and self-check commands, failures retain the original exception
in `apps/desktop/scripts/native.cjs` and append `[native-command]` to the error message:
the executable, arguments, exit code, signal, system error code, followed by fully
captured stdout/stderr. Successful commands do not echo extra output; environment
variables are not written to diagnostics. Retain each command's existing 4 MiB output
capture limit. When the limit is reached, explicitly set `outputMayBeTruncated`; do not
claim truncated output is complete. This diagnostic does not change failure codes,
timeouts, self-checks, or signing gates.

The extracted Codex runtime is under `SCHOLARSEED_BUILD_CACHE_ROOT/codex-runtime/`;
`SCHOLARSEED_CODEX_RUNTIME_CACHE` can specify a private directory. If neither is set,
retain the Desktop development cache path at `node_modules/.cache/scholarseed/codex`.
The cache is keyed by version, platform, and audited archive SHA-256, independently of
the npm installation snapshot. On a hit, verify the path, file digests, and actual
`codex --version`; if damaged, rebuild from the audited archive. After file verification
and the version probe, atomically publish the complete runtime with its receipt to avoid
re-extracting it on the next clean checkout.

macOS distribution CI can provide a shared cache for the complete OpenAI-signed
runtime. A clean runner verifies the downloaded receipt against the platform's
`receiptSha256`, checks every file, then runs the version probe at its final path.
A shared miss publishes the verified upstream runtime. A local entry from an
earlier build can seed the same shared cache, including after an interrupted
upload. Subsequent local hits skip OSS. The Desktop packaging step still applies
the macOS voice exclusion to its staging copy.

macOS 正式构建可通过共享缓存复用保留 OpenAI 原签名的完整运行时。新构建机先核对该架构的
`receiptSha256` 和所有文件摘要，再在最终路径探测版本。共享缓存缺失时，
CI 会上传已校验的运行时。本机已有缓存也可用于首次补传或失败重试。
确认上传后，同一构建机可直接复用。Desktop 仍在打包副本中排除 voice 文件。

Windows Velopack acceptance does not start Go sessions or retirement for the old
store/launcher. Clean only the installation directory and isolated HOME owned by this
acceptance run; if uninstall fails, preserve the state and fail acceptance.

<a id="启动诊断与存储维护资格"></a>
## Startup Diagnostics and Storage-Maintenance Eligibility

Desktop continues to stream captured backend startup output to console/IPC in real time.
File writes to `backend.log` are buffered until the backend health check passes, avoiding
conflicts between the log writer's HOME-ancestor eligibility and the exclusive
maintenance eligibility used for first-time initialization. After the health check
passes, replay the buffered lines in batches using their original timestamps. If startup
fails, wait for the child process's output pipes to close, replay the lines, and wait for
log compaction to finish; normal-exit evidence remains bound to bytes newly written in
this run. The buffer retains at most the current log-file size limit (50 MiB by default)
and 4096 chunks. If exceeded, replay an explicit capacity diagnostic while retaining
console/IPC output. Do not skip the cache, eligibility lock, or installer acceptance.

### Windows Uninstall Entry

The reviewed Go compilation session on Windows also builds `Uninstall.exe`. Brand its PE,
sign it with CI Authenticode, freeze its digest, and read it back after packaging along
with the launcher. Velopack install/update hooks publish it to the installation root.
Installer acceptance checks that the root entry matches the frozen bytes, then uses it
for silent uninstall and waits for the entire installation directory to be deleted.
Update-package caches are consolidated under `packages` in the installation root. See
the [Windows update Owner](../../apps/desktop/updater/README.md#windows-velopack) for
handoff helpers outside the installation root and historical cache-cleanup boundaries.
macOS does not generate this entry. The merged CI must still verify the formally signed
package and complete install/update/uninstall results.


<a id="安装失败诊断与留存"></a>
### Installer Failure Diagnostics and Retention

Windows Velopack installer acceptance explicitly passes a separate `--log` path; use a
different filename for every call to prevent an acceptance rerun from overwriting or
misreading the previous native log. Keep the uninstall entry's existing arguments; do
not append installer arguments to the uninstall wrapper, which supports only `--silent`.

Before returning failure, `installation.cjs` records the exit code, signal, startup error,
stdout/stderr, and native log. Missing native logs (for example, when a wrapper rejects
before starting the engine) and read failures have separate error fields. Read at most
the last 4 MiB and record the original size and truncation flag. On failure,
`[installer-diagnostic]` writes a redacted tail of at most 16 KiB from each output stream
to CI stdout and records its source and truncation status. JSON-escape control characters;
do not print argv or the environment. On success, do not echo ordinary output.
Redaction covers sensitive environment values, common credential fields, HTTP
authentication, and URL query parameters, but full local evidence remains private
diagnostic material.

Failure-evidence JSON is also copied to
`SCHOLARSEED_INSTALLER_DIAGNOSTICS_ROOT/failure-<随机值>/` (using a random value).
If this variable is unset while `SCHOLARSEED_BUILD_CACHE_ROOT` is set, use the sibling
`installer-diagnostics/` directory next to the cache, not a directory inside the cache
tree. The current Windows distribution CI sets a persistent cache root, so checkout
cleanup does not remove this retained evidence. If neither variable is set, retain only
the build-directory evidence and CI stdout, and explicitly print
`retention-unconfigured`. A custom persistent root must be an absolute path controlled
by the current build user and must not point into a temporary checkout. Logs print the
exact retention path; create a separate directory for each failure. On Windows, the leaf
directory uses a private ACL; on macOS, directories/files use 0700/0600 permissions.

The retained JSON contains all captured stdout/stderr, the bounded native log described
above, the original build-log path, and timestamps. Write it before cleaning the
installer-acceptance temp directory. Report archive or primary-log write failures
separately; they must not replace the original installer failure or turn failure into a
pass. This directory does not automatically delete other task evidence: after
investigation, clean up the exact directory from the CI log. Retain CI stdout according
to the platform's retention policy.

Focused verification: `node --test apps/desktop/scripts/cd/__tests__/installation.test.cjs`.
The real subprocess contract covers exit, timeout, log retention, redaction, truncation,
and archive failure; this does not replace Windows signed-installer/product acceptance.


<a id="windows-安装验收注册表预检查"></a>
### Windows Installer-Acceptance Registry Preflight

Within the machine-level verification lock, installer acceptance runs
`verification.installation-preflight` before creating a temporary install directory or
running Setup. It queries 32/64-bit views of HKCU/HKLM and checks current Velopack
uninstall entries and historical NSIS GUID install/uninstall entries. It is read-only by
default; any entry blocks isolated installation. Access failures and invalid query
results also fail.

Windows signed distribution skips existing artifacts and claims before running
`npm run package:preflight`. This command precedes any new claim, takes the same
verification lock, and requires neither Desktop
dependencies nor signing inputs. The check before Setup still runs under its own lock.

CI may explicitly set `SCHOLARSEED_CI_REGISTRATION_ROOT` to allow automatic cleanup of
complete historical NSIS registration pairs left by acceptance installs beneath that
root, at `apps/desktop/release/{dev,preview,release}-win32-x86_64/native-install/app`.
Cleanup runs only when the directory no longer exists, uninstall command and install
scope match exactly, no related process or subkey exists, and no ancestor path contains a
reparse point. Before deletion, reread and verify all registration values; after
non-recursive deletion, read them back. Any failure blocks installation immediately. An
empty setting disables automatic cleanup. Drive roots, UNC paths, relative paths, and
inaccessible directories are not accepted. The distribution repository is responsible
for providing a private CI root.

Signed distribution CI sets `SCHOLARSEED_CI_VELOPACK_ROOT` to the same private root as
`--verification-root`. Before launching Setup, acceptance records its exact temporary
sandbox and version in the ACL-protected `.installer-registration/<appId>.json` in that
root. It removes the receipt after successful uninstall and a clean registry readback.
On a later preflight, only an HKCU registration whose install location, uninstall
command, and display version match the receipt is eligible. The install directory must
be absent, its ancestors must be non-redirected, and no process may run from it.
The script compares the complete entry again before non-recursive deletion and verifies
the deletion afterward. An existing installation or a registration without a matching
receipt blocks the build. The preflight never invokes the uninstaller or deletes app files.
`[installer-preflight]` reports the cleanup status and hive/view/kind.
For a matching receipt whose install directory or process remains, it also reports
the exact sandbox path and why remediation was blocked. Have the runner owner
inspect that sandbox and retire the CI installation under the original account
before retrying.

Windows 正式签名包先跳过已有产物或占位的任务，其余任务在申请新占位前执行
`npm run package:preflight`，并在运行 Setup
前持安装验收锁复查。只有显式配置 `SCHOLARSEED_CI_VELOPACK_ROOT` 的 CI 才会在
私有验收根下写入 `.installer-registration/<appId>.json`。正常卸载且注册表回读干净后
删除凭据。异常中断时，下次预检只清理安装路径、卸载命令及版本均与凭据匹配，
且安装目录和相关进程均已消失的 HKCU 登记。普通安装、来源不明的登记和旧版 CI
留下的无凭据登记继续触发阻断。预检不会启动卸载程序或删除应用文件。
凭据匹配但目录或进程尚在时会报告对应沙箱路径与阻断原因，由 Runner 管理者核查后
以原构建账号处理该 CI 安装，再重试。

Focused check: `node --test apps/desktop/scripts/cd/__tests__/registration.test.cjs`, also
registered in the build-contract aggregate entry point. Native Windows integration tests
use a random test registry namespace and cover automatic cleanup, idempotency, and
protection boundaries; passing tests or preflight does not replace full signed-installer
acceptance.
