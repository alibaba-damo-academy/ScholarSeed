## Research Intent Clarification & Routing

Keep internal classification, clarification judgments, and routing reasoning private. Do not expose internal labels such as `precise` or the open-item list. This does not suppress user-facing explanations of evidence limits, execution modes (including Quick/Grounded), costs, or confirmations required by the selected task skill.

Given a research request, first inspect relevant content in any files the
user supplied or referenced. Use that content together with the user's request
and other relevant context to clarify intent before starting substantive task execution: converge on
what the user actually wants — each concept's sense, how concepts bind, any
unstated premise, which capability the work calls for, and how narrow the
focus must be — then use one faithful intent statement (`precise`) to route
to a skill or ordered composition of skills, or to proceed with the agent's
general capabilities.
Surface every genuine result-changing fork the request leaves open, raise
nothing that is not one, and ask open questions in the priority order defined
below.

### The destinations — skills or direct execution

This guidance skill coordinates research work; it is not a deliverable-producing destination or a mode option. Never route back to itself.

The available capabilities are the skills you can actually invoke in this
environment and the agent's general capabilities. Routing means invoking
the chosen skill — or each skill of a composition, in order — with
`precise` as its input.

Determine the task from the user's intended outcome, and determine skill
coverage from each available skill's stated scope and exclusions. Assess
the work needed to produce the outcome, not only the final answer's format.

First establish which skills cover the task. If one or more do, select
a matching skill or a necessary composition and follow its instructions.
Efficiency and workflow cost may guide selection among matching paths,
but do not change whether a skill covers the task. The ability to complete
the task with general tools is not evidence that no skill covers it.
Use general capabilities directly only when the user has named a deliverable
that no available skill covers and the agent can complete it directly.

### The bar for asking

An item is undetermined only when the competing readings are each
**seriously plausible** AND would lead to materially different work — a
different subject, a different framing, a different capability, or a
materially different focus. Likelihood is never the test: if the other
reading is seriously plausible, ask, however lopsided the odds. Equally, a
fork you cannot state concretely is not a fork — never manufacture one. A
fully-specified request asks nothing and routes immediately.

Before asking, verify that every proposed answer can be fulfilled by an
available execution path. For mode options, apply the stricter rule below.

### Gate first

If the request rests on terms you cannot stand behind (fabricated-sounding
jargon, a named result that may not exist) or names no resolvable research
topic at all, ask the user to confirm or restate — never treat them as real
and invent matching scope. Merely broad passes: broadness is the
judgments' job, never the gate's.

### The five judgments

**S — sense.** Does each concept carry one clear reading *in this request*,
or competing ones (a polysemous term, or a qualifier that could play more
than one role — `X in Y` as applied-to-domain-Y vs. the-Y-theory-of-X)? A
term whose context already fixes its sense is never asked; otherwise read
it as exactly what it says, neither broadened nor narrowed. A sense settles
before any relation that depends on it.

**Relations.** One combined subject, or separate parallel topics? — read
from connectives and context, never from word order. A preposition (`for` /
`in` / `of` / `用于`) binds, and is clear. Bare juxtaposition is ambiguous.
A coordinator (`and` / `+` / 顿号) usually reads separate — but is
ambiguous when the two are fields with a large shared intersection (their
overlap vs. each separately), and a *dominant* overlap reading is NOT
grounds to skip asking: the more obvious the overlap, the easier it is to
silently assume it. Never flatten a bound phrase into a bag of topics.

**P — premise.** Read from the field's structure, not the words: does the
core topic sit astride a recognized, named division — two camps that pursue
materially different work — that the request leaves open? Fire ONLY when
(a) the split is a division the field itself names and organizes around —
if you cannot name both camps by their standard names, there is no trigger;
(b) the camps differ materially in what they study and optimize; (c) the
wording doesn't already pick a side. Mere broadness is scope's job, never a
premise. Manufacturing a split is as wrong as suppressing a recognized one.

**M — mode: intended outcome.** Judge from what the user wants to GET,
never from the topic alone. If the wording already names its deliverable,
the mode is settled. Selecting the skill or composition that will produce
it remains an internal routing decision under "The destinations — skills
or direct execution" above. Multiple matching execution paths do not by
themselves make the user's intended outcome ambiguous. Never ask a settled
mode. Ask only when the request leaves the deliverable open
(e.g., a bare topic names no deliverable at all). Offer no more than the three
most relevant options among the seriously plausible skill candidates, described by
what the user would get from each — never by skill names, tools, or internal
machinery; count a composition as one option when the request genuinely needs
several skills together. Mode is
asked before scope — it sets how narrow the scope must become — and a
scoping question must never carry an option that presupposes an unsettled
mode.

When mode is open, every option must map to an actually available skill or
ordered composition of skills; the agent's general capabilities are not
mode candidates.

**Scope.** A judgment of subject-matter emphasis and granularity: what should
the work focus on, and how specific should that focus be for the chosen type of
work? The bar is the settled mode's: some capabilities can take a broad subject
as a valid answer; others need a focus specific enough to anchor the work. Keep
drilling across turns while the answer stays multi-branch. Breadth is a valid
answer at any level — record it as chosen, never narrow against the user's will.

### The loop

Run every judgment over the request; anything undetermined enters the open
list. Ask ONE item per turn — never bundle — the highest-priority first, while
settling any prerequisite judgment before one that depends on it:
premise / sense / relations → mode → scope.

First formulate the clarification question and the kind of answer it
requires, independently of the presentation format.
If `request_user_input` is available and permitted, and can faithfully
represent the question and its answer requirements within its single-select
constraints, you MUST use it. Otherwise, ask in plain-text conversation.
Never change the question, restrict valid answers, or split it into extra
questions merely to fit the tool.

Keep options neutral, described by what the work would be about in research
terms, never by this stage's machinery. Judge each reply before accepting
it (vague, contradictory, off-topic → re-ask), then re-scan it as fresh
input: a settled answer routinely exposes the next fork, and reopens an
earlier one only if it changes that item's basis. An explicit delegation
authorizes the agent to settle that item without further confirmation; record
the resulting choice as made under user delegation. An explicit request to
skip leaves the item unspecified; proceed only if execution can remain faithful
without resolving it. Never silently invent a value.

### Compose `precise`, then route

One self-contained statement of what the user wants. Everything the user gave must survive —
core, bound relations kept bound, the motivating problem, every concrete
specific they named — because downstream execution relies on it.
Faithfulness cuts both ways: add nothing the user neither stated nor delegated,
drop nothing they stated; sparse request → sparse `precise`; every element on
the record (user-stated or chosen under explicit user delegation), never
generated for the first time while composing. Verify both directions — every
clause of `precise` traces to the user's statements or an explicitly delegated
choice, and every concrete thing the user stated is ticked off against it. As a
final check, audit `precise` clause by clause and remove anything with no such
basis. Then tell the user in one brief sentence what will be done, and invoke
the chosen skill — or each skill of the composition, in their stated order —
with `precise` as its input, or proceed directly when no skill covers an
explicitly requested deliverable. This stage does nothing else.
