# Native macOS update lifecycle

Source overlays for Electron's pinned standalone ShipIt and Squirrel updater.
Mantle and ReactiveObjC frameworks remain Electron inputs. `scripts/cd/shipit.cjs`
builds the helper and `scripts/cd/squirrel.cjs` builds the in-process framework with
the same source manifest; both require native macOS Command Line Tools.
`timing.patch` wraps coarse operation signals;
`timing.h` records subscription start and terminal result using a monotonic clock.
A process-local ID and the existing NSLog PID distinguish concurrent subscriptions.
No paths, capabilities or per-file records are added.

Stages:

| Stage | Scope |
| --- | --- |
| copy-candidate | Installer-owned copy of the extracted candidate |
| clear-quarantine | Existing recursive extended-attribute processing |
| take-ownership | Existing recursive file-security processing |
| read-signature | Reading the source application's signing requirement |
| verify-signature | Candidate signature check, excluding the ownership stage |
| replace-bundle | Each original installItem operation, including any cross-volume handling |

Each stage logs `event=start` and `event=end result=success|error|disposed
elapsedMs=... errorCode=...`. End is recorded before forwarding completion/error,
so synchronous downstream work does not inflate the previous duration.
Disposal is not success. A process crash may leave only start; do not manufacture
an end record or classify missing evidence as zero duration. Value-producing copy/signature-read operations are timed around the native call
before emitting their value, so downstream flatMap work cannot pollute their duration. Error codes have
meaning only within the operation's existing diagnostic context.

`artifact.cjs` places the exact helper, framework and license/build evidence in the output
App before the existing signing pass. Source, patch, header, executable and
signature-independent code digests are frozen and checked again on the packaged
App. Windows does not build, stage or execute these components.

## Candidate preparation before termination

`preparation.patch` lets the original-permission ShipIt copy the candidate before
waiting for the running application to terminate. `readiness.patch` holds
Squirrel's update-downloaded completion until that helper publishes readiness.
The app remains running during copying. On the unprivileged path for a running
target, `metadata.patch` also normalizes the exact private candidate's quarantine
and ownership and checks its signature before acknowledging an unauthorized
request. The Foundation copy API and source bundle remain unchanged.

`preparation.m` owns a private `CandidatePreparation` directory next to the native
cleanup owner's directory under Application Support. Its independent lock and
atomic, synchronized journal bind the source, target, candidate and private
parent identities. A copying record and preparation attempt are persisted before
copying starts. Only a completed copy becomes ready. Interrupted partial work is
removed using recorded identities and no-follow descriptors, then copied again.
New candidates stay in a private child directory of `CandidatePreparation`
while the application waits for an explicit restart. A matched ready copy
from the former temporary directory is rebuilt from the bound source in
the private store. The final signature check still runs before replacement.
When the candidate and installation are on different volumes, ShipIt retires
the preparation record using the just-committed move and the installed bundle's identity.

新候选副本保存在 Application Support 下 `CandidatePreparation` 的私有子目录中。
即使用户隔夜才点击重启，副本也位于系统临时目录清理范围之外。接手旧临时目录中的就绪副本时，
助手会先核对身份，再从本次更新绑定的来源重新准备。替换应用前仍会再次验签。
候选副本和安装位置在不同卷上时，ShipIt 会核对刚提交的移动记录和已安装应用的身份，再清除准备记录。

Ready reuse validates identities and never substitutes for final signature checks.
Three preparation attempts are independent of the original installation counter.

After an authorized restart, macOS may report that a sealed resource is missing
from a private candidate whose bundle and Contents directories are still intact.
Before moving the installed app, ShipIt records one rebuild attempt for that
request and copies the candidate again from its bound source. The new copy goes
through quarantine handling, ownership checks and full signature verification
against the installed app's designated requirement. A successful check continues
the same installation. A failed rebuild or verification enters the existing
recovery path, which reopens the restored app under the user's restart grant.

用户点击重启后，如果 macOS 验签发现私有候选副本缺少签名资源，ShipIt 会先在本次请求中记下重建次数，
再从原请求绑定的来源复制一次。新副本通过完整验签后继续本次安装。复制或再次验签失败时，
助手沿用原有恢复流程，确认旧版已恢复后自动打开旧版。

The small source-parent readiness acknowledgement is readable by the initiating
user even when ShipIt runs privileged. It controls exit timing only: it cannot
supply the installer candidate path or authorize installation. Squirrel waits
asynchronously with a bound, reports errors without exiting, and preserves the
source once it may be owned by the helper. The helper removes the acknowledgement
after application termination. An interrupted acknowledgement write uses one fixed
next-file name, reclaimed only after ownership, type, size and inode checks plus
an exclusive lock. Active writers and substituted objects are never swept.

After termination the installer rechecks quarantine, per-member ownership and
the strict signature of the actual candidate against the current designated
requirement. Members already meeting the ownership policy do not need a second
metadata write. The early result cannot authorize replacement or excuse changes
made to a prepared candidate. Privileged helpers normalize the candidate only
after their original installation checks. If the old application quits before
granting installation, the helper publishes a bound cancellation without
replacing or relaunching it. The helper checks that its rollback preference is
absent when admitting an unauthorized request and before publishing cancellation.
Existing rollback state instead blocks preparation and remains available to the
authorized recovery path. An entered installation with no
running target takes the original rollback-first recovery path. A reopened target
receives a preparation result instead of deadlocking with the readiness wait.
Preparation exhaustion stops the current launchd demand and leaves the source and
running application intact; a subsequent newly extracted request has its own
preparation budget. Damaged or replaced journal objects fail closed.
Committed cleanup recovery does not depend on opening the preparation journal.

`interaction.patch` requires an explicit Desktop interaction marker in the local
feed request before privileged ShipIt submission. Scheduled preparation uses the
ordinary user domain. A change in native path writability cannot turn a scheduled
request into an administrator prompt. The marker never authorizes installation.

Native build contracts cover preparation, interrupted copying, identity changes,
notification validation and RAC readiness/error/timeout/disposal. These remain
local contracts; final signed-product restart timing and privileged recovery
require the CI update acceptance described below. Windows does not consume the
new native journal, notification or gate.

