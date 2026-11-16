# Charts and Formulas

Ordinary answers use the display-only [conversation.ui](conversation.md) registry. Use independent extensions below for statistical plots, original-row selection, annotated formulas and native Markdown. Content and rich-content.compose are retired; never send a blocks wrapper.

| slot | data | Contract / example |
| --- | --- | --- |
| plot.view | {title?,model,notes?,sources?,script?} | [Schema](plot/schema.json) / [Request](plot/compose.json) |
| table.view | {dataset} | [Schema](table/schema.json) / [Request](table/compose.json) |
| formula.view | {caption?,source,notes?} | [Schema](formula/schema.json) / [Request](formula/compose.json) |
| markdown.view | {text} | [Schema](markdown/schema.json) / [Request](markdown/compose.json) |

Discover live contracts first. Send {request_id,title,slot,data} via component/display, or component/request only when continuation needs an explicit decision. The latter returns {action,values:{selected:[stable row IDs]}} in result.answers. Local operations and drafts never resume the Agent. Cancellation, failure and unknown outcomes are not confirmation. Changed inputs require a new request ID; reuse an ID only for a retry with identical parameters. The schema applies only to the `data` field.

Have Python/Bash compute and serialize the complete operation request into a session-local UTF-8 JSON file. Pass `request_file: "output/plot-request.json"` instead of `request`, never both. The file must contain more than just the dataset. Omit the outer capability/operation envelope. Print only the path and a summary; do not transcribe points through the model or give scripts Bridge credentials. Published cards retain their data snapshot.

A dataset has `columns: [{key, label, unit?}]` and `rows: [{id, values: [...]}]`. Null means missing, not zero. A plot model has `kind`, `dataset`, `x`, `y`, and optional `value` and `bins`. Supported kinds are `bar`, `grouped-bar`, `stacked-bar`, `line`, `scatter`, `pie`, `donut`, `histogram`, `boxplot`, and `heatmap`. Plot column indices are zero-based. Heatmaps require long-form rows with distinct `x`, `y: [columnIndex]`, and `value` columns; box plots need explicit ordered five-number summaries; pie charts reject negative values. Sources and scripts must reflect actual work.

Use Markdown fences for code/Mermaid and delimiter-free LaTeX for Formula source. Rendering does not execute code, prove mathematics, publish files or verify sources. Generate and validate real files before artifact/publish; these cards grant no network, filesystem or host privileges.
