# Charts and Formulas

**English** · [简体中文](content.zh.md)

Ordinary answers use the display-only [conversation.ui](conversation.md) registry. Use the extensions below for statistical plots, annotated formulas and native Markdown. For original-row selection, read [selection](selection.md) instead. Content and rich-content.compose are retired; never send a blocks wrapper.

| slot | data | Contract / example |
| --- | --- | --- |
| plot.view | {title?,model,notes?,sources?,script?} | [Schema](plot/schema.json) / [Request](plot/compose.json) |
| formula.view | {caption?,source,notes?} | [Schema](formula/schema.json) / [Request](formula/compose.json) |
| markdown.view | {text} | [Schema](markdown/schema.json) / [Request](markdown/compose.json) |

Read [interaction rules](interaction.md) before calling a custom slot, and only
its selected bundled schema/example. Missing or mismatched contracts use
[catalog recovery](catalog.md); do not fetch valid same-release schemas again.

A dataset has `columns: [{key, label, unit?}]` and `rows: [{id, values: [...]}]`. Null means missing, not zero. A plot model has `kind`, `dataset`, `x`, `y`, and optional `value` and `bins`. Supported kinds are `bar`, `grouped-bar`, `stacked-bar`, `line`, `scatter`, `pie`, `donut`, `histogram`, `boxplot`, and `heatmap`. Plot column indices are zero-based. Heatmaps require long-form rows with distinct `x`, `y: [columnIndex]`, and `value` columns; box plots need explicit ordered five-number summaries; pie charts reject negative values. Sources and scripts must reflect actual work.

Use Markdown fences for code/Mermaid and delimiter-free LaTeX for Formula source. Rendering does not execute code, prove mathematics, publish files or verify sources. Generate and validate real files before artifact/publish; these cards grant no network, filesystem or host privileges.
