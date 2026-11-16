# Canvas OpenUI signatures

Generated from the official Agent registry (host-canvas-v1). Do not edit.
Schema SHA-256: 5443ee51e9ca714a754388fa32083a766a68af06400bc9e54d8c7f8d436c77ad

Generate the OpenUI program for CanvasDocument.source only. Continue using the normal Agent tool workflow outside that string.

## Syntax Rules

1. Each statement is on its own line: `identifier = Expression`
2. `root` is the entry point — every program must define `root = Stack(...)`
3. Expressions are: strings ("..."), numbers, booleans (true/false), null, arrays ([...]), objects ({...}), or component calls TypeName(arg1, arg2, ...)
4. Use references for readability: define `name = ...` on one line, then use `name` later
5. EVERY variable (except root) MUST be referenced by at least one other variable. Unreferenced variables are silently dropped and will NOT render. Always include defined variables in their parent's children/items array.
6. Arguments are POSITIONAL (order matters, not names). Write `SomeComp([children], "row", "l")` NOT `SomeComp([children], direction: "row", gap: "l")` — colon syntax is NOT supported and silently breaks
7. Optional arguments can be omitted from the end
8. Declare mutable state with `$varName = defaultValue`. Components marked with `$binding` can read/write these. Undeclared $variables are auto-created with null default.
9. String concatenation: `"text" + $var + "more"`
10. Dot member access: `query.field` reads a field; on arrays it extracts that field from every element
11. Index access: `arr[0]`, `data[index]`
12. Arithmetic operators: +, -, *, /, % (work on numbers; + is string concat when either side is a string)
13. Comparison: ==, !=, >, <, >=, <=
14. Logical: &&, ||, ! (prefix)
15. Ternary: `condition ? valueIfTrue : valueIfFalse`
16. Parentheses for grouping: `(a + b) * c`
- Strings use double quotes with backslash escaping

## Component Signatures

Arguments marked with ? are optional. Sub-components can be inline or referenced; prefer references for better streaming.
Props marked `$binding<type>` accept a `$variable` reference for two-way binding.

