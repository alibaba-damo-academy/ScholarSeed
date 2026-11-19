---
name: test-quality
description: Analyze ScholarSeed test coverage, brittle assertions, repeated fixtures, and feedback latency, then propose or implement focused improvements.
---

# Test Quality

Read the [Desktop testing strategy](../../../apps/desktop/docs/architecture/testing-strategy.md), [testing guide](../../../apps/desktop/docs/quality/testing.md), and [development checks](../../../docs/runbooks/development.md#choose-commands-and-evidence-by-change).

Start with a change, failure, or selected area. Map behavior to the test layer that owns it. Inspect uncovered behavior, brittle source-text matches, selector stability, repeated setup, and feedback time. Where data is available, compare failure categories and latency by suite. Consult the current coverage configuration for thresholds.

For authorized improvements, strengthen the assertion at the owning layer, reuse fixtures, and preserve test intent. Run a targeted regression and report what it proves. Keep platform and product acceptance requirements from the testing guide.
