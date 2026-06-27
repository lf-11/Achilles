---
name: case-proposition-orchestrator
description: Orchestrates matching of legal propositions against case documents. Use when a user uploads a bundle of case files and a set of propositions to evaluate. Coordinates proposition extraction and dispatches per-proposition subagents that judge whether each proposition is supported or contradicted by the evidence.
---

# Case Proposition Orchestrator

## What this task is

You are the orchestrator for a legal document analysis pipeline. The user provides a **bundle of case documents** and a set of **propositions** (factual or legal assertions). Your job is to coordinate the production of **one `.json` file per proposition** that records a judgement on how the documents bear on that proposition.

Each proposition is judged on this scale:

- `supported` — documents clearly support the proposition
- `somewhat_supported` — some evidence supports it, but partial or weak
- `neutral` — documents touch on it but neither support nor contradict
- `somewhat_adverse` — some evidence contradicts it, but partial or weak
- `adverse` — documents clearly contradict the proposition
- `not_addressed` — no document in the bundle addresses the proposition

You do **not** judge propositions yourself. You set up the work and delegate the per-proposition judgement to subagents.

## Inputs

The uploaded bundle contains:
- **Case files** — the documents to search (PDFs, text, emails, contracts, witness statements, etc.). These live in the uploads directory.
- **An index file (optional)** — a manifest listing/describing the documents. It may be named `index.*`, `manifest.*`, `bundle.*`, or similar. If present, use it to understand document IDs, titles, and ordering. If absent, build your own list by enumerating the files.

## Workflow

Run these three steps in order.

### Step 1 — Survey the bundle

1. List all files in the uploads directory.
2. Detect whether an index file exists. If so, read it and use it as the authoritative document list (capturing each document's ID, filename, and any description).
3. If no index exists, enumerate every case file yourself and assign each a stable `doc_id` (e.g. `doc_001`, `doc_002`).
4. Write the resulting document inventory to `work/document_index.json`:

```json
{
  "has_index_file": true,
  "documents": [
    { "doc_id": "doc_001", "filename": "...", "title": "...", "path": "..." }
  ]
}
```

This index is passed to every subagent so they all reference documents consistently.

### Step 2 — Extract propositions

Locate the propositions (they may be in a dedicated file, in the index, or supplied in the prompt). Extract each into a structured list and write `work/propositions.json`:

```json
{
  "propositions": [
    {
      "proposition_id": "prop_001",
      "text": "The defendant signed the contract on 3 March 2021.",
      "context": "optional surrounding context or source reference"
    }
  ]
}
```

Assign each proposition a stable `proposition_id`. Do not paraphrase the proposition text — preserve it verbatim.

### Step 3 — Launch one subagent per proposition

For each proposition in `work/propositions.json`, launch a subagent (using the proposition-evaluator skill). Pass each subagent:

- the single `proposition_id` and its `text`
- the path to `work/document_index.json`
- the uploads directory path
- the required output path: `output/<proposition_id>.json`

Each subagent independently goes through **all** documents, decides per document whether it is relevant to its proposition, gathers the relevant evidence, reaches a judgement on the scale above, and writes its result to `output/<proposition_id>.json`.

Subagents are independent and can run in parallel — one proposition's evaluation never depends on another's. Launch them in batches if the proposition count is large.

## Output contract

Each subagent must produce a file matching this shape (the subagent skill enforces the details):

```json
{
  "proposition_id": "prop_001",
  "proposition_text": "...",
  "judgement": "supported",
  "confidence": 0.0,
  "summary": "One-paragraph explanation of the judgement.",
  "evidence": [
    {
      "doc_id": "doc_004",
      "relevance": "supports",
      "excerpt": "short supporting/contradicting passage",
      "note": "why this bears on the proposition"
    }
  ]
}
```

The `output/` directory of per-proposition JSON files is the final artifact. These are consumed by the frontend.

## Orchestrator rules

- Do the orchestration work yourself; do the **judging** only via subagents.
- Never collapse multiple propositions into one subagent — strictly one proposition per subagent for clean isolation and parallelism.
- Ensure every proposition in `propositions.json` has a corresponding file in `output/` before reporting completion. If any are missing, relaunch those subagents.
- Keep intermediate state (`document_index.json`, `propositions.json`) in `work/`; keep only final results in `output/`.
- Report a final summary to the user: count of propositions, and a breakdown of judgements across the scale.
