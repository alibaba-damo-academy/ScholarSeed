# MCP Server Configuration — 书深 MCP 配置

Use this reference when the user asks to inspect, add, remove, enable, disable, or change
an external MCP tool server. MCP configuration is product-owned state — always
use bridge operations, never read or write configuration files directly.

## Bridge Operations

| Operation | Capability | Purpose |
| --- | --- | --- |
| Status | `mcp` / `status` | Read current MCP application state and servers |
| Plan | `mcp` / `plan` | Prepare a single-server change without installing |
| Apply | `mcp` / `apply` | Commit an existing plan under current permissions |

### Status — Read MCP State

```json
{
  "capability": "mcp",
  "operation": "status",
  "request": {}
}
```

Optionally pass `{"plan_id": "<id>"}` to also retrieve a conversation-owned plan.

Returns the current configuration revision, server list (with transport, enabled
state), application state (`ready`, `pending_apply`, `failed`, `disabled`), and
whether MCP is supported by the current runtime.

### Plan — Prepare a Change

```json
{
  "capability": "mcp",
  "operation": "plan",
  "request": {
    "expected_revision": 0,
    "mutation": {
      "operation": "upsert",
      "server": {
        "id": "my-server",
        "name": "My MCP Server",
        "transport": "http",
        "url": "https://example.com/mcp"
      }
    },
    "intent": "Add example MCP server"
  }
}
```

Mutations:
- `upsert` — add or update a server (requires `server` with `id`, `name`, `transport`, and transport-specific fields)
- `remove` — remove a server by `server_id`
- `enable` — enable or disable a server by `server_id` and `enabled` boolean

Server transports:
- **HTTP**: `transport: "http"`, `url: "https://..."` (optional `headers`)
- **Stdio**: `transport: "stdio"`, `command: "npx"`, `args: [...]` (optional `cwd`, `environment`)

Returns a plan with `plan_id` and `plan_digest` for later commit. The plan does
not install or execute anything.

### Apply — Commit a Plan

```json
{
  "capability": "mcp",
  "operation": "apply",
  "request": {
    "plan_id": "<plan_id from plan operation>",
    "plan_digest": "<plan_digest from plan operation>"
  }
}
```

The product enforces permission checks at commit time. Returns the updated plan
state (`saved`) and the new configuration.

## Workflow

1. **Check status** — call `mcp/status` to see current servers and revision
2. **Plan** — call `mcp/plan` with the desired mutation and current revision
3. **Apply** — call `mcp/apply` with the returned plan_id and plan_digest
4. **Verify** — call `mcp/status` again to confirm the new state

Always create a plan first, then apply it. Never bypass the plan workflow by
writing configuration files directly. The single source of truth is the
product-owned configuration file, not personal runtime settings.

## Reporting the Result

For ordinary MCP product-operation replies, use only ScholarSeed product terms.
Do not repeat internal engine names, managed runtime paths, or external-client
installer commands, even when explaining what was not changed. Report the actual
product state and safe error; saved or pending does not mean tools are ready.
New tools become available after this turn ends, not during installation.

## Important Boundaries

- Never write `mcp.json` or any Codex configuration file directly
- Never read or import user `~/.codex` MCP configurations
- The product ignores personal runtime MCP settings
- Configuration changes take effect at the next safe session boundary
- The current turn does not use newly added tools; the next turn does
- Distinguish between connecting to an HTTP server and downloading/executing
  a local stdio program — the former does not imply authorization for the latter

## User-facing replies

For ordinary MCP product-operation replies, use only ScholarSeed product terms.
Do not repeat internal engine names, managed runtime paths, or external-client
installer commands, even when explaining what was not changed. Report the actual
product state and safe error; saved or pending does not mean tools are ready.
New tools become available after this turn ends, not during installation.