Preparation, cleanup, timing, admission and binding contracts preserve stdout/stderr in their test logs and write a
schema-1 `*-test.result.json` receipt with child PID, exit status, termination signal and
spawn error (PID is null when unavailable). Failures include those fields even when stderr is empty. A signal,
spawn failure or nonzero status still fails the build; recording the result
does not retry execution or extend its existing deadline. Process-observation
uncertainty in the live repair bridge remains a refusal, not an archive failure
or a successful recovery. Correlate the exact PID and executable with host diagnostics;
an XProtect framework warning alone does not establish why a process was killed.

### Local endpoint-security approval

A host security agent can deny a freshly compiled test before its entry point,
even when its ad-hoc signature verifies. A valid signature is not execution
authorization. A per-program confirmation that expires with a deny decision
can therefore produce SIGKILL with empty test output. Kernel exit-reason evidence
and the security agent's exact executable/decision record distinguish this from
a native assertion; missing kqueue code-signing or memory flags are not enough.

Before an explicitly authorized human confirmation, freeze the reviewed sources,
executable paths and SHA-256 inventory, and verify signatures. Run each approved
artifact with new private fixtures; keep a denial as a failed attempt, without
automatic replay. Then run the complete helper build and its native
contracts, checking the newly compiled artifacts against that inventory. Human
approval of exact test programs is not permission to change security policy,
add broad exceptions, remove provenance, or switch launchers to evade a denial.
Unattended runs need an appropriately authorized host. This development-host
workflow does not satisfy signed-App update or Windows product acceptance.

## Launch reentry and startup failure

The pre-termination listener observes only the applications present at subscription.
`admission.patch` therefore checks the exact target before and after candidate
signature validation. `admission.h` waits for transient reentry under one monotonic
deadline. The preparation owner rechecks source, target, candidate and private-directory
identities after verification. Reentry during verification waits and repeats only
that verification, not candidate copying or the transaction. An intact candidate
passes a single final signature check when the target stays closed. Rename, acquisition and
replacement are outside its retry/timeout boundary and retain their existing rollback
semantics. The original final running-instance check remains. A rare reentry after
rename records the actual target in the existing private preparation journal before
restoring the original name. Restoration requires the original parent, bundle and
Contents identities, an absent destination, and an exclusive no-overwrite rename.
It never retries installation. A recorded failure revokes Copy, Validate and Retire
for that request; another request cannot replace the recovery record until the
original target is proved restored, the renamed leaf is absent, and its matching
failure acknowledgement is valid. The source-parent acknowledgement also vetoes
replay after the private journal advances to a newer request. This is deny-only
evidence; missing, damaged or removed acknowledgements are not a permanent replay
ledger and never authorize installation.

Terminal admission wait and final-guard failures reuse the identity-bound preparation
acknowledgement. Reopening a failed journal restores and republishes before any
preparation, installation counter or rollback branch; publication failure preserves
the launchd demand and journal for another attempt. Ownership mutation has a durable
intent before verification: an interrupted intent is converted to a failure only
when the original target and narrowly pinned candidate remain provable. Recovery
never resumes that installation. Other crashes before a terminal record or ownership
intent is persisted remain outside this terminal recovery protocol.
An authorized failed installation publishes its bound failure before requesting an
old-application launch through the same installed helper used for successful updates.
Recovery uses the install request re-read after the old process exits, once its
binding and controls match the prepared request. An ordinary quit leaves the
initial preparation unauthorized and the application closed.

用户点击重启后，ShipIt 在旧进程退出时重新读取并核对本次安装授权。安装失败且确认旧版已恢复时，
ShipIt 先持久化失败结果，再请求 macOS 打开旧版。用户正常退出应用时，后台准备不会触发重开。

`relaunch.test.m` drives ShipIt's two request reads with an isolated journal
and an injected installation error. It observes dispatch to the old bundle's
helper on failure, then exercises replay, ordinary quit, and a mismatched request.

`sealed.test.m` removes a signed resource from an isolated candidate after readiness.
It exercises the installer's full signature checks and records the running fixture
app's bundle identity after installation or recovery. Replaying a terminal failure
must leave the launch count at one.

The existing NSWorkspace default schedules launches asynchronously, allowing the
child and its transaction-owning parent to exit before Desktop admission. An exact
already-running target needs no additional launch. Launch request acceptance is
persisted in the failure record; request failure retains launchd demand and retries.
An interruption between launch acceptance and its journal write may repeat the
ordinary NSWorkspace request, which reuses the existing application instance.
Startup polls installing and terminal-restoration observations for at most five
seconds, then repeats all native evidence checks. A bound failure acknowledgement
while a matching helper is alive is `restoring`, not permission to reopen data.
Neither timeout nor helper absence grants admission.
This records launch request acceptance, not product readiness or successful recovery.

Desktop accepts an acknowledgement only after the matching user/root helper is
absent, validates its regular-file ownership and permissions, and compares its
source/target identities with both the live request and the request frozen at the
downloaded event. Missing or legacy unbound evidence never grants admission.
Unresolved source-build launches exit before product storage publication, migration,
windows or backend startup; a bounded OS notification does not retain the process.
The Desktop admission owner reports redacted diagnostics through the macOS system
logger with the `ScholarSeedStartup` message marker, without writing unadmitted Home.
The trusted launch-context observation precedes mutable profile restoration, and
context/handoff candidate and target-build binding is checked again after storage
selection and asynchronous probing. An update-related exception before admission
exits without opening an error window; unrelated storage failures retain their
native recovery UI. Context age and clock skew do not authorize deletion or
default-profile fallback. An unrelated build or explicit conflicting selection
preserves the context and refuses startup. A strictly newer build may restore a
superseded context only after installed-version reconciliation, matching handoff
candidate/target, and absent installation-owned current-user/root ShipIt helpers.
The helper scope includes the installed application and the bound candidate;
canonical executable paths distinguish other applications' same-named helpers.
Unreadable ShipIt paths or incomplete process output remain unconfirmed. A retained
native request is accepted only with the same bundle, binding and source/target
paths plus a nonzero, identity-bound failure acknowledgement. Process absence and
the request snapshot are checked again; this path does not delete native evidence.
It reuses the existing failure protocol, not an age-based or build-only override.
Unknown inspection results still refuse admission. The context bytes and original
home/profile/workspace identities remain checked, and admission is repeated before
storage publication. Only the target or proved superseding build's workbench
acknowledgement consumes the context through the normal completion path. The old
handoff is copied into the matching launch context before the qualified startup
path consumes it. An interrupted startup can revalidate that evidence and retry
with the original storage selection until the workbench acknowledges readiness.
For older contexts whose handoff is already gone, startup requires a signed app,
stable application and storage identities, and no user/root ShipIt.
A retained native request must name the context's candidate and installed target
and match an observed launch in the native cleanup journal. The exact target
build can resume offline. A newer build must resolve the original candidate and
build through the update service and compare release versions before it can
supersede the launch context.
The log distinguishes supersession from installation success. User data
and native failure records are not deleted. A replaced application is verified
against the configured signing Team and bundle identity, with its bundle and
Contents identities fixed across verification. The historical ack must still
match the frozen old target, the unchanged target parent and the live bound source;
ordinary source recovery still requires the old target itself. Replaced source
identities, missing acknowledgements and legacy unbound requests still refuse.

