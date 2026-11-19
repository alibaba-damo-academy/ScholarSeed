---
name: windows-remote
description: Verify an authorized Windows SSH target and determine whether it can support an interactive ScholarSeed Desktop test.
---

# Windows Remote

Use the [Windows development guide](../../../docs/runbooks/windows.md) and the [cross-platform evidence rules](../../../docs/runbooks/development.md#cross-platform-development-and-acceptance).

Confirm the exact host, account, port, and expected host key before connecting through an existing SSH configuration. Verify the connected identity, project directory, and shell. Text diagnostics can run over SSH. GUI evidence must come from a verified unlocked interactive session.

Use loopback-only port forwarding for an authorized debugging endpoint, and use [desktop-control](../desktop-control/SKILL.md) to confirm the application instance. Preserve existing processes and profiles. Host setup, service changes, credentials, and starting or stopping a target require their corresponding authority.
