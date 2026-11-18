<a id="出网与凭据接收方边界"></a>
# Network Egress and Credential Recipient Boundaries

Read this page when changing connection addresses, retrieval transport, supply-chain sources, or egress configuration. It identifies Owners and security verification requirements; it is not a repository-wide endpoint inventory and does not prove zero runtime egress. Actual defaults, override precedence, and enablement conditions are defined by the relevant configuration and consumers. Do not copy historical hosts, fixed dependency counts, or obsolete paths.

<a id="两个独立问题"></a>
## Two Separate Questions

The fact that a connection target is configurable does not mean it is allowed to receive account tokens, model keys, cookies, or other credentials.
When evaluating a change, separately identify: request purpose and trigger conditions; address source and permitted overrides; credential source and recipient; redirect/proxy/child-process behavior; and failure behavior and actionable outcomes for users. Anonymous requests may still expose titles, identifiers, or document content; "no credentials" does not mean "no user data" or no network-security risk.

**Requirements to preserve**: send credentials only to explicitly authorized recipients; changing a default URL must not automatically expand trust. Determine behavior from protocols and capabilities, not hostname substrings used to infer keys or features. Address-shape validation, HTTPS, access authorization, and recipient trust are separate checks; passing one does not substitute for the others.

<a id="当前-owner-与核验起点"></a>
## Current Owners and Verification Entry Points

| Egress surface | Current entry points | Conclusions that must not be inferred |
| --- | --- | --- |
| Model connections and custom endpoints | [Serve settings API](../../apps/serve/service/chat/api/settings.py), [model assembly](../../apps/serve/service/chat/service/models.py), [Settings UI](../../apps/desktop/src/renderer/src/components/business/Settings.tsx) | A prefilled provider form does not mean requests are sent by default; an existing API does not prove that real credentials/protocol connections work; do not reuse the obsolete claim that "all routes are stubs" |
| PaperHub / Brave Skill search | [PaperHub tool](../../skills/community/agentic-search/tools/paperhub.py), [local configuration](../../skills/community/agentic-search/tools/localconf.py), [Brave tool](../../skills/community/agentic-search/tools/brave.py) | The actual Skill source and configuration are authoritative; a removed transport file cannot prove a fixed origin allowlist |
| Literature metadata and full text | [OpenAlex](../../apps/serve/service/literature/service/openalex.py), [DOI full text](../../apps/serve/service/literature/service/fulltext.py), [failure classification](../../apps/serve/service/literature/service/outcome.py) | Redirect rules for anonymous requests do not apply to credentialed requests; a dynamic PDF host does not mean arbitrary files or content are acceptable |
| Update and distribution sources | [product configuration validation](../../apps/desktop/src/main/product.ts), [updater](../../apps/desktop/src/main/updater.ts), [build contract](../runbooks/build.md) | Changing an update source changes the installer's trust boundary; do not remove protocol, signature, digest, or platform checks to make the source "replaceable" |
| Account signature verification, revocation, and feedback submission | [AccountTrust](../../apps/serve/service/identity/service/account.py), [feedback service](../../apps/serve/service/chat/service/feedback.py) | An HTTP local-auth mode does not mean an account token is valid; feedback log bundles are deliberate egress data and still require review when submitted anonymously |
| Runtime, Trace, and product Skill distribution | [separate ownership](ownership.md), [Skill source of truth](skills.md), and the relevant package guides | Static product review does not prove that upstream binaries have zero telemetry; local services and bundled assets do not mean all their consumers have zero egress |

<a id="文献全文下载预算"></a>
### Literature Full-Text Download Budget

The literature domain's [transport](../../apps/serve/service/literature/service/transport.py)
owns the connection, read-idle, and total budgets. A single full-text item shares a 300-second budget, including the DOI lookup and derived arXiv-to-DOI fallback; ordinary metadata queries remain limited to 10 seconds, with 5 seconds each for connection and read-idle. Do not treat the read timeout as the total download duration.

Synchronous business entry points still execute on their existing worker thread or FastAPI thread pool. Internal asynchronous network operations use a cancellable total-budget scope covering response headers, redirect response bodies, and the body; checks only between chunks cannot constrain redirect reads performed internally by HTTPX.
Each request phase is capped by the remaining budget. Fallback does not reset the total budget, and a complete PDF is published only after validation; partial files are not cached, and there is no automatic retry or resume. A sequential batch of five papers can approach 25 minutes; do not describe a per-item budget as a batch budget.