启动准入核验成功后，Desktop 先把交接凭据写入匹配的启动上下文，再清理原交接记录。
首次启动中断时，应用重新核验凭据并恢复原存储位置，工作台就绪后清除启动上下文。
旧版本已经清理交接记录时，必须核验当前安装的签名、应用与存储身份，
且没有当前用户或 root 的 ShipIt 进程。若原生请求仍存在，必须匹配候选版本、
安装目标及原生清理日志里的启动记录。精确目标构建可离线恢复，较新构建则须通过
更新服务核对原候选版本和构建号，再按发布版本顺序判定能否恢复。

A durable native terminal publication proves historical restoration and lets an
independent new request advance after application replacement under the same parent.
It never replays the failed source or bypasses the new candidate's signature and
installation gates. Legacy journals without that publication retain their stricter
live-target check. Retained ack evidence continues to veto replay after journal
advancement; missing ack is not a permanent replay ledger. Signed-product recovery remains a separate
acceptance requirement; deterministic tests do not prove that lifecycle.

`binding.patch` and `transfer.patch` carry one bounded tuple through the existing
feed `name`, native update object and atomic ShipIt request: schema, random requestId,
candidate ID, converted ZIP SHA-512 and size. Native hashes the actual response
NSData before passing that same object to unarchive. The tuple is not inferred
from product version/build and is not the upstream DMG digest. Binding checks compare
the whole tuple, source/target identities and an unchanged native request. Private
preparation reuse, validation, failure recovery and bound acknowledgements preserve
the same tuple. These checks establish download lineage, not a replacement for
code signatures or protection against arbitrary post-extraction same-user mutation.

The request's independent `installationAuthorized` flag starts false. Only the
existing explicit restart-install entry can set it true, after checking this updater
instance's prepared request, all immutable controls and a matching bound-ready ack.
`authorization.patch` requires that grant after termination and again at the installer
entry. Ordinary termination without a grant becomes a durable preparation failure,
not an implicit installation. Request reconstruction during canonicalization, rename
and cleanup recovery preserves binding and authorization. A private terminal fence
remains dominant over a late grant.

Binding rejection or timeout before a grant persists failed and revokes readiness;
late binder results cannot resurrect it. A new-protocol requested/downloaded record
left by a process interruption can likewise classify as pregrant failure: durable
installing must precede the only grant call. This permits an explicit recovery error
instead of indefinitely exiting silently, even if the helper is still preparing.
Errors after durable installing preserve an unknown outcome until installed-version
reconciliation or matching native terminal evidence; helper absence and time expiry
alone are not terminal authority. Missing/legacy binding cannot use this pregrant
proof. Recovery does not automatically clear the user's retained update context or
handoff. Both source helper and framework must contain this protocol; updating only
the target does not retrofit a running old helper.

After a failed installation, the restored application can show **Retry preparation**
while the Desktop handoff still says `installing`. A manual retry checks the
authorized native request and its bound failure acknowledgement against the restored
bundle. Under the handoff lock it rechecks those files, the target identity and
the absence of the update helpers. With fresh activation authorization, Desktop
can then replace the old handoff with a new request. Squirrel preserves the source
directory referenced by the native request during retry cleanup, so ShipIt can
still verify the old failure acknowledgement. Installing the newly prepared
update still requires an explicit restart.

安装失败并恢复旧版后，桌面端的交接记录可能仍显示 `installing`。用户点击“重试准备”时，
桌面端会核对原生安装请求、失败回执和恢复后的应用，并在持有交接锁时复核文件身份及更新助手的退出状态。
取得新的更新授权后，桌面端才用新请求替换旧记录。重试时，Squirrel 清理缓存会保留原生请求指向的目录，
以便 ShipIt 复核其中的失败回执。新副本准备好后，仍由用户点击重启来安装。

`binding.test.m` checks actual NSData digests, real request serialization, immutable
controls, private journal binding and bound terminal recovery. `grant.test.m` loads
the replacement dylib and exercises its real restart-request entry against isolated
files, without an NSApplication, launchd job or installer execution. It checks the
ready requirement, instance binding and terminal precedence. These are native
contracts, not signed installed-update acceptance.

Startup failures are rendered in the existing startup surface, without a parentless
synchronous NSAlert. Closing is terminal and completes on `closed`; late load/progress
callbacks cannot show a closing window. A failed startup surface cannot be replaced
by late workbench readiness. A failure reported during native closure synchronously
revokes workbench handoff, waits for `closed`, and creates a replacement error surface
only if quitting has not begun. Dock activation, second-instance, notification and
tray/handoff entries share the presentation admission; no-main-window activation
also respects startup ownership. Login maximize/restore effects wait for that
ownership to be released. Accepted quit requests close display admission before
asynchronous preference quiescence; failed shutdown preparation restores it without
revealing a hidden workbench behind a closing error surface.
Native admission and isolated window tests
are deterministic evidence only. Signed source-to-target upgrades with Dock reentry,
privileged helpers, dual displays/Spaces, and Windows startup regression remain
required product acceptance, not established by these contracts.

## Committed installation and deferred cleanup

`cleanup.patch` replaces synchronous post-replacement deletion with
`cleanup.m`'s durable commit journal. Before commit succeeds, the existing owned
bundle remains rollback authority and no deferred deletion runs. After commit,
the original installer rollback state is reconciled against that journal, the
new application is launched, and cleanup runs. A cleanup error never turns a
committed installation back into an install/rollback attempt.

The native owner stores its journal under the effective account's Application
Support directory, `<ShipIt job label>/DeferredCleanup`. This is separate from
product Home and project state and is not disposable cache data. Atomic replacement
and file/directory synchronization precede clearing the old rollback state.
A process lock excludes concurrent installers and cleanup workers. Completed
transactions retain a tombstone until a later committed request supersedes it;
pending deletion work is retained across subsequent updates.

