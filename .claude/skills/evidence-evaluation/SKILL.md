---
name: evidence-evaluation
description: For a single proposition, evaluate every document in the bundle and produce a consolidated per-proposition JSON of relevant evidence, with each excerpt verified against its source.
---

# Proposition Evidence Evaluation

Runs once per proposition (one subagent per proposition). Takes the pleaded fact and the case bundle, and outputs a single JSON file capturing which evidence is relevant, how it bears on the proposition, and an overall judgement. This skill owns the per-proposition output contract that the orchestrator skill delegates to.

## Input

- **proposition** — the `proposition_id` and verbatim `text` of the pleaded fact being tested.
- **document index** — path to `work/document_index.json`; use it to identify documents by `doc_id` and to decide which files are worth opening.
- **uploads directory** — where the case files live.
- **output path** — `output/<proposition_id>.json`.

## Procedure

Work through the documents **oldest → newest**, keeping scratchpad notes per document. For each document:

1. **Relevance.** Decide how the document bears on the proposition and assign exactly one `relevance` label:
   `supported ↔ somewhat_supported ↔ neutral ↔ somewhat_adverse ↔ adverse`, or `not_addressed` if the document does not address the proposition at all.
2. **Excerpt.** Extract the exact supporting or contradicting passage. When `relevance` is `not_addressed`, leave the excerpt empty.
3. **Reasoning.** Write a single free-text `reasoning` field that covers *both* whether/why the document is relevant *and* how it bears on the proposition. If it responds to a point made in an earlier document, fold that into the reasoning (name the earlier document) rather than splitting it out. If the source is not relevant from the outset, state that here and set `relevance` to `not_addressed`.

Keep **every** document considered in the output — irrelevant ones stay in the list with `relevance: "not_addressed"` and an empty excerpt, so "checked, not relevant" stays distinguishable from "not checked".

After all documents are graded, reach an overall `judgement` on the proposition and write a one-paragraph `summary`.

## Excerpt verification

Before any excerpt is written into the output, verify it against the source text:

- Match by exact string / regex first.
- If there's no exact match, compute the edit distance to the closest source span; tolerate small divergences (≤ ~5) caused by line breaks, unicode, or whitespace.
- If divergence exceeds tolerance, decide whether it's a formatting artefact or a genuine misrepresentation, and **flag** the latter — never emit an unverified excerpt silently.

## Output

Write **one JSON file per proposition** to `output/<proposition_id>.json`. One object per document considered goes in `evidence`.

```json
{
  "proposition_id": "prop_001",
  "proposition_text": "The defendant signed the contract on 3 March 2021.",
  "judgement": "supported",
  "confidence": 0.0,
  "summary": "One-paragraph explanation of the judgement.",
  "evidence": [
    {
      "doc_id": "doc_004",
      "relevance": "supported",
      "reasoning": "Why the document is relevant and how it bears on the proposition.",
      "excerpt": "short supporting/contradicting passage"
    },
    {
      "doc_id": "doc_001",
      "relevance": "not_addressed",
      "reasoning": "Does not address the proposition.",
      "excerpt": ""
    }
  ]
}
```

Field reference:

- `judgement` — overall judgement on the proposition: `supported | somewhat_supported | neutral | somewhat_adverse | adverse | not_addressed`.
- `confidence` — 0.0–1.0.
- `evidence[].relevance` — the single per-document criterion, on the same scale: `supported | somewhat_supported | neutral | somewhat_adverse | adverse | not_addressed`.
- `evidence[].reasoning` — the one free-text field; folds whether/why the document is relevant and how it bears on the proposition (including any earlier document it responds to). For `not_addressed`, state that it is not relevant here.
- `evidence[].excerpt` — the verified passage; empty when `relevance` is `not_addressed`.

The `output/<proposition_id>.json` file is the final per-proposition artifact and is consumed by the frontend.