---
name: update-orchestrator
description: Orchestrates an incremental update when new documents are added to a case that has already been analysed. Use when a user uploads additional case files and an existing set of per-proposition result JSONs already exists in output/. Reuses the existing propositions, dispatches per-proposition subagents that evaluate only the NEW documents, merge them into each proposition's evidence, and recompute the judgement.
---

# Case Proposition Update Orchestrator

## What this task is

A first set of case documents has **already been analysed**. The `work/propositions.json` file and the per-proposition results in `output/<proposition_id>.json` already exist. The user has now uploaded **additional documents** and wants them folded into the existing analysis.

The propositions do **not** change. You do **not** re-extract propositions, and you do **not** re-evaluate documents that were already judged. You evaluate only the **new** documents against each existing proposition, merge the new evidence into that proposition's JSON, and recompute its overall judgement.

You do not judge anything yourself. You identify the new documents and delegate the per-proposition update to subagents.

The judgement scale is unchanged from the initial run:

- `supported` — documents clearly support the proposition
- `somewhat_supported` — some evidence supports it, but partial or weak
- `neutral` — documents touch on it but neither support nor contradict
- `somewhat_adverse` — some evidence contradicts it, but partial or weak
- `adverse` — documents clearly contradict the proposition
- `not_addressed` — no document in the bundle addresses the proposition

## Inputs (already present from the first run)

- `work/propositions.json` — the propositions, unchanged. Reuse verbatim.
- `work/document_index.json` — the inventory of the documents analysed in the first run.
- `output/<proposition_id>.json` — one existing result file per proposition, with its current `judgement`, `confidence`, `summary`, and `evidence` list.
- **New uploads** — the additional case files, in the uploads directory.

## Workflow

Run these three steps in order.

### Step 1 — Identify and index the new documents

1. List all files in the uploads directory.
2. Compare against `work/document_index.json` to determine which files are **new** (not already inventoried). Match on filename/path; if an index file in the new upload designates IDs, honour it.
3. Assign each new document a stable `doc_id` that does **not collide** with existing IDs — continue the existing numbering (e.g. if the index ends at `doc_042`, the first new one is `doc_043`).
4. Append the new documents to `work/document_index.json` (do not rewrite or renumber existing entries), and also write the new-only subset to `work/new_documents.json`:

```json
{
  "new_documents": [
    { "doc_id": "doc_043", "filename": "...", "title": "...", "path": "..." }
  ]
}
```

If no genuinely new documents are found, report that and stop — there is nothing to update.

### Step 2 — Confirm the existing state

Read `work/propositions.json` and confirm an `output/<proposition_id>.json` exists for each proposition. Every proposition with an existing result file is in scope for an update. (If a proposition has no existing result file — e.g. it was added since — note it; you may fall back to a full evaluation for that one, but the normal case is that all results already exist.)

### Step 3 — Fan out one subagent per proposition via a Claude Code Workflow

Dispatch the per-proposition update using a **Claude Code Workflow** (the `Workflow` tool), exactly as in the initial-run orchestrator — not ad-hoc `Agent` calls. One proposition's update never depends on another's, so this is a clean single-stage fan-out.

Invoking a workflow here is explicitly requested by this skill — that satisfies the `Workflow` tool's opt-in requirement, so call it directly.

As before, workflow scripts have **no filesystem access**, so embed the propositions, the new-documents list, and the absolute paths directly as literals at the top of the generated script. Each subagent has full filesystem access and re-reads what it needs from disk — crucially, its **existing** `output/<proposition_id>.json` and the **new** documents.

Read `work/propositions.json` and `work/new_documents.json`, resolve the absolute `uploads`, `work`, and `output` paths, then generate a workflow `script` with those values inlined:

```javascript
export const meta = {
  name: 'proposition-update-fanout',
  description: 'Fold new documents into each proposition\'s existing result, one subagent per proposition',
  phases: [{ title: 'Update', detail: 'one subagent per proposition' }],
}

// === Inputs — the orchestrator fills these in as literals before submitting ===
const INPUT = {
  propositions: [
    { proposition_id: 'prop_001', text: 'The defendant signed the contract on 3 March 2021.' },
    // ...one entry per proposition, copied verbatim from work/propositions.json...
  ],
  newDocuments: [
    { doc_id: 'doc_043', filename: '...', path: '/abs/path/to/uploads/...' },
    // ...one entry per NEW document, copied verbatim from work/new_documents.json...
  ],
  documentIndexPath: '/abs/path/to/work/document_index.json',
  uploadsDir: '/abs/path/to/uploads',
  outputDir: '/abs/path/to/output',
  skillPath: '/abs/path/to/.claude/skills/update-evidence-evaluation/SKILL.md',
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
    new_docs_added: { type: 'integer' },
    judgement_changed: { type: 'boolean' },
    output_path: { type: 'string' },
  },
  required: ['proposition_id', 'judgement', 'output_path'],
}

phase('Update')

const newDocsLiteral = JSON.stringify(INPUT.newDocuments)

const results = await parallel(INPUT.propositions.map((p) => () =>
  agent(
    [
      `You are UPDATING the evaluation of ONE legal proposition with newly added documents.`,
      `Follow the procedure in the update-evidence-evaluation skill exactly`,
      `(read it at: ${INPUT.skillPath}).`,
      ``,
      `proposition_id: ${p.proposition_id}`,
      `proposition text (verbatim): ${p.text}`,
      `existing result JSON to update (read it, merge into it): ${INPUT.outputDir}/${p.proposition_id}.json`,
      `document index JSON: ${INPUT.documentIndexPath}`,
      `uploads directory: ${INPUT.uploadsDir}`,
      ``,
      `Evaluate ONLY these new documents (do NOT re-evaluate documents already in the existing result):`,
      newDocsLiteral,
      ``,
      `For each new document: decide relevance, extract a verified exact quote,`,
      `note whether it responds to an earlier document, and grade it on the scale.`,
      `Then MERGE the new evidence entries into the existing evidence list,`,
      `RECOMPUTE the overall judgement over the full (old + new) evidence,`,
      `and write the updated result back to ${INPUT.outputDir}/${p.proposition_id}.json.`,
      `Then return the summary object.`,
    ].join('\n'),
    { label: `update:${p.proposition_id}`, phase: 'Update', schema: RESULT_SCHEMA },
  )
))

return results.filter(Boolean)
```

Notes:
- Each subagent reads its existing `output/<proposition_id>.json`, evaluates **only** the new documents, verifies quotes, merges, recomputes the judgement, and **writes the file back itself** — exactly as the **update-evidence-evaluation** skill specifies.
- `parallel()` caps concurrency and queues the rest, so passing all propositions at once is safe for large sets.
- The workflow returns per-proposition summaries (including whether each judgement changed); use them for the final report, but treat the written `output/*.json` files as authoritative.

## Output contract

Each subagent overwrites `output/<proposition_id>.json` in place with the merged result. The shape is unchanged from the initial run and is defined and enforced by the **update-evidence-evaluation** skill (which preserves the same schema as the original evaluation skill: `judgement`, `confidence`, `summary`, and the per-document `evidence` list). The new documents appear as additional entries in `evidence`; the existing entries are preserved.

The `output/` directory remains the final artifact consumed by the frontend.

## Orchestrator rules

- Do the orchestration yourself (detect new documents, index them, confirm existing results); do the **judging** only via the workflow's subagents.
- Never re-extract propositions and never re-evaluate already-judged documents. Only the new documents are evaluated; everything else is preserved.
- Assign new `doc_id`s that never collide with existing ones; append to `work/document_index.json` without renumbering existing entries.
- Always fan out through a **Claude Code Workflow**; one proposition per `agent()` call.
- Ensure every in-scope proposition's `output/<proposition_id>.json` has been updated before reporting completion. If any failed, re-run the workflow for just those `proposition_id`s.
- Report a final summary: number of new documents added, number of propositions updated, and how many judgements changed (with the before→after for those that did).