Stack(children: any[], direction?: "row" | "column", gap?: "none" | "xs" | "s" | "m" | "l" | "xl" | "2xl", align?: "start" | "center" | "end" | "stretch" | "baseline", justify?: "start" | "center" | "end" | "between" | "around" | "evenly", wrap?: boolean)
Tabs(items: TabItem[])
TabItem(value: string, trigger: string, content: (TextContent | MarkDownRenderer | CardHeader | Callout | TextCallout | CodeBlock | Image | ImageBlock | ImageGallery | Separator | HorizontalBarChart | RadarChart | PieChart | RadialChart | SingleStackedBarChart | ScatterChart | AreaChart | BarChart | LineChart | Table | TagBlock | Form | Buttons | IconButton | Steps | InlineHeader | EntityList | EditableTable | SnippetCardBlock | OverviewCardBlock | ContextCardBlock | CompositeCardBlock | VisualCardBlock)[])
Accordion(items: AccordionItem[])
AccordionItem(value: string, trigger: string, content: (TextContent | MarkDownRenderer | CardHeader | Callout | TextCallout | CodeBlock | Image | ImageBlock | ImageGallery | Separator | HorizontalBarChart | RadarChart | PieChart | RadialChart | SingleStackedBarChart | ScatterChart | AreaChart | BarChart | LineChart | Table | TagBlock | Form | Buttons | IconButton | Steps | InlineHeader | EntityList | EditableTable | SnippetCardBlock | OverviewCardBlock | ContextCardBlock | CompositeCardBlock | VisualCardBlock)[])
Separator(orientation?: "horizontal" | "vertical", decorative?: boolean)
FormControl(label: string, input: Input | TextArea | Select | DatePicker | Slider | CheckBoxGroup | RadioGroup | Chips | OptionCards, hint?: string)
Label(text: string)
Input(name: string, placeholder?: string, type?: "text" | "email" | "password" | "number" | "url", rules?: {required?: boolean, email?: boolean, url?: boolean, numeric?: boolean, min?: number, max?: number, minLength?: number, maxLength?: number, pattern?: string}, value?: $binding<string>)
TextArea(name: string, placeholder?: string, rows?: number, rules?: {required?: boolean, email?: boolean, url?: boolean, numeric?: boolean, min?: number, max?: number, minLength?: number, maxLength?: number, pattern?: string}, value?: $binding<string>)
Select(name: string, items: SelectItem[], placeholder?: string, rules?: {required?: boolean, email?: boolean, url?: boolean, numeric?: boolean, min?: number, max?: number, minLength?: number, maxLength?: number, pattern?: string}, value?: $binding<string>, size?: "small" | "medium" | "large")
SelectItem(value: string, label: string)
Slider(name: string, variant: "continuous" | "discrete", min: number, max: number, step?: number, defaultValue?: number[], label?: string, rules?: {required?: boolean, email?: boolean, url?: boolean, numeric?: boolean, min?: number, max?: number, minLength?: number, maxLength?: number, pattern?: string}, value?: $binding<number[]>)
CheckBoxGroup(name: string, items: CheckBoxItem[], rules?: {required?: boolean, email?: boolean, url?: boolean, numeric?: boolean, min?: number, max?: number, minLength?: number, maxLength?: number, pattern?: string}, value?: $binding<Record<string, boolean>>)
CheckBoxItem(label: string, description: string, name: string, defaultChecked?: boolean)
RadioGroup(name: string, items: RadioItem[], defaultValue?: string, rules?: {required?: boolean, email?: boolean, url?: boolean, numeric?: boolean, min?: number, max?: number, minLength?: number, maxLength?: number, pattern?: string}, value?: $binding<string>)
RadioItem(label: string, description: string, value: string)
SwitchGroup(name: string, items: SwitchItem[], variant?: "clear" | "card" | "sunk", value?: $binding<Record<string, boolean>>)
SwitchItem(label?: string, description?: string, name: string, defaultChecked?: boolean)
TextContent(text: string, size?: "small" | "default" | "large" | "small-heavy" | "large-heavy")
Tag(text: string, icon?: Icon, size?: "sm" | "md" | "lg", variant?: "neutral" | "info" | "success" | "warning" | "danger")
TagBlock(tags: string[], size?: "sm" | "md" | "lg")
Table(columns: Col[])
Col(label: string, data: any, type?: "string" | "number" | "action")
BarChart(labels: string[], series: Series[], variant?: "grouped" | "stacked", xLabel?: string, yLabel?: string, height?: number, title?: string)
LineChart(labels: string[], series: Series[], variant?: "linear" | "natural" | "step", xLabel?: string, yLabel?: string, height?: number, title?: string)
AreaChart(labels: string[], series: Series[], variant?: "linear" | "natural" | "step", xLabel?: string, yLabel?: string, height?: number, title?: string)
HorizontalBarChart(labels: string[], series: Series[], variant?: "grouped" | "stacked", xLabel?: string, yLabel?: string, title?: string)
ScatterChart(datasets: ScatterSeries[], xLabel?: string, yLabel?: string, title?: string)
ScatterSeries(name: string, points: Point[])
Point(x: number, y: number, z?: number)
Series(category: string, values: number[])
PieChart(labels: string[], values: number[], variant?: "pie" | "donut", appearance?: "circular" | "semiCircular", title?: string)
RadialChart(labels: string[], values: number[], title?: string, maximum?: number)
SingleStackedBarChart(labels: string[], values: number[], title?: string)
Slice(category: string, value: number)
RadarChart(labels: string[], series: Series[], title?: string)

## Hoisting & Streaming (CRITICAL)

openui-lang supports hoisting: a reference can be used BEFORE it is defined. The parser resolves all references after the full input is parsed.

During streaming, the output is re-parsed on every chunk. Undefined references are temporarily unresolved and appear once their definitions stream in. This creates a progressive top-down reveal — structure first, then data fills in.

**Recommended statement order for optimal streaming:**
1. `root = Stack(...)` — UI shell appears immediately
2. $variable declarations — state ready for bindings
3. Component definitions — fill in with data already available
4. Data values — leaf content last

Always write the root = Stack(...) statement first so the UI shell appears immediately, even before child data has streamed in.
## Important Rules
- Choose components that best represent the content (tables for comparisons, charts for trends, forms for input, etc.)

## Final Verification
Before finishing, walk your output and verify:
1. root = Stack(...) is the FIRST line (for optimal streaming).
2. Every referenced name is defined. Every defined name (other than root) is reachable from root.
3. Every $binding appears in at least one component or expression.

- This is a task Canvas, not a conversation answer. Local fields and reactive variables never resume the Agent.
- The host owns optional rollback/cancel/submit controls. Do not generate submission buttons, Query, Mutation, @Run, @ToAssistant or @OpenUrl.
- Use named fields. Submitted values unwrap OpenUI field wrappers; field names and form nesting must match the declared output_schema.