Connection/read/total-budget timeouts and upstream 408/504 use `FULLTEXT_TIMEOUT` with API status 504; Desktop displays the timeout message in Chinese and English. A 404, missing primary PDF address, and similar cases retain their existing classifications.
The budget constrains network operations; it does not guarantee hard termination of operating-system DNS threads or every process-cleanup call. Passing deterministic contracts does not prove actual download results under the original Windows network conditions.

<a id="desktop-本地与发行凭据配置"></a>
## Desktop Local and Distribution Credential Configuration

[Product resources](../../apps/desktop/resources/product.json) declare credential_profiles separately for
local/mock_keychain and distribution/system_keychain, along with their respective storage namespaces.
[Main configuration](../../apps/desktop/src/main/index.ts) sets sessionData and the refresh namespace,
adds the development-key switch for local configuration, and explicitly rejects that switch in system configuration;
the [refresh-credential Owner](../../apps/desktop/src/main/auth-refresh.ts) does
not persist a nonempty token when safeStorage encryption is unavailable. A development key is not equivalent to system key protection. Do not change distribution configuration to mock to avoid prompts, and do not infer from optional accounts or local HTTP auth-off that refresh credentials or model authentication are unnecessary.
A source-code branch is not acceptance evidence for a signed distribution or real sign-in/refresh. Namespace isolation does not authorize migration or deletion of old user assets.

<a id="社区认证入口与历史身份保留"></a>
## Community Authentication Entry Points and Historical Identity Retention

[The identity-provider catalog](../../apps/serve/service/identity/catalog.py) currently assembles only local authentication;
[the authentication policy](../../apps/serve/service/identity/service/policy.py) accepts off/local/account/auto uniformly.
Invalid legacy SSO modes are explicitly rejected; there is no anonymous fallback, no fabricated local password, and no restored BUC compatibility entry point.
Managed-account handoff and AccountTrust remain independent consumers; removing the enterprise provider does not remove them.

`has_users` in [user storage](../../apps/serve/service/identity/persistence/users.py) still checks the existing
user collection. Historical identities without salt/password_hash cannot sign in with a password, but do not delete users, unknown fields, or invalidate tokens in bulk just to clean up entry points. Knowledge/test migrations must not delete auth.json to obtain isolation.
[The Desktop startup Owner](../../apps/desktop/src/main/backend.ts) fixes off/machine; this defines product ownership for local
projects and sessions across signed-in accounts. It does not prove account-token validity, successful model authorization, or secure configuration of an external Serve deployment. The actual AuthPolicy still owns auto/local/account semantics for standalone Serve.
Changes to these integration points must check retention of historical assets, rejection of old entry points, existing local/account handoff, and a real product turn. Fixtures in the
[community authentication contract](../../apps/serve/tests/contract_community_auth.py) do not substitute for real-device acceptance.

<a id="模型表单预置的接收方登记"></a>
## Recipient Registry for Model-Form Presets

[The Serve model-form preset recipient registry](../../apps/serve/docs/network.md) is the sole registry;
the private network-review text does not duplicate its host list. This table is for review and contract validation only. It is not a runtime egress allowlist and does not replace user authorization for custom endpoints.

The credential hint in local presets is not a business rule that "loopback addresses need no credentials"; do not skip
credential or protocol checks for candidate connections based on address shape. The model catalog is fetched from `/models` by the candidate connection's
[probe Owner](../../apps/serve/service/chat/service/probe.py); it is not a static list of model names here. Catalog lookup does not persist data, change the current selection, or prove that a session is usable.

<a id="codex-模型传输不能一概视为本机桥"></a>
## Codex Model Transport Must Not Be Treated Uniformly as a Local Bridge

[Model assembly](../../apps/serve/service/chat/service/models.py) registers some connections with Serve's
completion bridge, then passes a loopback address to Codex. Current trigger conditions also involve reasoning, account tokens, and gateway ownership; URL suffixes alone do not describe all bridge behavior. Proxy semantics differ between bridged and direct paths: the former projects only the proxy bypass for the bridge target, while the latter preserves external upstream-proxy semantics.

