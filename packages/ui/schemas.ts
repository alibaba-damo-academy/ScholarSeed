const text = { type: "string", maxLength: 65536 } as const;
const dataIdentifier = { type: "string", minLength: 1 } as const;
const integer = { type: "integer", minimum: 0 } as const;
const array = <Item extends object>(items: Item) => ({ type: "array", items });
const list = <Item extends object>(items: Item, maxItems = 64) => ({
  type: "array",
  items,
  maxItems,
});
const object = <Properties extends Record<string, object>>(
  properties: Properties,
  required: string[] = Object.keys(properties),
) => ({ type: "object", properties, required, additionalProperties: false });
const column = object(
  { key: dataIdentifier, label: { type: "string" }, unit: { type: "string" } },
  ["key", "label"],
);
const row = object({
  id: dataIdentifier,
  values: array({ type: ["string", "number", "null"] }),
});
const dataset = object({
  columns: { ...array(column), minItems: 1 },
  rows: array(row),
});
const chartFields = object(
  {
    kind: {
      enum: [
        "bar",
        "grouped-bar",
        "stacked-bar",
        "line",
        "scatter",
        "pie",
        "donut",
        "histogram",
        "boxplot",
        "heatmap",
      ],
    },
    dataset,
    x: integer,
    y: array(integer),
    value: integer,
    bins: { type: "integer", minimum: 1 },
  },
  ["kind", "dataset", "x", "y"],
);
const chart = {
  ...chartFields,
  allOf: [
    {
      if: { properties: { kind: { const: "heatmap" } }, required: ["kind"] },
      then: {
        required: ["value"],
        properties: { y: { minItems: 1, maxItems: 1 } },
      },
    },
  ],
};
const plot = object({ title: text, model: chart, notes: text, sources: list(text), script: text, version: text }, ["model"]);
const table = object({ dataset }, ["dataset"]);
const formula = object({ caption: text, source: text, notes: text }, ["source"]);
const markdown = object({ text }, ["text"]);
const selection = object({ selected: { ...array(dataIdentifier), uniqueItems: true } });

export const schemas = {
  dataset,
  chart,
  plot,
  table,
  formula,
  markdown,
  selection,
} as const;

const reference = (name: string) => ({ $ref: `#/$defs/${name}` });
const chartDefinition = {
  ...chart,
  properties: { ...chart.properties, dataset: reference("dataset") },
};
export const schemaCatalog = {
  $defs: {
    dataset,
    chart: chartDefinition,
    plot: { ...plot, properties: { ...plot.properties, model: reference("chart") } },
    table: { ...table, properties: { dataset: reference("dataset") } },
    formula,
    markdown,
    selection,
  },
  inputs: {
    plot: reference("plot"),
    table: reference("table"),
    formula: reference("formula"),
    markdown: reference("markdown"),
  },
  output: reference("selection"),
} as const;