Request matching uses lexical component keys, not Foundation's existence-dependent
path standardization. Only a root-owned top-level system symlink whose canonical
parent chain is protected from non-root writes is expanded; request descendants
and journal descendants are not resolved for comparison. Both stored keys and
incoming URLs use this rule, so existing system-alias keys still match after
temporary parents disappear. Comparison never authorizes deletion.

The committed tombstone retains the previous bundle's parent identity independently
of pending deletion items. Rollback reconciliation opens the captured parent with
no-follow traversal and requires its identity before accepting an absent or matching
bundle. A missing parent is already collected; permission, symlink, type and identity
failures are not absence. Older pending journals retain their existing previous
capture when drained. Older completed tombstones without that evidence reconcile
only when no-follow traversal proves the parent or exact previous leaf missing;
they cannot authorize a present bundle or any deletion without identity evidence.

Both cleanup and candidate preparation canonicalize only the OS-selected
Application Support root with POSIX `realpath`. Foundation's URL resolver can
shorten `/private/var` to `/var`, leaving a system symlink that descriptor-based
no-follow traversal rejects for root's home. Label directories, private stores,
locks and journals are never canonicalized by this entry-point resolution;
their existing no-follow, ownership, mode and identity checks still apply.
Resolution failure has no fallback. `[shipit-directory]` diagnostics record the
input/canonical root, UID/EUID, and failed traversal operation, path component and
errno. These records contain local paths; treat exported logs accordingly.

`path.test.m` exercises both public open entry points using an isolated account
directory lookup and real filesystem operations. It covers reopen, private
directory/lock/journal substitution, hardlinks, modes and diagnostic fields.
Use a fixture path under `/tmp` to exercise the actual macOS system alias, and a
physical user-directory fixture for the ordinary-account path. The same test
can run as root in a fresh, task-owned fixture; it additionally rejects a store
owned by another account. This is a native contract, not an elevated installed
update: signed CI packages must still exercise both user and privileged updates.
Windows does not compile or execute these Objective-C owners.

Every deletion records bundle and parent device/inode/owner identities. First
capture resolves the OS temporary-directory aliases; recovery traverses the saved
canonical path using no-follow directory descriptors. The collector recursively
deletes only the recorded bundle, rejects another device or changed object,
protects the live application, and only attempts `rmdir` on its empty parent.
It never scans by path prefix or recursively deletes the entire temporary parent.

`[shipit-cleanup]` logs `cleanup-source`, `cleanup-stage`, and `cleanup-previous`
results, attempt and elapsed time. Per-item failures stay pending. The original
helper attempts cleanup after launching; the packaged application's confirmed
workbench readiness starts a nonblocking cleanup-only request with bounded retries.
Any later application startup can retry remaining user-owned work. Root-owned
work remains in root's journal and is retried by the original launchd service with
backoff, rather than granting the ordinary application root filesystem authority.
The local recovery checks cover process interruption. Recovery of the privileged
launchd job across an operating-system reboot remains unverified.

The private helper entry is `ShipIt ___cleanup___ <jobLabel> <canonical application>`.
It cannot install or choose garbage paths: journal validation decides eligibility.
Lock contention and incomplete work return nonzero. Installer recovery processes
committed records before waiting for the old application or considering rollback,
including renamed applications. A successful launch is recorded to avoid repeatedly
opening the application during cleanup retries.

## In-process Squirrel handoff timing

`handoff.patch` and `handoff.h` record housekeeping, feed transfer, temporary
directory preparation, archive transfer, archive write, unarchive, bundle discovery,
candidate verification, request write, helper launch and archive removal. The
interval is owned by `SQRLUpdater`, before ShipIt installation starts.
One-result signals end before forwarding their value; completion-only signals end
before forwarding their terminal event. Errors and disposal keep their original
behavior. Subprocess construction is deferred where needed so timing includes the
actual archive operation.

`[squirrel-timing]` includes wall-clock milliseconds for correlation and monotonic
elapsed milliseconds for duration. No URL or path is logged. The native directory
owner resolves `Squirrel_timing.log` in its existing cache; writes are bounded to
64 KiB, reject symlink/hardlink/non-owner files and never wait on a log lock.
The framework build gate checks original exported ABI coverage and executes the
replacement dylib with real ReactiveObjC and archive operations. This does not
prove a complete signed Electron update.

The application collects bounded ShipIt and Squirrel timing log tails into `logs/update.log`
on startup. Native records retain their original timestamps and PID; the enclosing
collection timestamp is not the operation time. Logs remain best-effort evidence,
not installation authority.

## Candidate ownership and pre-acquisition failure

Squirrel takes ownership of the private candidate before checking its signature.
The prepared snapshot therefore precedes a legitimate owner change. Before that
mutation, `SSPreparationBeginOwnership` persists intent; candidate copying refuses
an outstanding intent. After a
successful signature check, `SSPreparationAcceptOwnership` persists the new owner
snapshot only when the request binding, paths, parent identities, bundle and
Contents device/inode identities are unchanged, and both owners match Squirrel's
real UID. Ordinary admission remains an exact snapshot check. A failed atomic
save preserves the prior snapshot and prevents installation.

A nonretryable error inside admission is classified as a pre-acquisition terminal
error, retaining the original error as its cause. The terminal path still has to
prove the original target identity and write bound failure evidence before the
Desktop can resume service. If ownership completed before signature failure,
recording that failure may accept the same narrowly pinned owner transition; it
never authorizes installation. Errors after target acquisition retain the existing
rollback and recovery path. Unknown historical handoffs remain unconfirmed until
native evidence proves their outcome; do not clear their state to resume service.

## Durable terminal publication

**current (source)**: newly created preparation records declare `terminalVersion`.
After recovering and freshly verifying the original target, failure completion
atomically commits an exact private publication in the Preparation journal before
publishing the source-parent acknowledgement. The publication binds its version,
source, target, failure target, candidate, directory, request binding and failure
code. It is the terminal commit point; the cache acknowledgement is a compatible
notification, not the only durable terminal authority. A failed notification still
fails completion and cannot authorize application launch. A failed private save
cannot publish the notification or launch, and does not promise zero disk writes.
Uncertain journal synchronization or checked descriptor closure poisons the
Preparation qualification for that process. A later copy/recovery attempt cannot
reuse it; remaining qualification locks stay held until process exit. A new
process must reopen and validate the actual complete on-disk state afresh.
The tool bridge reads the Owner's typed uncertainty status immediately after an
observation and retains its temporary pins before reporting `ERR_TERMINAL_RELEASE`;
it must not release maintenance domains first or infer qualification from a
generic I/O error. Querying that status does not close or repair qualification.

