# Conversation OpenUI signatures

Generated from the official Agent registry (host-v3). Do not edit.
Schema SHA-256: 1eeaa08167f28cf5ecc89f6fe92ab2ccd7fe739a76f877d66fecce0812882da7

Generate OpenUI Lang, not JavaScript, JSX, HTML or a chat protocol. Use root = Conversation([...]).
Only literal data and declared display components are admitted. No actions, external resource URLs, queries, mutations, reactive variables, regular expressions or arbitrary tools.
Compose natural explanation, relevant components, then interpretation. Do not add a web page shell, nested cards or extra vertical scroll owners.
User input, execution progress, confirmation, clarification and error recovery belong to existing native product flows, not generated conversation components.
Registered components (positional arguments):
Conversation(children: any[]) — A natural conversation answer: narrative, relevant components, then interpretation. No outer card or independent scroll area.
TextContent(text: string, size?: "small" | "default" | "large" | "small-heavy" | "large-heavy") — Narrative Markdown, including fenced code and section breaks. Links and images remain literal; source and artifact navigation stay in native product flows.
Tag(text: string, icon?: Icon, size?: "sm" | "md" | "lg", variant?: "neutral" | "info" | "success" | "warning" | "danger") — Styled tag/badge with optional Icon and variant
TagBlock(tags: string[], size?: "sm" | "md" | "lg") — tags is an array of strings; optional size sm | md | lg
Table(columns: Col[]) — Data table — column-oriented. Each Col holds its own data array.
Col(label: string, data: any, type?: "string" | "number" | "action") — Column definition — holds label + data array
BarChart(labels: string[], series: Series[], variant?: "grouped" | "stacked", xLabel?: string, yLabel?: string, height?: number, title?: string) — Vertical bars; use for comparing values across categories with one or more series Optional title labels the shared figure/data and source-copy header.
LineChart(labels: string[], series: Series[], variant?: "linear" | "natural" | "step", xLabel?: string, yLabel?: string, height?: number, title?: string) — Lines over categories; use for trends and continuous data over time Optional title labels the shared figure/data and source-copy header.
AreaChart(labels: string[], series: Series[], variant?: "linear" | "natural" | "step", xLabel?: string, yLabel?: string, height?: number, title?: string) — Filled area under lines; use for cumulative totals or volume trends over time Optional title labels the shared figure/data and source-copy header.
HorizontalBarChart(labels: string[], series: Series[], variant?: "grouped" | "stacked", xLabel?: string, yLabel?: string, title?: string) — Horizontal bars; prefer when category labels are long or for ranked lists Optional title labels the shared figure/data and source-copy header.
ScatterChart(datasets: ScatterSeries[], xLabel?: string, yLabel?: string, title?: string) — X/Y scatter plot; use for correlations, distributions, and clustering Optional title labels the shared figure/data and source-copy header.
ScatterSeries(name: string, points: Point[]) — Named dataset
Point(x: number, y: number, z?: number) — Data point with numeric coordinates
Series(category: string, values: number[]) — One data series
PieChart(labels: string[], values: number[], variant?: "pie" | "donut", appearance?: "circular" | "semiCircular", title?: string) — Circular slices; use plucked arrays: PieChart(data.categories, data.values) Optional title labels the shared figure/data and source-copy header.
RadialChart(labels: string[], values: number[], title?: string, maximum?: number) — Radial bars; use plucked arrays: RadialChart(data.categories, data.values) Optional title labels the shared figure/data and source-copy header. For fixed-target progress, supply maximum after title: RadialChart(labels, values, title, maximum); each arc and percentage uses that denominator, not the sum or largest value. Without maximum this is a relative category comparison, never absolute progress.
SingleStackedBarChart(labels: string[], values: number[], title?: string) — Single horizontal stacked bar; use plucked arrays: SingleStackedBarChart(data.categories, data.values) Optional title labels the shared figure/data and source-copy header.
Slice(category: string, value: number) — One slice with label and numeric value
RadarChart(labels: string[], series: Series[], title?: string) — Spider/web chart; use for comparing multiple variables across one or more entities Optional title labels the shared figure/data and source-copy header.
Only literal registered display components are admitted.
Do not generate URLs, regular expressions, scripts, queries, mutations, reactive variables or built-in actions.
Source citations and artifact navigation belong to native product flows, not generated display components.
Use component/display with slot conversation.ui and data {format: "openui-lang", version: 1, source: program}. Reuse request_id and increment revision by one to update the same surface; identical retries retain the revision.
This slot is display-only. Use native product tools for input, progress, confirmation, clarification and recovery. Local resource opening never advances the Agent.