The direct branch still declares the Responses protocol and, when an API key is present, passes it to the executor through a named environment variable; custom headers also have a separate environment projection. Therefore, the old generalization that "all real addresses and credentials never leave the Serve process" is not a security guarantee. When changing transport, verify the selected branch, secret projection, and recipient; do not extend bridged-path constraints to direct paths. An Adapter must not infer product gateway identity on its own. The relevant Owner must still perform real network and child-process verification; a static assembly branch does not prove the executor's actual requests or upstream safety.

<a id="用量与积分的消费边界"></a>
## Usage and Credit Consumption Boundaries

The enterprise gateway owns billing, quotas, and credit redemption. This repository's model calls, correlation identifiers, and error projections are not a second balance ledger. Historical daily quotas, signup credits, expiration periods, and deployment policies are not current defaults; they do not authorize implementing external issuance/settlement here or overriding server-side balances with local token estimates.

Registration in [CompletionBridge](../../apps/serve/service/chat/service/completions.py) retains
the session identifier; a turn identifier is obtained per call, and the two must not be conflated. The current bridge emits the product error envelope for a registered `credit_balance_exhausted` and preserves the upstream HTTP status; this does not prove that real billing behavior has been accepted for all protocols, direct connections, or external gateways.
[ModelService.usage](../../apps/serve/service/chat/service/models.py) currently returns a placeholder shape with zero tokens
and an empty cost; this is not evidence of zero actual spend, a credit balance, or a pricing basis.
When changing these consumers, verify the actual recipient, identity/session/turn correlation, and error redaction. Do not apply historical fail-open metering proposals to authentication, and do not treat a public-origin change as authorization to forward cookies/tokens to model vendors.

<a id="托管-mcp-与内置浏览器是独立边界"></a>
## Managed MCP and the Built-In Browser Have Separate Boundaries

The [Codex Adapter guide](../../packages/adapters/codex/README.md) and
[isolation Owner](../../packages/adapters/codex/scholarseed_codex/isolation.py) manage
the managed App Server's discovery environment and highest-priority configuration. MCP declarations are cleared at this boundary; configuration from the user's Home or project cwd is not inherited. Redirecting a spawned shell to the user's directory is separate from isolating managed-process discovery; do not generalize this to mean that all child processes have no network or all hosts lack MCP.

The [MCP control mapping](../../packages/adapters/codex/scholarseed_codex/mcp.py) declares
capabilities such as queries, resource reads, OAuth sign-in, reload, and direct tool calls, but does not support configuration writes or trust. A protocol mapping does not prove that a service is configured, tools actually work, or network access has been accepted. The Codex CLI/MCP configuration used for development on this project must also not be overridden by managed-product isolation rules.

The built-in browser is not the unimplemented `capabilities.browser` configuration from the old Harness. The current product uses
`features.browser` in the manifest and disables it by default. Network isolation, externally restricted CDP, Agent authorization,
credential sessions, and native overlays each have separate constraints; see the
[Desktop browser documentation](../../apps/desktop/docs/browser.md). The existence of source and documentation does not mean acceptance is complete on all platforms or in the real product, nor does it authorize changing the switch or a user's running instance as part of knowledge maintenance.

<a id="必须保留的当前缺口"></a>
## Current Gaps That Must Remain Explicit

The current PaperHub tool reads `SCHOLARSEED_API_KEY` from the environment and attaches a Bearer header. The target comes from
`PAPERHUB_URL` / local configuration. Configuration normalization changes HTTP to HTTPS only for specified public hosts,
while preserving custom/tunnel addresses. The verified request branches use urllib's default opener or an opener that only replaces ProxyHandler; this does not prove a fixed credential-origin allowlist or disabled authenticated redirects.
The two guarantees stated on the old network page must not continue to be treated as current security facts. This section records the gap between implementation and requirements; it does not authorize expanding credential recipients or changing product Skills or transport policy as part of knowledge maintenance.

<a id="权限意图与审批身份"></a>
## Permission Intent and Approval Identity

Permission intent is a Runtime-neutral contract; vendor policy mapping belongs to
[Codex permission](../../packages/adapters/codex/scholarseed_codex/permission.py).
Both `ask` and `safe_auto` use workspace-write/on-request; they differ in whether USER or AUTO_REVIEW
is the approver. Do not compare only sandbox settings or interpret "approve for me" as expanding writable roots, network access, or protected paths.
Full access is a separate danger-full-access/never policy, not an alias for automatic approval.
Approval-field propagation, UI mode, and actual tool authorization are different kinds of evidence. Changes to the mapping require verification of real boundary-crossing operations, handoff to a human, rejection, and recovery; three-tier labels or contract fixtures do not establish complete permission acceptance.

