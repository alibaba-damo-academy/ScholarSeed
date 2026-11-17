# Direct proof drafting

Use the current client LLM to fill the selected Lean proof obligation. Preserve the exact declaration, its assumptions, and its meaning. Save a complete Lean file, retaining the original imports and definitions. Add only necessary imports and fully proved helpers that do not change the target's interpretation.

Use known Lean and Mathlib lemmas and appropriate tactics. Do not invent identifiers or add assumptions, axioms, proof holes, `sorry`, `admit`, or `native_decide`. If you cannot produce a complete draft, report drafting failure rather than supplying a placeholder as proof.

Do not run a local checker or server. Follow SKILL.md for remote verification and separate explicit confirmation before any fallback search.
