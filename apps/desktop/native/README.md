# Process-owned storage coordination (in progress)

`lease.c` is the narrow Node-API kernel primitive for Desktop data-domain
coordination. `acquire(absoluteFile, exclusive)` returns an opaque lease;
`release(lease)` closes its private OS handle. Locks are nonblocking macOS
`flock` or Windows `LockFileEx` over byte zero. Admission and occupancy must use
different permanent files: shared-to-exclusive lock conversion is not a
transaction. Files are never unlinked by this module.

POSIX slot creation uses `O_CREAT | O_EXCL`; only `EEXIST` permits opening the
existing slot without `O_CREAT`. This avoids the observed concurrent ordinary
`O_CREAT` failure on macOS without retrying `ENOENT`. If the slot disappears
between those two calls, acquisition fails instead of creating a second lock
namespace. Both opens retain the no-follow, close-on-exec and nonblocking flags.

GC and N-API environment teardown **do not release live leases**. A lost JS
reference or a terminated Node Worker does not prove application IO has ended.
The main composition owner must retain each lease and release it only after its
actual writers drain; process death is the final kernel cleanup. Closed leases
are reclaimed by GC. Lost live/uncertain leases deliberately remain held until
process death. Failed close is an error, never a successful release receipt.

The module rejects invalid/relative paths, embedded NUL, nonregular leaves,
symlink/reparse leaves and multiple hardlinks. POSIX leaves must belong to the
current effective user. Windows lock-file handles deny deletion while held. These are
leaf checks, **not full ancestor/ACL or data-domain authorization**. Callers must
establish trusted directory ownership and identity before opening a permanent
coordination file. An advisory lock does not prohibit same-user path mutation on
macOS. Product migrations must coordinate source and target domains; no inode
path spelling substitutes for that protocol.

The primitive does not attest data compatibility, a signed candidate or an empty
process family. Chromium/backend descendants may survive their parent; activation
still requires their actual ownership/exit evidence in addition to leases.
The Windows hook binds imports to the running Electron/Node image without a PATH
lookup. Desktop startup now supplies this library to storage's initial pointer
reader. That read binds a directory object, but does not admit writers or enable
activation. Full data-domain startup and migration remain in progress.

## Directory capability

`pin(absoluteDirectory, create, role = "private")` returns an opaque directory
capability. All roles retain local-volume, no-follow/reparse, identity and
relative-IO checks. On macOS the default `private` role checks owner and writer
authority. On Windows ordinary `private` data follows actual OS access rights;
extra SID grants or another owner alone do not reject startup. Existing ACLs are
not rewritten, and newly created records still receive private descriptors.
Explicit `project` roots permit shared/sandbox writer grants and rely on the OS
access check for each requested operation; Windows project reads do not request
`READ_CONTROL`. PROJECT record creation and lock operations retain their existing
strict authority checks. Child directory checks and data reads/listing inherit the role.
Coordination slots remain cooperating-process locks, not protection against
OS-authorized hostile writers. No existing ACL is repaired. Optional creation creates only the final directory.
`identity(pin)` returns the opened directory's device/file identity, never a
path hash. `acquireAt(pin, leafName, exclusive)` opens the single coordination
file relative to that capability. Names are bounded lowercase ASCII letters,
digits, dots, hyphens and underscores, without a leading/trailing dot. The same leaf and
permission checks apply when opening existing files.

On macOS, a root-owned ancestor writable by the privileged `admin` group
(gid 80), with no world-write bit, is permitted. This includes the standard
`/System/Volumes/Data` mode 0775 on macOS 13. The exception never applies to
data leaves, ordinary groups, non-root owners or extended ACL write grants.
Python and the native library enforce the same rule; group-writable data leaves
and untrusted ACLs remain rejected. Permission diagnostics include the checked
logical or physical path, uid, gid and mode without changing that directory.