<a id="全文门禁与沙箱是不同边界"></a>
## Full-Text Gates and Sandbox Are Separate Boundaries

<a id="固定域名放行与命令升级不互相替代"></a>
### Fixed-Domain Allowlisting and Command Escalation Do Not Substitute for Each Other

[Product default-authorization resolution](../../apps/serve/service/chat/active.py) reads
`default_permission.allowed_network_domains` from the manifest and accepts only exact lowercase hostnames. The current root and
Desktop resource manifests declare the same fixed host; new authorization is not derived from an overridable service URL.
[Session composition](../../apps/serve/service/chat/runtime/composition.py) passes the domains to the neutral
PermissionIntent; internal read_only does not project this set. Product origins belong to the product Owner. The Adapter
only maps to the host and must not hard-code business origins or silently ignore restrictions in vendor implementations.

[The native Codex profile](../../packages/adapters/codex/scholarseed_codex/permission.py)
combines exact hostnames with named local-socket authorization. The `full` field in network mode does not mean the domain table is `*`;
the latter is generated only by explicit network_access. A generated profile does not prove acceptance of real proxy behavior, subagent inheritance,
rebinding, or Windows egress. Allowlisting a fixed host also does not grant separate egress permission to redirect hosts, browsers, MCP, or
managed search. Credential recipients and data transfers still require their own checks.

Native approval for ask/safe_auto covers the entire escalated command, not only that domain or network request. Escalation may cross
file and network execution boundaries; it does not change the session to full access or permanently register an approved host. Preserve default command
network restrictions and approval-failure semantics. The historical investigation into deny-read preventing escalation from taking effect explains the tradeoff in removing hard read restrictions; it does not authorize restoring the withdrawn PaperHub Bridge migration or opening all network access.
For changes, verify separately that allowlisted requests work by default, non-allowlisted requests are denied by default, the actual target responds after approval, and later default
requests remain restricted. A successful proxy CONNECT, generated configuration, or historical screenshot is not acceptance of the current version.

