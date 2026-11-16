# Custom interactions: payloads and lifecycle

This guide describes existing schema 2 semantics. It neither grants capabilities nor replaces real usage verification.

## Declare and invoke a component

Declare `id`, `slot`, JSON `preview` and `actions` under schema 2 `components`; do not use schema 1 `ui`, standalone HTML or `context/invoke`. Public components reference a public slot from the contract, set `public: true` and omit `entry`. The host owns those implementations and their domain tools and permissions; generic invocation cannot replace them or fabricate candidates, downloads or authorization records.

Custom components provide a package-local JavaScript `entry` and omit `public` or set it to false. Use the contract's JSON Schema subset without external references. Inputs, drafts and answers are JSON, not secrets or functions. Mount ordinary JavaScript in the host's `#root`; no CDN, remote modules, network requests or proxies, Node, host DOM, popups, downloads or external links. The host owns the isolated container.

For a workbench, verify host support before declaring `"workbench": true` on the custom component (or using `--workbench`). The host supplies the open action and moves the same instance; do not add a navigation button.

At runtime, check `component/catalog` with `{}` through the model tool `scholarseed_bridge`, not shell credentials. A descriptor or preview does not display a card. Use `component/display` once per logical result: the returned card record does not prove business completion. A display card is resolved; browsing state stays local with no draft saves. Use `component/request` when later work depends on the answer. Parse `{action, values}` from `result.answers` on success and treat `result.cancelled` as cancellation. Failure, expiry and unknown delivery cannot advance dependent work. Consume successful answers without asking for textual confirmation again.

Start with the package's invocation payload and the current `component_invocation_schema`. Both calls require `request_id`, `slot`, `data` and `title`; optional `prompt` explains the decision but does not replace the title. Measure serialized UTF-8 bytes against `bridge_request_max_bytes`, not the data schema limit. Send only summaries, stable IDs and evidence pointers for the current step. Split oversized requests by stage and keep full evidence in the persistent working directory.

Use a new ID for a new result, stage or revision. If delivery is uncertain, check the original receipt before retrying with the same ID and identical payload. Keep inputs on failure and carry unchanged confirmations forward. Never repeat business side effects to recover an unknown response.

Enablement allows new bindings; it does not run the Skill or display a card. Custom slots are exclusive among enabled plugins. An initial conflict may permit installation without enablement; an update conflict preserves the previous version and registration. Disablement prevents new bindings, while existing interactions remain pinned to their original package, data and saved choices and continue only after permission checks.

## The same values, two validations

A component's input_schema describes host-provided data. An action's input_schema describes user-submitted values.
For interaction.answer, the component output_schema validates those same values, not the outer answer envelope.
For example, a user submits `{ "feedback": "Keep the current scope" }`:

```json
{
  "type": "object",
  "properties": { "feedback": { "type": "string" } },
  "required": ["feedback"],
  "additionalProperties": false
}
```

Use this schema for both the confirmation action input_schema and the component output_schema.
Do not require action in output_schema or silently add an undeclared stage on submission.
Only the host's answer to the AI is `{ "action": "confirm", "values": { "feedback": "Keep the current scope" } }`.

## Preview the same component

A scenario uses `{data, responses}`; cover every action with a `{state, data}` response, where state is resolved, failed or cancelled. Include `"submissions": { "confirm": [{ "feedback": "Keep the current scope" }] }`-style examples for each custom confirmation action. The preview validates actual submitted values against both schemas before applying sample responses.

Public previews reuse the host component; custom previews load the same package code as live use. Replace only business execution with sample responses. Do not add preview-only confirmation controls or execute real business operations. Use the [testing guide](testing.md) for task-specific scenarios and checks.

## Registering content for copying

The host's copy control below the message combines the text and cards in order; the iframe does not write directly to the clipboard. Inside the official `mount`, text and research cards, charts, `DataTable` and `Content` register automatically. For additional custom-rendered text, call the declared `useCopyContent(text)` from the React component. Use `setCopyContent({text, markdown?})` for the whole card only when it is fully custom-rendered. Do not mix replacement-style registration with automatic merging in the same frame.

After saving a draft, wait for `onState.revision` to update before registering the new version. Keep complete source text, excerpts, sources and current choices. Do not copy buttons, rely only on the collapsed DOM or read files pointed to by artifact links. Report registration failures and allow retry. If content exceeds 64 KiB, do not truncate it and report success. Copy registration neither advances the AI, proves task completion nor grants clipboard permissions.

## Saving and submitting

```javascript
try {
  const receipt = await window.plugin.save({ feedback });
  savedRevision = receipt.revision;
  savedDraft = receipt.state;
  showSaved();
} catch (error) {
  showUnsaved(error);
}
```

The card implements these variables and display functions. `receipt.state` is the saved JSON draft, not the string `"saved"`. Only a successful receipt with its revision proves persistence; save neither authorizes nor advances the workflow. Keep local input on failure. Submit the declared action and JSON values with `window.plugin.submit`; wait for `onState`, not a business-result Promise. Sensitive operations require trusted host confirmation outside the component.

## Local edits are not host snapshots

Use `data` for card inputs and field definitions, and `draft` for saved user values. Do not merge them even when the keys match: for example, `data.fields` is an array of field definitions, while `draft.fields` is an object of values. Restore values from the draft one field at a time.

Maintain an independent current edit model. Inputs, insertion/removal, sorting and priority changes update it immediately.
Save and confirm handlers read that model at click time, not a values copy captured during a previous render.
Validation must not make optional user fields mandatory. Whether removing the final item is allowed is a business requirement.

On first mount, restore draft: empty arrays, false and empty strings are valid. Fall back to data/default only for missing fields.
`onState` supplies the host snapshot (`data`, `draft`, `status`, `language`, `slot`, `theme`). State, language or theme changes with identical data/draft must not clear unsaved edits. An iframe remount is not a new business step.
An older save receipt must not overwrite edits made while saving. Record the edit revision submitted for saving; mark everything saved only if the local revision has not changed.
Define a merge/conflict policy for genuinely new workflow data or externally changed drafts. Never reset the edit model unconditionally on every onState.
Disable answer submission outside pending. Completed display cards may still offer authorized read-only viewing actions.

When a confirmation card resolves, use its final values to restore the original view. Include the stable IDs, filters, selections and edits needed for review in the declared values. Disable editing, saving and submission; keep details readable.

The scaffold's optional `data.fields` is an array of `{id, label, placeholder?, value?}` definitions. Text defaults to an empty string; drafts and answers use `fields: {fieldId: text}`. No definitions means no extra inputs. Update requests, preview responses, submissions and downstream consumption together. Dynamic rows need their own checks: the first edit must write real state even when the displayed row started as a placeholder or all rows were deleted.

## Answers and host capabilities are separate

plugin.submit answers a pending interaction; it cannot open papers, navigate, save or import to a library.
A display card has no pending answer, so submit on it cannot produce navigation.
Use `await plugin.request(actionId, values)` for host capabilities. Declare the action in the package and verify that the current invocation context has its real handler.
Present success, cancellation and failure separately. Catch rejection and retain content; "sent" does not mean "opened".

Declaring navigation.open or literature.read does not create an arbitrary literature API.
Generic custom component plugin-call currently connects skills.list and navigation.skills only. Paper viewing and other domain operations belong to the corresponding public literature card's domain port.
Copying a public card's action name into a generic custom card does not make it available. Explain a missing capability and agree on a supported flow instead of generating a dead "open full text" button, silently degrading or using window.open to bypass isolation.