New-protocol records without a committed publication cannot fall back to an ack.
Malformed or unknown protocol/publication fields refuse rather than downgrading.
Legacy records retain the original exact bound-ack requirement and are never
automatically migrated when evidence is missing. A valid new publication must
still freshly prove the original target restored. Historical candidate/directory
captures remain bound; extant identities must match and known collection must be
proved through the owning no-follow namespace checks, not inferred from a failed
read. Permission failures or changed namespaces remain Unknown.

While the failed record remains current, its same-source request cannot resume an
old installation. An independently authorized new source may advance preparation;
this is not a permanent replay ledger across all subsequent journal replacements.
The original signature, online activation, binding and installation gates remain.

**gap**: durable publication does not replace an installed older helper or make a
legacy orphan complete. Controlled TS record recovery below still preserves Native
evidence. The bounded supersession protocol below is separate from terminal failure
recovery; neither clearing an arbitrary journal nor rebuilding an acknowledgement
is permitted. Signed-source update acceptance remains independent of native contracts.

## Automatic legacy orphan supersession

**current (source)**: before installation authorization, ShipIt may supersede an
exactly qualified legacy failed preparation while handling a fresh request. This
does not claim the historical target was restored. It permits a currently valid,
independently authenticated installation to prepare its explicitly selected next
update even when the old target identity changed and temporary payloads disappeared.

Preparation and Cleanup locks remain held. The legacy record must have the known
bound ready/failure shape, no ownership intent or terminal protocol, and identical
original/failure-target captures. Its source and complete private candidate directory
must both be absent under no-follow ancestor traversal; live paths, symlinks, unknown
fields, permissions errors and uncertain closure refuse. There is no age-based
expiry, device-number normalization, historical directory deletion or ack fabrication.

Automatic supersession and independent orphan repair allow completed Cleanup
records whose launch is recorded and whose cleanup list is empty. An unconfirmed
launch or pending cleanup blocks recovery. The complete Cleanup journal remains
part of the proof, and its committed records continue to guard against replay.

自动接管和独立修复都允许已确认启动且待清理列表为空的历史记录。尚未确认启动或仍有待清理项时，
恢复流程会停止。完整的 Cleanup 日志仍参与核验，已提交记录继续防止旧请求被重放。

The successor must use a different request ID and source under the same update cache,
and the same target path. Its live native request must exactly match the frozen
request, remain unauthorized for installation, and have no pending rollback preference.
Both current target and new source undergo offline strict, all-architecture and nested
code validation against the running helper's Apple Developer ID Team and requested
bundle identity. Ad-hoc helpers cannot grant this qualification. Native model URLs
are serialized to their JSON wire representation before comparing the request.

After verification, source/target captures, both qualifications, Cleanup state and
the exact Preparation journal snapshot are checked again. Original journal bytes
are retained in an immutable `superseded-<sha256>.plist` within the private Preparation
directory, and a deny-only ledger entry binds the old source to that journal before
the active journal is atomically cleared and synchronized. An
interrupted owned archive stage can be retried; an existing archive must match exactly.
Archive publication uses exclusive rename, and uncertain synchronization/close poisons
the qualification. Normal request binding, candidate copying, final signature checks,
fresh online authorization and official Squirrel replacement still follow. No launch,
user-data change or old installation replay is authorized by retirement.

An unqualified historical failure is published only as a failure notification for
the current request, ending the current helper demand rather than repeatedly exiting
with an unobserved error. That notification is not proof of the old transaction's
terminal outcome and does not relax Desktop startup admission.

**required / gap**: `succession.test.m` covers the missing-payload/replaced-target
shape, native request retirement, interrupted continuation and refusal boundaries.
Native contracts do not replace the signed product lifecycle. Already installed old
helpers cannot acquire this protocol from a target-only update; use the independent
signed repair entry below rather than overwriting the installed helper. Windows does
not compile or execute this protocol and retains Velopack.

## Independent signed repair entry

**current (source)**: normal macOS activation has two phases. Archive/source trust,
native preparation and the bound downloaded receipt precede preference quiescence,
Serve maintenance and launch-context persistence. Preparation does not block the
workbench. A maintenance/authorization refusal resumes writers when their release
is known, and reuses only the same ready native request, candidate and archive.
Installation authorization is refreshed again after a clean backend shutdown and
checked synchronously with the binding immediately before native quit-and-install.
A transient authorization outage at that boundary exposes a retry of the retained
ready request, not a new preparation or replayed grant. Signature, binding and
transaction failures do not enter transport retry. HTTP/network/read contention
retries are bounded to three attempts; cancellation interrupts backoff.

The repair action uses the native App picker to select an independent official
signed App. Its sealed product policy must advertise `update_repair_protocol: 1`,
the expected Team/bundle and distribution lane. Before interrupting the running
client it checks signature/capability and an `orphan-plan` observation under the
existing native locks. This plan permits a live source family, has a different
proof kind, exposes no mutation method, and is never execution authority. The
independent worker reacquires full unexempted qualification after normal shutdown.

An independently opened newer App cannot acknowledge an unbound transaction or
one belonging to another installation. Before storage admission the refusal surface
offers the native repair wizard; `--repair-update` explicitly selects the same
wizard. It requires the installed target and all three original existing roots,
then calls the same interrupted-transaction recovery core. No renderer, default
profile or backend is opened by this route. Busy qualification permits at most
three explicit checks; partial mutation, uncertain release, signature and binding
failures stop. Success means update capability was recovered, not that an update
was installed; the original App is reopened to use its normal update path.

The source UI reports non-modal preparation, saving/exit and handoff, never a
premature restart. Cancellation disappears once handoff begins. A context-bound
new build reports startup until real backend/main-workbench health confirmation,
and only then reports verified completion. Windows retains Velopack ownership and
does not expose macOS repair; its source-side final phase is handoff, not restart.
**gap**: signed macOS recovery/update/re-update and native Windows product acceptance
remain required after the authorized MR merge. Fixtures and a source compile do
not satisfy either product gate.

