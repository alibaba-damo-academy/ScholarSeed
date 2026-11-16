<a id="账号与开发者候选需求"></a>
# Candidate Requirements for Account and Developer Features

<a id="用途与入口"></a>
## Purpose and Entry Points

Users inspect account status and access sign-in, profile, and quota-related entry points from the avatar menu in the main interface. They manage API keys through the Developer entry in Settings. The actual entry points, applicability, and requirement version for the target installed build remain unverified; this page is a candidate, not an adopted criterion or runtime finding.

**Reference screenshot gap:** No complete window screenshots have been verified for the target build's reusable account menu, sign-in handoff, or Developer settings. Static component images, model-service images, and real user account content are not substitutes.

<a id="候选功能"></a>
## Candidate Features

<a id="当前账户状态历史-account-state-011产品需求版本待确认"></a>
### Current Account Status (historical `ACCOUNT-STATE-01@1`; product requirement version pending confirmation)

The avatar menu reflects the branch actually observed in this run: signed in or signed out. If sensitive identity information is displayed, mask it as required by the product interface. Compare the display with an independent reference for the corresponding current state of an authorized test account. Do not sign in, sign out, or switch users to manufacture a branch. An existing signed-in state does not prove that authentication or recovery succeeded in this run.

<a id="登录与恢复历史-account-login-013产品需求版本待确认"></a>
### Sign-in and Recovery (historical `ACCOUNT-LOGIN-01@3`; product requirement version pending confirmation)

In an explicitly authorized, signed-out isolated instance and with a dedicated test identity, complete the sign-in handoff through the real entry point and verify that the client displays the corresponding identity. Check the state after reopening only within the scope explicitly designated and authorized for this run. Record reopening the menu, reopening the client, and recovery across a restart separately; they are not interchangeable. Record cancellation, failure, and sign-out as separate focused scenarios.

<a id="个人资料与额度入口account-profile-cand-001需求版本待确认"></a>
### Profile and Quota Entry Points (`ACCOUNT-PROFILE-CAND-001`; requirement version pending confirmation)

Profile, points, or quota entry points and their visible states in the avatar menu vary with identity and feature availability. Current source routes the corresponding entry points to cloud pages. Whether the target build exposes them, which fields it displays, and their business semantics remain to be confirmed. Do not treat point totals in code or design examples as fixed expectations. Profile edits, purchases, and plan changes each require separate authorization and verification of their real end state.

<a id="开发者-api-密钥account-key-cand-001需求版本待确认"></a>
### Developer API Keys (`ACCOUNT-KEY-CAND-001`; requirement version pending confirmation)

Developer settings are a normal product feature. The naturally displayed list and its empty, loading, or error state should match an authorized, non-secret reference. The actual account, hosted-key lifecycle, and target-build applicability remain unverified. Opening the page may prepare hosted credentials, so its permissions and side effects must be checked. Creating, copying, revoking, and rotating hosted keys are separate write operations and focused scenarios; viewing the page does not authorize them.

Current source indicates that a newly created key may be shown in full once. Masking in the ordinary list does not mean plaintext is never displayed in any state. Do not read, record, or disclose a real full key, verification code, token, or authentication cookie. If a real full credential unexpectedly appears in evidence, stop its propagation and isolate it according to the actual risk; do not stop ordinary, authorized observation merely because of the page title.

<a id="数据参照与边界"></a>
## Data, References, and Boundaries

Account state and identity require an isolated instance, a dedicated test identity, and an independently observed reference that can be safely projected, all explicitly authorized for this run. Do not read real user configuration, sessions, or credentials. Explicitly scope permissions and expected end states for sign-in/sign-out, account profile changes, network access, real key creation or rotation, cloud access, and each platform. If there is no test account, actual entry point, or trusted reference, retain the gap; do not treat the naturally occurring current state or source registration as a passing feature. See [Build Basis](./build.md) for related sources and target-build boundaries.
