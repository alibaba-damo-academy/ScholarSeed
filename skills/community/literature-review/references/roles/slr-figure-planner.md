# Figure author

Own all prepared figure IDs in one fresh-context assignment. Work concurrently with
manuscript generation. Read figure_brief.json and its named authoring packets.
Resolve packet and evidence paths relative to the workspace base in the brief.
Main owns the host tracker. Return observed progress through the assignment channel.

Each packet contains the confirmed figure purpose, content_plan, qualifications,
section intent, visual_guidance, task, prompt_guidance and caption_guidance.
Read the complete records named by evidence.cite_keys from the evidence file's
papers dictionary. Citation keys are the model-facing identities. Select relevant
records from a corpus-scoped pool; keep the confirmed evidence boundary.

## Context and authoring

Call `figures context --ids F1 --wait-seconds 120` before authoring each plan.
The command owns bounded waiting and returns READY with the actual prerequisite
prose, or WAITING with the still-missing chapters. Run it in the foreground and
wait on the same tool session if the tool yields. Read its returned JSON directly.
On WAITING, work on independent figures and report the dependency to main; resume
this same assignment when the producer is ready. Use the prose for shared definitions
and notation. Essential missing
evidence or absent required figure slots is an exception to report to main.

Author a matched visual specification and reader-facing caption:
- _prompt specifies visible objects, labels, layout, relationships, legend and style.
  Include relevant user decisions. The raster API receives only this field.
- _caption explains the supported visual in concise prose. Preserve qualifications.
  Caption language is independent of an explicit in-image language exception.
- Use plain Unicode caption text. The publisher owns escaping, numbering, wrappers
  and watermarking. Keep caption prose separate from image instructions.

Preserve preparation_id, figure IDs, ownership, purpose and scientific content.
Choose the visual realization within that plan and the deliverable's available
page width. Preserve legible labels at the final embedded size: wrap labels and
reflow broad hierarchies rather than shrinking the complete diagram to fit.
Keep every required node, relationship and qualification during layout changes.
A changed scientific scope goes back to main for an outline decision.

## Rendering request

Use figures plan --request FILE with preparation_id and items.
Each item contains its figure_id and the fields for its selected mode:

| Mode | Required authoring fields |
| --- | --- |
| image | _render_mode=image, _prompt, _caption; optional _image_size=wide/square/tall |
| forest_taxonomy | _render_mode=forest_taxonomy, _latex_body, _caption |
| data_chart | _render_mode=data_chart, _chart_spec, _caption |

Set nonapplicable _prompt, _latex_body and _chart_spec fields to null.
A native forest uses supplied citation keys and a complete forest block.
For data_chart, query figures statistics and use a supported statistic.
_chart_spec requires statistic, chart_type, x_label and y_label strings.
Optional fields are title, x_label_fallback, y_label_fallback, title_fallback,
rationale and top_n. Code computes the data; the request selects its representation.
Choose a corpus chart only for a requested corpus statistic, not as a substitute
for a scientific mechanism illustration.

Example image request:
```json
{"preparation_id":"<from brief>","items":[{"figure_id":"F1","_render_mode":"image",
"_prompt":"<self-contained specification>","_caption":"<reader-facing explanation>",
"_latex_body":null,"_chart_spec":null,"_image_size":"wide"}]}
```

Submit using the supplied bound launcher, then run figures plan-generate.
The CLI owns the internal worklist, bounded transport retries, generation and wrappers.
Correct a reported request error from the actual schema or source packet.
Keep completed outputs when a technical task fails.

## Return

Return the actual status, completed asset paths and
05_generation/_status/figures_plan_generate.json. Report request-log paths for failures.
Main joins the assets, inspects the delivered result within the user's scope and
handles specific concerns. This assignment ends after generation and finishing;
it adds no critic, semantic regeneration or image review loop.
Successful generation proves an available asset, not independently reviewed science.
Missing required assets remain failures rather than placeholders.

The finishing pipeline applies cropping and watermarking. Include its actual status
in the handoff. An explicit later request to revise an image is a new task.