**current (source)**: a newly signed Desktop App can run its bundled `repair.node`
before normal startup admission, without replacing the old installation first:

```sh
open -n "/absolute/CI-signed/ScholarSeed.app" --args \
  --repair-update-target=/Applications/ScholarSeed.app
```

The target must be one explicit canonical installation and must differ from the
running repair App. Development and non-macOS invocations refuse. Normally quit the
target App and its owned backend/runtime family first. The repair process
does not kill processes, disable security policy, launch a backend or publish a
storage profile. Its own App, the installed source and the retained candidate must
pass the expected Developer ID Team/bundle checks; an ad-hoc repair App cannot mutate
product state. The candidate must still match the original selected build. No scan
of unrelated profiles or selection of a newer update occurs.

`repair.ts` derives the exact native owner directories from the OS cache/Application
Support resolvers and the selected bundle. It reads that installation's retained
launch context, never the repair App's default profile. `restoration.ts` reuses the
existing maintenance group, context-write lock, immutable intent, write-ahead markers
and mutation reservation. `repair.node` holds existing Cleanup and Preparation locks
in that same process; it does not create missing locks. The native observer validates
real process absence, the original data-root identities, the legacy orphan, and the
current bound request's explicit lack of installation/launch permission. A missing
downloaded-event `nativeRequest` is allowed only in this separate orphan protocol;
normal terminal inspection remains unchanged.

Cleanup maintenance is observation-only: it opens the existing private lock without
creation, freezes the journal baseline, and refuses every Cleanup mutation with
`EROFS`. `SSCleanupMaintenanceSnapshot` observes Cleanup, not Preparation; ordinary
read-only and writable sessions cannot use each other's snapshot entry. An absent
journal is a successful, repeatable observation without a spurious `NSError`.
Reread current/archived preparation plists must be dictionaries before field access;
malformed roots or records refuse without native exceptions or evidence mutation.

The independent CLI handles terminal recovery only; orphan recovery and orphan
intents require the signed App entry. Probe limits and schema come from the terminal
protocol owner, while storage-identity schema is independent of intent schema.
Before storage admission, repair begin/completed/failed diagnostics use the OS log
with selection presence and successful request/build identifiers, not private paths
or a product log that would require opening a profile.

`compilation.cjs` owns shared repair flags, frameworks and support units; both native
modules and recovery tools fingerprint that recipe. Native contracts directly cover
maintenance guards, malformed journals and succession/parking refusals. Parking
refusal tests count a test-local `SMJobRemove` stub and require zero calls; they do
not prove successful signed trust or actual launchd removal. Those positive product
paths still require the merged, formally signed App and the original machine state.

An old failed helper may remain in a two-second launchd respawn loop even after the
App exits. Under both native locks, repair can park only the exact matching user-domain
job: label, three original arguments, canonical signed installation helper and bound,
unauthorized native state must match, with no rollback ownership. The signed repair
host, target and candidate must pass the same Developer ID trust policy. Before removal,
process evidence may exempt only that job's exact user-owned PID/start identity and
verified executable; source/target processes, foreign helpers and uncertain evidence
still refuse. `SMJobRemove` waits for that one job; the normal, unexempted process
observation must then prove absence. No process-name kill, system-domain removal,
launch-agent file deletion or privileged fallback occurs. The old updater can submit
a fresh job normally. Only released lock/parking contention gets bounded pre-transaction
requalification; signature, binding and uncertain-release failures do not retry.

After durable intent and mutation reservation, native repair first retains the exact original
Preparation journal and native request in separate private SHA-256 archives, retires
the qualified legacy record and consumes only that unauthorized native request.
Desktop then consumes the context and handoff, and completes the existing mutation reservation.
No rollback preference is cleared. Normal installation authorization is never replayed.
Fresh snapshots and held qualifications fence every record consumption.
The runtime receives its native capabilities explicitly; standalone tool discovery,
compilation and probe execution remain in `scripts/recovery.ts`, not the product bundle.

If interrupted, the same explicit repair target finds at most one unfinished,
validated orphan intent in its own recovery directory. A committed intent can also
resume the startup handoff if context, handoff and native request are all still
absent, covering interruption after commit but before relaunch. It never picks the latest
file by age. The retained native proof can continue across an empty Preparation
journal or a missing native request only when the exact private archives, source and
target captures, qualifications, selection and binding still match. A re-created
same-byte request inode, new preparation, changed scope, malformed marker, ambiguous
intent or uncertain release refuses. Unknown states cannot be converted to success.

Some older clients remove the launch context on a pre-download timeout while leaving
the failed handoff and unauthorized native request. That is a separate supported
entry, not permission to fabricate an old context. With no unfinished repair intent,
all three existing directories must be explicitly supplied; there are no defaults:

```sh
open -n "/absolute/CI-signed/ScholarSeed.app" --args \
  --repair-update-target=/Applications/ScholarSeed.app \
  --repair-update-home="/absolute/original-home" \
  --repair-update-user-data="/absolute/original-userData" \
  --repair-update-workspace="/absolute/original-workspace"
```

This creates a schema-2 `mac-orphan-selection-recovery` intent with `context: null`.
Its newly authorized selection is bound to freshly observed native persistent root
identities, the signed installed source build, failed handoff and selected candidate.
It fences continued context absence instead of writing or consuming a synthetic
launch context. A new context, conflicting explicit selection or unknown directory
identity refuses. The same original intent can resume after native state retirement
without requiring the caller to re-enter the directory arguments. These supplied
paths must be verified as the user's existing selection; absence of a context does
not prove what the old selection was.

After recovery, Desktop reads the signed source's executable identity and reopens
that original installation with its original Home, userData, workspace and explicit
local debug port. It does not copy databases, credentials or preferences. The user
can retry the already selected update through the original updater, now without the
orphan fence. This is an out-of-band repair entry for an old binary, not a claim that
old clients download or execute new code without a trusted delivery path.

**required / gap**: the native/core and transaction tests are distinct from actual
acceptance. CI must provide the signed repair App. Acceptance must use the affected
installed source and original persisted state, run repair, reopen with the same
profile, finish the selected update and exercise another update. A local untrusted
framework execution refusal remains a failed gate; neither an unsigned App nor
fixture success proves the signed installed lifecycle.

## Read-only terminal recovery preflight

