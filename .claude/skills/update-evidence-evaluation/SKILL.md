---
name: update-evidence-evaluation
description: For a single proposition that has already been evaluated, fold in newly added documents. Evaluates only the new documents against the proposition, verifies each quote, merges them into the existing per-proposition result JSON, and recomputes the overall judgement. Used by the update-orchestrator skill.
---

# Proposition Evidence Update

Runs once per proposition (one subagent per proposition) during an **incremental update**. The proposition has already been evaluated against the original bundle and its result lives in `output/<proposition_id>.json`. New documents have been added. Your job is to evaluate **only the new documents**, merge them into the existing result, and recompute the proposition's overall judgement. You do not touch the existing evidence entries.

## Input

- **proposition** — the `proposition_id` and verbatim `text` of the pleaded fact being tested.
- **existing result** — path to `output/<proposition_id>.json`, the result from the previous run. Read it first.
- **new documents** — the list of newly added documents (`doc_id`, `path`) to evaluate. These are the *only* documents you evaluate.
- **document index** — path to `work/document_index.json`, for context on how new documents relate to existing ones.
- **uploads directory** — where the case files (including the new ones) live.
- **output path** — `output/<proposition_id>.json` (you overwrite this in place with the merged result).

## Procedure

First, **read the existing `output/<proposition_id>.json`** so you know the current `judgement`, `summary`, and the `evidence` already recorded (including which `doc_id`s are already covered).

Then work through the **new** documents only, oldest → newest, keeping scratchpad notes per document. For each new document follow these steps in order:

1. **Relevance — decide and commit.** Evaluate whether the document is relevant to the proposition. End this with a **definite yes or no** statement. If **no**, record it as `not_addressed` with an empty excerpt and move on. If **yes**, continue the steps below.
2. **Quote — be exact.** Extract the exact passage that bears on the proposition. Quote it verbatim from the source.
3. **Responds to an earlier document?** Decide whether this new document addresses or answers a point made in an earlier document (existing or new). If yes, name which one (`doc_id`) and fold that into the reasoning.
4. **Grade.** Grade the document with respect to the proposition, ending with a **definite classification** on the scale: `supported ↔ somewhat_supported ↔ neutral ↔ somewhat_adverse ↔ adverse`.

Only the new documents get new evidence entries. Do not re-grade or alter existing entries.

## Quote verification

Run the quote-correction step again on every new excerpt before it is written — same procedure as the original evaluation:

- Match by exact string / regex first.
- If there's no exact match, compute the edit distance to the closest source span; tolerate small divergences (≤ ~5) caused by line breaks, unicode, or whitespace.
- If divergence exceeds tolerance, decide whether it's a formatting artefact or a genuine misrepresentation, and **flag** the latter — never emit an unverified excerpt silently.

## Merge and recompute

1. **Merge.** Append one `evidence` entry per new document to the existing `evidence` list. Keep all existing entries untouched. If a new document somehow shares a `doc_id` already present (it should not), prefer the existing entry and flag the collision rather than overwriting.
2. **Recompute the judgement.** Re-derive the overall `judgement` over the **full** evidence list (old + new), not just the new documents. New corroborating evidence can strengthen a judgement; new contradicting evidence can weaken or flip it. Update `confidence` accordingly.
3. **Rewrite the summary.** Update the one-paragraph `summary` so it reflects the combined picture, and note explicitly if the new documents changed the judgement (and how).

## Output

Overwrite `output/<proposition_id>.json` with the merged result. Same schema as the original evaluation — one object per document considered in `evidence`, existing entries preserved, new ones appended.

```json
{
  "proposition_id": "prop_001",
  "proposition_text": "The defendant signed the contract on 3 March 2021.",
  "judgement": "supported",
  "confidence": 0.0,
  "summary": "One-paragraph explanation reflecting old + new evidence; note any change caused by the new documents.",
  "evidence": [
    {
      "doc_id": "doc_004",
      "relevance": "supported",
      "reasoning": "Existing entry — preserved unchanged.",
      "excerpt": "short supporting passage"
    },
    {
      "doc_id": "doc_043",
      "relevance": "somewhat_adverse",
      "reasoning": "New document. Why relevant and how it bears; responds to doc_004's point about the signing date.",
      "excerpt": "verified exact quote from the new document"
    }
  ]
}
```

Field reference:

- `judgement` — overall judgement, recomputed over old + new evidence: `supported | somewhat_supported | neutral | somewhat_adverse | adverse | not_addressed`.
- `confidence` — 0.0–1.0, updated to reflect the combined evidence.
- `evidence[].relevance` — per-document grade on the same scale; `not_addressed` for new documents that are not relevant.
- `evidence[].reasoning` — folds whether/why the document is relevant, how it bears on the proposition, and any earlier document it responds to.
- `evidence[].excerpt` — the verified passage; empty when `relevance` is `not_addressed`.

The overwritten `output/<proposition_id>.json` remains the final per-proposition artifact consumed by the frontend.