Windows retains every ancestor without deletion sharing. The `installation`
role additionally checks owner/DACL authority at the installation root and every
internal child/record against the current user, SYSTEM, Administrators and the
Windows installer service; external ancestors retain structural checks only.
This role survives child pinning and cannot downgrade to ordinary data policy. OWNER RIGHTS ACEs used by Codex apply only to the actual owner
after that owner passes the same authority check. The alias never qualifies an
object owner or permits foreign writers; kernel access checks still enforce deny
ACEs. See [Microsoft's SID definition](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-dtyp/81d92bba-d22b-4a8c-908a-554ab29148ab).
This does not guarantee that every pinned directory cannot
be renamed: the attributes-only leaf handle permitted rename on the tested
Windows host. Namespace revalidation is required on both platforms.
The first handle must resolve to a physical volume GUID root;
UNC, remote mapped drives and SUBST roots are unsupported. POSIX checks effective
user/root ownership, mode bits and extended ACL write authority. Sticky trusted
ancestors can contain the current user's private temporary directories. macOS
requires local filesystems and uses `openat`; relative IO stays on the pinned
directory even if the same user renames it. This does **not** make Chromium's
ordinary pathname IO safe against concurrent rename.

Windows `acquireAt` uses `NtCreateFile` with the retained directory as
`RootDirectory`, matching POSIX `openat`. Renaming the pinned leaf and creating
a replacement at its old pathname must not redirect a new coordination-file
open. Existing files are opened without truncation; missing files are created
on the pinned object. This relative-IO guarantee complements the domain owner's
namespace revalidation; it does not make a changed pathname valid for writers.

`readAt(pin, leafName, maxBytes)` reads a regular file relative to the retained
directory and returns a Buffer. Only an absent leaf returns `null`; reading never
creates a file. Names use the same single-component grammar as `acquireAt`.
`maxBytes` must be an integer from 1 to 1 MiB. Links, unsafe write authority,
oversize files and metadata changes during the read fail explicitly. The same
handle supplies permissions, size, bytes and final metadata; it is closed before
returning success, and an uncertain close is reported as `ERR_LEASE_RELEASE`.
Windows opens with only read sharing, so an existing writer causes an error,
not a missing-file result. POSIX opens nonblocking and rejects special files
before reading. The caller still owns domain qualification and namespace
revalidation. These checks do not promise an atomic snapshot against arbitrary
same-user in-place mutation; cooperating writers must use the same protocol.
Pointer JSON/schema interpretation remains outside this native filesystem API.

`createAt(pin, leafName, Buffer)` exclusively creates a nonempty record of at
most 1 MiB. It never replaces an existing entry. Windows uses write-through
creation and FlushFileBuffers; macOS flushes the file and parent directory.
Failure retains any partial record for the owning protocol to recover, rather
than deleting evidence or treating a retry as permission to overwrite it.

Darwin `consumeAt(pin, leaf, expectedBytes, expectedDevice, expectedInode)` consumes
one nonempty record only while its caller already owns the namespace maintenance
qualification. Device and inode are canonical unsigned decimal strings, not JS
numbers. The primitive revalidates the pinned directory's original namespace,
private leaf permissions, current UID, regular single-link identity, bounded stable
bytes and leaf binding before `unlinkat`, then synchronizes the parent directory.
Missing records, replaced inodes, changed bytes, links and zero-byte coordination
slots refuse consumption. `ERR_LEASE_SYNC` or `ERR_LEASE_RELEASE` means the result
is uncertain: the pin is poisoned, no retry is permitted, and the owning recovery
intent must remain until a fresh process requalifies it. Windows returns
`ERR_LEASE_PLATFORM` before filesystem access; there is no pathname deletion
fallback. This is an advisory cooperating-writer protocol, not protection against
same-UID hostile rename, installation authority or a multi-record transaction.

`listAt(pin, maxEntries, maxBytes)` returns own enumerable Buffer properties
for a dedicated flat record directory, including names such as `__proto__`.
The limits are 1–4096 entries and 1–1 MiB for both each record and total payload.
Invalid names, unsafe objects, duplicate/missing entries, incomplete enumeration
and exceeded limits fail without returning a partial inventory. The caller must
hold the namespace qualification shared by every publisher and cleaner; this is
not an OS snapshot. macOS opens a separate relative directory description;
Windows uses an empty native relative name to reopen the retained directory,
checks its physical identity, then enumerates with an aligned NT buffer.
These primitives do not publish family authority or permit metadata deletion.

Use `release(pin)` only after releasing all its child leases; otherwise it fails
with `ERR_LEASE_IN_USE`. GC/environment teardown keeps both pins and child locks
alive. Close failures remain uncertain and are never retried. No API removes
directories or coordination files. Failed creation/validation may leave a newly
created empty private directory rather than guessing ownership for cleanup.

Actual startup still needs to select permanent coordination identities outside
moved data roots, hold admission/occupancy in the shared protocol, verify actual
data generations and coordinate all migrations. This capability is the filesystem
boundary for that owner, not an implemented writer-admission policy. Network
storage support and real SMB/NAS acceptance remain unresolved.

## Hierarchical domains (kernel protocol, not product admission)

`lineage(pin)` returns the identities of validated, retained ancestors and the
selected directory last. On macOS the capability also opens and verifies the
handle-derived `F_GETPATH` and `F_GETPATH_NOFIRMLINK` spellings. Their leaf must
match the original object. The union includes both logical and physical APFS
firmlink ancestors; ordinary realpath is insufficient. It is a snapshot, not a
promise that a later namespace move cannot invalidate the topology.

`domains.cjs` owns the shared two-phase protocol over existing pins. Its
`beginDomains(native, coordinationPath, roots, maintenance, roles = {})` closes admission;
`roles` maps selected root paths to `private` or `project` and is retained during
revalidation. Conflicting roles for one physical identity are rejected;
`occupy()` acquires occupancy nonblockingly. A maintainer retains admission while
occupancy is busy so existing writers can drain without new arrivals. A writer
must check actual data compatibility **before** calling `admit()` to release
admission. This module does not supply that policy or authorize activation.

Every selected root uses S for a writer or X for maintenance; all ancestors use
IS or IX respectively. Each identity has two slots in each phase:

| Mode | Slot a | Slot b |
| --- | --- | --- |
| IS | shared | absent |
| S | shared | shared |
| IX | shared | exclusive |
| X | exclusive | exclusive |

This conservatively serializes maintainers sharing an ancestor (IX/IX), but an
unrelated ordinary writer may proceed. Identity/slot order is fixed; duplicate
and overlapping roots collapse to the strongest selected mode without lock
upgrades. The private permanent coordination directory must be outside every
root, determined by its validated ancestry, and must be identical for all
participants. Names encode actual object identity, never path hashes. Files are
never deleted. Runtime composition still has to choose that stable directory.

After acquiring the complete admission group, after acquiring occupancy, and
before a writer releases admission, the module reopens every original selected
path and the coordination path with native no-follow validation. Their leaf
identity and complete ancestor identity set must match the initial selection.
`ERR_DOMAIN_CHANGED` rejects a changed binding; it never silently adopts a new
root. Other native open/validation errors remain errors. Close the failed domain
session, then let the startup owner perform a complete new selection.

After `occupy()` and before writer `admit()`, `read(root, leaf, maxBytes)` consumes
the retained pin of an explicitly selected root. It revalidates every selected
root and the coordinator before and after native `readAt`; bytes are returned
only after both checks succeed. An implicit child or an unselected alias is not
a selected root. The same read phase is available to occupied maintenance.
Read failure poisons that domain session: no subsequent read or writer admission
is allowed. An ordinary failure still permits ordered `close()`; native or domain
release uncertainty instead retains qualifications until process death. This
is the metadata-reading boundary, not JSON/schema or generation validation.

A recheck pin or other resource close failure reports `ERR_DOMAIN_RELEASE`.
The session becomes unusable and retains later qualifications until process
exit, including when `beginDomains()` cannot return a session. Do not retry an
uncertain close. These are bounded checks under an advisory protocol, not an
atomic namespace freeze against uncoordinated same-user mutations after a check.
All product namespace mutators must participate in the same protocol.

After actual IO drains, `close()` releases data pins, occupancy, admission and
the coordination pin in that order. An uncertain predecessor close retains the
remaining capabilities until process death; it is never retried. Acquisition
failure cleans up partial locks, while occupancy contention retains admission.

These APIs still need actual Desktop/Serve/CLI consumers, pre-write startup
composition, protected pointer recheck, generation verification, migration and
final process-family drain.
They are not a product-level acceptance result. No legacy root may be renamed
under an ordinary shared runtime lease.

## Creating missing structure

`createChild(parentPin, name)` creates or opens exactly one direct directory,
returns its actual identity and closes the temporary child handle. POSIX uses
`mkdirat/openat(O_NOFOLLOW)`; Windows uses
[`NtCreateFile` with `RootDirectory`](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile),
`FILE_OPEN_IF` and reparse-point rejection. It never truncates, merges or deletes
existing content. Names cannot escape the parent. A renamed parent still receives
the relative operation; subsequent path revalidation must detect that move.

`ERR_LEASE_MISSING` is emitted only for a missing component during a directory
open; permissions, reparse points, invalid types and other errors are not absence.
`systemCode` retains the OS diagnostic. An uncertain directory cleanup or child
close reports `ERR_LEASE_RELEASE`; it must not be handled as a missing path.

`createDirectory(native, coordinator, parentPath, name)` holds IS admission and
occupancy on the parent's complete lineage, revalidates bindings, calls the
relative primitive and checks the resulting child identity. This is only an empty
structure operation. It does not grant recursive maintenance, seed writes or
generation authority. IS lets ordinary writers continue, but blocks an ancestor's
X maintenance. The creation ancestor may contain the coordinator because no
authority to migrate that ancestor is granted; `beginDomains` still forbids a
data root containing the coordinator.

`ensureDirectories(native, coordinator, roots)` prepares only caller-authorized
structural roots. It walks upward solely on the explicit missing error, creates
one level per qualification, and reacquires sorted qualifications at each level.
Invalid path components are rejected before creating any roots. A bounded number
of stages rejects continual namespace churn. Failed preparation may leave empty
directories; it does not guess which directories are safe to remove.

After this returns, startup must resample its pointer and acquire **all** final
data domains, verify generations, and admit writers. Existing roots and successful
creation are not compatibility proof. Any uncertain release retains later
qualifications until process exit. These APIs still require product composition.

Identity locks do not reserve an absent child name. A future transaction that
moves or replaces a child must additionally protect the affected parent's
namespace; an X on the old child with IX on its parent does not block this IS
creation operation. No namespace migration is authorized by these creation APIs.

## Build and native contracts

From the repository root, build into a new directory:

```sh
node apps/desktop/scripts/shared/native.cjs --output /absolute/new-directory
```

`toolchain.json` pins the headers, Node license, Windows compiler and Electron
import library by SHA256 and size. macOS uses the selected Apple compiler and
SDK under the capability checks below. Verified local archives can be supplied through `--headers`, `--compiler`,
`--library` and `--license`; they undergo the same checks. Compilation uses a
private temporary extraction and removes it on exit. `build.json` records the
source, compiler, input and output hashes and licenses only after success. It is
build provenance, not signing or activation authority.

Set `SCHOLARSEED_LEASE_LIBRARY` to that exact `lease.node` and
`SCHOLARSEED_LEASE_ELECTRON` to the installed Electron executable, then run:

```sh
npm --prefix apps/desktop run test:native
```

The explicit native gate requires the reviewed Node and Electron versions and
actual binaries; it does not silently skip missing build inputs. It exercises
independent Node/Electron processes, Worker environment teardown, GC, contention,
close/death and invalid leaves. This gate is separate from ordinary JS tests
because it requires compilation on the matching macOS or Windows host. It does
not replace the packaged Desktop and old-to-new update acceptance gates.

The gate also places the actual compiled library in an ASAR and asks a real
Electron process to load it and hold a competing lock. The closure verifier
accepts only `out/main/lease.node` with an explicitly supplied frozen digest;
preload cannot reach it, including through main chunks. The unpacked inventory
must contain exactly that ordinary, single-link file, with matching size and
digest; ASAR links and other unpacked dependencies are rejected. Build/Vite and
signing owners still need to supply the final signed digest and the real startup
consumer. The integration fixture is not a packaged ScholarSeed acceptance run.

### Explicit macOS recovery gate

The maintenance gate is separate from the unchanged no-argument native compiler
gate. On the reviewed native macOS/Node host, supply both verified local inputs
and a nonexistent output under an existing private parent outside the checkout:

```sh
node apps/desktop/scripts/ci/native-contract.cjs --recovery-maintenance \
  --output "/absolute/private-parent/new-tool" \
  --headers "/absolute/verified/node-v24.16.0-headers.tar.gz" \
  --license "/absolute/verified/NODE-LICENSE.txt"
```

This builds and resolves the current-source maintenance tool without downloading,
signing or installing. It serially runs `consumption.test.cjs`,
`shipit/bridge.test.cjs` and `restoration.test.cjs` against those exact addons and
self-owned fixtures, not real product records. Missing prerequisites, incomplete
Node observations, an absent suite, zero cases, any skip/failure, nonzero exit,
changed tool receipts or changed repository source/HEAD/index fail the gate.
Do not edit the checkout during execution; an unignored in-repository output also
changes its source snapshot. The private output retains `native-gate.json`,
`node-events.jsonl`, `stdout.log`, `stderr.log` and build evidence on failure for
diagnosis. Passing this native fixture gate does not authorize or prove recovery
of an installed application's real records.

`observations.cjs` records direct restoration-preparation and checked-close
fixture execution without changing the command, arguments, timeout or exit
criteria. Each observation includes the calling time window, returned PID and
status, caller identity, and executable path snapshots with content hashes.
These are not exact termination times, kernel image attestations or proof of a
signal's sender. Environment values are not collected. The evidence leaf is
reserved exclusively before execution; evidence I/O errors fail the calling
test independently of the unchanged native result. A disk record cannot attest
its own write, flush or close: consult the returned observation and test report.
Abnormal checked-close executions retain both their executable and related
fixture; successful cases keep their normal cleanup.

A valid on-disk signature is not proof of Gatekeeper admission. SIGKILL alone
does not identify a security policy or its sender. Keep policy decisions and
actual termination evidence distinct, preserve failures, and obtain an approved
development host or trusted artifacts rather than changing policy, signatures,
launch wrappers, timeouts or retry counts to turn a gate green.

## Final native artifact staging

`scripts/cd/seal.cjs` owns `prepareNative({directory, arch, artifacts, environment,
signing})`. It invokes the fixed compiler above in a new directory, preserves its
original unsigned `build.json`, signs the exact library, and freezes the final
library, provenance and licenses in `native.json`. It returns external frozen
digests, target and signing policy for the build context. No arbitrary prebuilt
library or implicit signing downgrade is accepted.

The signing policy is explicit: macOS uses `{mode: 'ad-hoc-local-only'}` or
`{mode: 'developer-id', identity, teamId}`; Windows uses `{mode: 'unsigned-dev'}`
or `{mode: 'authenticode', publisher}`. Formal Windows signing reuses the existing
signing client owner; its credentials remain in the build parent, not Vite.
Developer ID requires the expected authority/team, hardened runtime and timestamp.
Unsigned Windows validation is not formal Authenticode acceptance.

`readNative(directory, frozen)` checks the manifest against the external digest,
checks exact inventory and single-link regular files, binds file identity and
reads to one descriptor, and verifies signature and matching bytes before/after
the signature command. It returns a Map of verified filename → Buffer, including
the manifest. Bundlers must emit these buffers rather than reopening paths after
verification. This is for an exclusively owned, trusted build directory; the
path-based external signing tools do not provide an atomic namespace transaction
against uncoordinated same-user mutation.

`test:native` includes actual fresh staging compilation and Node/Electron loading.
Optional `SCHOLARSEED_NATIVE_ARTIFACTS` is a JSON map of local compiler inputs for
the **test driver**; the compiler still verifies their pinned hashes and sizes.
Tests reject byte changes, extra resources, links, same-byte identity replacement,
wrong target/signing policy, and a Node executable mislabelled as Electron.

Staging is currently independent of the product build. Vite emission, exact ASAR
unpacking, outer signing preservation and the real synchronous startup consumer
must land together. Do not add a dummy import or ship an unreferenced library to
make the closure pass. Formal signing and packaged old-to-new activation remain
unverified by these native contracts.

## Product supply and initial pointer reads

The Vite main plugin in `scripts/shared/lease.mjs` emits the exact Buffer verified by
`seal.cjs`. Development builds compile once per builder process with a local
signing policy; changing C sources or toolchain policy requires restarting the
builder. There is no path-reader fallback when the native library is absent.
`SCHOLARSEED_NATIVE_ARTIFACTS` may select local input archives by artifact name;
every selected archive must still match the fixed toolchain hashes.

Packaging compiles/signs/freezes before invoking Vite and passes one context to
built/ASAR verification. Only `out/main/lease.node` is unpacked; compiler evidence,
licenses and `native.json` ship under `resources/native`, without a second library.
Both macOS outer signers preserve only the current App's exact, verified library
and recheck its bytes afterwards. Release identity selection requires one matching
Developer ID Application for the product team. Windows uses the configured
Authenticode publisher. Local builds are not formal signed release evidence.

Storage's initial read pins existing userData, reads at most 64 KiB and releases
successfully before parsing strict UTF-8 and schema. Only an explicitly missing
directory or pointer permits a missing observation. Ordinary read failure closes
the pin; uncertain read-close retains later qualifications until process death.
Release failures never return content and are not retried. Explicit HOME selection
still avoids reading the unused pointer. Complete-domain rereads must use
`domains.read`; a successful initial read is not a pointer transaction or data
compatibility proof. Product packaging acceptance must cover both platforms.

## C close-boundary gate

The fixed-input native builder compiles and runs `directory.test.c` before it
emits the library. Its separate translation unit injects failure immediately
after a real OS close; no injection code enters `lease.node`. Six real directory
handles are arranged into physical, logical and primary chains. Seven runs cover
successful release and uncertainty at every close position, checking that all
later handles remain valid. The topology is a contract fixture, not evidence of
actual firmlink discovery or product shutdown.

The test uses the same compiler and SDK as the library; when cross-compiling a macOS
library it executes the contract on the host architecture. The temporary test
executable is not shipped. macOS signs it ad-hoc and verifies that signature;
execution policy rejection remains a failed gate, never a skipped test.

The Darwin compiler/SDK strings in `toolchain.json` describe the reference CI
toolchain, not an exact-version allowlist. Builds require Apple clang and a macOS
SDK at least as new as the deployment target (currently 13.0). Actual source
compilation with warnings as errors and all seven native contract runs remain
mandatory; accepting a version string alone does not certify a toolchain.
`DEVELOPER_DIR` may explicitly select an installed Xcode or Command Line Tools
directory. Compiler flags and arbitrary SDK overrides are still filtered out.
The selected compiler version, executable digest and SDK path/version remain in
`build.json` for diagnosis and release provenance. CI should select its reference
toolchain explicitly; other combinations require platform packaging and runtime
acceptance before release.

Apple clang builds enable `--no-default-config` only when the selected driver
advertises that option; older Apple drivers must not fail merely because the
option is unavailable. Compiler environment overrides remain filtered, and the
selected capability is recorded as `compiler.default_config_disabled`.

The four pinned native dependencies (Node headers/LICENSE, LLVM-MinGW and the
Electron import library) download from versioned domestic OSS mirrors
under `oss://deep-rd/scholarseed-vendor/vendor/native/<component>/<version>/` first, then their
original upstream sources. Every source must match the same
reviewed size and SHA256. Downloads use a 120-second timeout per attempt and at
most two attempts per source; diagnostics identify the artifact, source and
HTTP/system error without URL credentials or query parameters. Verified local
archives and the shared digest cache continue to work without network access.

## Durable mutation reservations (implementation; acceptance pending)

`mutations-v1/<physical-identity>/<self|descendants>/<intent-sha256>` records an
unfinished synchronous mutation. The publisher already holds exclusive activity
and closed admission. It publishes every selected-root `self` membership and
every ancestor `descendants` membership before touching product data. Each file
contains the same immutable, bounded version-1 owner and physical-binding frame.
The permanent `<physical-identity>-mutations` gate serializes index publication,
reading and retirement. Empty index directories and gate files remain permanent.

Ordinary writer admission checks `self` for all ancestors and both buckets for
selected roots. Python startup initialization and maintenance mutation perform
this check before writes as well. Unknown, malformed and empty records block;
process absence and elapsed time never clear them. Read-only source inspection
can still run so the actual migration owner can recover before admitting data
writers. An interrupted publisher that has not finished the complete index may
not have started product writes.

Only an occupied maintenance session can call `reserveMutation(owner)`. Resume
requires exactly the same owner bytes and physical bindings; every other intent
remains blocking. The returned `finish()` removes only those exact records, after
the transaction has durably committed and completed its synchronous writes.
Closing the session without `finish()` deliberately retains the reservations.
Desktop legacy migration retains them through copy, verification, source cleanup
and its retirement receipt. Source-root deletion is excluded from that operation.

This implementation is not evidence of full writer coverage, Windows power-loss
recovery, Mac guardian lifetime, candidate activation, or successful product
acceptance. Cross-language and actual process-crash validation remain required.
# Native startup selection

Windows `startupSession(pipe, parentPID)` is a single-use, synchronous bootstrap
read before Electron singleton and session initialization. It accepts only the
updater pipe namespace, verifies the kernel server PID, and returns the bounded
session bytes with OS-observed parent and child creation identities. Desktop
validates those observations against the native session before consuming paths.
The connection then closes; the ordinary resident client reconnects and must
receive the same immutable session. This read does not authorize update, exit,
data mutation or workbench health.

Connection and reading share a 10-second deadline. Pending overlapped IO is
cancelled and drained before its memory or handles can be released. If completion
or handle release cannot be proved, the allocation and remaining handles stay
alive until process exit. macOS does not expose this Windows bootstrap behavior.
The implementation and regression sources are currently unverified; real
Electron pre-ready and reconnect acceptance remains required.

## Native maintenance session observation

Windows `maintenanceSession(pipe, workerPID)` uses the same bounded synchronous
pipe read and kernel server PID/creation checks as startup selection. It returns
`bytes`, `ownerCreated` (the independent worker) and `leaderCreated` (the calling
Desktop process). The worker need not be the Desktop parent. Every invocation
reopens and verifies the actual server; it neither consumes nor resets the
single-use `startupSession` admission. Desktop must still match the frame to the
expected transaction and its original leader identity. This observation grants
no installation, exit or user-data mutation authority. macOS rejects the method
with `ERR_LEASE_PLATFORM`; its update path does not use this Windows capability.

Native regression tests cover repeated maintenance observation across startup,
wrong-server rejection and preserved startup single-use behavior. Signed Windows
package and application-update acceptance remain separate requirements.

## Windows notification presentation

`notification.c` is the Windows WinRT Toast provider. `show(aumid, xml, callback)`
returns a retained handle; `close(handle)` removes its event subscriptions and hides
the toast. Events cross into JavaScript through a Node-API thread-safe function.
Timed-out banners remain clickable in Action Center while the application is alive;
main owns the bounded handle set and session navigation. Exit disposes those toasts.
Submission success is not proof that Windows displayed a banner.

Before submission, a successful `get_Setting` result still blocks any setting other
than Enabled. Only `get_Setting` returning `HRESULT_FROM_WIN32(ERROR_NOT_FOUND)`
(`0x80070490`) permits submitting the real requested toast once with an unknown
setting. Identity-less Win32 applications can lack notification settings before
their first submission; the [Windows Community Toolkit implementation](https://github.com/CommunityToolkit/WindowsCommunityToolkit/blob/main/Microsoft.Toolkit.Uwp.Notifications/Toasts/Compat/ToastNotificationManagerCompat.cs)
also accounts for this initialization order. This provider does not send a dummy
toast, change registrations or retry failed submissions. Windows retains control
over permission and display. Every other query error and every `Show` error still
propagates to the caller.

The synchronous `setting-unavailable` diagnostic preserves the query stage and
HRESULT; the main-process log reports `setting: -1`, not Enabled. Failed query
output values are never treated as valid settings. Existing attempt, setting,
submitted and failure diagnostics remain. The portable `notification.test.c`
policy contract runs with the native builder's compiler when contracts are enabled
on both platforms; JavaScript tests cover diagnostic routing and unchanged error
propagation. These checks do not prove Windows installation or first-toast runtime
acceptance; macOS keeps its existing Electron notification path.

`programs()` resolves the current user's Programs known folder. `shortcutId(path)`
reads its Shell property store: Electron's IShellLink property view returned an
empty AUMID for the tested Velopack launcher link even though the serialized link
and Windows Shell both contained the correct identity.

The module never creates Start Menu shortcuts or COM activation registrations.
The installer owns the stable launcher shortcut and AUMID. Electron 44's Windows
Notification presenter creates a shortcut from the runtime executable's PE product
name, so Windows presentation must not call that presenter. macOS retains Electron
Notification; its bundled notification module has no Windows exports.

`src/main/shortcut.ts` performs a narrowly scoped upgrade cleanup of the current
user's `Electron.lnk`: both it and the installer shortcut must match the product
AUMID, empty arguments and this installation's exact launcher/engine layout.
Redirected paths and foreign targets are preserved. An absent old engine version
may be validated through its nearest existing physical ancestor. This is ordinary
upgrade cleanup, not protection against arbitrary concurrent same-user mutation.
Native compilation and unit contracts are separate from real Windows notification,
click, dismissal and upgrade acceptance.

Notification-center activation uses the existing `scholarseed` protocol. Main
owns a bounded, one-shot UUID route map; native WinRT supplies presentation and
lifecycle events. A dismissal may precede the protocol callback, so presentation
can close before its route is consumed. Shutdown/eviction invalidates routes;
URLs do not contain session IDs or commands. This avoids COM server/shortcut
registration and preserves installer ownership of the stable application link.

## macOS offline notarization

`notarization.c` verifies the exact ticket attached at `Contents/CodeResources`.
It is included only in the macOS native closure; Windows continues to use its
existing signed release manifest and Authenticode/Velopack path. No Xcode tool is
needed on an installed Mac for this gate. CI still notarizes and staples release
artifacts; this verifier neither signs nor issues tickets.

The main-process owner first verifies the release SHA-512, bundle/build identity,
architecture and expected Developer ID. The native worker requires a strict,
nested, all-architecture signature check with `kSecCSNoNetworkAccess` before accepting the ticket. It obtains the
SHA-256 CDHash of every Mach-O architecture with the system `codesign` tool. The
native worker then checks bounded ticket/DER framing, all those digest bindings,
the Apple ticket certificate chain and the ECDSA/SHA-256 signature. A successful
cached system ticket lookup or a previous process receipt is never sufficient.
Prepared ZIP reuse rechecks the same digest-pinned DMG before native Squirrel
checks the actual final application's nested/strict signature.

Certificate validation uses `SecPolicyCreateWithProperties` with Apple's
DeveloperIDPlusTicket policy OID `1.2.840.113635.100.1.90`, requiring an Apple root,
three-certificate chain, the intermediate marker `1.2.840.113635.100.6.2.17` and
leaf marker `1.2.840.113635.100.6.1.30`. This policy identifier is not a public SDK
constant; policy absence/mismatch fails closed as an unavailable verifier. No
fallback to Basic X.509, common-name matching or user-added trust anchors exists.
Both `SecTrustSetNetworkFetchAllowed(false)` and a network-disabled revocation
policy prevent trust evaluation from requiring a fresh response. Available
certificate revocations still reject. Following Apple's ticket policy, ticket
signer expiration alone does not invalidate an earlier ticket.

This proves that Apple signed the exact code-directory authorization; it cannot
prove that no new revocation exists on an unreachable server. Gatekeeper and OS
launch policy remain in control. The updater still requires its own update
service for candidate authorization; “offline” here means independent of Apple
service availability once the release is downloaded, not an offline release feed.
Missing/malformed tickets, unsupported formats, wrong digests, untrusted chains
and bad signatures all block installation. Local IO/worker failure and timeout
remain failures; cancellation cannot become a successful handoff.

Alternatives rejected: `stapler validate` requires an Apple service lookup;
`codesign -R notarized` can answer from the system ticket database and does not
prove this attached ticket is valid. The implementation therefore verifies the
attached bytes directly, using Security.framework for trust and cryptography.
The ticket parser currently accepts the observed version-1 s8ch / g8tk SHA-256
format and zero flags; new layouts require review, not a permissive fallback.

Sources: Apple's [ticket trust policy](https://github.com/apple-oss-distributions/Security/blob/main/trust/headers/SecPolicyPriv.h)
and [stapled ticket handling](https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_codesigning/lib/notarization.cpp);
Mothers Ruin's [ticket format research](https://mothersruin.com/software/Archaeology/reverse/tickets.html).
The format was checked against the included authentic public ticket fixture;
the fixed 72-byte signature slot contains DER ECDSA followed by zero padding.

Native build contracts run `notarization.test.cjs` against the compiled library,
covering a real Apple-signed ticket, each digest binding, corrupt signatures and
certificates, malformed lengths/flags, replay against another digest and async
input ownership. These and the TypeScript cancellation/prepared-archive tests
are component evidence. Final signed-package upgrade, macOS 13/Intel and Windows
package regression acceptance remain separate release gates; a passing fixture
or local native probe does not establish that acceptance.
