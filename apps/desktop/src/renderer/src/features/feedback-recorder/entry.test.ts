import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const recorderSource = readFileSync(
  new URL("./Recorder.tsx", import.meta.url),
  "utf8",
);

test("idle recorder entry keeps the original movable dot presentation", () => {
  assert.doesNotMatch(recorderSource, /MessageCircleWarning/);
  assert.match(recorderSource, /ref=\{setEntrySurface\}/);
  assert.match(recorderSource, /style=\{floating\.style\}/);
  assert.match(
    recorderSource,
    /phase === 'idle' \? FLOATING_EDGE_MARGIN_PX : FLOATING_PANEL_MARGIN_PX/,
  );
  assert.match(recorderSource, /right-\[var\(--vds-space-4\)\]/);
  assert.match(recorderSource, /bg-\[var\(--vds-brand-bg-default\)\]/);
  assert.match(recorderSource, /border-\[var\(--vds-brand-light-border\)\]/);
  assert.match(
    recorderSource,
    /background:var\(--vds-brand-light-bg-default\)/,
  );
  assert.doesNotMatch(recorderSource, /vds-error/);
});
