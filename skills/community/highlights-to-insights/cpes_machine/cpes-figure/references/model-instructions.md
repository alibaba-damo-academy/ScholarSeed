# Figure Card reading instructions

Inspect every attached image. Treat the packet as the complete default text context. Match the user's language; when unspecified in a Chinese conversation, write Chinese while preserving original symbols, metric names, and technical terms.

Return only the schema-conforming mutable JSON object. Do not reproduce fixed metadata or add a card title; the numbered author caption is the heading. Use the exact field names below, with no aliases. All six fields are required even when an array is empty.

## Field semantics

- `overview` is a string of one or two short declarative sentences. Start with a short overview of what the Figure shows and its role, not a question or a list of graphical objects.
- `panels` is an array of objects with `panel_id`, `title`, and `visual_observations`. Explain its subfigures or multiple included assets as panels inside that card. Panel titles distinguish subfigures; use an empty title when none is appropriate. `visual_observations` is an array of strings describing directly visible structure or trends, not a single string. A single-panel figure still has one `panels` item. Use an empty `panels` array only when `visual_status` is `unavailable`.
- `how_to_read` is an array of strings, not a single string. Explain the reading path: panel order, axes, units, legend, comparison, metric direction, and the visual pattern that matters.
- `author_findings` is an array of objects with `claim` and a non-empty array of `evidence_ids`. Attribute a conclusion to the authors only when the caption or paper text supports it. A plausible interpretation is not an author finding. If no supplied evidence line supports a claim, omit the finding.
- `prerequisites` is an array of strings describing notation and setup needed to read the figure.
- `scope` is an array of strings describing datasets, models, parameters, sample sizes, domains, and statistical conditions under which the result holds.

## Reading discipline

- Use exact values only when legible in the figure or explicitly stated in the paper. Never estimate a precise value from pixels and present it as reported data.
- Prefer qualitative trends to pixel-derived point estimates. Include an approximate plotted value only when it materially helps the reading and is clearly legible; never enumerate approximate curve values merely to sound complete.
- Treat legend encoding as a mapping, not as additional plotted series. Count panels, curves, entities, arrows, or stages only after checking the entire Figure; when crowded or ambiguous, describe the visible groups without asserting a count.
- Cite only supplied line IDs (`L1099`, or `S1:L1099` for multiple sources). Source headers declare files; caption/body/appendix/other headings declare evidence types. Read the complete caption identified by `Caption evidence` and each `Reference` window. The cited lines together must entail the whole claim. `Caption (uncitable)` has no numbered source and cannot support an evidence ID.
- Preserve operation polarity when paraphrasing mechanisms: for example, “receives a smaller bonus” is not “is penalized,” correlation is not causation, and an absent increase is not a decrease.
- Do not invent generic limitations. If the paper supplies no figure-relevant limitation, say so and state only evidence-based scope boundaries.
- Avoid repeating the same fact across fields. Explain each fact fully only in its most appropriate field; other fields should add distinct information, not paraphrase that explanation.
- Before returning JSON, silently verify: every visual statement is directly visible; every author claim is entailed by its cited lines; every count and legend mapping was checked; and no uncertainty was converted into a fact.