See the [Download Owner](../features/downloads.md#全文同意与有效授权范围) for full-text authorization and retrieval/read entry points;
do not maintain a second authorization flow on the network page.
The [Serve session policy](../../apps/serve/service/chat/runtime/permission.py) currently provides `deny_read_roots` only in the internal
`read_only` mode; `ask` and `safe_auto` do not provide these hard read restrictions.
The [Runtime contract](../../packages/runtime/scholarseed_runtime/contract/permission.py) already has this field;
the [Codex Adapter](../../packages/adapters/codex/scholarseed_codex/permission.py) projects deny only in the macOS
sandbox profile. It does not project it on non-macOS, and that profile is not created in full-access mode.
Therefore, do not reuse the old conclusions that "Runtime has no read-path field" or "all macOS product modes isolate managed full text."

Protected paths come from the [product path Owner](../../apps/serve/service/paths.py). Do not deny the entire
service root and inadvertently block sockets or session workspaces; also check derived surfaces such as databases and WAL files.
Historical built-in profiles, custom profiles, different versions, and non-interactive Windows probes each have their own scope.
Do not generalize a timeout or a failure on one OS version into a claim that all Windows versions are unsupported; nor does a configuration field prove that real tools cannot bypass it. For verification, pin the actual version, mode, input channel, target path, tool executor,
and platform, and retain runtime startup and recovery results. Knowledge maintenance must not change sandbox policy or user configuration.

<a id="文献取回的决策与验证"></a>
## Literature Retrieval Decisions and Verification

Current DOI full-text lookup uses only OpenAlex `primary_location.pdf_url` and does not silently select another candidate. Lookup and retrieval are not retried, preserving the source consistency and rate-limit semantics of the interactive button. The request client does not explicitly set account-authentication headers; downloads may include a source Referer. Do not describe anonymous requests as having no headers or user information at all.
After retrieval, check the media type, size, PDF magic bytes, and parse result; an HTTP success does not mean the full text is usable.
Not found, inaccessible, and rate-limited outcomes retain their respective classifications; do not merge them into a network error with no actionable guidance.

Outbound-call timeouts are owned by [transport Owner](../../apps/serve/service/literature/service/transport.py),
which defines two payload-shape classes (ordinary JSON/BibTeX data and binary PDF streams) and names each of the three phases;
do not duplicate the values here. httpx enforces only connect and read (read is the idle limit between adjacent bytes,
not the total download duration), and has no total clock. The caller enforces total: the async path wraps each request in `asyncio.timeout`,
and the sync streaming path checks the monotonic deadline between chunks and stops itself (threads cannot be
interrupted). Timeouts are treated like "no response" and folded into existing outcome classifications; no new user-visible failure code is added. If retries are added later,
their budget must fit within total and must not increase actual elapsed time.

<a id="单条题录查询与覆盖通道"></a>
## Single-Record Lookup and Supplementary Channel

[The papermeta API](../../apps/serve/service/literature/api/papermeta.py) selects exactly one nonempty **bibliographic-record** lookup dimension in this order: DOI, arXiv,
then title; a failed record lookup does not switch sources. Identifiers are used by
[bibliography](../../apps/serve/service/literature/service/bibliography.py) to fetch public BibTeX;
titles are searched through OpenAlex. Neither attaches account credentials. Requests still send a paper identifier or title upstream;
anonymous does not mean that no user data is sent. The BibTeX client allows redirects; do not generalize this behavior to credentialed requests.

An identifier that was not selected is not discarded: the request body may include both a DOI and an arXiv ID. The record-lookup leg still contacts only the source for the selected dimension; other identifiers serve only as fallback sources for the abstract-supplementation leg below. They do not change dimension selection or affect the rule that the user must confirm whether the first title match is the same paper.

The OpenAlex Owner configures the title-search URL and mailto parameter through `OPENALEX_SEARCH_URL` and
`OPENALEX_MAILTO`; URL-shape validation is not recipient trust or a guarantee that HTTPS is enforced.
The API Owner parses `PAPER_META_TIMEOUT`, shared by all three dimensions. A nonpositive, nonfinite, or unparseable value falls back to the source-code default; do not maintain a second list of defaults here. This setting controls only the total budget for this outbound call. The connect and read phases are fixed by the ordinary-data constants in the transport Owner above
and cannot be overridden by the environment.

When the BibTeX retrieved by the identifier leg has no `abstract` (public arXiv BibTeX never includes one, while only some doi.org
publishers do), the bibliography Owner makes supplementary requests along an **identity chain**, in order, to Crossref (`api.crossref.org`)
or the arXiv Atom API (`export.arxiv.org`), and stops at the first nonempty abstract. The chain is generated by
`identity_chain` in the [identity Owner](../../apps/serve/service/literature/service/identity.py).
Its order is the trust order: the record's own lookup dimension (**do not fold it**—the publisher's Crossref
record takes precedence over any preprint source) → the arXiv ID folded from that identifier (included in self-registered arXiv
DOIs such as `10.48550/arXiv.*`) → another known identifier on the record. Deduplication uses versionless keys, so `v2` and the unversioned
form of the same paper do not each trigger an upstream request; the derived unversioned form takes priority. A title is not an identifier and is excluded from the chain. Malformed identifiers in the chain are skipped rather than raised—one bad value must not make a synchronous lookup fail after its bibliographic record was already retrieved. Both recipients are anonymous, both allow redirects, and requests carry only the paper identifier.

This leg is an **optional enhancement**: a timeout, non-200 response, unexpected body shape, or parse failure degrades only to "no abstract." It must not fail a lookup whose bibliographic record was already retrieved, nor overwrite an abstract included in the BibTeX. It **fills a blank; it does not choose the best**: if Crossref already returned an abstract, do not make even one arXiv request. Conversely, a fallback may return a preprint-version abstract rather than the published-version abstract; this tradeoff is explicitly accepted (an absent abstract has no value to the user, and the DOI and arXiv ID in the details show the version difference).
The entire chain and the record-lookup leg share one `PAPER_META_TIMEOUT` total budget. The deadline is set when entering the identifier leg; all hops in the chain combined must stay within it. When the budget is exhausted, abandon the remaining candidates; do not quietly double the budget for this channel. Crossref abstracts are JATS fragments, where `<title>` is a publisher section heading (often `Abstract`), not the body, and must be removed before storage. Undeclared prefixes are common, so do not assume the fragment is well-formed XML.

Lookup is not insertion. The user must still confirm whether the first title match is the same paper; field normalization and insertion are
separate responsibilities. Preserve the actionable 429 failure semantics for upstream rate limiting; a unified error display must not conflate it with ordinary failures.
See the [papermeta contract](../../apps/serve/tests/contract_literature_papermeta.py) for deterministic evidence;
fixtures do not prove real-network behavior, credential safety, or product acceptance.

