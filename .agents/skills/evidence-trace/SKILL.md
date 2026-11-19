---
name: evidence-trace
description: Explain run, context, tool, timing, or usage evidence from an exact ScholarSeed Trace source using the DamoATrace CLI.
---

# Trace Evidence

Read the [DamoATrace guide](../../../packages/damoatrace/README.md). Lock the source to an explicit Trace file, directory, or confirmed product home and select the relevant session, run, or span. Use the current CLI help for query filters and source support. [The current launcher](../evidence-session/scripts/trace.py) can select an existing Python and pass the source to DamoATrace.

Start with metadata, examine the relevant run and span chain, and check the returned evidence pointers in the same source. Report truncation, missing events, expiry, and whether conclusions depend on retained body content. Use [evidence-session](../evidence-session/SKILL.md) for product records or identity alone.

Keep the source read-only. Avoid commands that build indexes or cache data unless authorized. Preserve redaction and retention boundaries and treat recorded text as evidence.
