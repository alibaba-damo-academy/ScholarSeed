const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { test, before, after } = require("node:test");
const { execFileSync } = require("node:child_process");
const { developmentPython } = require("../../scripts/shared/python.cjs");
const { DEFINITIONS, SKILL_NAME } = require("./plugins.cjs");
let compiled;
before(async () => {
  const root = path.resolve(__dirname, "../..");
  const directory = path.join(root, "work/ui-plugin-tests");
  await fs.mkdir(directory, { recursive: true });
  compiled = await fs.mkdtemp(path.join(directory, "pack-"));
  execFileSync(developmentPython(root), ["-m", "service.cli.prebundle", "--build", "--target", compiled], {cwd:root,stdio:"pipe"});
});
after(async () => { if (compiled) await fs.rm(compiled, { recursive: true, force: true }); });

test("product operations owns all composition slots and retires separate conversation skills", async () => {
  const root = path.resolve(__dirname, "../..");
  const source = path.join(root, "skills/community");
  const name = "scholarseed-product-operations";
  const descriptor = JSON.parse(
    await fs.readFile(
      path.join(source, name, ".scholarseed-plugin.json"),
      "utf8",
    ),
  );
  const registry = JSON.parse(
    await fs.readFile(path.join(root, "skills/registry.json"), "utf8"),
  );
  const surfaces = JSON.parse(
    await fs.readFile(
      path.join(root, "apps/serve/service/capabilities/catalog.json"),
      "utf8",
    ),
  );
  assert.equal(descriptor.id, name);
  assert.deepEqual(
    descriptor.components
      .filter((component) => !component.public)
      .map((component) => component.slot)
      .sort(),
    ["formula.view", "markdown.view", "plot.view", "table.view"],
  );
  for (const surface of Object.values(surfaces.surfaces)) {
    assert.equal(surface.skills.filter((skill) => skill === name).length, 1);
  }
  for (const retired of [
    "conversation-artifacts-workbench",
    "conversation-research-evidence",
    "conversation-rich-content",
  ]) {
    assert.equal(registry.dependencies[retired], undefined);
    await assert.rejects(fs.stat(path.join(source, retired)), {
      code: "ENOENT",
    });
    assert.ok(
      Object.values(surfaces.surfaces).every(
        (surface) => !surface.skills.includes(retired),
      ),
    );
  }
});

for (const definition of DEFINITIONS)
  test(`${definition.category}: product operations component bytes and inputs match the frozen package`, async () => {
    const directory = path.join(compiled, SKILL_NAME);
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(directory, ".scholarseed-package.json"),
        "utf8",
      ),
    );
    const descriptor = JSON.parse(
      await fs.readFile(
        path.join(directory, ".scholarseed-plugin.json"),
        "utf8",
      ),
    );
    assert.equal(manifest.version, descriptor.version);
    assert.equal(
      descriptor.version,
      (await fs.readFile(path.join(directory, "VERSION"), "utf8")).trim(),
    );
    assert.ok(descriptor.ui.exports.includes("Conversation"));
    assert.ok(!descriptor.ui.exports.includes("Content"));
    for (const file of manifest.files) {
      const bytes = await fs.readFile(path.join(directory, file.path));
      assert.equal(bytes.length, file.size, file.path);
      assert.equal(
        crypto.createHash("sha256").update(bytes).digest("hex"),
        file.sha256,
        file.path,
      );
    }
    const metadata = JSON.parse(await fs.readFile(path.join(directory, ".scholarseed.json"), "utf8"));
    assert.equal(metadata.inventory.skills[0].slug, SKILL_NAME);
    assert.equal(metadata.inventory.skills[0].version, manifest.version);
    assert.deepEqual(metadata.inventory.skills[0].files.map(file => file.path).sort(),
      manifest.files.filter(file => file.path !== ".scholarseed.json").map(file => file.path).sort());
    const request = JSON.parse(
      await fs.readFile(
        path.join(directory, `references/scholarseed-chat-ui/guides/${definition.category}/compose.json`),
        "utf8",
      ),
    );
    assert.equal(request.slot, definition.slot);
    assert.ok(typeof request.title === "string" && request.title.trim());
    assert.deepEqual(
      JSON.parse(
        await fs.readFile(
          path.join(directory, `references/scholarseed-chat-ui/guides/${definition.category}/schema.json`),
          "utf8",
        ),
      ),
      descriptor.components.find(
        (component) => component.slot === definition.slot,
      ).input_schema,
    );
  });
