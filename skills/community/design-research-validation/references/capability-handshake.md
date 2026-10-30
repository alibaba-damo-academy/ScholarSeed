# Dynamic capability handshake

Read this reference after the target-centred validation draft when real execution
capabilities could change what should be done now. Do not read or apply it when
the user only needs a conceptual design and resource availability would not alter
the scientific recommendation.

## Purpose and boundary

Fit a scientifically sound draft to the user's actual environment without
assuming resources or turning the conversation into an intake form. A capability
is any dependency whose state changes the route, feasibility, interpretation, or
claim scope. Derive capabilities from the proposed validation; never select a
discipline profile or populate a fixed inventory.

## Ordered procedure

1. **Freeze the scientific target first.** Identify the claim, discriminating
   comparison, decisive observable, and the conclusion each outcome permits.
   Resource constraints may change the route, not silently redefine the target.
2. **Inspect before asking, but know inspection's blind spots.** Use only
   read-only discovery over the current workspace, attached manifests, available
   tool descriptions, and user-provided context. Record what the system actually
   established; absence of evidence is `unknown`, not `unavailable`. In desktop or
   sandboxed environments, tool permissions, network reachability, credentials,
   and code-execution access are frequently invisible to any inspection — this
   invisibility is `unknown`, never evidence of availability or unavailability,
   and user confirmation is the only reliable way to resolve it. Do not proceed on
   an assumed permission just to avoid asking.
3. **Infer decision-changing dependencies.** For every proposed action, ask
   whether a different dependency state would change the action, route,
   interpretation, or defensible claim. Omit dependencies that affect only
   convenience or presentation.
4. **Assign a state with provenance.** Use one of:
   - `confirmed_available`: read-only evidence or the user confirms usable access;
   - `constrained`: usable, but a stated limit changes scale, timing, or route;
   - `unknown`: current evidence does not establish availability;
   - `unavailable`: the user or a reliable check establishes non-availability.
5. **Ask once, only if useful.** If one or more decision-changing states remain
   `unknown`, ask at most one compact question combining them. Do not ask about a
   capability already discovered or about a dependency that does not alter the
   plan. If the user does not answer, continue with explicit branches.
6. **Return executable branches.** Provide:
   - **now**: work supported by confirmed capabilities;
   - **conditional**: the preferred route if the unresolved capability is
     confirmed;
   - **fallback**: the least costly scientifically valid route under the known
     constraint, or defer when no valid route exists.
7. **Preserve claim integrity.** A fallback using a proxy, reduced setting,
   indirect observable, retrospective source, or simulation may support only a
   narrower conclusion. State the narrower claim and what remains unresolved.
   Never present feasibility evidence as validation of the original strong claim.
## Interaction rules

- If all decision-changing dependencies are `confirmed_available`, proceed
  without a resource question.
- When the environment hides capability state from inspection (common on
  desktop, where tool permissions and execution access are not observable),
  confirming the decision-changing unknowns with the user is expected and
  correct — combine them into one question, but never skip it or proceed on an
  assumed permission just to avoid asking.
- If read-only discovery confirms a dependency, do not ask the user to reconfirm
  it unless the evidence is stale or contradictory.
- If the task does not require execution and availability would not change the
  recommended scientific design, do not trigger the handshake.
- If constraints affect only throughput, adjust scale or sequencing rather than
  inventing a different scientific objective.
- If no fallback can test the target claim, say so rather than filling the gap
  with generic suggestions.

## Recommended internal trace

Keep a lightweight internal trace for each derived dependency: its free-text
role, state, provenance, the decision it changes, and the chosen route. This is an
audit aid, not a required user-facing schema. Do not expose it unless requested.

In the answer, integrate capability information into the usable validation plan:
what can be done now, the single unresolved decision if any, the conditional or
fallback route, and the strongest claim each route supports.
