const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const {
  buildComponents,
} = require("../../apps/desktop/scripts/cd/components.cjs");
const requireDesktop = createRequire(
  path.resolve(__dirname, "../../apps/desktop/package.json"),
);
const { build } = requireDesktop("esbuild");
const ROOT = path.resolve(__dirname, "../..");
const uiManifest = require("./manifest.json");
const SKILL_NAME = "scholarseed-product-operations";
const DEFINITIONS = ["plot", "table", "formula", "markdown"].map(category => ({ category, slot: `${category}.view` }));
const SAMPLE_DATASET = {
  columns: [
    { key: "method", label: "示例方法 / Sample method" },
    { key: "score", label: "示例得分 / Sample score", unit: "%" },
  ],
  rows: [
    { id: "sample-a", values: ["A", 80] },
    { id: "sample-b", values: ["B", 85] },
    { id: "sample-c", values: ["C", null] },
  ],
};
const SAMPLES = {
  plot: { title: "合成示例 / Synthetic example", model: { kind: "bar", dataset: SAMPLE_DATASET, x: 0, y: [1] } },
  table: { dataset: SAMPLE_DATASET },
  formula: { caption: "百分比 / Percentage", source: "\\frac{80}{100}\\times100\\%" },
  markdown: { text: "```python\nvalues = [80, 85, None]\nprint(values)\n```" },
};

async function buildPlugins(hostVersion) {
  if (typeof hostVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(hostVersion))
    throw new Error(
      "The actual plugin host version from author contract discovery is required",
    );
  const result = await build({
    entryPoints: [path.join(__dirname, "schemas.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const context = { module: { exports: {} } };
  vm.runInNewContext(result.outputFiles[0].text, context, { timeout: 1000 });
  const { schemas } = context.module.exports;
  const research = JSON.parse(
    await fs.readFile(
      path.join(
        ROOT,
        "skills/community/research-idea-partner/.scholarseed-plugin.json",
      ),
      "utf8",
    ),
  );
  const directory = path.join(ROOT, "skills/community", SKILL_NAME);
  const version = (
    await fs.readFile(path.join(directory, "VERSION"), "utf8")
  ).trim();
  const components = [];
  for (const definition of DEFINITIONS) {
    const componentDirectory = `components/${definition.category}`;
    const referenceDirectory = `references/${definition.category}`;
    await fs.mkdir(path.join(directory, componentDirectory), {
      recursive: true,
    });
    await fs.mkdir(path.join(directory, referenceDirectory), {
      recursive: true,
    });
    const component = {
      id: definition.category,
      slot: definition.slot,
      entry: `${componentDirectory}/cards.js`,
      preview: `${componentDirectory}/preview.json`,
      input_schema: schemas[definition.category],
      output_schema: schemas.selection,
      actions: ["continue", "cancel"].map((id) => ({
        id,
        capability: "interaction.answer",
        input_schema: schemas.selection,
      })),
    };
    components.push(component);
    const data = SAMPLES[definition.category];
    const values = { selected: [] };
    const preview = {
      data,
      responses: {
        continue: { state: "resolved", data },
        cancel: { state: "cancelled", data },
      },
      submissions: { continue: [values], cancel: [values] },
    };
    const request = {
      request_id: "replace-for-each-step",
      slot: definition.slot,
      title: data.title ?? definition.category,
      data,
    };
    for (const [name, value] of [
      [`${componentDirectory}/preview.json`, preview],
      [`${referenceDirectory}/compose.json`, request],
      [`${referenceDirectory}/schema.json`, component.input_schema],
    ]) {
      await fs.writeFile(
        path.join(directory, name),
        `${JSON.stringify(value, null, 2)}\n`,
      );
    }
    await buildComponents(
      path.join(directory, componentDirectory),
      "../../packages/ui/single.tsx",
    );
  }
  for (const original of research.components.filter(
    (item) =>
      item.public &&
      ["results", "downloads", "delivery", "details"].includes(
        item.id,
      ),
  )) {
    const copy = { ...original, preview: `components/${original.id}.json` };
    components.push(copy);
    await fs.copyFile(
      path.join(
        ROOT,
        "skills/community/research-idea-partner",
        original.preview,
      ),
      path.join(directory, copy.preview),
    );
  }
  for (const category of ["evidence", "artifacts", "content"]) {
    for (const relative of [
      `components/${category}/cards.js`,
      `components/${category}/preview.json`,
      `references/${category}/compose.json`,
      `references/${category}/schema.json`,
    ]) {
      await fs.rm(path.join(directory, relative), { force: true });
    }
  }
  const descriptor = {
    schema: 2,
    id: SKILL_NAME,
    version,
    host: `==${hostVersion}`,
    skill: "SKILL.md",
    ui: {
      compatibility: uiManifest.compatibility,
      exports: [
        "React",
        "mount",
        "Conversation",
        "Button",
        "Alert",
        "AlertDescription",
        "useTranslation",
        "useCopyContent",
      ],
    },
    capabilities: [
      "interaction.answer",
      "navigation.open",
      "literature.read",
      "literature.write",
    ],
    components,
  };
  await fs.writeFile(
    path.join(directory, ".scholarseed-plugin.json"),
    `${JSON.stringify(descriptor, null, 2)}\n`,
  );
}

if (require.main === module)
  buildPlugins(process.argv[2])
    .then(() =>
      console.log(
        "Product operations components built from the official schema and runtime",
      ),
    )
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
module.exports = { buildPlugins, DEFINITIONS, SKILL_NAME };
