import React from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import * as plots from "../../apps/desktop/src/renderer/src/components/primitive/Plot";
import { DataTable as TableView } from "../../apps/desktop/src/renderer/src/components/primitive/DataTable";
import {
  datasetTSV,
  type Dataset,
} from "../../apps/desktop/src/renderer/src/components/ui/statistics";
import { copyText, useCopyContent } from "./copying";

type Translate = TFunction<"conversation">;
const join = (parts: (string | undefined)[]): string =>
  parts.filter(Boolean).join("\n\n");

function datasetText(dataset: Dataset): string {
  try {
    return datasetTSV({
      ...dataset,
      columns: dataset.columns.map((column) => ({
        ...column,
        label: column.unit ? `${column.label} (${column.unit})` : column.label,
      })),
    });
  } catch {
    return JSON.stringify(dataset, null, 2) ?? "null";
  }
}

function selection(ids: string[] | undefined, translate: Translate): string {
  return ids?.length
    ? `${translate("plot.selected", { count: ids.length })}\n${ids.join("\n")}`
    : "";
}

function plotText(
  props: {
    model: { dataset: Dataset };
    title?: string;
    notes?: string;
    sources?: string[];
    script?: string;
    version?: string;
    selected?: string[];
  },
  translate: Translate,
): string {
  return join([
    props.title,
    props.notes,
    datasetText(props.model.dataset),
    selection(props.selected, translate),
    props.sources?.length
      ? `${translate("plot.sources")}\n${props.sources.join("\n")}`
      : undefined,
    props.script ? `${translate("plot.script")}\n${props.script}` : undefined,
    props.version
      ? `${translate("plot.version")}\n${props.version}`
      : undefined,
  ]);
}


function composed<Props extends { onCopy?: (text: string) => Promise<void> }>(
  View: React.ComponentType<Props>,
  text: (props: Props, translate: Translate) => string,
): React.ComponentType<Props> {
  return function Card(props: Props): React.JSX.Element {
    const { t: translate } = useTranslation("conversation");
    useCopyContent(text(props, translate));
    return <View {...props} onCopy={props.onCopy ?? copyText} />;
  };
}

export const Plot = composed(plots.Plot, plotText);
export const BarChart = composed(plots.BarChart, plotText);
export const GroupedBarChart = composed(plots.GroupedBarChart, plotText);
export const StackedBarChart = composed(plots.StackedBarChart, plotText);
export const LineChart = composed(plots.LineChart, plotText);
export const ScatterChart = composed(plots.ScatterChart, plotText);
export const PieChart = composed(plots.PieChart, plotText);
export const DonutChart = composed(plots.DonutChart, plotText);
export const Histogram = composed(plots.Histogram, plotText);
export const BoxPlot = composed(plots.BoxPlot, plotText);
export const Heatmap = composed(plots.Heatmap, plotText);
export const DataTable = composed(TableView, (props, translate) =>
  join([datasetText(props.dataset), selection(props.selected, translate)]),
);
