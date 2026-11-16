# Client-side formalization: statement mapping and examples

For every natural-language request, the client must generate and display in full three Lean candidates that retain `sorry`, label one as the recommendation, and call the native user-input tool to show three selectable options. Follow [SKILL.md's selection-card contract](../SKILL.md#native-selection-card-contract): ScholarSeed's blocking question waits for an explicit answer without a simulated countdown; a 20-second recommended fallback requires host-supported, confirmed interaction expiry. An explicit user choice always takes precedence; a permitted automatic recommendation is an **LLM selection**, never a user selection. The three mathematical examples below are modeling references and are not the three candidates for any particular request. Candidates are generated with the [English client prompt](client_autoformal_prompt.md), following the mathematical constraints of ProofServer `AutoFormal` but not its automatic-selection logic. User-facing explanations and progress adapt to the user's current conversation language and language preference; this reference document is not tied to Chinese.

The following are all **problem files** that retain `sorry` for remote search to fill in; they are not verified proofs. `import Mathlib` uses the Mathlib supplied by the chosen server; do not infer that server's Lean or Mathlib version from other examples.

## Statement mapping

Check these details during formalization, since each can change the mathematical meaning:

- **Domain of variables**: natural numbers, integers, real numbers, and complex numbers are not interchangeable. For example, a square of an odd number can be stated over both the naturals and the integers; when the source does not specify a domain, state the one chosen.
- **Quantifiers and dependencies**: preserve "for all", "exists", and "exists unique", together with their order. Which parameters a witness may depend on must match the source.
- **Hypotheses**: preserve conditions such as nonnegativity, strict positivity, nonzero, finiteness, and continuity. Domains of definition deserve particular care for denominators, square roots, logarithms, and limits.
- **All conclusions**: conjunctions, equivalences, equality conditions, and boundary cases all belong in the theorem type. An implication in one direction cannot replace "if and only if".
- **Background and proof drafts**: mathematical assumptions supplied by the user are part of the statement; the goal to be proved or intermediate claims in a draft must not be silently rewritten as hypotheses.

Ask the user when there is substantive ambiguity. When a reasonable inference is possible, adopt an explicit convention and show it in the mapping note. A verified proof establishes the Lean statement, not independently its correspondence with the original prose. The mapping note explains that correspondence without claiming certified natural-language equivalence. Apply SKILL.md's user-facing language boundary to mapping notes and explanations; describe mathematical meaning, not who or what generated or checked it.

Default to one target theorem so that the text in `--statement-file` corresponds to a single theorem family. Add auxiliary definitions only when genuinely needed and supported by the server; do not introduce mathematical axioms the user has not authorized.

## AM-GM, including the equality condition

User input: for all nonnegative real numbers a and b, the arithmetic mean is at least the geometric mean, with equality holding if and only if a = b.

```lean
import Mathlib

theorem am_gm_with_equality (a b : ℝ) (ha : 0 ≤ a) (hb : 0 ≤ b) :
    Real.sqrt (a * b) ≤ (a + b) / 2 ∧
      ((a + b) / 2 = Real.sqrt (a * b) ↔ a = b) := by
  sorry
```

Mapping note: `a b : ℝ` corresponds to the real numbers, and `ha`, `hb` correspond to the nonnegativity hypotheses; the first conjunct is the inequality, and the second preserves the two-way equality condition in full. The server only fills in the proof obligation; it may not delete the second conjunct or additionally assume `a = b`.

## √2 is irrational

User input: prove that √2 is irrational.

```lean
import Mathlib

theorem sqrt_two_is_irrational : Irrational (Real.sqrt (2 : ℝ)) := by
  sorry
```

Mapping note: `Real.sqrt` is explicitly the real square root, and `Irrational` corresponds to "irrational number". Using the Mathlib predicate avoids omitting a denominator constraint when expanding the rational representation by hand. Nothing presupposes proof by contradiction or any particular tactic.

## An odd integer's square

User input: if an integer n is odd, then n² is also odd.

```lean
import Mathlib

theorem odd_integer_square (n : ℤ) (h : Odd n) : Odd (n ^ 2) := by
  sorry
```

Mapping note: `n : ℤ` preserves the integer domain, `h` is the given oddness hypothesis, and the conclusion is that the square is odd. Switch to `ℕ` when the source explicitly says natural number; state the convention adopted when the source does not specify the domain.

## Revision after diagnostics

Imports, identifiers, type annotations, and syntax errors may be corrected on the basis of real diagnostics. After each change, re-check the original quantifiers, hypotheses, and conclusion, and save a new version; when revising an already-submitted request, use a new task and a new idempotency key.

If an error concerns mathematical meaning, return to the user's original statement to resolve the ambiguity rather than repeatedly rewriting it into something easier to prove. An exhausted search budget only reports that no proof has been found yet; it does not justify adding hypotheses or declaring the original statement false.