<a id="身份缓存与反馈失败边界"></a>
## Identity Caching and Feedback Failure Boundaries

<a id="桌面登录交接与本机协调"></a>
### Desktop Sign-In Handoff and Local Coordination

When the new Desktop initiates sign-in, it listens only on `127.0.0.1` at a system-assigned ephemeral port.
The account service follows the new protocol to navigate the browser back to `/auth/callback` on that port. After validating
`state`, Desktop submits the S256 PKCE verifier through a separate exchange endpoint. Success, cancellation, replacement, or expiration
closes the listener. The new version does not probe or fall back to the legacy sign-in protocol, and does not register the old sign-in scheme; system notifications use
a separate scheme. Version 0.3.1 still uses the original web entry point, `scholarseed://`, and original authorization-code exchange endpoint.

New Desktop releases bind an ephemeral listener to `127.0.0.1` for each sign-in.
The browser navigates to its `/auth/callback` endpoint, and Desktop validates the
state before exchanging the code with its S256 PKCE verifier. This flow does not
fall back to the legacy login scheme; native notifications use a separate scheme.
Desktop 0.3.1 retains its existing web, deep-link, and code-exchange endpoints.

[DesktopHandoff](../../apps/desktop/src/main/handoff.ts) distinguishes browser sign-in, code exchange,
client adoption, and result reporting; web sign-in or dispatching a deep link does not prove successful client adoption. Only one
exchange may be in flight. start/cancel advances the generation, and a late result cannot overwrite a new intent. Clear state only on terminal failure;
transport errors preserve the retryable intent until it expires. Do not fetch another code from the coordination store while an exchange is in flight, to avoid
discarding a code after atomic consumption. Reporting adoption requires an already obtained token and is asynchronous; client adoption
does not mean the upstream has confirmed the report, and an exchange failure must not fabricate an authenticated completion receipt.

[Local coordination transport](../../apps/desktop/src/main/handoff-local.ts) and the
[Serve endpoint](../../apps/serve/service/identity/api/handoff.py) handle only legacy deep-link handoff across instances
within the same product user root. They do not control which application the operating system delivers a deep link to, nor solve cases where a deep link never reaches the machine.
`/api/auth/handoff/` is exempt from ordinary authentication, but every endpoint requires host identity; loopback or auth-off must not
remove this gate. Missing claims, expired claims, and self-handoff all return orphaned; do not extend this to a state-existence query.

The [lease store](../../apps/serve/service/identity/persistence/handoff.py) validates state/owner;
renewal extends the lease within a transaction, conditionally takes the code, and clears the code column. A process restart does not reuse the old owner identity.
A transport failure differs from an explicit server response that no owner exists: the former gets bounded retries, while the latter stops coordination and preserves the in-memory deep-link path.
Different `SCHOLARSEED_HOME` roots do not share this store, and cross-user-root interoperability is not promised. See
[persistence documentation](persistence.md) for store ownership and private transactions. Codes/tokens are credentials and must not enter logs, ordinary snapshots, or the project database.
Client, protocol, and store tests cover mechanisms separately; they do not replace real-product acceptance of multi-instance delivery, restart, expiration, failure reporting, and
actual credential adoption. The external account-service Owner verifies cloud status and rate limits.

AccountTrust verifies signatures using the account service's JWKS and also checks required claims, token type, and the revocation set.
It checks issuer only when explicitly configured; an empty issuer setting must not be described as a verified issuer claim.
Cached signing keys may be used offline. If no usable key is available, reject the token; a network failure cannot stand in for a valid signature.
User and administrator token types must remain separate; using the same signing key does not make their permissions equivalent.

`revoked_at`, `expires_at`, and the local refresh clock in revocation responses are different contracts: the incremental cursor moves back through
an overlap window and entries are merged by jti. When a valid expiration value is missing, retain the record; do not guess a TTL and evict it early.
The current `_prune_expired_locked` compares the response expiration value against `self._clock() - DECODE_LEEWAY_S`,
while the default clock is `time.monotonic`. Do not treat it as the same time axis as JWT epoch seconds,
or claim that cache entries are reliably pruned by expiration. Verify the clock domain and signature-validation leeway together. This task only records
the source discrepancy; it has not measured upstream timestamps or changed identity-security behavior.

