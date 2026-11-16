<a id="账号与开发者候选构建依据"></a>
# Account and Developer Candidate Build Basis

<a id="建设状态"></a>
## Construction Status

Asset revision `account/1`. This page records historical IDs and current source clues; it does not automatically become an adopted baseline for the target build. Product requirement version, Owner, entry-point reachability, and applicability to `0.3.2 / 202611121823 / preview` remain to be confirmed. Ordinary display, real sign-in and recovery, cloud profile, and key creation/rotation are not interchangeable. No complete real window screenshot is available for the target build.

<a id="历史需求与确认边界"></a>
## Historical Requirements and Confirmation Boundaries

[P2 freeze](../../frozen/p2-20261025-539af0794/freeze.json) records `sourceCommit` `539af079455cc821b976760728fc13dfedbb8b66`. From that commit, check `apps/desktop/docs/scenarios/catalog.json` and `apps/desktop/eval-scenarios/exploratory/desktop-business/cases/settings.json`; their SHA-256 values are `e4a029cce1e58db658acb2643ea05621f48c288d12209eb0df41f5a4329ec45f` and `372aee4969f44a7e9caafc93bdf4d3ee57990a7ada48b7d0db867bf7405e2ff2`, respectively. They can be inspected with `git show <sourceCommit>:<路径>`; do not restore or rewrite frozen files.

- `ACCOUNT-LOGIN-01@3`: directory `pending/exploratory`; goal is a real sign-in with a dedicated account, the corresponding identity shown in the client, and state checked within the authorized reopen scope. Historical primary case `D6-SET-002` is `candidate_unapproved`. `@3` is a historical asset revision, not a product requirement version.
- `ACCOUNT-STATE-01@1`: directory `current/exploratory`; read-only display of the current account-menu state, separate from sign-in/recovery. Historical `D6-SET-004` remains `candidate_unapproved`. Directory value `current` does not prove adoption or evaluation in the target build.
- The design map's sign-in handoff and avatar menu are historical design/implementation clues. External sign-in pages and cloud profiles are not thereby pages in this repository or verified capabilities. Current source hides navigation to the standalone account settings page; the `AccountPage` component alone does not prove the entry point is reachable.
- The user explicitly clarified for this task that “Developer → API Keys” is a product feature and is not sensitive merely because of the page title. This does not authorize creating, copying, revoking, or rotating keys, and does not prove that every page state avoids showing plaintext. Confirm target-build semantics and applicability.

<a id="当前源码与副作用"></a>
## Current Source and Side Effects

Analysis baseline `acce09fa42ddf234d84b02dde34b2ab4be570215`. The files below had no uncommitted differences against this commit when checked; they are not proven to come from the target installed build:

- [accountview.ts](../../../src/renderer/src/components/business/accountview.ts) assembles sign-in/identity, available quota, and other menu actions, controlling entry points based on current action availability and sign-out state; SHA-256 `ff0a35476157fac0967e7ffc7199c6b042d985e46e27691860e787f2e57379f7`. Identity masking is an observable presentation property; do not copy user names or phone numbers into the baseline.
- [AccountMenu.tsx](../../../src/renderer/src/components/business/AccountMenu.tsx) owns menu actions and cloud entry points for profile and quota; SHA-256 `9262bfcd271655b5cb00eb67237bb74b93ed38b111f1913cb8ba8ae8f150dfdd`. [Landing.tsx](../../../src/renderer/src/components/business/Landing.tsx) invokes the sign-in handoff; SHA-256 `ca908ae97a7042483496c2c45f781144ffb09911ba0c7c77a99da206fb80c1fd`. Sign-in, sign-out, and cloud access are not side-effect-free state projections.
- [AccountPanel.tsx](../../../src/renderer/src/components/business/AccountPanel.tsx) contains `DeveloperPage`: loading first calls `ensureSkillCredential`, then reads the API key list; create, revoke, and hosted rotation each call a write operation; `FreshKeyCard` displays the resulting `token` after creation. File SHA-256 `478d2820a9400a4859e8e3e7fcf53add8faf0bc6850a86b692242252da9661a9`. Current source proves this side-effect risk and plaintext branch, but not that the target build has the same source, that this branch is reachable, or that credentials need to be obtained for this run.

<a id="数据与交接"></a>
## Data and Handoff

Target identity clue: macOS arm64 `0.3.2 / 202611121823 / preview`; existing ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`. Recheck the running instance and artifact before any later operation. There is no authorized complete-window reference image for the target build's account menu, sign-in, or Developer settings. Do not substitute real user identities, keys, or component fixtures.

The handoff must identify the requirement Owner, product requirement version, target applicability, and adopted scope, and prepare a dedicated test account, a masked reference, and necessary authorization. Check side effects separately for ordinary page navigation, real sign-in/sign-out, cloud profile, hosted credential preparation, and key create/copy/rotate/revoke. Keep screenshots within the authorized scope and never record a full credential. If prerequisites are missing, retain the candidate and screenshot gap; do not include this page in smoke coverage or claim it passed.
