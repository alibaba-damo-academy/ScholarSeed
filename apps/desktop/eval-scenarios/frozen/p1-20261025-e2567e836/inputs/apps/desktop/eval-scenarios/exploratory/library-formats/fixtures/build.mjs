import { fileURLToPath } from "node:url";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const root = path.dirname(fileURLToPath(import.meta.url));
const workbook = Workbook.create();
const sheet = workbook.worksheets.add("Equipment");

sheet.getRange("A1:C4").values = [
  ["Harbor Lab Equipment Plan", null, null],
  ["Item", "Planned", "Ready"],
  ["Scanner", 20, 15],
  ["Workstation", 32, 24],
];
sheet.getRange("A6").values = [["Synthetic evaluation fixture; counts are devices."]];
sheet.getRange("A1:C1").format = {
  fill: "#E5EEF7",
  font: { name: "Arial", size: 13, bold: true, color: "#000000" },
};
sheet.getRange("A2:C2").format = {
  fill: "#E8E8E8",
  font: { name: "Arial", size: 11, bold: true, color: "#000000" },
};
sheet.getRange("A3:C4").format.font = { name: "Arial", size: 11 };
sheet.getRange("A1:A6").format.columnWidth = 48;
sheet.getRange("B1:C6").format.columnWidth = 14;
sheet.getRange("A1:C4").format.rowHeight = 25;
sheet.getRange("A2:C4").format.borders = {
  preset: "all",
  style: "thin",
  color: "#D9D9D9",
};
sheet.freezePanes.freezeRows(2);

await workbook.recalculate();
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(path.join(root, "equipment-plan.xlsx"));
