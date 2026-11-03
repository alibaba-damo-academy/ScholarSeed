# Windows updates

## Sandbox private ownership

The installed helper has a separate `--sandbox-home` entry, not an extension of
the update or `group` request. It accepts only reviewed 0.163.0 or 0.165.0 execution whose
path and entry hash match this build's authenticated runtime manifest. The
component's upstream version must match the requested execution version exactly;
a reviewed component for the other version cannot substitute for it. The
original coordinator token supplies the profile and owner SID, including when
the application was started with an elevated token or by the built-in
Administrator. It is never replaced with a linked token or the worker identity;
system UAC settings and the login user remain unchanged. Only its default
`.scholarseed/codex/.sandbox-secrets` directory is supported; custom homes are
reported as unsupported without redirecting to that default.

The coordinator pins local ancestors and the target without deletion sharing,
rejects reparse points, and inspects the target before applying recovery-only ACL
qualification. An existing original-user owner with actual WRITE_DAC returns
`unchanged` without auditing ancestor principals or modifying security. Other
non-Administrators maintenance states return `unsupported` to the existing native
sandbox startup, not a claim of healthy isolation. Tests exercise actual access
under the caller token (including backup/restore privileges), and retain the
access-denied case with a privilege-disabled test-thread token. Metadata/I/O, installation and
path failures remain errors. A missing leaf is created only under the original
token with the existing explicit private descriptor and must pass its own owner,
descriptor and WRITE_DAC checks. Confirmed Administrators ownership alone enters
the reviewed ACL and owner-recovery path. Existing reviewed
Administrators ownership is repaired by changing only Owner, never DACL. A
temporary user FullControl ACE cannot substitute for persistent ownership.
Current-user recovery is attempted first; access-denied or missing-privilege
results can launch the same installed helper through UAC, including from an
already elevated coordinator when owner restoration still needs its dedicated
worker privilege. The worker derives the original identity from a live, pinned
same-file coordinator and independently validates the directory snapshot. It never
launches the application. The coordinator waits for the worker, verifies the owner-only security postcondition
and checks WRITE_DAC using the original token before reporting recovery.

Both the writer and coordinator require unchanged directory identity and security
control. DACL bytes must remain identical except for Windows' native OWNER RIGHTS
normalization during Administrators-to-original-user ownership transfer: an allow
ACE for the exact OWNER RIGHTS SID with FullControl may change OI|CI to IO,
preserving its inherited marker (0x03→0x08 or 0x13→0x18). Every other byte, including
ACE order, masks, SIDs and the native sandbox deny, remains exact. This compares
the postcondition; it never writes or restores the DACL. The pre-write fingerprint
comparison remains byte-exact. macOS has no change to its recovery behavior.

Only enabled non-deny-only token logon SIDs may retain read/execute access;
OWNER RIGHTS FullControl is interpreted only after validating its actual owner.
Unknown recovery policies are refused rather than normalized. These qualifications
apply to an actual ownership repair, not to unrelated normal-startup ACLs. Native
readiness/setup and the real execution gate remain mandatory after every outcome;
an `unsupported` outcome never disables or weakens the sandbox. Workers cannot take
the coordinator's unchanged/unsupported shortcuts, and confirmed repair failures
are never delegated. Windows installation, UAC
consent/cancellation, full native setup and conversation recovery require real
Windows acceptance; cross-compilation and deterministic tests do not prove them.

