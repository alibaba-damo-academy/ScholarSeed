# Verify a generated plugin

## Before implementation: define expected results

For each decisive requirement, record the input, user action if applicable, expected value and failure condition. Derive expectations independently from user criteria or source material, not actual component output. Keep small JSON fixtures and rerunnable assertions under the session's `work/` directory. Use standard-library `unittest` in the product Python runtime or the available JavaScript runner. Failures should report the scenario, item ID, expected and actual values, and source.

Use representative data and only the boundaries that matter to this workflow:

| Risk | Cases and assertions |
| --- | --- |
| Evidence mapped to the wrong item | Match the label, details and export to the same ID, quotation, value, unit and source; use a nearby value from a different item as a negative case. |
| Comparison missing a source | Run with both sources and with the revision alone. Preserve an explicitly restated earlier value and its qualification; mark original verification as pending. |
| Stale decisions or deadlines | Switch between branches, clear selection and switch back. Check effective dates and current tasks in the card, actual answer and export; exclude inactive branches. |
| Misaligned interval charts | Assert the shared mapping at the reference value, on both sides and for an interval crossing it. Check ticks and labels in the narrow host. |

## Before packing: validate the actual payloads

Update every component's invocation payload and its generated Skill reference when schemas, actions or domain fields change. Use descriptor action IDs, not button objects. Run `validate` on each file in `requests/` and on any actual first-card payload saved in the session:

```sh
scholarseed-skill-python -m service.cli.plugins validate ./plugin-source/.scholarseed-plugin.json ./work/request.json
```

This checks the descriptor, invocation envelope and `input_schema`; it does not invoke the model, install or grant permission. Use `detail.path` and `missing` to fix the actual reference, retaining a copy of the original payload to check that source materials, selections and references survived the correction.

## Packaged preview: inspect the first view and operate the component

Follow the [scenario contract](interaction.md#preview-the-same-component) for `responses` and `submissions`. Include the expected initial result, a representative long title or value, and missing or empty data where relevant. Use two inputs with different expected results when a branch changes the outcome. Cover applicable normal, failed, cancelled and read-only states. Check that resetting or paging through a preview restores the scenario's inputs.

Load the exact candidate in the host. Use the [design guide](DESIGN.md#visual-and-interaction-checks) to inspect the initial view before scrolling, in both themes and at regular and narrow widths (about 590 px of **workbench content** for narrow workbench cases). Capture the first view and a key action. Check that the result, comparison and action read in order; inspect long values, evidence disclosure, dialog copy, focus and keyboard/pointer access. A failed action should preserve input and offer retry for that operation. If preview is unavailable, keep the scenarios and mark the checks pending until authorized installation. Preview responses prove component behavior only.

## Installed workflow: verify the actual outcome

Use a real task and host replies, not hand-built submissions. Open actual exports and check both values and [presentation](DESIGN.md#copy-and-exported-results). Select the relevant cases:

| Flow | What to verify in the host |
| --- | --- |
| Display and workbench | Run the same plugin with two inputs; only data changes. Check one display call per result in tool receipts. Filter, select, inspect evidence and move to the workbench and back: keep state and focus without save errors. |
| Edit and save | Prefill real values, distinguishing missing from empty, `false` and empty strings. Type into an initially empty row, clear it and type again. Deselect a default. Check real saved values, no restored defaults, and no older receipt overwriting a newer edit. |
| Confirm and recover | Make consecutive edits or insert/remove a row, then confirm without blurring. Check the actual submitted values, `pending` → `submitting` → `resolved` and the next model action. On save or submit failure retain edits, report the right failure and test retry. On cancellation stop; on unknown outcome inspect the existing request before retrying. |
| Review and revise | Keep the workbench open during confirmation and verify the same view and artifact link. Reopen the conversation and check pinned package/data, final values, accessible details and disabled edit/save/submit. Verify each revision separately: new ID, unchanged materials and carried-forward confirmations. |
| Copy the turn | Use the host copy control to check text/card order, complete collapsed content, raw chart data, sources and current selection. Test save revision updates, registration retry and copy after unmount. Check automatic and custom content do not overwrite one another. |

Record package, preview and live results separately as passed, failed or unverified. Keep failed-run recordings. If the workbench reports that the plugin page did not load after submission, capture before/after, host logs and recovery without discarding the original card or resubmitting. Fix source failures, rebuild, and rerun the affected scenario on the new digest. Record the scenario, width where relevant, observation, fix and result.