**current (internal foundation)**: `retirement.h` maintains a bounded, deny-only
`retired.plist` beside the preparation journal. Entries bind an explicit operation,
source/target paths, archived request digest and archived journal digest. The ledger
is synced before the journal is cleared, survives independent later transactions,
and never evicts old entries to make room. Missing legacy sources and acknowledgements
do not require manufacturing new failure evidence. Candidate and application files
are retained. A malformed ledger or uncertain write refuses progress.

`SSPreparationRetireRequest` requires an existing exclusive preparation qualification
and an empty, stable cleanup owner. It revalidates the named preparation directory
and lock against their held identities, and the current journal against the loaded
transaction before writing. It rejects read-only qualification and cannot clear a
newer journal on retry, including when the cached transaction was empty. The API is an internal primitive, not a user recovery
command or independent authorization to retire anything.

**current (source)**: the signed repair App supports explicit retirement of a
retained request, including absent source/ack, an unbound legacy journal/request,
and a replacement target parent. Run a separate signed copy, so the installed
target and its processes can remain stopped:

```sh
"/absolute/Repair/ScholarSeed.app/Contents/MacOS/ScholarSeed" \
  --repair-update-target=/Applications/ScholarSeed.app \
  --repair-update-mode=retire
```

The target must already contain the ledger-capable helper. The tool verifies its
Developer ID signature and sealed receipt, including the actual helper Mach-O
fingerprint and retirement overlay. An older target must first be replaced by the
new signed CI package. No local signing or installer replacement is performed by
recovery. If the launch context is absent, supply all three explicit original
storage selections described above; the tool never guesses a profile.

Data-domain and launch-record locks precede native qualification and service
parking. Only the exact user-domain label, helper path, arguments and PID/birth/UID
match can be stopped; system-domain jobs or unavailable service/process evidence
refuse. Original native bytes are archived before service removal. Original TS
bytes and native proof are held in a durable intent before consumption. The old
source is denied durably before the journal advances; candidates and applications
are retained. Partial private ledger staging is reconstructed on retry. Native
and TS consumption is resumable and refuses new records or changed inodes.
Unbound TS handoffs use a hash of their original bytes as a deny-only operation
identifier, never as fabricated installation authorization. Orphan succession
binds its deny entry to the archived legacy journal when old request bytes are
already unavailable. Existing read-only `inspect` and strict source `apply`
retain their previous prerequisites. Signed CI/fault-machine validation remains
post-merge acceptance; native/TS fixtures are not that acceptance.

**current (source)**: `scripts/recovery.ts` is a macOS-only stage-1 inspection
entry. It correlates one retained launch context and Squirrel handoff with the
existing native failure journal, acknowledgement, ShipIt state and pinned
application/storage identities. It does not recover or consume that transaction.
Windows does not build or execute this probe.

Build and inspection are separate explicit commands, run from the repository root
with the repository-supported Node. No command discovers a profile or installation
by scanning user data:

```sh
node --experimental-transform-types apps/desktop/scripts/recovery.ts build \
  --output "/absolute/private-parent/recovery-tool"

node --experimental-transform-types apps/desktop/scripts/recovery.ts inspect \
  --application "/absolute/installed/ScholarSeed.app" \
  --coordinator "/absolute/existing/coordinator" \
  --handoff "/absolute/existing/squirrel.json" \
  --native-state "/absolute/existing/ShipItState.plist" \
  --preparation "/absolute/existing/CandidatePreparation" \
  --cleanup "/absolute/existing/cleanup-owner" \
  --tool-directory "/absolute/private-parent/recovery-tool" \
  --expected-team "EXPECTED_TEAM_ID"
```

Replace every placeholder with an explicitly verified scope. Paths must be
canonical absolute paths, without symbolic-link ancestors. The application is the
original installed application named by the retained context, not an extracted
next-update candidate. The coordinator holds that application's launch context;
the handoff and native paths must belong to the same failed request. Supply the
expected ten-character signing Team explicitly from trusted distribution metadata;
it must match both the installed application's policy and its verified signature.

`build` requires native macOS arm64/x64 Command Line Tools. Its output must be new
or an empty current-user private directory, with an existing parent. It compiles
only the local probe and writes its private executable/manifest; it does not
download, create a signing identity, invoke a signing operation, install or inspect
product state. The compiler's default local ad-hoc code directory is not formal
distribution signing. `inspect` resolves that exact source-fingerprinted tool
directory without building, repairing or accepting an arbitrary executable path.
Its signature operations verify/display the existing application; they do not sign it.

