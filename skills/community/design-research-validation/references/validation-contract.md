# Auditable validation contract

For a machine-readable plan, return one JSON object with these shared fields in
addition to the requested native `discussion` and `predictions` fields:

- `status`: `ready` or `insufficient_material`.
- `claim_map`: decision-relevant claims. Each item has `claim_id` (`C1`, `C2`, ...),
  `statement`, a short exact `source_anchor`, `central` (boolean), `disposition`
  (`validate` or `unresolved`), and `axes`. Each axis has `axis_id` (`C1.A1`, ...)
  and a material-derived `validation_question`. An unresolved claim instead has
  empty `axes` and a non-empty `unresolved_reason`.
- `coverage`: one item per prediction, with its zero-based `prediction_index` and
  the non-empty `axis_ids` it addresses.

For `ready`, expose the map before selecting predictions. Cover every axis of every
`validate` claim. Copy source anchors from the supplied material; do not paraphrase
them. The fields define traceability, not scientific dimensions: derive every claim
and axis from the material.

For `insufficient_material`, explain the missing content in `discussion` and return
empty `claim_map`, `predictions`, and `coverage`.
