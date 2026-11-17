<a id="mcp-连接器"></a>
# MCP Connectors

This directory owns the product-level catalog, installation, authorization, and credentials. Execution configuration is still applied to Runtime by `settings/mcp.py`; it does not copy the Adapter's MCP control protocol or read vendors' private credential stores.

<a id="当前范围"></a>
## Current Scope

- See `catalog.py` for the seven preset entries; the frontend uses the existing Skills page UI components and card layout.
- Installation only registers and publishes a disabled configuration; it does not start OAuth or call third-party tools.
- After API Key validation or OAuth completes, the connector performs a read-only handshake and discovers the complete paginated tool list. Zotero first validates Web API library access (an empty library is valid), then starts the pinned local MCP server to check its protocol and tools.
- HTTP OAuth uses service discovery, PKCE S256, one-time state, a fixed loopback callback, issuer validation, and DCR or a pre-registered client. Metadata endpoints must use an HTTPS host allowed by that preset service.
- Failed updates preserve the original credentials and enabled/disabled choice. Cancellation, retry, or removal invalidates the previous attempt.
- Refresh and credential reads are protected by a private state lock; `invalid_grant` changes the state to authorization required. For each HTTP/SSE request on a running connection, Serve resolves the latest credentials so the native host does not retain stale provider tokens.

<a id="真实执行"></a>
## Real Execution

`transport.py` uses a pinned MCP SDK version to connect over HTTP, SSE, and STDIO. `broker.py` projects these connections as loopback-only HTTP endpoints protected by random temporary tokens for the existing native Runtime to call. The bridge does not copy business tool implementations; it passes through actual tools, resources, prompts, progress, and errors, and does not automatically retry tool calls. Provider credentials are not sent to the native host. Tool-change notifications trigger discovery of the complete tool list and notify the host; the details page reflects changes by polling the public catalog. Disabling, changing the target, removing a connector, or exiting the service closes the corresponding session and local process.

Connection errors distinguish TLS interruption, certificate validation, proxy connection/authentication, timeouts, and explicit network-policy blocking. A domain is marked as blocked only when the response contains a recognized, complete policy-hint signature; an ordinary 403 remains ambiguous between a service or gateway denial and is not directly attributed to account permissions. Probing and SDK execution share error classification; raw responses and credentials are not returned. TLS validation is not disabled, proxies are not switched, and tool calls are not automatically retried. Reauthorization clears historical revocation notices; the public view of an existing credential also no longer shows a stale “authorization removed” record.
The bridge token is reserved as a shared startup credential on first configuration per application instance and projected only through a private environment alias. Adding, editing, or enabling/disabling a connector does not change the credential environment of a running native host or cancel its secure silent-point checks.

<a id="zotero-资料库发现"></a>
## Zotero Library Discovery

For a personal library, the API Key is the only required input by default: the backend verifies access through Zotero's official `/keys/current` endpoint and obtains the user's numeric ID, then continues through the existing library-read and MCP-handshake flow. If the library type is omitted, the backend defaults to the personal library. The authorization page no longer asks users to select a library or enter an ID, and no dedicated configuration page is added. An empty library may connect; missing personal-library read access is rejected explicitly, not presented as an empty library or silently replaced with a group.

Library selection is handled by existing Zotero MCP tools: `zotero_list_libraries` discovers libraries, and `zotero_switch_library` switches the library for subsequent tool calls; confirm the target in conversation when it is unclear.
This is not Qoder's per-call argument protocol, nor does it automatically aggregate all libraries: the upstream switch applies to subsequent calls in the current MCP process. Restore personal-library context before reading the personal library; group libraries remain subject to API Key permissions.
The locally dependent source enables the `libraries` tool group by default; real account and concurrent-session behavior require separate acceptance.

`libraries` uses the same host authorization-management channel for read-only discovery. It does not install, save, or replace credentials, or change the running MCP configuration. The Key is sent only in request headers to the fixed official Zotero API; pagination does not follow arbitrary links returned by the service. This endpoint is no longer used by the authorization form. Existing explicit library configuration is still validated against its original target and is not silently changed to another library during authorization refresh or reconnection; resubmitting authorization with only an API Key defaults to the personal library.
These statements describe source behavior; integration with real personal/group accounts and final Desktop screenshots require separate acceptance.