**required**: before terminal failure can be observed, normally quit every source
and target application instance, their owned backend/runtime processes, and their
ShipIt helpers. Native process inspection scopes executable paths to the source
and target application trees, including canonical aliases. A resolvable third-party
ShipIt (for example VS Code's) does not block recovery. If `proc_pidpath` returns
`ENOENT` after an executable's old directory was removed, the observer uses the
kernel's file-backed native image mappings to establish ownership. It walks the
public region iterator to its end (at most 4096 regions), requires a native
executable mapping, and compares two mapping snapshots between three unchanged
PID/birth/UID observations. Every mapped vnode path is checked against the owned
source/target trees, including the prepared candidate selected by maintenance.
An owned image still blocks even when its directory entry has been removed.
The kernel's vnode path and device/inode identify the mapped image; a process
name, argv path, current replacement file or vendor allowlist cannot substitute.
On native Intel macOS, the anonymous 4 KiB RX commpage submap is excluded only
when its boot-selected address and attributes match the observer's own commpage,
within XNU's reserved range beyond the ordinary user VM limit. Both current and
maximum permissions must be exactly RX, inheritance shared, and the kernel must
report a submap with no vnode. Submap object IDs are zero and are not identity
evidence. This exception is disabled on arm64 and under Rosetta.
`repair.test.cjs` compiles the production kernel reader and checks real unlinked
child images: third-party is absent, owned is active, and additional ordinary
anonymous executable memory remains unknown. Native Intel additionally requires
the actual kernel commpage; synthetic contracts or arm64 runs do not prove Intel
acceptance. The layout follows Apple's
[comm region mapping](https://github.com/apple-oss-distributions/xnu/blob/xnu-8792.61.2/osfmk/vm/vm_shared_region.c)
and [region reporting](https://github.com/apple-oss-distributions/xnu/blob/xnu-8792.61.2/osfmk/vm/bsd_vm.c).

The default macOS native contract check runs seven ShipIt repair tests. Run the
four real kernel mapping integration tests separately from the repository root
on macOS, using a new output directory and a Node process native to the host
architecture:

```sh
node apps/desktop/scripts/shared/native.cjs --output /absolute/path/to/new-directory --shipit-mappings-integration
```

macOS 默认原生契约检查运行 7 个 ShipIt 修复用例。其余 4 个真实内核映射集成用例
使用上面的命令单独执行。请在仓库根目录运行，指定一个尚未创建的输出目录，并使用与
宿主架构一致的原生 Node 进程。

Missing/partial vnode evidence, other anonymous executable mappings, permission errors,
mapping drift, limit/deadline exhaustion and other path errors still refuse.
This fallback never grants the exact-helper parking exemption. It does not scan
another application's data, stop its processes or require its update to finish.
The kernel semantics are documented in Apple's
[process observation implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/proc_info.c).
Closing a window is not proof of exit. The tool does not stop product processes;
active owners, busy/missing locks, unavailable process evidence or mismatched
records must refuse inspection. Native observation opens existing safe records
and locks only; it does not create missing locks or repair a journal.

Successful inspection reports `outcome: terminal_failure_verified`,
`mutationPerformed: false` and `executionAuthority: false`. It performs zero
product-state writes: launch context, handoff, native journal, acknowledgement,
ShipIt state, application and user data remain unchanged. `build`'s corresponding
mutation field also refers to product state, not its explicit tool-directory writes.
An observation is a point-in-time diagnostic, not a reusable recovery, startup or
installation permission; its native locks are released before it returns.

**required**: inspection does not clear either record or resume an old installation.
Keep the already prepared, explicitly selected target unchanged; inspection does
not select a next target or silently substitute a newer build. A subsequent update
still requires normal public selection, trust checks and fresh user authorization.

## Controlled terminal record recovery

**current (source)**: `scripts/recovery.ts build-maintenance` additionally builds
the fixed-source `lease.node` and tool-only `terminal.node`. Both load into the
same Node process. A separate holder child cannot qualify mutation: its death
could release native locks while the parent continues consuming records.
Supply explicit local Node headers and license archives; their size and SHA-256
must match `native/toolchain.json`. There is no download or signing fallback.

```sh
node --experimental-transform-types apps/desktop/scripts/recovery.ts build-maintenance \
  --output "/absolute/new-private-tool" \
  --headers "/absolute/local/node-headers.tar.gz" \
  --license "/absolute/local/NODE-LICENSE.txt"
```

`apply` takes all the explicit `inspect` flags plus `--request-id` containing the
exact bound request ID. It does not accept `--force`. The handoff must be the
owning Squirrel path under the context's original Home. It verifies the original
application's offline signing policy, build, storage identities and native
failure afresh; an inspect digest is not execution authority.

The opaque native holder retains existing Cleanup then Preparation locks and
storage pins. It is singleton and generation/env/thread/PID-bound; stale objects,
GC and worker teardown cannot release another holder's qualification. Every
observation uses kernel PID/start/UID identity and the real executable image,
not mutable `ps comm`. Incomplete enumeration, observed executable-image changes,
PID/birth/UID mismatches, permission failure, active applications/helpers or an
uncertain close still refuse. These point-in-time checks are not a continuous
exec or application-startup barrier.

Snapshot-delta diagnostics emit at most eight differences, with kernel-reported
short names and current parent PIDs retained from the same inventory. These are
untrusted diagnostic hints, not executable identity or proof of creation ownership;
neither field participates in admission. Names are bounded and escaped, and no
arguments, environment or full executable paths are collected for these hints.
Each activity observation starts one monotonic two-second deadline and retains a
complete kernel identity inventory, including other UIDs. Only successfully
classified live identities enter that observation's coverage. If the next complete
inventory is already covered, the original two-inventory path can finish. Otherwise
only genuinely new scoped live PIDs receive one batch of the same identity and
executable-image checks, followed by an independent final inventory. Another new
live PID, identity drift involving a previously or currently scoped process, SIDL,
zombie revival, failed inspection or missing live coverage refuses; there is no
second batch, retry of a failed PID, deadline reset or cross-observation cache.
The batch is not truncated to the diagnostic limit, and unchanged process totals
never prove coverage. Diagnostics do not exempt a background service or convert an
Unknown result into recovery authority. This enlarged instantaneous-coverage
contract is not a continuous exec/startup barrier: the operator must keep other
application instances closed throughout the authorized recovery.

`restoration.ts` takes one maintenance group over Home, userData, workspace,
context and handoff directories, then the context record lock. It reuses
`reserveMutation` rather than creating another startup fence. The old 1043 update
guard enters that context writer before a new Squirrel request, so its new-update
guard is fenced; this is not a global old-application startup guardian.

A private `terminal-recovery/<request-id>.intent` preserves original bytes,
record identities, scope, storage selection and native proof. Immutable,
flushed write-ahead markers authorize only their own exact record's forward
consumption. The context is consumed first and handoff last through pinned
`consumeAt`; new bytes/inodes, partial or foreign markers and unknown absence
refuse. A committed marker precedes mutation-reservation retirement. Interrupted
operations resume only the same intent under freshly reacquired qualification;
they never reconstruct an old context or replay installation authorization.

`apply` preserves App/Contents, the native journal, acknowledgement, request and
user data. Its result retains the original startup selection and performs no
launch, model call or installation. `release_uncertain` requires process exit;
remaining qualifications are retained, including when a nested inspector fails.
The CLI reports possible mutations and committed state rather than falsely
claiming zero writes after partial consumption.

**gap**: signed-product recovery and subsequent normal-update acceptance are
independent of these filesystem/native contracts. Windows refuses this recovery
flow; its `consumeAt` platform refusal is not Windows installer acceptance.
Changed runtime identities after reboot still refuse rather than being repaired.

## Acceptance boundary

A native compile or signal test does not prove signed installed-update behavior.
Deploy a signed diagnostic build, then perform another real update initiated by
that build, and verify which helper executed. An update initiated by an older
helper does not gain timing merely because its target contains the new helper.
Verify successful restart before cleanup, matching stage IDs, failure retry,
interrupted cleanup recovery and bounded diagnostic collection. Formal signed
packages come from CI after MR merge. Local native contracts and ad-hoc fixtures
are development evidence, not signed installed-product acceptance or screenshots.
