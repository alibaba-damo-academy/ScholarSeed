import React from "react";
import { PlotCopyContext, PlotExportContext } from "../../../apps/desktop/src/renderer/src/components/primitive/Plot";
import { prepareChartExport, rasterizeChartSVG } from "../../../apps/desktop/src/renderer/src/components/ui";

async function copyPlot(request) {
  const svg = prepareChartExport(request);
  if (!svg) throw new Error("plot_export_invalid");
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": rasterizeChartSVG(svg) }),
  ]);
  return { ok: true };
}

async function exportPlot(request) {
  let writer;
  try {
    const svg = prepareChartExport(request);
    if (!svg) throw new Error("plot_export_invalid");
    const file = await window.showSaveFilePicker({
      suggestedName: "chart.svg",
      types: [{ description: "SVG", accept: { "image/svg+xml": [".svg"] } }],
    });
    writer = await file.createWritable();
    await writer.write(svg);
    await writer.close();
    return { ok: true };
  } catch (error) {
    if (writer) await writer.abort().catch(() => undefined);
    if (error.name === "AbortError") return { ok: false, canceled: true };
    throw error;
  }
}

export function ExportProvider({ children }) {
  return (
    <PlotExportContext.Provider
      value={window.showSaveFilePicker ? exportPlot : undefined}
    >
      <PlotCopyContext.Provider value={navigator.clipboard?.write && typeof ClipboardItem !== "undefined" ? copyPlot : undefined}>
        {children}
      </PlotCopyContext.Provider>
    </PlotExportContext.Provider>
  );
}
