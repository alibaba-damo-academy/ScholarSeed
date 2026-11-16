<a id="文献综述工作区与产物边界"></a>
# Literature Review Workspace and Artifact Boundaries

Read this page when changing review activation, checkpoints, artifact reads, or compatibility with historical workspaces. The [product Skill](../../skills/community/literature-review/SKILL.md) is the sole source for the specific execution procedure.
This page records security constraints and compatibility rationale; it does not mean full-text authorization or cross-platform acceptance has passed.

<a id="激活与身份"></a>
## Activation and Identity

Use the exact relative `workspace` returned by successful task activation; do not substitute a phase directory or an absolute path.
The actual Skill identity and version in the binding come from the real workspace binding, not from examples, old records, or memory.
A routine status query or script launch is not lease activation for the current product turn. If task context is missing, recover through the existing binding and controlled activation entry point; do not fabricate metadata or switch workspaces to bypass a rejection.

The [review API](../../apps/serve/service/literature/api/review.py) validates the bridge caller and publication turn. Retrieval checkpoints validate lease type, workspace, and runtime identity.
When changing checkpoints, check each current branch individually; do not infer that validation is identical across every phase from the retrieval branch.
Requests that declare a launcher manifest must also keep runtime identity, manifest, and content hashes consistent. Normal model-tool call fields follow the Skill; do not add parameters just because a lower-level compatibility field exists.

<a id="根目录兼容和文件读取"></a>
## Root Compatibility and File Reads

New reviews use an isolated relative directory. Reviews in historically bound session roots use `workspace="."`, retaining their original files; user assets are not moved automatically for the new directory structure. `scoped_workspace` / `scoped_workspace_path` in the [literature persistence boundary](../../apps/serve/service/literature/persistence/files.py) interpret the root only for this compatibility case. They do not authorize other storage interfaces to accept empty paths, absolute paths, or `..`.

Artifact reads go through `read_scoped_file` and the [platform storage Owner](../../apps/serve/service/platform/storage.py), which restricts relative paths, regular files, and read size and rejects link escapes. Path preflight does not replace the security boundary at open time.

| Boundary | macOS Requirement | Windows Requirement |
| --- | --- | --- |
| Historical and new workspace | Root compatibility and actual activation binding are correct | Same; a drive-letter absolute path cannot be a workspace |
| File open | Safely open each path component and reject symlink escapes | Native handles reject junctions/reparse points and transfer/release ownership correctly |
| Acceptance | Root compatibility, subdirectories, invalid paths, and the real full-text authorization flow | Provide evidence for this platform separately; macOS results do not substitute |

This matrix states security and acceptance requirements; it does not claim that behavior has passed on either platform. macOS results do not replace Windows acceptance or reduce existing Windows product constraints.

<a id="大纲确认与超时边界"></a>
## Outline Confirmation and Timeout Boundaries

`outline_review=timeout_auto` uses a 300-second confirmation deadline; `required` has no timeout. `auto`, approved, and packets with an applied timeout decision do not create another confirmation question. A timeout is not user approval: an actual response, pause, edit, or cancellation must not be rewritten as consent. Full-text authorization remains governed by its separate boundary.

In-product, the review bridge and product-interaction Owner handle the wait, and the Skill consumes the confirmation receipt unchanged; do not start a second standalone timer in parallel. The current deadline starts at `created_at` recorded by HIL. Publishing a card in source code does not establish when it was actually displayed on the user's screen, so do not claim a rendering-time guarantee.
The response must preserve packet, snapshot, request identity, and the original decision. Reread the packet after waiting; if its content changed, reject the old decision. Failure or cancellation must not silently fall through to automatic continuation.

The model passes the receipt to the Skill. Field, identity, and state validation is not a tamper-proof signature protocol and does not prove that a response passed between models is verbatim. Changes to the handoff mechanism must preserve the actual decision semantics and raw evidence; passing structural checks does not establish end-to-end signing, a client-rendered receipt, or recovery after arbitrary restarts.

The independent-host path starts waiting only after it has actually displayed the current packet; rereading the same packet does not reset the deadline.
Timeout application saves a stable decision and notification identity under a lock, using `timeout_default` and `user_response: null` to distinguish it from a real response. Repeated recovery does not create a second decision or generation task.
This mechanism does not install a background scheduler in the CLI or imply automatic wake-up after process exit.
The product Skill remains the sole source for response, notification, and continuation steps; this page does not duplicate command procedures.

When changing these mechanisms, check the [confirmation projection](../../apps/serve/service/literature/service/confirmation.py), [product interaction](../../apps/serve/service/chat/runtime/interaction.py), and [Skill decision state](../../skills/community/literature-review/lib/review_timeout.py).
Policy-projection unit tests do not prove that a real five-minute wait, card visibility, cancellation, restart recovery, or model continuation passes.

<a id="更新与停止条件"></a>
## Updates and Stop Conditions

When activation, binding, checkpoints, or secure-open mechanisms change, the corresponding Skill/Serve/platform Owner updates the contract and verification. Do not copy the business procedure into a general Skill architecture page. Stop expanding the reading scope once the actually affected branch is found.
Deterministic tests and path-source inspection do not prove that real full-text authorization, model-tool calls, or product artifact display have passed.
