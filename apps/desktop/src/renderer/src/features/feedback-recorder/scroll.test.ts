import assert from "node:assert/strict";
import test from "node:test";

import { scrollStepListToLatest } from "./scroll.ts";

test("expanded step list scrolls to its latest item", () => {
  const container = { scrollHeight: 480, scrollTop: 120 };

  scrollStepListToLatest(container, true);

  assert.equal(container.scrollTop, 480);
});

test("collapsed step list keeps its current scroll position", () => {
  const container = { scrollHeight: 480, scrollTop: 120 };

  scrollStepListToLatest(container, false);

  assert.equal(container.scrollTop, 120);
});
