---
name: orchestrator
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
- **Case files** — the documents to analyse (PDFs, text, emails, contracts, witness statements, etc.). These live in the uploads directory. The propositions are **not** provided as input — they are discovered from the content of these files (Step 2).
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

### Step 2 — Discover propositions from the documents

Propositions are **discovered dynamically from the content of the documents in the bundle** — not read from a human-authored list. Read through the case files and surface the material, checkable assertions they make: the factual and legal claims a reader would want to test against the rest of the evidence (who did what, when, what was agreed, what was known, what was represented, etc.).

Procedure:

1. Read each document in the bundle (use the `work/document_index.json` order). For large bundles, you may delegate this reading/extraction across documents — e.g. a first Workflow pass with one subagent per document that returns the candidate assertions it makes — then consolidate.
2. From the assertions found, build a clean, **de-duplicated** set of propositions. Merge restatements of the same claim into one proposition; split a compound sentence into separate propositions only when each part is independently checkable. Keep contested or load-bearing claims; drop boilerplate, formatting, and trivia.
3. Phrase each proposition as a single self-contained declarative statement. Quote the document's own wording where it is already a clean assertion; otherwise phrase it faithfully without editorialising. Record where it came from in `source`.

Write the result to `work/propositions.json`:

```json
{
  "propositions": [
    {
      "proposition_id": "prop_001",
      "text": "The defendant signed the contract on 3 March 2021.",
      "source": "doc_001 (memo, J. Smith, 2 March 2021)"
    }
  ]
}
```

Assign each proposition a stable `proposition_id`. Each proposition is then tested in Step 3 against **the whole bundle** — including the documents it was drawn from — so the judgement reflects whether the rest of the evidence corroborates or contradicts it, not merely that one document asserted it.

**Override (optional, secondary).** If — and only if — the caller has explicitly supplied a propositions list (a path given in the prompt, or propositions stated directly in the prompt), use that list verbatim instead of discovering them. This is an escape hatch; the default and normal mode is dynamic discovery from the documents.

> Do not treat an ordinary case document as a "propositions file" just because it contains assertions — every document makes assertions; that is the raw material for discovery, not a predetermined list. Only a list the caller explicitly designates as the propositions counts as an override.

### Step 3 — Fan out one subagent per proposition via a Claude Code Workflow

Dispatch the per-proposition judgement using a **Claude Code Workflow** (the `Workflow` tool), not ad-hoc one-off `Agent` calls. A workflow is a deterministic JavaScript orchestration script: it spawns subagents with `agent()`, runs them concurrently with `parallel()` / `pipeline()`, automatically caps concurrency, retries on transient failures, and gives the user a live progress tree. One proposition's evaluation never depends on another's, so this is a clean single-stage fan-out.

Invoking a workflow here is explicitly requested by this skill — that satisfies the `Workflow` tool's opt-in requirement, so call it directly; do not wait for the user to ask again.

Workflow scripts have **no filesystem access** and run in their own sandbox. The most reliable way to get the propositions and paths into the script is to **embed them directly as a literal** at the top of the script you generate — you are writing the script text fresh each run anyway, so paste the actual values in. (The `args` channel is an alternative, but embedding avoids any plumbing surprises across CLI versions.) The subagents themselves still have full filesystem access and re-read the files they need from disk using the paths you embed.

So: read `work/propositions.json` and the absolute `uploads`, `work`, and `output` directory paths, then generate a workflow `script` with those values inlined. Keep the one-agent-per-proposition shape:

```javascript
export const meta = {
  name: 'proposition-fanout',
  description: 'Evaluate each proposition against the case bundle, one subagent per proposition',
  phases: [{ title: 'Evaluate', detail: 'one subagent per proposition' }],
}

// === Inputs — the orchestrator fills these in as literals before submitting ===
const INPUT = {
  propositions: [
    { proposition_id: 'prop_001', text: 'The defendant signed the contract on 3 March 2021.' },
    // ...one entry per proposition, copied verbatim from work/propositions.json...
  ],
  documentIndexPath: '/abs/path/to/work/document_index.json',
  uploadsDir: '/abs/path/to/uploads',
  outputDir: '/abs/path/to/output',
  skillPath: '/abs/path/to/.claude/skills/evidence-evaluation/SKILL.md',
}
// ============================================================================

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    proposition_id: { type: 'string' },
    judgement: {
      type: 'string',
      enum: ['supported','somewhat_supported','neutral','somewhat_adverse','adverse','not_addressed'],
    },
    output_path: { type: 'string' },
  },
  required: ['proposition_id', 'judgement', 'output_path'],
}

phase('Evaluate')

const results = await parallel(INPUT.propositions.map((p) => () =>
  agent(
    [
      `You are evaluating ONE legal proposition against a case bundle.`,
      `Follow the procedure in the evidence-evaluation skill exactly`,
      `(read it at: ${INPUT.skillPath}).`,
      ``,
      `proposition_id: ${p.proposition_id}`,
      `proposition text (verbatim): ${p.text}`,
      `document index JSON: ${INPUT.documentIndexPath}`,
      `uploads directory: ${INPUT.uploadsDir}`,
      ``,
      `Go through EVERY document in the index, grade each one's relevance,`,
      `verify every excerpt against its source, reach an overall judgement,`,
      `and WRITE the result JSON to: ${INPUT.outputDir}/${p.proposition_id}.json`,
      `(create the file yourself; the schema is defined by the skill).`,
      `Then return the summary object.`,
    ].join('\n'),
    { label: `eval:${p.proposition_id}`, phase: 'Evaluate', schema: RESULT_SCHEMA },
  )
))

return results.filter(Boolean)
```

Notes:
- Each subagent independently reads the document index and uploads, judges every document, verifies excerpts, reaches a judgement on the scale above, and **writes `output/<proposition_id>.json` itself** — exactly as the **evidence-evaluation** skill specifies.
- `parallel()` is a barrier that runs all proposition evaluations concurrently (the runtime caps how many execute at once and queues the rest), so passing all propositions at once is safe even for large bundles — no manual batching needed.
- The workflow returns the per-proposition summaries; use them for the final report, but treat the written `output/*.json` files as the authoritative artifact.

## Output contract

Each subagent produces one file at `output/<proposition_id>.json`. The exact shape — the overall `judgement`, `confidence`, `summary`, and the per-document `evidence` list with verified excerpts — is defined and enforced by the **evidence-evaluation** skill. See that skill for the authoritative output schema.

The `output/` directory of per-proposition JSON files is the final artifact. These are consumed by the frontend.

## Orchestrator rules

- Do the orchestration work yourself (survey + proposition extraction); do the **judging** only via the workflow's subagents.
- Always fan out the per-proposition judgement through a **Claude Code Workflow** (`Workflow` tool), as described in Step 3 — do not hand-roll the parallelism with individual `Agent` calls.
- Never collapse multiple propositions into one subagent — strictly one proposition per `agent()` call for clean isolation and parallelism.
- Ensure every proposition in `propositions.json` has a corresponding file in `output/` before reporting completion. If any are missing, re-run the workflow for just the missing `proposition_id`s.
- Keep intermediate state (`document_index.json`, `propositions.json`) in `work/`; keep only final results in `output/`.
- Report a final summary to the user: count of propositions, and a breakdown of judgements across the scale.