<a id="oauth-应用配置"></a>
## OAuth Client Configuration

The authorization UI lists API Key before OAuth and shows only methods actually supported by the service. The backend validates API Keys by calling the service. OAuth must complete real service discovery, client registration, browser authorization, callback exchange, and handshake checks; a frontend button cannot directly mark it successful. The browser opens only the HTTPS authorization URL returned by the service, with no fallback to `about:blank`, a local demo account, or a simulated consent page. Demo scripts in reference HTML are not product entry points; this repository does not modify reference files to pass them off as a real integration.

Key labels, placeholders, acquisition links, and help text consistently use “API Key” without changing each service's authentication protocol. Authorization state belongs to the connector, not an individual tab; any valid method shows the connector as authorized. Only an explicit “Change authorization” action reopens the authorization form; failure or cancellation preserves the original authorization. The catalog displays version `1.0.0` consistently; actual protocol handshake and underlying dependency versions retain their original values and are not overwritten by the display version.

Services supporting DCR reuse the local registration record. GitHub uses a managed authorization strategy: first sign in to ScholarSeed, then the current account service creates an authorization transaction bound to the user, PKCE, and loopback URI. The callback is still received by local Serve; code exchange and refresh call the account service over HTTPS, and the client neither configures nor receives a shared Client Secret.
Server-side configuration and implementation belong to a separate enterprise repository; this repository maintains only the consumer contract. If the service is unconfigured or login has expired, report an explicit error; do not fall back to a built-in Secret, PAT, or Device Flow. Existing authorization flows for other connectors are unchanged.
Other services also support `SCHOLARSEED_CONNECTOR_<大写条目 ID>_CLIENT_ID` (“uppercase entry ID”) and `_CLIENT_SECRET`; do not automatically modify the user's environment or register an account.

The callback is `http://127.0.0.1:<port>/api/settings/connectors/callback` on the port actually listened to by the current Serve process. Do not construct it from the request Host or forwarding headers. Pre-registered applications must allow this callback; for services that do not support dynamic loopback ports, the deployer must provide a compatible client-registration strategy rather than bypassing the restriction by relaxing callback validation.

<a id="持久化与边界"></a>
## Persistence and Boundaries

`state.json` under `paths.CONNECTOR_STATE_ROOT` uses the existing pinned-directory, native-lock, and atomic-publication capabilities. Credentials are stored privately with operating-system permission protection, **not encrypted at rest**; this directory is included in the product Agent deny-read roots. Public responses contain only state, tools, and opaque authorization URLs; they do not contain a Token, PKCE verifier, client secret, or credential reference. Runtime configuration stores only opaque references.

Both macOS and Windows reuse the storage Owner's permission, lock, and path semantics; local contract tests do not prove native Windows product acceptance. STDIO does not concatenate Shell commands or download dependencies when connecting. The bundled Zotero server is launched by the current product Python at the pinned version `zotero-mcp-server==0.15.1`; the MCP SDK is pinned to `mcp==1.26.0`. Both and any added transitive dependencies use the project's existing official PyPI index explicitly, without changing global configuration or the mirror source for other packages. Source deployments must be able to reach that index; final installers still require freezing and distribution acceptance on both platforms.

<a id="跨平台预检查"></a>
### Cross-Platform Preflight