The 0.165.0 admission follows the bounded upstream source comparison recorded in
the [Codex Adapter compatibility notes](../../../packages/adapters/codex/README.md#windows-01650-沙箱适配).
Windows acceptance for this version remains pending; no ACL, UAC or directory
qualification policy is relaxed by the additional exact version.

Recovery ancestor qualification additionally accepts allow ACEs limited to FILE_TRAVERSE
and SYNCHRONIZE, applying only to that directory (an inherited marker is allowed,
but propagation flags are not). This is a rights-based exception, not trust in a
capability SID prefix. It does not allow listing, reading file contents, writing,
changing security, or passing the exception into the secrets policy. The actual
machine-local sandbox alias may retain at most RX on an ancestor, including child
inheritance; this does not trust arbitrary group names, other readers or mutation
permissions. On the repair target, only that same group's inherited RX may be
accepted when preceded by the exact effective, explicit OI|CI native deny. The deny
must cover the allowed mask and cannot be inherit-only, inherited or propagation-
limited. Other untrusted allow entries remain refused. No existing ancestor or
target DACL is rewritten, and the helper does not inspect credential contents or
certify an entire secrets tree's access policy.

Sandbox failures return only bounded `event=failed`, `stage`, `reason`, and an
optional numeric `system_error`; they never return the underlying exception text.
Stages distinguish installation/runtime qualification, each private ancestor,
target validation, ownership, elevation, worker privileges, and final verification.
UAC cancellation is reported only from the actual cancellation result, separately
from access denial or another launch failure. Elevated workers convey their fixed
stage/reason through reserved nonzero process exit codes; their numeric system
error is unavailable to the coordinator and is omitted, not guessed. Unknown
worker exit codes remain failures. None of this changes update handoff operations.

## Fixed tool admission

The `group` handoff operation only ensures the fixed machine-local
`CodexSandboxUsers` alias. Only an unmapped account can request UAC; existing
aliases are strictly resolved without changing members, comments or ACLs.
Official sandbox readiness still owns accounts, memberships and passwords.
The request accepts no executable, group name or user data directory.

Python, TeX and PowerShell use reviewed r2 component identities. An empty,
pinned extraction stage receives precise inheritable sandbox RX before any
archive member is created. Published receipts bind the access policy, actual
machine SID and native directory identity. A receipt is a trusted publication
record, not proof against arbitrary later modifications by its trusted owner.
Existing r1 directories are neither relabelled nor repaired during a conversation.

Electron, launchers and product libraries are admitted only during application
installation preparation or after official update commit. Their fixed roots
undergo two-phase no-delete pinned preflight and explicit, non-inheriting RX
grants. A bounded application receipt binds the pack version, SID and native
root identities. Invalid receipts fail closed and require installation repair;
normal reuse does not traverse tool trees. Serve receives the prepared SID,
independently checks the actual local alias and only prepares dynamic directory
metadata before a conversation. It never scans fixed tools, including on its
first turn or after a backend restart.

Reinstallation explicitly retires only the installed pack version's application
admission before privatizing `current`. It validates the existing receipt's
owner, actual SID and version and deletes the pinned record, not any component
receipt. This prevents a same-version reinstall from retaining stale application
admission after replacing roots or resetting application ACLs. Invalid records
are not silently discarded. The next installation preparation re-admits the
application tools; conversations still never perform that work.

Required acceptance includes a real first installation, application update,
reinstallation, UAC cancellation and restricted tool execution. Permission
metrics must distinguish extraction-time inheritance from application admission;
fixture tests alone do not establish the five-second installation permission
budget or the one-second local conversation preparation budget. macOS does not
enable this Windows DACL protocol and still requires its own runtime regression.

## Windows data access at startup

Product data and execution trees have different roles. Windows PRIVATE product
records (userData, home, coordination, sessions and logs) use the calling token's
actual open/read/create/write/lock rights. Startup does not reject an otherwise
accessible user profile merely because its owner or inherited ACE grants another
SID access. Existing ACLs are never repaired; newly created data retains explicit
private descriptors. PRIVATE names the product record/concurrency role, not a
claim of cross-account integrity: OS-authorized writers can modify these records.

Directory identity, local-volume qualification, no-follow/type/hardlink checks,
cooperative locks and uncertain-release failures remain mandatory. Actual Access
Denied still fails. Installation pins retain their INSTALLATION role through
children and records: accepted external ancestor risks do not waive the private
execution-root or runtime checks. Python installation seed bindings retain the
same distinction. Sandbox, elevated cleanup and macOS policies are unchanged.

This aligns ordinary data access during startup with Setup's data-location
boundary. It does not guarantee startup after an ACL/path change or unrelated IO
failure, and it is not signed installation/update acceptance. This change's
requested verification is lightweight native/contracts only, without packaging.

## Windows Velopack

**required — final installed acceptance before production cutover.** The user has
authorized a bounded elevation handoff and reusable runtime archives with official
Velopack 1.2.161. In this upstream version, Windows apply
extracts into `PackagesDir/VelopackTemp` and renames the tree into `current`
without restoring the installation's ACL inheritance. An unwritable installation
root causes the official locator to fall back to a user cache before elevation;
the elevated updater retains that cache location. Passing `root/packages` alone
therefore does not fix ordinary-user global updates. See the fixed upstream
[locator](https://github.com/velopack/velopack/blob/1.2.161/src/lib-rust/src/locator.rs)
and [apply implementation](https://github.com/velopack/velopack/blob/1.2.161/src/bins/src/commands/apply_windows_impl.rs).
Actual machine testing confirmed cache ACLs persisted in the updated installation.
An Administrator startup does not establish access for other users. The handoff
must elevate before constructing the apply locator and use `<root>/packages` for
staging, then restore the initiating user's application from its unelevated
coordinator. Do not patch upstream or broaden cache-directory permissions. Real
ordinary-user update, restart, runtime access and ACL checks remain required.

Windows packaging explicitly uses `--exclude '(?!)' --noDefaultExclude` to
preserve the complete frozen application inventory. Independent component archives
are validated by their own signed inventories and never enter the vpk pack input. The first option overrides vpk's
default `.pdb` filter; the second disables its separate built-in exclusions.
Component recipes and inventory verification retain ownership of package contents.
The flattened-runtime configuration passed a real Windows full build and personal
installation: all 40 Python `.pdb` files matched staged, nupkg and installed hashes.
The archive-based runtime layout has also passed the real Windows full build,
personal installation, first preparation, unchanged-file reuse and whole-root
uninstall at source `92be6b089`. This is local unsigned installation evidence;
it does not establish signed-update acceptance. Do not weaken inventory verification
or treat generated installers alone as proof.

Windows now builds and runs through Velopack 1.2.161. The active owners are
[`velopack.ts`](../src/main/velopack.ts), [`nupkg.ts`](../src/main/nupkg.ts),
[`family.ts`](../src/main/family.ts) and [`velopack.cjs`](../scripts/cd/velopack.cjs).
The active Go targets are `cmd/handoff` and the thin `cmd/launcher`, sharing the
independent `handoff` package and Go standard library. Both compile in one reviewed
SDK session. The historical Go updater packages remain removed. The old
Current/Previous store, launcher permits, health commit and worker/wrapper handoff
have been removed.
This change follows the explicitly approved Windows replacement scope; it does
not change macOS Squirrel.Mac behavior or user data/cache locations.

The official SDK applies authenticated full packages or deltas against a verified
base. An unavailable or invalid base/delta falls back to the full package. A signed
member inventory verifies reconstructed ZIP contents independently of compression.
SDK installation/cache and nested component paths retain the conservative MAX_PATH
budget, including Python, TeX Live, PowerShell, Codex, Office and Electron destinations.
All candidate paths are checked before stopping the application.

Personal installations keep SDK packages in `<installation>/packages`. Each
installation has its own package cache and SDK lock; uninstall removes these
files with the installation. The updater copy used for delta preparation also
lives there. Installed paths remain explicit `RootAppDir` paths; no per-user
package cache or fallback to it is introduced when the root is unwritable.

The original-user handoff coordinator still runs outside the installation in
`%LOCALAPPDATA%/ScholarSeedUpdates`: official apply terminates processes inside
the entire installation root. This directory holds the short-lived coordinator
and request files, not new update packages. The before-uninstall hook attempts
bounded cleanup of recognized legacy package/coordinator files. It opens all
files exclusively before deletion, rejects reparse points/hardlinks, and retains
busy or unknown contents with a lifecycle diagnostic. It never removes user
profiles, project data or another installation's runtime directories.

The Windows after-update hook resets this installation's disposable
`runtime/cache/texlive` tree on every successful application replacement, before
application restart. It derives the root from its own installed `current` and
`sq.version`; no environment path, hash, version or cache-content classification
is used. The next ordinary startup recreates the version cache and its identity
through the existing TeX initializer. Toolchain binaries, downloaded archives,
user profiles and session caches are outside this operation. First installation,
ordinary startup, component preparation and macOS Squirrel do not run this reset.

The hook reserves the cache root with a no-follow, no-sharing DELETE handle and
retires it to the fixed sibling `texlive.retired` before inspecting children.
All members must pass exclusive-handle preflight before any unlink; reparse
points, hardlinks, readonly or occupied entries fail safely. Deletion uses those
same handles in postorder, with a 4096-member, 64-level and ten-second cooperative
budget. In-flight filesystem calls are not forcibly interrupted. A failed
preflight deletes no contents; retirement may already have moved the tree.
Interrupted deletion leaves only the retired namespace, so ordinary startup can
create a fresh active cache. The next update retries that retired tree first;
if it remains blocked, the active tree is retained. Errors and removed-file
timing are reported by the lifecycle hook without failing application update.
Native tests cover these filesystem rules; they do not establish signed installed
upgrade acceptance.

The Windows before-uninstall hook also clears this installation's `runtime`
before handing the remaining root deletion back to Velopack. It derives the root
from its own installed `current` directory and verifies `sq.version`; no external
runtime path or environment override is accepted. Cleanup uses at most four concurrent workers globally (the caller plus
three additional workers), enumerates directories in batches and opens regular files for metadata
and deletion only (no file-data read access). Ancestors remain pinned against
rename; deletion and readonly-attribute repair use inspected handles. Reparse
points and hardlinks are refused, and all workers join before return.
A 45-second cooperative cancellation budget reserves time under the SDK's
60-second hook timeout; an in-flight Windows filesystem call is not forcibly
interrupted, so this is not a hard wall-clock bound. Errors are reported through the lifecycle diagnostic; the official SDK
retains ownership of subsequent uninstall behavior. Component timing records
report removed file count and elapsed time. This does not change macOS cleanup
or establish signed-package uninstall acceptance.

**Local debug arguments on restart.**

The native coordinator and worker validate the same bounded restart argv before
accepting a request. They accept a single nonempty `--user-data-dir=...` and an
optional pair of `--remote-debugging-address=127.0.0.1` and a decimal
`--remote-debugging-port=0..65535`. Desktop's `debuglaunch.ts` normalizes explicitly
requested localhost/IPv6-loopback debugging to this IPv4-loopback pair. Missing
debug arguments do not enable debugging. Unknown or duplicate switches, unpaired
address/port, non-loopback addresses, NUL bytes and oversized arguments fail closed.
The coordinator passes validated argv directly to the restarted application without
a shell; package trust, authorization and process-exit barriers remain required.

Go contracts invoke the actual TypeScript producer and Windows tests verify native
restart argument round-tripping. These do not prove a signed installed upgrade or
post-update CDP connectivity. That acceptance requires the source installation to
already contain the corrected helper; a new candidate cannot repair the running
old helper's preflight. macOS retains its existing one-use relaunch context.

Windows builds also compile `Uninstall.exe` with the same reviewed Go session,
brand and sign it in CI before freezing its digest. It has no Electron, Python or
network dependency. Install/update fast hooks publish those exact bytes at the
installation root. Both that entry and `current/Uninstall.exe` launch the adjacent
installation's `Update.exe --uninstall` and immediately exit. Only `--silent` is
forwarded; GUI startup failures have English/Chinese messages. Control Panel
continues using the official updater and runs the same cleanup hook.

Required acceptance: verify the root entry digest/signature after installation
and update, exercise GUI/cancel and silent removal, and confirm removal of the
root/runtime/packages. The build installer check uses the new entry and waits
for actual retirement, not just its early process exit. Local native tests do
not establish full signed installer/update acceptance. macOS retains its existing
Squirrel.Mac packaging and has no Uninstall.exe or Windows cache cleanup.

The updater is copied from the installed application. Delta paths are checked
against its actual OS-temp patch location, and full application paths against
the install-root staging directory. Nested component paths are checked separately
before runtime shutdown. Both retain the 259-character compatibility limit.
Replacement staging and `current` are on the installation volume; download cache
files may reside on a different volume because they are only read during apply.

Windows runtime binaries live in `<root>/runtime/<kind>/<component-version>`.
Only the authenticated manifest travels inside `current/resources/components`.
The native launcher prepares only Electron through the shared authenticated
Bootstrap API before loading `current/resources/app.asar`. Missing engine downloads
have native progress, cancellation and retry; existing noninteractive CLI entries
report failures with a nonzero exit. The fixed engine bootstrap preserves program
identity, while `process.execPath` continues to identify the real engine for shared
Node. Application resource and protocol/update launcher paths come from the program
resolver, not engine resources. The remaining components download through the
existing Electron preparation UI before backend startup; updates prepare all target
components before shutdown. Both use the configured update service and
`/api/v1/updates/components/<target>/<kind>/<version>/<archiveSha256>`.
Archives are staged in `<root>/runtime/.archives/<kind>-<version>.zip`; unchanged
versions reuse their expanded files without downloading or expanding again. A full
Velopack fallback downloads program bytes only. First installation requires network
access; no previous Velopack release compatibility is implemented.
Existing external runtime directories are neither migrated nor deleted. A Windows
Job tracks the owned backend family, attached before product entry through a private
stdin startup barrier. Update handoff requires clean backend and family exit.
Preparation or pre-handoff failures resume/restart the current runtime; no health
failure rollback, persistent recovery guard or old updater-directory migration is
implemented. Only the official per-user Setup EXE is built and distributed;
machine-wide installation and MSI distribution are not supported. The bounded
helper still prepares missing components and preserves the existing permission checks.
Actual permission/restart and
signed-update acceptance must be reported independently of contract tests.

Component build recipes, immutable CI registry and normalized ZIPs are reused.
These controls remain build-time owners. Component versions are readable upstream
versions plus reviewed recipe/dependency revisions, bound to content and archive
digests. Application version/build does not rename unchanged runtime directories.
Delivery `contentId` is the measured normalized tree digest; the existing CI recipe
identity remains build evidence and cache authority. Adding a recipe must not force
an unchanged runtime tree to expand again merely because a shared script changed.
Electron authenticates the frozen dependency manifest before downloading components.
The helper rechecks the signed manifest, complete archive/member inventory and destination paths before
atomic publication. Installation/update/repair reuse verifies the critical entry's full
content hash. Ordinary startup instead uses published readiness: completion receipt,
manifest identity, actual permission-directory identity, and a pinned regular critical
entry of the expected size. It reads no critical-entry payload bytes and does not
claim to detect same-size modification by the trusted owner or arbitrary disk corruption.

Desktop first sends one read-only `inspect` request. A ready result includes the
validated local sandbox SID and skips component delivery, group preparation and the
preparation helper. Inspection never launches a worker, provisions a group or changes
ACLs. Missing component publication or application admission returns not-ready and
enters the existing preparation flow; invalid existing receipts/identities/entries fail
explicitly. Missing admission means preparation is pending, not proof of first install.
The native launcher uses the same readiness boundary for an existing Electron component,
while retaining installation identity, signed frozen manifest, lock and cancellation checks.
Helper executable trust remains separate: all pinned executables still undergo exact
publisher and Authenticode verification through native Windows trust APIs, with
each input held by a no-follow, single-link, read-only pinned handle throughout
validation. No PowerShell process or trust-result cache is used by the Go handoff.
System-directory DLLs provide catalog verification (SHA-256, then SHA-1) and embedded
WinVerifyTrust fallback; a trusted catalog's publisher cannot fall back to another
signer on mismatch. The exact, case-sensitive certificate Subject comes from the
verified provider's signer certificate. UI is disabled; revocation/provider policy
flags retain the previous WinVerifyTrust defaults, not offline/cache-only shortcuts.
The installer-owned PowerShell cmdlet verifier is unchanged.
Final signed launcher/helper startup acceptance is required in
addition to native readiness probes.
Existing pre-Velopack component directories are left untouched.
The authenticated manifest accepts 1–32 uniquely named component kinds. Current
Python/TeX/PowerShell/Codex/Office requirements belong to build recipes and consumers,
not to a fixed extraction whitelist. A signed update may add a new kind without
replacing the installed helper first; it follows the same validation and reuse rules.

Normal first startup downloads and prepares components before backend launch;
time-limited install hooks are not the preparation boundary. Preparation progress,
retry and exit are available without Python. Update preparation downloads all missing
archives before quiescing the current runtime. Failed preparation preserves the
current app; it does not enable post-update health rollback. Unpacked validation uses an isolated
`application/current` with sibling runtime, so expanded validation files cannot leak
into vpk's pack input. Official Setup uninstall removes the installation root,
including runtime, but can ignore deletion errors. Verify actual removal, including
the running-app case, independently of the installer exit code.

The exact component download route must be deployed before CI application validation.
CI freezes component ZIPs outside the application input and publishes immutable
objects before unpacked/installed application checks. The injected
`SCHOLARSEED_RUNTIME_PUBLISH_COMMAND` is a JSON argument array; the build appends
`--manifest <runtime.json> --directory <runtime-components>`. Only signed CI
builds invoke it. Local unsigned builds may consume existing immutable components
through the same service, but never upload them implicitly. Final release results
carry the exact independent runtime artifacts and final distribution must confirm
their availability before publishing the application release marker. macOS retains
its bundled runtime and existing packaging checks.

**gap — production signed-update acceptance remains outstanding.** Local unsigned
installation can exercise runtime preparation and real interactive UAC, but cannot
establish production signature or update-apply acceptance. Verify a single changed
component, cancellation and grant expiry during update, personal-installation
updates, original-token restart and whole-root uninstall. Account for coordinator
scratch left after a committed main-process exit in cleanup evidence. Keep first-launch
preparation evidence separate from application replacement and delta/full evidence.

### Confirmed update shutdown preparation

**current (source).** Explicit installation on Windows and macOS sends the private
`prepare_update` operation instead of ordinary `quiesce`. Status `1` plus the exact
maintenance generation means admission remains closed and business shutdown
preparation succeeded; it is not an attachment-drain or process-exit receipt.
Serve's business marker, bounded failure handling and typed diagnostic failure
handling belong to the [Serve lifecycle contract](../../../docs/architecture/serve.md#已确认更新的关闭准备).
Ordinary quiesce, idle maintenance and normal suspension retain their existing
Trace checkpoint requirements.

Preparation does not close the live sessions. Cancellation before backend shutdown
may resume the exact successful generation; unknown preparation outcomes never
authorize installation or a guessed resume. Windows retains its owned-family
shutdown and same-version recovery path. macOS retains the existing Squirrel
candidate commit, native readiness and subsequent backend-close boundary; it does
not stop the backend earlier in the authorization callback.

Only a business-marked final update shutdown may downgrade known pure
`TraceRecordingError` projection failures, including earlier publication or
consumer failures. Ordinary close retains their fatal behavior. A mixed
`ExceptionGroup` containing a native detach or business failure remains fatal;
diagnostic classification must not hide actual business I/O or resource-exit failures.
The narrow final `Trace.close()` handling still requires the business persistence
worker to have closed. Final clean backend shutdown remains mandatory, including
Windows owned-family exit acknowledgement. Forced termination, business
persistence failure or unknown native exit still rejects installation. Package
trust, installation occupancy, permissions and fresh candidate authorization are
unchanged. Recoverable
pre-handoff failures retain still-valid verified package bytes for retry, not a
reusable installation grant; candidate withdrawal or integrity failure still
invalidates the candidate under its existing policy. Committed handoff recovery
remains with the existing native owner.

**required / gap.** Final installed macOS and Windows acceptance for this protocol
has not run. Verify diagnostic-only failures, genuine business shutdown failures,
control-response loss, cancellation/recovery and retry with retained payload bytes
through each platform's real update flow. Contract tests do not establish signed
update acceptance. An older installed client that does not send `prepare_update`
requires full exit followed by a supported installation or upgrade; this protocol
does not provide automatic in-place rescue for that running client.

## Removed updater state

The old store, owner, launcher, profile copy/recovery/collection and health rollback
implementation is removed. New Windows builds do not create or consume
`.scholarseed-profiles`. Existing user directories are not scanned, migrated or
deleted by this cleanup.

`.scholarseed-coordination` remains the shared Desktop/Serve data coordination
namespace. `.scholarseed-update-launch` remains the macOS Squirrel restart context.
Neither path nor its current consumers change here.

## Windows installation directory

The distributed Setup now has a native directory-selection front end (`cmd/setup`). It embeds the unchanged official Setup; Velopack still owns installation, replacement, registry entries, updates and uninstall. The default is the user's shell-resolved LocalAppData/scholarseed. No installer extraction or application download starts before confirmation; cancel exits without installation.

First installations may select another writable local fixed-drive folder. The front end rejects foreign nonempty folders, device names, reparse paths, protected system folders (including short-name aliases) and paths that exceed the frozen package/runtime budget. An existing HKCU installation is checked against `current/sq.version` and stays in its registered folder; relocation requires uninstall first. This remains a personal installation, without a global-install option.

`--silent --installto <directory>` uses the same preflight. The inner Setup is signed before embedding; the front end is branded and signed afterward, and final installer verification/hash calculation consumes the outer executable. Build/runtime tests and an unsigned directory screenshot do not establish final signed installation acceptance.

安装位置检查区分风险与硬错误：上级目录中可解析的其他账户 owner/ALLOW 权限作为风险列出，交互安装默认不继续，用户明确确认后才继续；静默安装须额外传入 `--accept-directory-risk`，该授权不传给内部安装器或提权 worker。接受风险不代表上级目录已经安全，安装器不修改其 ACL。确认后锁定路径并重新检查结构、访问及相关权限；按主体与风险权限比较，增加无害读取 ACE 不会导致确认失效，风险变化仍停止。缺失的安装路径逐级通过固定父句柄原子创建私有目录。

权限判定区分真实卷根、普通祖先与程序/运行组件。卷根必须通过打开句柄的 volume-GUID 路径确认，盘符别名不会得到卷根豁免；普通祖先仍检查删除、写属性及权限变更。新建各级目录使用显式受保护 DACL，不再推断父级 inherit-only 写权限必然传播。generic 权限先归一化；仅同 SID 或 Everyone 的先行无条件 Deny 可以抵消相关 Allow，运行组件区分自身、直接子项及更深后代，不能用 NO_PROPAGATE 的 Deny 抵消深层授权。执行 Deny 按当前令牌的 enabled/deny-only SID 判断，不以无关主体 Deny 拒绝。未知 capability 没有写权限豁免；不支持的 ACE 明示无法评估并停止，不默认为安全。

安装执行域的 C、Go、Python 判定由 `native/security.json` 在构建期生成，并通过共同向量核对；运行期不加载策略文件。安装主体由同一策略的 profiles.installation 定义，适配层不各自维护白名单。真实物理卷根按外部卷管理边界判断，不按 owner SID 拒绝，根自身改权/改所有者按卷管理权限处理；外部 DELETE_CHILD 仍拒绝。普通祖先、程序目录和 runtime 保持严格规则，不修改用户磁盘的 owner/DACL，也不承诺抵御卷控制者未来主动改权。

旧版迁移的数据定位仅检查路径结构及重叠；计划递归清理的目标仍检查内容及祖先权限，即使目标尚不存在也不能绕过祖先保护。运行组件保留和提权删除不接受目录风险确认作为放行依据。上述策略的确定性测试不替代 Windows 安装版及双账户验收。

路径、磁盘、重解析点、访问检查或安装树私有权限检查失败仍阻止安装，并显示失败目录、原因和建议。重装换目录提示同时列出原目录与所选目录。组件冷下载使用安装树专用句柄：外部祖先保留结构及防删除固定，安装根和内部派生目录仍严格检查，不改变用户数据的 PRIVATE/PROJECT 策略。安装后无法创建启动进程与安装失败分别提示；进程成功创建不等于完整运行验收。

目录选择前导程序在交互安装期间显示统一品牌的等待界面，内部使用官方静默安装以延后正常启动。安装后仅为核验过的书深安装树设置当前用户、SYSTEM、Administrators 的私有权限，再调用官方 `Update.exe start`；静默调用不启动应用。新建根也先设置私有权限，重装重新处理新树；不修改用户选择目录的父级权限。

安装目录句柄按阶段交接：预检与准备期间固定完整路径；调用官方安装引擎前仅关闭安装根目录的防删除句柄，祖先句柄持续持有，允许 Velopack 将旧根重命名后创建新根。引擎成功后重新以 no-follow、防删除方式固定新根，再执行安装身份核验和权限处理；引擎失败直接保留原错误，句柄关闭或新根资格失败均停止。不得对整条路径开放删除共享。该交接只用于 Windows Setup，macOS Squirrel 不使用此流程。

## Component preparation timing

Windows emits one `[component-timing]` JSON summary per component operation, with
`kind`, `version`, `pid`, `operation`, `status`, `elapsed_ms`, `files`, `bytes`, and
`metrics` (`calls`, accumulated `elapsed_ms`). It never logs archive URLs, signed
query strings, local paths, or one line per extracted file. Diagnostics are not
receipt, reuse, signature, progress, or authorization inputs.

The native launcher's `bootstrap` measures Electron identity verification, lock,
manifest verification, download, preflight, and preparation. Electron's `runtime`
`startup` summary first measures `inspect`; unprepared installations continue through manifest verification,
component delivery, and helper completion; retry-dialog time is excluded.
Per-component `readiness`, `download`, `preflight`, and `prepare` summaries distinguish
`reused`, `retained` (verified cached archive), `passed`, and `failed`. Failure
summaries close outstanding measurements; `last_phase` is the last measured
operation, not a claim about the root cause.

For complete login callbacks the launcher also forwards a bounded, versioned
`--scholarseed-callback-timing` diagnostic to Electron. It contains a 16-hex SHA-256
state fingerprint, launcher PID/start time, activation, bootstrap, nested signature
and readiness durations, and time before spawning Electron. The existing
second-instance and inbox paths preserve this record. Desktop validates its shape,
limits and callback fingerprint before logging `[callback-timing]` with the delivery
source, receiver PID and remaining launcher-to-receipt wall-clock gap. The gap
includes engine startup/IPC/queueing, not browser time; clock changes can invalidate
it. Argument diagnostics are untrusted observations, never authentication evidence
or input to authorization, callback routing, state TTL or token exchange.
Failures before Electron starts still have only the native stderr/package-check
channel; a browser invocation cannot guarantee durable evidence for that interval.

The account handoff logs monotonic durations for account-base resolution, HTTP
exchange, credential adoption, local forwarding, renderer confirmation and receipt
completion using the same fingerprint. No code, raw state, token or callback URL is
added to timing logs. These phases are not interchangeable with login success.
If window.log cannot be appended, lifecycle diagnostics use the existing backend.log
writer (including its qualification and rotation), without a second writer or ACL
repair. Before that writer exists, a bounded in-memory backlog reports omissions
when storage returns. If both sinks remain unavailable or the process exits first,
persistence is not guaranteed; stdout/in-memory output is not durable evidence.
`RotatingFileLog.write()` reports acceptance, not durability: `true` means appended
or retained for best-effort replay by `resume()`; `false` means rejected, including
closed writers, storage failure or an oversized deferred chunk. Deferred replay
can still fail if storage is unavailable. Do not replace this result with an
unconditional success or use it as evidence that a line is already on disk.
The diagnostic backlog has its own 50 MiB byte limit and 4096-chunk limit, independent
of the primary file's rotation setting. New lines cannot overtake retained lines.
An omitted-byte notice is best-effort and cannot block retained data; a failed
notice remains pending. Pending diagnostics retry once per second through an
unreferenced timer, so quiet periods can recover without keeping the process alive.
The will-quit hook calls `DiagnosticLog.end()` for a final best-effort drain before
closing the primary writer and cancels retries; repeated closes are idempotent.

Platform matrix: Windows uses native handoff trust and callback launch telemetry;
macOS signature/bootstrap behavior is unchanged and open-url delivery has no native
launch record. Both platforms share phase timing and diagnostic fallback. Native
oracle fixtures cover embedded/catalog signatures, exact Unicode publishers, wrong
publishers, tampering and unsigned inputs; they do not establish signed installed
startup, update/UAC, or final callback acceptance. Those require the real signed
package and final-revision runtime screenshot evidence on the affected platform.

Readiness reports lineage, receipt, inventory identity and entry qualification, with
zero payload `bytes` and no `hash` metric. Full reuse reports payload hash bytes.
Transport summaries separate copy, request, spawn, ready, authorize, commit and exit;
native request/identity/coordinator summaries separate manifest, signatures, principal,
component preflight and application-tool admission. Nested phase totals are not additive.

Preparation measures path checks, directory/handle creation, archive hashing,
streamed extraction reads (including ZIP decompression), writes,
file sync/close, and receipt/publication. `directories` includes output file
creation; its nested `directory_pin` measures mkdir plus validated directory open,
and `file_create` measures exclusive output creation. `files` counts copied archive members;
`bytes` counts copied expanded bytes for preparation and payload bytes for download.
These include **nested** wall-clock measurements: `extract` contains
`read_write_hash`, `directories`, `sync`, etc.; `read_write_hash` contains `read`,
`write`, and (for release verification) `hash`. The historical `read_write_hash`
metric name is retained for comparison. Do not add parents to children. Coordinator and worker
preflight are separate real passes and retain their process IDs.

The helper worker returns summaries through its existing nonce-bound status
channel. The coordinator forwards them on stderr, and Desktop retains bounded
individual lines in its existing log. Pipe batching cannot truncate later
component records. A killed worker may have no final summary. Native launcher
stderr is captured by package-check. CI forwards the structured summaries with
a `check` label (`unpacked-first`, `unpacked-reopen`, `installed-velopack-first`, or
`installed-velopack-reopen`); raw diagnostics remain in the package-check log. This adds
no separate persistent launcher log or user-data directory.

## Bounded component file flushing

Windows extraction creates, streams and validates up to thirteen files, then hands
the batch's output files and pinned parent handles to four flush workers. The queue
holds at most eight jobs; at most thirteen file jobs are retained in total. The next
write batch starts only after all files in the previous batch Sync and Close,
avoiding file creation competing with FlushFileBuffers. A final partial batch is
also drained. File contents are streamed, never buffered as a batch in memory.
There is no runtime setting or environment override. Non-Windows helper tests keep
synchronous flushing; macOS packaging and runtime never use this Windows helper.

Component preparation verifies the pinned ZIP's full SHA-256 before extraction.
Extraction checks the complete member inventory, sizes, paths and ZIP CRC/read
errors, but does not compute each member's SHA-256 again. Thus a signed inventory
whose individual digests disagree with its authenticated ZIP is no longer caught
during extraction. Critical-entry checks on reuse remain. Application release and
reconstructed delta verification still check individual member SHA-256, because
reconstructed ZIP bytes need not match the original full archive.

The extractor retains the current validated directory lineage and shares its
common prefix with subsequent files. Reference-counted pins remain alive for the
producer and pending flush jobs; an old branch closes after its last dependent
file closes. Revisiting an unpinned branch performs mkdir and reparse checks again.
There is no archive-wide handle cache: retained lineages are bounded by path depth
and the bounded file batches. Cached Windows directory handles deny both write
access and deletion, preventing mutation into a reparse point after validation;
the staging root remains held by preparation through publication.

Every accepted file still requires a successful Sync and Close. All queued work
is drained on every exit, including inventory/path/read failures, before staging can be
removed. Directory pins remain held until the owning file closes. The component
receipt is created exclusively, explicitly synced and closed only after all jobs
succeed; the existing handle-relative publication then runs. A failed job prevents
receipt creation/publication. Reuse, signatures, complete inventory checks, path
budgets and reparse rejection are unchanged. This does not promise general
power-loss recovery or full-tree corruption detection on subsequent reuse.

`flush_workers` and `flush_peak` describe the pipeline; `flush_wait` measures queue
submission waits, `flush_batch` each batch's submission and completion barrier,
and `flush_drain` the final worker join. Sync and Close durations sum
work across workers and may overlap extraction or exceed elapsed wall time. Use
`elapsed_ms` for user-facing preparation latency; do not sum concurrent metrics.

`BenchmarkComponentPreparation` is an opt-in comparison using a local unsigned
build's exact runtime.json and component ZIP directory, selected through test-only
`SCHOLARSEED_FLUSH_BENCH_MANIFEST` and `SCHOLARSEED_FLUSH_BENCH_ARCHIVES`. It compares
serial (0), two and four workers, fresh expanded directories each iteration, full
archive/inventory verification and publication. Cleanup is outside the measurement;
archives may be cached. This benchmark is not product installation acceptance.

`BenchmarkDirectoryExtraction` exercises a synthetic directory-heavy ZIP through
the extractor with zero, two and four flush workers and reports directory pinning separately from
file creation. It is a filesystem microbenchmark, not installed startup acceptance.

## Single-release NSIS migration

The source inventory and Go embed placeholder named `legacy-files.json` use Git
LF checkout attributes. The reviewed source SHA-256 authenticates exact bytes,
including the final newline; the placeholder remains an empty array for tests.
Refreshing an existing Windows checkout must rematerialize these files; changing
the expected digest to accommodate CRLF is not a valid repair. Setup staging
copies the authenticated inventory into its embedded input without normalization.

The private Setup compiler preserves `cmd/setup` and `handoff` under the original
Go module root. Its non-standard dependency closure must contain exactly those
two reviewed packages; additional internal or third-party packages are refused.
The normal build tests include inventory checkout and staging regressions. On
Windows, set `SCHOLARSEED_SETUP_TEST_GO` to a reviewed Go SDK's `bin/go.exe` and
run `node --test apps/desktop/scripts/cd/__tests__/setup.test.cjs` from the repository root to
also compile the isolated source tree and execute its embedded-policy check.
This diagnostic binary uses a fixture payload and is not installation acceptance;
signed Setup, installation and update verification remain required in CI.
macOS does not use this Windows Setup wrapper.

The Setup front end has a bounded migration entry for the original Windows release
`202610091639` (`b8a938849f0be71d7b3d92830b8a4988722435d7`). Its build policy freezes
SHA-256 digests measured from that published, Authenticode-valid installer:
`Uninstall ScholarSeed.exe`, `resources/product.json`, and `resources/app.asar`.
The complete 1,496-file inventory in `scripts/cd/legacy-files.json` is authenticated by
that policy and checked before removal; extra or changed program files stop
migration rather than allowing the old uninstaller to delete unknown content.
The source URL and installer digest live in `scripts/cd/legacy.json`. No runtime
learning or version-string-only authorization is supported.

After user confirmation and destination preflight, the front end invokes a verified
private copy of that uninstaller with `/S /KEEP_APP_DATA --updated`, the original
scope, and the final NSIS `_?=` directory. The old program is retired before the
embedded official Velopack Setup runs. Data directories and raw user/machine
`SCHOLARSEED_HOME` registrations are checked and preserved; the old update-mode
hook removes only its transient staging/lock directories. It does not clear user
configuration or move projects. Unknown source, unsafe paths, overlapping data
roots, changed configuration, competing migrations and running applications stop
migration before removal. Installation failure after removal is recoverable by
rerunning Setup; this is not automatic binary rollback.

New installation remains per-user. A legacy machine installation requests elevation
only for its bounded removal worker, which independently validates the same user
identity and original source. Approval with another administrator account is refused
before uninstall because the immutable old hook would otherwise access that
account's HKCU data location. Start Setup normally, not as administrator.

**current — bounded Windows acceptance (2026-10-17):** the original signed NSIS
release was migrated through the normal Setup GUI under a standard user on ecs-win.
Cancellation and running-application refusal preserved the old installation. After
normal application exit, migration removed its directory and registration, installed
Velopack to a Unicode/space path, and preserved all 17 checked project/data files
byte-for-byte and the user/machine Home registration states. The installed application
opened the original project and note, then reopened them after normal exit and a
Desktop-shortcut launch. Desktop and Start Menu shortcuts target the new installation.
The tested source was `1f1d5bc83`; the local unsigned build was
`0.2.0 / 202610171620`, with the complete package result `status: passed`.

**required/gap:** this local-lane result does not establish signed distribution or
credential-store continuity. Same-user UAC for machine-wide legacy installs,
UAC cancellation, post-removal failure/retry and the full data-location/type matrix
still require Windows evidence. The unsigned distribution-candidate build was
rejected by runtime signature trust; the supported local build passed without
relaxing that boundary. Signed distribution is CI-only. macOS Squirrel packaging
is unaffected; its installed product flow was not exercised by this Windows task.

## Cross-session installation occupancy

Before Windows handoff, native occupancy compares kernel image paths with the
installation directory's resolved NT device path, including the path separator.
A different installation in another login session does not block this update.
Access-denied process/session queries use read-only system information, without
changing token privileges, process permissions or other users' applications.
The optional PID-image information class is resolved dynamically. An unavailable,
malformed or incomplete observation for a matching application still refuses
handoff as `ERR_UPDATE_INSTALLATION_QUERY`; confirmed same-root use remains
`ERR_UPDATE_INSTALLATION_IN_USE`. These map to separate bilingual instructions,
retain the staged package and keep raw diagnostics out of the user-facing error.

This is a point-in-time observation at the existing handoff checkpoints, not a
cross-user launch lock. Same-session runtime drain and official replacement are
unchanged. macOS does not call this Windows-only check. Native contracts and
cross-user probes do not substitute for final CI-signed installed-update acceptance.

### Startup component progress

Windows keeps its startup surface visible while preparing components and the local
backend. Download percentages use received archive bytes. Extraction percentages
use bytes written and verified against the component inventory, with verified file
counts; publication and application permissions remain separate pending stages.
The existing nonce-bound worker status channel carries display-only progress to the
coordinator and main process. Progress cannot authorize a handoff or replace the
terminal completion/receipt checks. The main window is revealed after preparation
and window-service initialization. macOS retains its bundled runtime layout.

### Physical volume management boundary

A verified physical volume root is an external filesystem anchor, not an application-owned directory. Its valid owner SID is not an admission whitelist: Network Service, other service accounts and ordinary owners use the same rule. Changes to the root's own DACL/owner (`WRITE_DAC` / `WRITE_OWNER`) are volume management, rather than direct access to protected application content. Existing root-only deletion/metadata/sibling-creation allowances remain scoped to this role. `FILE_DELETE_CHILD` still fails admission for an untrusted writer, including via generic full control or OWNER RIGHTS. Invalid descriptors, NULL DACLs, unsupported ACEs and unavailable identity fail closed.

Only the opened handle's exact volume-GUID root receives this role. A drive alias resolving to an ordinary directory does not. The same root requested as program content retains content rules; ordinary ancestors, installation directories and runtime retain their owner and dangerous-write checks. Protected installation DACLs, no-follow traversal and pinned identities remain required; no existing root ACL is rewritten.

This is a current-state admission policy, not protection against a volume controller later changing root permissions to grant child deletion. In particular, an owner can normally change its object's DACL. Root management is explicitly outside the application isolation guarantee; a later operation must revalidate its bound installation, and a previously accepted volume is not a permanent security authorization. The policy does not promise cross-account integrity against the volume manager.

References: [Windows file security and access rights](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights), [owner implicit permissions](https://devblogs.microsoft.com/oldnewthing/20241030-00/?p=110440).

### Installation authority source

`native/security.json.profiles.installation` is the sole definition of the installation authority set: the initiating user plus SYSTEM, Administrators and TrustedInstaller. The build compiler validates canonical SID literals and emits C binary-SID comparisons, Go canonical-SID comparisons and Python binary-SID comparisons. Adapters collect validated OS SIDs and the initiating user, then call the generated authority function for both owner and ACE decisions; they do not maintain independent trust sets. Generated outputs and the authority policy share the existing SHA receipt. No policy file is loaded at runtime.

The independent `native/principals.test.json` oracle covers the same 17 principal/user pairs across C, Go and Python, including exact matching, other users, service accounts, OWNER RIGHTS, capability and prefix lookalikes. OWNER RIGHTS must still resolve to the validated actual owner before authority evaluation. This centralization preserves the existing authority set and the volume-role boundary; it does not replace the narrower handoff/repair/private-record policies with installation privileges.

### Reading the build-time policy

`native/security.json` schema 2 uses typed, ordered parameters and named statement objects (`let`, `set`, `if`/`then`, `for`/`do`, `return`). Rights use documented hexadecimal masks; `@rights.*`, `@flags.*`, `@roles.*`, `@scopes.*` and `@reasons.*` refer only to literal values in this file. Prefix expressions contain the limited existing bitwise/comparison/call operations. They are not executable strings.

`scripts/shared/policy.cjs` validates and lowers this source notation into the same bounded IR as before; `scripts/security.cjs` remains the single compiler for C/Go/Python. Unknown references, operations, statement fields and out-of-range masks fail generation. Authority SID labels and function descriptions are review aids; the SID values and ordered rule bodies determine behavior. Run `node scripts/security.cjs` from Desktop to regenerate, followed by `--check` and the shared native/Go/Python contracts.

### Purpose-specific principal profiles and denial diagnostics

`native/security.json.principals` defines fixed SID values once. `profiles` defines separate installation, machine-authority, tool owner/writer, recovery owner/writer, private owner/writer, and lease-state/grant rules. Tool ownership excludes the sandbox execution principal. Private ownership still requires actual current-token Administrators membership; logon-read and directory metadata exceptions stay in the private-record operation. OWNER RIGHTS in tool/recovery writer profiles requires the actual validated owner as an explicit argument. It is not a globally trusted SID.

The compiler produces the existing C/Go/Python installation kernel, named Go/Python profile methods, a standalone Adapter permissions module and the tooling JavaScript constants. Adapter code imports neither Serve nor Desktop. The cooperative startup mutex descriptor is generated from its own exact rights table; it is unchanged. No Codex version, recovery version allowlist or MXC changes are included.

Rejected qualifications use schema 1 `permission_rejected` events through each caller's existing log/stderr channel. Common fields include policy hash, profile, stage, reason, controlled code, numeric system code and correlation ID. Known subject roles, source file basename/line, a path-string digest, or native ACE index/mask/scope are added when available. A path digest is diagnostic context, not an installation identity or authorization. Windows codes 5, 1223, 1300 and 1314 normalize to access denied, authorization cancelled and privilege not held.

New structured rejection events do not serialize exception text, full paths, raw SIDs, ACL/SDDL, bootstrap frames or credentials. Existing unrelated success logs are outside this event contract. Python and JavaScript observers retain the same exception; Go wraps with Unwrap so errors.Is/As and the original message continue to work. First-record correlation and observer-failure behavior are tested. Native binding errors expose `permissionIncidentId`; logging does not authorize a retry or grant. A rejected qualification may subsequently recover through an existing supported path, so this event alone does not prove the final user operation failed.

Deterministic and native probes verify event production and refusal behavior. The installed launcher, native helper and feedback ZIP still require CI-package verification of the complete log collection chain; stderr output alone is not evidence of persistent product logs. No new machine journal, administrator registration or alternative log directory is created.
