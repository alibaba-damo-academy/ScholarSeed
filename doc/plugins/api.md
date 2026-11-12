---
id: reference-plugin-api
title: Available APIs
doc_type: design
category: skills
status: active
keywords: [skill, sdk, hil]
summary: Find actual contracts for the frontend SDK, component discovery, and Skill backend operations.
---

# Available APIs

**English** · [简体中文](api.zh.md) · [Read offline](../plugins.html#api)

[Plugin Overview](../plugins.md)

`scholarseed-bridge` is ScholarSeed's backend CLI for agents to inspect resources, manage literature, and display conversation cards. Skills use this CLI; card interfaces use the [frontend SDK](#frontend-sdk).

## Use the CLI

Inside ScholarSeed's agent execution environment, use `scholarseed-bridge <capability> <operation> --json '<request>'`:

```sh
scholarseed-bridge history list --json '{"limit":5}'
scholarseed-bridge component catalog --json '{"include_ui":true}'
scholarseed-bridge component preflight --json '{"slots":["reading.focus"]}'
```

The CLI uses the current session's project and authorization. Inspect parameters with:

```sh
scholarseed-bridge --help
scholarseed-bridge component request --help
```

AI can also call the `scholarseed_bridge` model tool using `{capability, operation, request}`. JSON examples below use that envelope; the CLI's `--json` accepts only its inner `request`.

## Inspect the Actual Contract

In a Python environment with the matching backend installed, run:

```sh
python -m service.cli.plugins describe
```

This returns the descriptor format, component SDK, and request definitions. Follow the target backend's output when developing or updating a plugin. See [Write It Yourself](create.md#write-it-yourself) for the `host` value.

## Frontend SDK

| Method | Result | Purpose |
| --- | --- | --- |
| `window.plugin.onState(callback)` | Unsubscribe function | Current snapshot and later state updates; unsubscribe on unmount. |
| `window.plugin.setCopyContent({text, markdown?})` | Promise with registration result | Register copyable card text; does not write the system clipboard. |
| `window.plugin.save(values)` | Promise with `{state, revision}` | Save a JSON draft without continuing the AI task. |
| `window.plugin.submit(actionId, values)` | `void` | Submit an answer; determine completion from subsequent state. |
| `window.plugin.request(actionId, values)` | Promise with the operation result | Invoke a declared operation with a handler in the current context. |
| `window.scholarseedUI.mount(render)` | Unmount function | Mount React UI and synchronize state, language, and theme. |
| `window.scholarseedUI.useCopyContent(text)` | React Hook | Add the current component's text to the card's copy content. |

Ordinary custom cards currently connect plugin-call only to `skills.list` and `navigation.skills`. Full text, classifications, and saving in literature cards use domain-specific ports. Copying names such as `literature.read` or `navigation.open` does not grant those operations to an ordinary card.

### Register Copyable Card Content

Register text after UI state updates. When copying a message, ScholarSeed merges turn prose and card content in order. Public cards generate this text from business data; do not register it again.

Inside `mount()`, official `Conversation.Choices`, `Results`, `Details`, `References`, `Downloads`, `Delivery`, and `Review` components automatically register text. Compositions merge their content. Collapsed review sections, citations, checks, and questions remain included. Artifacts retain titles and paths; their file contents are not automatically read.

`Markdown`, `Message`, `Code`, `Formula`, and `Artifact` also register automatically. Code retains its full source even when collapsed; formulas retain LaTeX, descriptions, and annotations. `Tabulation` requires `copyText` or `invalidSource` and does not infer data from table DOM.

For custom rendering, call `window.scholarseedUI.useCopyContent(text)` inside a component and declare `useCopyContent` in `ui.exports`. The Hook combines text from components and re-registers it after saved state updates; registration failures appear inside the card. Do not combine this Hook with direct `setCopyContent()` calls that replace the entire card's text.

```js
const { React, mount } = window.scholarseedUI;

function Notes({ state }) {
  const [error, setError] = React.useState("");
  const focus = state.draft?.focus ?? "evidence";
  React.useEffect(() => {
    let current = true;
    window.plugin.setCopyContent({
      text: `Reading focus: ${focus === "method" ? "Understand the method" : "Check the evidence"}`
    }).then(() => {
      if (current) setError("");
    }).catch(() => {
      if (current) setError("Copy content could not be saved");
    });
    return () => { current = false; };
  }, [focus, state.revision]);
  return React.createElement("p", { role: error ? "status" : undefined }, error || focus);
}

mount(state => React.createElement(Notes, { state }));
```

`text` is required. Include headings, body, current choices, and citations or links that should be preserved, but not action buttons such as Submit or Expand. Optional `markdown` may retain source; copying currently uses `text`, and HTML is not accepted. Registration is limited to 64 KiB and also subject to the total message-size limit.

Wait for `save()` to finish, then register text using the new state delivered through `onState`. Draft updates invalidate old text; registrations against an old revision are rejected. Registered text persists with the card's session binding, so copying historical cards does not rerun their iframe. Cards without text explicitly indicate the omission. Registration neither advances the AI nor grants clipboard read/write permission.

## Discover Components and Slots

Query components and official UI exports:

```json
{"capability":"component","operation":"catalog","request":{"include_ui":true}}
```

The result includes current components, UI exports, and the composition catalog. Read-only preflight checks custom slots for conflicts:

```json
{"capability":"component","operation":"preflight","request":{"slots":["reading.focus"]}}
```

Preflight checks only conflicts. Installation and enabling validate again.

## Discover Backend Operations

List operations and inspect their request contract:

```json
{"capability":"contract","operation":"list","request":{}}
```

```json
{"capability":"contract","operation":"describe","request":{"target_capability":"literature","target_operation":"read"}}
```

### Current CLI Operations

Names in this table follow `scholarseed-bridge`.

| Commands and operations | Purpose | Effects and precautions |
| --- | --- | --- |
| `history list / search / read` | List sessions, search messages, and read more content | Read only currently authorized history. |
| `resource list / read` | List or read current-project resources | Read-only; continue large-file reads using returned pagination. |
| `resource import` | Import published artifacts or session files into project resources | Writes resources; confirm files and destination first. |
| `pdf list / status / read / search / library / annotations` | Inspect PDFs, preparation state, text, evidence windows, and annotations | Read authorized content; returns citation identity and page numbers. |
| `pdf prepare` | Prepare PDF text and index | Starts preparation; use `status` for progress. |
| `pdf materialize` | Write PDF content to a destination | Creates files and records; confirm the destination. |
| `pdf register-card` | Register a `paper_card` | Writes structured literature evidence and its version. |
| `literature list / read / annotations / receipt` | Read literature, text, annotations, and full-text authorization receipts | `receipt` reports the actual authorized and acquired full-text scope for this turn. |
| `literature authorize` | Request full-text permission | Shows candidate papers and waits for user confirmation. |
| `literature result / review` | Show search-result or review-workflow cards | Presents checkpoint results, collects choices, or confirms an outline. |
| `literature acquire` | Obtain authorized candidates' open full text | Downloads and manages files; returns per-paper outcomes. |
| `literature ingest / import` | Import downloads or session files into the literature library | Writes library entries and associates the current project; `import` follows an explicit user instruction. |
| `literature delivery` | Present the full-text saving workflow | Pins a delivery batch, then saves or imports according to later user choices. |
| `literature collection.list / tag.list` | List collections or tags | Collections belong to the current project; tags are shared globally. |
| `literature collection.create / collection.update` | Create, rename, or move collections | Modifies the current project's collection structure. |
| `literature tag.create / tag.update` | Create or rename tags | Changes global tags; renaming affects every project using them. |
| `literature collection.delete / tag.delete` | Delete collections or tags | Returns affected associations first; deletion requires user confirmation. |
| `literature organize` | Add or remove collection/tag associations | Changes selected literature entries' associations. |
| `search run` | Execute product search | Makes external requests and registers new results. **Do not automatically retry:** another call runs another search. |
| `search browser` | Internal browser callback for search | Used by existing search tasks; plugins use `search run`. |
| `artifact publish` | Publish generated file artifacts | Registers files and pinned versions for opening or saving. |
| `plan get` | Read the current plan | Returns the plan, step IDs, and revision. |
| `plan write / structure / action` | Write plans, change structure, or record execution actions | Changes plan state; supply the current revision and operation request ID. |
| `task activate` | Activate task identity | Changes the current turn's binding; called by the Skill launcher. |
| `display-card` | Show a business card | Creates a recoverable conversation card; takes `--json` directly. |
| `component catalog / preflight` | Inspect components, exports, or slot conflicts | Read-only. |
| `component request / display` | Request interaction or display a custom card | Creates a card; `request` waits for an answer, `display` only displays content. |

## Source and Types

Use a source revision matching the target ScholarSeed version. These repository-relative links work in a public checkout without access to a private code host:

- [Descriptor and schema](../../apps/serve/service/capabilities/service/descriptor.py), [offline tools](../../apps/serve/service/cli/plugins.py).
- [Official UI exports](../../packages/ui/manifest.json), [component catalog](../../packages/ui/catalog.ts).
- [SDK types](../../packages/ui/contract.ts), [Conversation exports](../../packages/ui/conversation.ts).
- [Action handlers](../../apps/serve/service/capabilities/api/routes.py), [research-card ports](../../apps/desktop/src/renderer/src/features/literature/ports.ts).
- [CLI commands](../../apps/serve/service/cli/bridge.py), [backend operation registry and effects](../../apps/serve/service/platform/bridge.py).

When an upgrade is incompatible, update the plugin and rerun checks. Do not merely widen the `host` range or skip validation.