| Boundary | macOS | Windows | Verification boundary |
| --- | --- | --- | --- |
| Local command and arguments | SDK starts a separate argv | SDK resolves the command extension and starts a separate argv | Do not add Shell concatenation; Windows `.exe`/`.cmd`/`.bat` still need native runtime verification |
| Paths and environment variables | Preserve local absolute paths and each value | Preserve drive letters/UNC, spaces, backslashes, and each value | Chinese working directories, quoted and special-character arguments, empty arguments, and Chinese environment values were verified in the macOS subprocess contract; this is not a Windows test |
| Protocol and diagnostic encoding | MCP uses UTF-8; stderr is read with error tolerance | Same; does not rely on the system code page | Non-UTF-8 stderr must not mask the original error classification; UTF-8 protocol and CRLF are covered by contracts |
| Subprocess exit | SDK cleans up the process group | SDK cleans up the Job Object/process tree | Preserve existing activity draining; do not terminate processes by name. Windows descendant-process exit still needs device verification |
| Private state | Reuse the storage Owner | Reuse the storage Owner's native permissions, locks, and atomic replacement | Do not treat POSIX permission bits or a bare directory fd as a Windows implementation |

STDIO stderr is used only for bounded error classification; raw logs are not echoed to the frontend. Non-UTF-8 bytes are read with replacement characters while preserving the distinction between a missing dependency and process failure. Protocol stdout still strictly follows UTF-8; tolerant decoding is not used to accept malformed MCP messages.

<a id="自定义"></a>
## Custom Connectors

“Add connector” in the marketplace reuses the existing versioned MCP configuration channel. It supports HTTP/SSE/STDIO forms and bulk import, preview, editing, enable/disable, and removal of `mcpServers` JSON. A single configuration can be converted between form and JSON with parameter order preserved. Descriptions and integer timeouts of at least 1000 milliseconds are stored in the actual configuration; the timeout maps to Codex `tool_timeout_sec` and is not display-only. New configurations preserve the intent to enable them. Saving performs an actual HTTP handshake and discovers the complete tool list; network failures preserve the configuration, and a 401 sets the state to authorization required. STDIO performs a real subprocess handshake and discovery; a successful save does not stand in for connectivity. Publish the batch only after all validation and version-conflict checks pass, preserving existing configuration.
Request-header and environment-variable values are stored in private ConnectorStore records; only opaque references enter MCP configuration. When editing the same target, leaving a field blank preserves its existing value; removing a field removes that value; public listings never echo values. After the service address, command, arguments, or working directory changes, do not automatically pass the old credentials to the new target; preserving them by leaving fields blank is rejected.
macOS and Windows both reuse the existing path, lock, and execution channels; no Shell concatenation or automatic installation commands are introduced. Local acceptance does not prove Windows behavior. When custom HTTP/SSE encounters a real authentication challenge, discover OAuth using resource metadata and reuse the real login, callback, refresh, and revocation lifecycle. Discovery and authorization endpoints must use public HTTPS; DNS resolution is pinned to a checked public address to prevent loopback/private metadata access and credential leakage through redirects.
Do not fabricate a login entry point when usable OAuth metadata is absent; request headers can still be edited. Revocation results distinguish remote revocation from local-only removal and provide a provider management link; deleting a local Token must not be described as revoking remote access.

Resource discovery prioritizes `resource_metadata` from the authentication challenge. If it is absent, query `/.well-known/oauth-protected-resource` for the MCP path and then the site root, supporting POST-only services that return 405 for GET. Only 404/405 advances to the next candidate; authentication errors, network errors, and resource-identity mismatches remain failures. Every candidate still uses public HTTPS, pinned DNS, and resource/issuer validation; there is no automatic registration or login.
Details and cards distinguish authorized, credentials pending validation, authorization not required, and authentication method not yet identified. A local process not requiring authorization does not mean the handshake succeeded. If OAuth is not discovered for a custom entry, offer configuration editing and retry after failure; do not label configuration editing as authorization. Protocol failures and 401 responses separately indicate communication failure and missing/invalid/expired credentials.

<a id="prd-对齐边界2026-10-22"></a>
## PRD Alignment Boundaries (2026-10-22)

