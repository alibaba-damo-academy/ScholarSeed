---
name: desktop-control
description: Start or inspect a specifically identified local ScholarSeed Desktop instance and capture evidence from its real renderer.
---

# Desktop Control

Use the [Desktop rules](../../../apps/desktop/AGENTS.md) and the [isolated development launcher](../../../docs/runbooks/development.md#isolated-hot-reload-debugging). Record the checkout, launcher, process, debugging target, and product home. Verify the target before attaching. Preserve ongoing sessions and use an isolated development instance for new authorized runs.

Use [playwright-cli](../playwright-cli/SKILL.md) to inspect the selected renderer. After an action, capture the real resulting UI state and confirm it belongs to the intended instance. Record actions, observations, and relevant runtime identifiers. A preview or static fixture cannot establish behavior in an installed build.

Use [evidence-session](../evidence-session/SKILL.md) or [evidence-trace](../evidence-trace/SKILL.md) to interpret existing runtime data.
