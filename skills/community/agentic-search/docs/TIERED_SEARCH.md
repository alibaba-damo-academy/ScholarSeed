# Tiered academic search design

The Skill maps one retrieval core into three product modes. All deliver paper-level metadata.json, not long reports.
The experiment results below are recorded historical evidence, not measurements repeated by this documentation translation.

## Modes

| Mode | Use case | Default budget | Recorded model / effort | Output cap |
|---|---|---|---|---|
| Quick | Search bars and previews | One minute | Luna / low | 20 |
| Balanced | Interactive discovery | Six minutes | Sol / high | 40 |
| Quality | High recall before systematic reviews | No limit | Sol / xhigh | 40 |

For time_budget_minutes B: B <= 2 selects Quick; 2 < B <= 6 selects Balanced; B > 6 selects Quality with a deadline. No budget selects Quality.
Evidence primarily calibrates the one-minute, six-minute and unrestricted endpoints, not every intermediate budget as a proven Pareto optimum.

## Different execution graphs

```text
Quick: one three-query web disambiguation batch
       -> one PaperHub graph -> deterministic provenance-aware selection
Balanced: one web batch -> one high-information PaperHub round
          -> model selection and provenance audit
Quality: C1 entity/relation gap recovery
         -> model-selected citation expansion per round
         -> provenance audit and model selection
```

Lower modes reduce model decision points; higher modes expand adaptive search, following useful control structures from the Perplexity presets. Batching, the full candidate pool and metadata normalization are shared.

### Quick

- The model resolves implicit entities and sends three high-information queries in one logical web-search batch.
- One tools/quick_search.py invocation performs at most four keyword queries, eight exact-title queries, two automatic citation anchors, deduplication and selection.
- Ranking combines exact-title matches, cross-query/citation provenance, topical relevance and set diversity, without a second model selection turn.
- This is a supported mode of the same Skill, not a separately maintained fast variant.

### Balanced

- Retains model judgment over implicit entities and the candidate set, but compresses search into one web batch and one logical round of at most 27 queries.
- Uses limited model-selected citation tracking only with sufficient deadline headroom.
- Reserves 150 seconds for final model selection.

### Quality

- Restores C1's entity/relation checklist, full short-title probes, adaptive gap search, citation expansion and provenance-aware selection.
- Does not blindly run a fixed round count. A large pool is not sufficient coverage: central relations, named families and both sides of a comparison may still need recovery.
- The model selects three to five citation anchors per logical round. The tested automatic-anchor C2 variant worsened both quality and speed and is not used for Quality.

## Recorded benchmark8 evidence

New runs in this record were blind, strictly serial, live PaperHub and cache-off. Artifacts were frozen before ground-truth scoring; runs were not repeated to improve scores.

| Method | Recall | Precision | F1 | T1 precision | T1+2 recall | Mean papers | Metadata time |
|---|---:|---:|---:|---:|---:|---:|---|
| Quick, conservative main result | 0.2229 | 0.0625 | 0.0973 | 0.1875 | 0.2229 | 20 | 0:50.5 |
| Quick, priority repeat | 0.2479 | 0.0688 | 0.1073 | 0.2188 | 0.2229 | 20 | 0:49.8 |
| Balanced | 0.4813 | 0.0656 | 0.1151 | 0.3000 | 0.3937 | 40 | 4:33.5 |
| Quality/C1 reproduced endpoint | 0.5604 | 0.0750 | 0.1318 | 0.2250 | 0.4771 | 40 | 8:14 metadata / 8:35 wall |
| Quality/C1 historical endpoint | 0.5562 | 0.0750 | 0.1317 | 0.2500 | 0.4729 | 40 | 14:07 wall |
| Perplexity Agent fast | 0.1979 | 0.0481 | 0.0764 | 0.1000 | 0.1771 | 21.625 | 0:21.7 wall |
| Perplexity Agent medium | 0.3583 | 0.0551 | 0.0943 | 0.2250 | 0.2917 | 35.125 | 1:18.9 wall |
| Claude bench8 | 0.5750 | 0.0780 | 0.1380 | 0.3750 | 0.5125 | 39.75 | 9:19 wall |

The reproduced C1 line used commit 9a692bf: all eight tasks frozen before scoring, cache off, infrastructure retries only under preregistered rules.
On the full bench20, recall was 0.5167, T1 precision 0.2450, T1+2 recall 0.4431, mean metadata time 8:15 and wall 8:33. Keep the older C1 line separate as cross-time repetition evidence.

Both Quick batches used the same logical strategy; the second tested priority service. Mean metadata time changed from 50.48 to 49.84 seconds, with 7/8 still below 60 seconds in both.
That difference, and recall variation from 0.223 to 0.248, were within live search/agent variability rather than evidence of priority improving latency or quality. The formal Quick profile did not enable it by default.

## Product interpretation of those experiments

- Quick established a useful low-latency endpoint with stronger quality than the recorded Perplexity fast reference, but 60 seconds remained a soft SLO.
- Balanced improved recall over the previous Full A from 0.4562 to 0.4813 while reducing metadata time from about 8:25 to 4:33; it also exceeded the recorded Perplexity medium result on bench8.
- Quality remained the Skill's highest-quality mode. bench8 wall was about 8% below the Claude reference, with recall slightly lower (0.5604 versus 0.5750). On bench20, wall was 8:33 versus 10:43 but recall remained lower by 0.0703.
- Proposed next work was better head ranking and fewer redundant title probes while preserving C1's central entity/relation coverage.
- No mode dominated both others on quality, speed and cost.

## Hard deadlines and fallback

The internal deadline prevents new batches, not interruption of a model response.
A product requiring a hard 60-second response needs a persistent session, an outer 55–60-second deadline, explicit timeout handling that returns already-written metadata or clearly labeled single-API candidates, and metadata recording mode, actual duration and degradation.
A single API call can take seconds but had benchmark8 recall 0.0667; it must not masquerade as the full Quick workflow.
These are product-layer responsibilities, not a claim that the Skill supplies a hard SLA.