| Requirement | Current implementation and acceptance boundary |
| --- | --- |
| §4 Catalog, installation, search | Marketplace/My are separate; installation does not authorize. Cards show no extra status; counts and refresh are on the tab row, and Add is in the search area |
| §5 Details and status | Custom connectors also open a separate detail view; four states derive from authorization, enablement, and connection results. Version, paginated tools, and retrieval time come from validation results; unknown is not zero |
| §6 Initial authorization and replacement | Preserve the first credential already proven valid if tool discovery fails; replace the original authorization only after the new credential and connection both succeed. Positive authorization with real providers still needs account and permission acceptance |
| §7 Management and deletion | Manage existing authorization in details; disabling preserves credentials; deletion removes only local records, not third-party content; failed configuration removal preserves a recoverable record |
| §8 Custom input | HTTP/SSE/STDIO, name/description/timeout, individual arguments and key-value items, single-item form↔JSON conversion, bulk preview, configuration-conflict protection, and credential isolation after target changes |
| §8 Custom connection | Real handshakes and complete discovery for all three transports; custom OAuth resource discovery and real lifecycle; failures preserve configuration and provide actionable errors |
| Execution | SDK sessions, tool-change notifications, per-request credential resolution and refresh, and cleanup on disable/exit; deterministic protocol tests are not real-account acceptance |
| Accepted scope | macOS Desktop: public DeepWiki HTTP discovery and real model-driven tool calls; real Zotero SSE/STDIO process handshakes and discovery, which do not constitute library-account acceptance |
| gap | Installer freezing/distribution on both platforms, Windows product execution, and positive real-account authorization and in-account Agent calls for all seven services still require separate acceptance |

This table distinguishes code capability from product acceptance and does not mean all requirements are complete. Real test results and screenshots are stored in an ignored task evidence directory; mocked protocol tests are not provider connectivity.

<a id="验证"></a>
## Verification

For catalog takeover and storage maintenance, first drain Runtime attachments and the Provider pool; then the composition root asks the Broker to release idle connections. The Broker validates the current maintenance generation. Startup, in-flight RPCs, or unfinished HTTP requests return a blocker; active connections are not forcibly stopped. Idle connections reuse the existing SDK close path and wait for actual cleanup; failure or cancellation cannot be reported as success. Admission can be closed and catalog eligibility switched only after every Owner has completed.
Release does not delete connector configuration or credentials and does not close the listener; the same endpoint can establish a new connection as needed after maintenance. Catalog timeout logs record each Owner's blockers and activity counts, not credentials or tool content.

Run `../../.venv/bin/python -m tests.contract_connectors` from `apps/serve`; this suite is registered in `tests/run_all.py`. HTTP mocks are only for deterministic protocol and security contracts, not provider-connectivity acceptance. Real authorization requires a user account, credentials, service plan, and organization permissions; projects that lack these prerequisites remain explicitly pending acceptance.

<a id="mcp-初始化超时与诊断"></a>
## MCP Initialization Timeout and Diagnostics

Advanced JSON configuration for custom connectors supports `startup_timeout` in milliseconds (minimum 1000, maximum JavaScript safe integer); the existing `timeout` remains the tool-request timeout. Example:
`{"mcpServers":{"research":{"url":"https://example.invalid/mcp","startup_timeout":120000,"timeout":60000}}}`。
Switching between JSON and form views and saving again preserves the startup timeout; this does not add a form control. If unset, the existing default behavior remains.

An explicit startup budget covers connection, initialization, and first tool discovery in the Serve bridge, and is passed through to Runtime and Codex as `startup_timeout_sec`; tool requests continue to use a separate budget. A timeout does not automatically replay a tool. Shutdown still waits for the associated connection task to finish and does not treat a timer firing as proof that the native process has exited.
Initialization failures record a fixed stage, server-identifier digest, numeric errno/Windows system code, and correlation ID; they do not record raw exception text, commands, paths, or credentials. A log-write failure does not change the original initialization result.

Shutdown/disable and startup timeout are separate controls. Shutdown cancels the associated transport task if it is still connecting, initializing, or performing first discovery, and waits for SDK context and process cleanup to finish; already admitted tool calls are drained first. If the shutdown caller is cancelled, the independent cleanup task continues and is awaited; issuing cancellation does not count as completed cleanup. After shutdown, no new start is accepted, and bridge cold startup follows the same shutdown protocol.
