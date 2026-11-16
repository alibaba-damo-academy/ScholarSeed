import assert from "node:assert/strict";
import { test } from "node:test";
import {
  prepareChart,
  CHART_KINDS,
  validateDataset,
  type Dataset,
} from "../../apps/desktop/src/renderer/src/components/ui/statistics.ts";

const dataset: Dataset = {
  columns: [
    { key: "name", label: "方法" },
    { key: "score", label: "得分", unit: "%" },
  ],
  rows: [
    { id: "a", values: ["A", -2] },
    { id: "b", values: ["B", 0] },
    { id: "c", values: ["C", 3] },
  ],
};

test("datasets and charts accept more than 10000 rows and 64 columns", () => {
  const large: Dataset = {
    columns: Array.from({ length: 65 }, (_, index) => ({
      key: `c${index}`,
      label: `C${index}`,
    })),
    rows: Array.from({ length: 10001 }, (_, index) => ({
      id: `r${index}`,
      values: Array.from({ length: 65 }, (_, column) => index + column),
    })),
  };
  assert.doesNotThrow(() => validateDataset(large));
  const result = prepareChart({ kind: "line", dataset: large, x: 0, y: [64] });
  assert.equal(result.members.length, large.rows.length);
  assert.equal(result.option.series[0].data.at(-1), 10064);
  assert.doesNotThrow(() =>
    prepareChart({ kind: "histogram", dataset: large, x: 64, y: [] }),
  );
});

test("chart preparation preserves source row identity, negative values and gaps", () => {
  const result = prepareChart({ kind: "bar", dataset, x: 0, y: [1] });
  assert.deepEqual(result.members, [["a"], ["b"], ["c"]]);
  assert.deepEqual(result.option.series[0].data, [-2, 0, 3]);
  assert.equal(result.option.tooltip.renderMode, "richText");
  assert.equal("formatter" in result.option.tooltip, false);
  const missing = structuredClone(dataset);
  missing.rows[1].values[1] = null;
  assert.deepEqual(
    prepareChart({ kind: "line", dataset: missing, x: 0, y: [1] }).option
      .series[0].data,
    [-2, null, 3],
  );
});

test("histogram uses explicit bins and accounts for every input, including the upper endpoint", () => {
  const result = prepareChart({
    kind: "histogram",
    dataset,
    x: 1,
    y: [],
    bins: 2,
  });
  assert.deepEqual(result.members.flat().sort(), ["a", "b", "c"]);
  assert.deepEqual(result.option.series[0].data, [2, 1]);
  assert.equal(result.option.yAxis.name, "");
  assert.equal(result.option.yAxis.minInterval, 1);
  assert.equal(
    prepareChart(
      { kind: "histogram", dataset, x: 1, y: [1], bins: 2 },
      { frequency: "频数" },
    ).option.yAxis.name,
    "频数",
  );
  assert.deepEqual(result.intervals, [
    [-2, 0.5],
    [0.5, 3],
  ]);
});

test("all declared chart families produce inert options with explicit numeric fields", () => {
  const full = {
    columns: ["label", "low", "q1", "median", "q3", "high"].map((key) => ({
      key,
      label: key,
    })),
    rows: [{ id: "a", values: ["A", 1, 2, 3, 4, 5] }],
  };
  for (const kind of CHART_KINDS) {
    const data =
      kind === "scatter" || kind === "histogram"
        ? { ...full, rows: [{ id: "a", values: [0, 1, 2, 3, 4, 5] }] }
        : full;
    const result = prepareChart({
      kind,
      dataset: data,
      x: 0,
      y:
        kind === "boxplot"
          ? [1, 2, 3, 4, 5]
          : kind === "heatmap"
            ? [1]
            : [1, 2],
      value: 2,
    });
    assert.ok(result.option.series.length, kind);
    assert.equal(typeof JSON.stringify(result.option), "string");
  }
});

test("invalid datasets and chart semantics are rejected, not repaired into invented results", () => {
  assert.throws(
    () => prepareChart({ kind: "heatmap", dataset, x: 0, y: [0, 1], value: 1 }),
    /chart_heatmap_fields/,
  );
  assert.throws(
    () =>
      validateDataset({ ...dataset, rows: [dataset.rows[0], dataset.rows[0]] }),
    /duplicate_row/,
  );
  assert.throws(
    () =>
      validateDataset({
        ...dataset,
        rows: [{ id: "a", values: ["A", Infinity] }],
      }),
    /invalid_value/,
  );
  assert.throws(
    () => prepareChart({ kind: "pie", dataset, x: 0, y: [1] }),
    /negative_slice/,
  );
  assert.throws(
    () => prepareChart({ kind: "scatter", dataset, x: 0, y: [1] }),
    /numeric_field/,
  );
  assert.throws(
    () => prepareChart({ kind: "bar", dataset, x: 0, y: [5] }),
    /field_missing/,
  );
});