When revocation refresh fails, the existing set is retained. This is a tradeoff between availability and timely revocation, not a guarantee of a strict maximum revocation delay.
Steady-state refresh also depends on requests triggering it and the upstream returning successfully; during ongoing failures, do not claim that revocation takes effect within at most one refresh
interval. On the current cold-start failure path, if no set was loaded successfully, a fetch returning an empty result still leads to a decision based on the existing set. Do not reinterpret the source comment "wait for initial fetch" as implemented fail-closed behavior. Changes to these semantics are a separate task for the identity-security
Owner; this page records the discrepancy only and does not authorize weakening or changing the policy.

Serve collects and submits images/diagnostics selected by the user. Verify default service and update addresses; feedback also allows environment and local-configuration overrides. The verified submission branch uses the supplied API key as Bearer identity
and does not upload a user JWT instead. Recipient trust still requires separate verification; an address override is not proof of authorization.
Log bundles have file exclusions and a separate capacity boundary, but this does not mean all contents are automatically redacted or that actual
report fields need no inspection. Errors preserve upstream status and diagnostics; do not describe an unsuccessful request as anonymously received feedback.

The feedback session-failure summary and original log bundle have separate evidence boundaries: `build_log_bundle` first creates the original bundle;
only when include_trace is enabled and session_id is present does it append a limited event summary. If the total budget is exceeded, it returns the original bundle and records the summary
gap without displacing original attachments. The summary reads specified events and fields from that session's Trace and reports match count and truncation;
it is not a complete Trace, and HTTP 429 cannot reveal quota or the vendor's actual reason. The calling layer must still check session
access permissions; the bundler's session_id argument and checkbox record do not independently prove authorization. Diagnostic fields do not change
retry policy, terminal state, or frontend error cards. Do not recollect vendor raw text, URLs, or user input to fill evidence gaps.

<a id="本地资产与安装期网络不能混算"></a>
## Local Assets and Installation-Time Network Must Be Counted Separately

Office previews use local format readers, fonts are imported through npm CSS, and citation styles reference vendored files through
the product Skill's local registry. Source URLs in an asset inventory do not automatically become runtime requests, but these static facts also do not prove that the entire viewer, files, or third-party runtimes have zero egress.
Verification must cover actual loading paths, build artifacts, and runtime requests; searching for a few SDK names is insufficient.
Changes to these local assets must not silently introduce remote-download, font, stylesheet, or telemetry dependencies. If new egress is needed,
obtain authorization for the relevant scope first and record the source, data, and verification evidence. Regression checks must cover actual consumption and artifacts;
do not reuse CDN assertions from an old page that current tests do not contain, and do not treat missing assertions as permission to add egress.
The entry points are [Office preview](../../apps/desktop/src/renderer/src/features/workbench/OfficeDocument.tsx),
[font imports](../../apps/desktop/src/renderer/src/main.tsx), and the
[citation-style registry](../../skills/community/literature-review/lib/citation_styles.py).

Built-in Skills are compiled offline from repository source. User-installed Skills through the API use a separate path; the current
[installation route](../../apps/serve/service/capabilities/api/routes.py) validates repository addresses to allow public
GitHub HTTPS addresses and constructs a raw manifest URL. Offline compilation of the built-in pack does not mean that all Skill operations are
network-free, and support for other sources does not justify skipping package, version, or trust-boundary checks.

The Trace server listens on loopback by default, but its CLI can select a host; "local by default" is not an immutable isolation
guarantee. Follow the independent package Owner for paths, storage, and evidence rules; do not restore references to the old `index.sqlite3` or Harness
paths. Builds/installations may also access locked dependencies and artifact sources; verify those separately from runtime downloads.
Follow the build guide and lockfile. Do not copy an old fixed registry count, switch sources, regenerate the lockfile, or install tools without authorization.

<a id="更新与停止条件"></a>
## Update and Stop Conditions

When adding egress or changing a source, document its purpose, configuration, data/credentials, failure behavior, security, and
verification boundaries in the owning mechanism's documentation. This page maintains only discovery routes and cross-Owner requirements. Changes involving secrets, proxies, redirects, or supply chains
require separate review and real-path verification; static searches, fixtures, and health probes do not prove the absence of actual leaks.
Stop expanding the investigation once the actual call site and authorization Owner are identified. Do not modify user credentials, configuration, or production behavior to make tests pass.
