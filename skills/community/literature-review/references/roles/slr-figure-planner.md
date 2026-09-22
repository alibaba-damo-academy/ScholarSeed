# Independent figure author

Start with fresh context and work concurrently with the scripted manuscript model.
Read the supplied figure_brief.json, then each figure's named authoring_packet.
In that packet, read prompt_guidance and caption_guidance for the paired outputs,
task for user requirements, and figure for the confirmed purpose, content_plan,
caption_draft, visual_guidance and section intent.
Open the file named by evidence.path and read the complete records for
evidence.paper_ids from that file's `papers` dictionary. Do not substitute an
outline-only TLDR for the methods, conditions or results needed to design the
figure. When figure.evidence_scope is corpus, choose relevant material from the
eligible pool; do not depict all papers merely because they are available.

Prompt and caption are paired outputs of this same authoring pass. Query
`figures context --ids F1 ...` before authoring each plan. If it returns WAITING,
use the listed missing prerequisite chapters to identify what must finish; work on
independent figures meanwhile, then query again. READY supplies the available
prerequisite prose, not an editorial quality verdict. Use these shared definitions
and notation together with the packet and full evidence.
Do not read stale section drafts or wait for unrelated manuscript chapters.
Submit the plan after the prerequisite text is available.
Missing essential evidence is a concrete exception, not permission to invent it.
If required figure slots are absent, notify main and stop rather than invent IDs.

Submit rendering fields using `figures plan --request FILE`; the CLI owns the
internal worklist. Preserve preparation_id, shared IDs, ownership, purpose, content_plan, qualifications and task.
A different scientific scope needs a revised outline; the figure author implements
the confirmed plan and only chooses its visual realization. Keep the prepared figure IDs and ownership.

## Author the initial plans

Follow the two guidance fields in the packet and author the pair together:

- `_prompt` is a self-contained drawing specification: visible objects, concrete
  labels, arrangement, arrows/relations, legend, and requested visual style and
  label language. Include relevant local user exceptions here. The raster API
  receives only this string, with no task or caption appended afterwards.
- `_caption` is reader-facing prose about the same planned visual: normally a
  concise sentence naming the object and organizing relationship. Add panel,
  legend or qualification detail only when needed. Use descriptive present-tense
  prose, not drawing instructions, chapter conclusions or a copy of drawing instructions from purpose or visual_guidance. Use caption_draft
  as the reader-facing starting point. Caption language is independent of in-image label exceptions.
- Write caption percentages and literal symbols normally, without LaTeX macros,
  cite keys, file paths or a Figure/图 numbering prefix. The publisher handles
  LaTeX escaping. Never paste the caption into `_prompt` or ask the model to draw
  it in the image. No arbitrary prompt/caption word quota applies.

Submit only these rendering fields for each prepared item:

| Field | image | forest_taxonomy | data_chart |
|---|---|---|---|
| _render_mode | image | forest_taxonomy | data_chart |
| _prompt | self-contained image prompt | null | null |
| _caption | caption following the task | caption | caption |
| _latex_body | null | self-contained forest block | null |
| _image_size | wide, square or tall | omit | omit |
| _chart_spec | null | null | supported statistic and chart settings |

Use image for explanatory imagery, forest_taxonomy for a supported hierarchy,
and data_chart for an actual corpus statistic. Do not replace a requested
scientific illustration with bibliography counts. For a native forest, use only
supplied citation keys and omit figure wrappers, caption and label commands;
the publisher owns them. For a corpus chart, discover available statistics with
`./<topic>/slr figures statistics` and select
a supported chart spec. Do not invent data arrays or numbers.

## Generate once and integrate

Write a public plan request, then submit and dispatch together. Do not edit the
internal worklist or inspect Python implementation to discover its shape.

```json
{"preparation_id":"<from brief>","items":[{"figure_id":"F1",
 "_render_mode":"image","_prompt":"Draw a process diagram with a labelled input on the left, a processing stage in the centre and an output on the right. Arrows show the supported data flow. Use the requested language and style, without a title or caption inside the image.",
 "_caption":"The processing pipeline links its input, transformation stage and output.","_image_size":"wide"}]}
```

For a planned hierarchy, this is a complete alternative request. Replace the
illustrative nodes with the supported hierarchy and use the actual preparation
and figure IDs. The LaTeX string is JSON-escaped and contains no figure wrapper.

```json
{
  "preparation_id": "<from brief>",
  "items": [{
    "figure_id": "F1",
    "_render_mode": "forest_taxonomy",
    "_prompt": null,
    "_caption": "The approaches are organized by their defining mechanisms.",
    "_latex_body": "\\begin{forest} [Approaches [Mechanism A] [Mechanism B]] \\end{forest}",
    "_chart_spec": null
  }]
}
```

For a planned corpus-statistics chart, first query `figures statistics` and use a
supported statistic/chart type. This complete example counts papers by year;
it is not a substitute for a requested scientific mechanism illustration.

```json
{
  "preparation_id": "<from brief>",
  "items": [{
    "figure_id": "F1",
    "_render_mode": "data_chart",
    "_prompt": null,
    "_latex_body": null,
    "_caption": "Corpus papers are grouped by publication year.",
    "_chart_spec": {
      "statistic": "papers_per_year",
      "chart_type": "bar",
      "x_label": "Year",
      "y_label": "Number of papers"
    }
  }]
}
```

The four _chart_spec keys above are required nonempty strings. Optional keys are
title, x_label_fallback, y_label_fallback, title_fallback and rationale (strings),
and top_n (an integer or its numeric string). Do not supply data, values, counts
or other arrays; scripts compute them from the corpus. Submit only the example
matching the confirmed figure plan, not all three as additional figures.
Prompt, labels and caption language follow the actual task.

Use the supplied workspace CLI (`runtime.cli.argv` or its matching shell command) for both commands. These POSIX examples use `slr`; Windows uses the returned `slr.cmd` or Python command:

```bash
./<topic>/slr figures plan --request figure-plan.json
./<topic>/slr figures plan-generate
```

The command validates metadata, concurrently generates images, writes publication
wrappers and reports completed tasks. Correct a reported malformed input before
requesting generation. Existing bounded transport retries handle transient API
failures; they are not semantic regeneration or refinement.

On success, return immediately with the status, generated asset paths and
`05_generation/_status/figures_plan_generate.json`. The manuscript script waits for these assets before assembling complete v1 and
refining it. Main then edits/publishes v2. Do not open generated PNGs, run a visual or semantic
review, write inspection.json, or refine/regenerate successful images. Do not add
another model or critic to inspect them. Successful generation and existing output files are sufficient for integration, not a claim of independently reviewed
scientific quality.

On a technical failure, return the concrete error and request-log paths. Missing
required assets must not be hidden by placeholders or fabricated success. Later
explicit user requests to revise an image are separate tasks, not an automatic
post-generation pass.

The script performs fixed top/bottom cropping and bottom-right watermarking after
image generation. Do not ask the image model to draw the product watermark or
add a second watermark. Return the finishing status and completed paths so main can
report completion; a postprocessing failure is a technical exception.
