---
name: update-orchestrator
description: Orchestrates an incremental update when new documents are added to a case that has already been analysed. Use when a user uploads additional case files and an existing set of per-proposition result JSONs already exists in output/. Folds the new documents into the existing analysis in two ways at once — (1) re-evaluates every existing proposition against the new documents and recomputes its judgement, and (2) discovers any genuinely new propositions the new documents raise and evaluates those against the whole bundle. The result is the previous analysis EXTENDED, not replaced.
---

# Case Proposition Update Orchestrator

## What this task is

A first set of case documents has **already been analysed**. The `work/propositions.json` file and the per-proposition results in `output/<proposition_id>.json` already exist. The user has now uploaded **additional documents** and wants them folded into the existing analysis so the previous bundle is **extended** with what the new documents add.

Extending the analysis means two distinct things happen, both by default:

1. **Existing propositions are re-tested.** Every proposition already on file is re-evaluated against the **new** documents only, the new evidence is merged into that proposition's result, and its overall judgement is recomputed. New corroborating evidence can strengthen a judgement; new contradicting evidence can weaken or flip it.
2. **New propositions are added.** The new documents may raise material, checkable assertions that the original bundle never made. Those become **new** propositions, are appended to `work/propositions.json`, and are evaluated against the **whole** bundle (old + new documents) like any first-run proposition.

You do **not** re-extract or renumber the existing propositions, and you do **not** re-evaluate documents that an existing proposition already judged. Everything from the first run is preserved; the update only adds.

You do not judge anything yourself. You identify the new documents, discover any new propositions, and delegate the per-proposition work to subagents.

The judgement scale is unchanged from the initial run:

- `supported` — documents clearly support the proposition
- `somewhat_supported` — some evidence supports it, but partial or weak
- `neutral` — documents touch on it but neither support nor contradict
- `somewhat_adverse` — some evidence contradicts it, but partial or weak
- `adverse` — documents clearly contradict the proposition
- `not_addressed` — no document in the bundle addresses the proposition

## Inputs (already present from the first run)

- `work/propositions.json` — the propositions (and any `groups`) from the first run. Reuse the existing entries verbatim; you only ever **append** to this file.
- `work/document_index.json` — the inventory of the documents analysed in the first run.
- `output/<proposition_id>.json` — one existing result file per existing proposition, with its current `judgement`, `confidence`, `summary`, and `evidence` list.
- **New uploads** — the additional case files, in the uploads directory.

## Workflow

Run these four steps in order.

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

### Step 2 — Discover any new propositions the new documents raise

Read the **new** documents and surface the material, checkable assertions they make — the factual or legal claims a reader would now want to test against the rest of the evidence (who did what, when, what was agreed, what was known, what was represented, etc.), exactly as Step 2 of the initial-run **orchestrator** skill describes.

Then de-duplicate those candidate assertions **against the propositions already in `work/propositions.json`**:

- If a candidate is merely more evidence about a claim an existing proposition already states, it is **not** a new proposition — it will be picked up in Step 4 when that existing proposition is re-tested against the new documents. Drop it from this list.
- Keep only candidates that assert something **materially new** that no existing proposition covers.

For each genuinely new proposition:

1. Phrase it as a single self-contained declarative statement, faithful to the document's wording, and record its `source` (the new `doc_id` and locator).
2. Assign a stable `proposition_id` that continues the existing numbering and never collides (e.g. if existing IDs end at `prop_018`, the first new one is `prop_019`).
3. Assign a `group_id`: prefer an existing group from `work/propositions.json` that the proposition clearly belongs to; only create a new group (with a stable `group_id` and short `title`) when none fits, and append it to the file's `groups` array. (If the first run produced no `groups`, you may add a `groups` array now; the frontend tolerates propositions with or without a group.)
4. **Append** the new proposition to `work/propositions.json` — never modify or renumber existing entries.

If no new propositions are warranted, that is fine — skip the new-proposition fan-out in Step 4 and only update the existing propositions.

### Step 3 — Confirm the existing state

Read `work/propositions.json` and confirm an `output/<proposition_id>.json` exists for each **pre-existing** proposition. Every pre-existing proposition with a result file is in scope for an incremental update (Step 4, update mode). The new propositions you just added in Step 2 have no result file yet — they are in scope for a full evaluation (Step 4, evaluate mode).

### Step 4 — Fan out one subagent per proposition via a Claude Code Workflow

Dispatch all per-proposition work in a **single** Claude Code Workflow (the `Workflow` tool), exactly as the initial-run orchestrator does — not ad-hoc `Agent` calls. One proposition's work never depends on another's, so this is a clean single-stage fan-out, but it contains **two kinds** of task:

- **Existing proposition → update mode.** The subagent reads its existing `output/<proposition_id>.json`, evaluates **only** the new documents, verifies quotes, merges them into the existing evidence, recomputes the judgement, and writes the file back. This follows the **update-evidence-evaluation** skill.
- **New proposition → evaluate mode.** The subagent evaluates the proposition against **every** document in the bundle (old + new), verifies quotes, reaches a judgement, and writes a fresh `output/<proposition_id>.json`. This follows the original **evidence-evaluation** skill (a full first-time evaluation, since the proposition has no prior result).

Invoking a workflow here is explicitly requested by this skill — that satisfies the `Workflow` tool's opt-in requirement, so call it directly.

As before, workflow scripts have **no filesystem access**, so embed the propositions, the new-documents list, and the absolute paths directly as literals at the top of the generated script. Each subagent has full filesystem access and re-reads what it needs from disk — its **existing** `output/<proposition_id>.json` (update mode) or the documents in the index (evaluate mode), plus the **new** documents.

Read `work/propositions.json` and `work/new_documents.json`, resolve the absolute `uploads`, `work`, and `output` paths, then generate a workflow `script` with those values inlined:

```javascript
export const meta = {
  name: 'proposition-update-fanout',
  description: 'Extend an existing analysis: update each existing proposition with the new documents, and fully evaluate each newly discovered proposition',
  phases: [{ title: 'Extend', detail: 'one subagent per proposition (update or evaluate)' }],
}

// === Inputs — the orchestrator fills these in as literals before submitting ===
const INPUT = {
  // Pre-existing propositions that already have an output/<id>.json — update mode.
  existingPropositions: [
    { proposition_id: 'prop_001', text: 'The defendant signed the contract on 3 March 2021.' },
    // ...one entry per EXISTING proposition, copied verbatim from work/propositions.json...
  ],
  // Newly discovered propositions with no result yet — evaluate mode (full bundle).
  newPropositions: [
    { proposition_id: 'prop_019', group_id: 'grp_002', group_title: 'Delivery was on time', text: 'The new SOW moved the go-live date to 1 May 2024.' },
    // ...one entry per NEW proposition added in Step 2; [] if none...
  ],
  newDocuments: [
    { doc_id: 'doc_043', filename: '...', path: '/abs/path/to/uploads/...' },
    // ...one entry per NEW document, copied verbatim from work/new_documents.json...
  ],
  documentIndexPath: '/abs/path/to/work/document_index.json',
  uploadsDir: '/abs/path/to/uploads',
  outputDir: '/abs/path/to/output',
  updateSkillPath: '/abs/path/to/.claude/skills/update-evidence-evaluation/SKILL.md',
  evalSkillPath: '/abs/path/to/.claude/skills/evidence-evaluation/SKILL.md',
}
// ============================================================================

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    proposition_id: { type: 'string' },
    mode: { type: 'string', enum: ['update', 'evaluate'] },
    judgement: {
      type: 'string',
      enum: ['supported','somewhat_supported','neutral','somewhat_adverse','adverse','not_addressed'],
    },
    new_docs_added: { type: 'integer' },
    judgement_changed: { type: 'boolean' },
    is_new_proposition: { type: 'boolean' },
    output_path: { type: 'string' },
  },
  required: ['proposition_id', 'mode', 'judgement', 'output_path'],
}

phase('Extend')

const newDocsLiteral = JSON.stringify(INPUT.newDocuments)

// Update mode — fold the new documents into each existing proposition.
const updateTasks = INPUT.existingPropositions.map((p) => () =>
  agent(
    [
      `You are UPDATING the evaluation of ONE legal proposition with newly added documents.`,
      `Follow the procedure in the update-evidence-evaluation skill exactly`,
      `(read it at: ${INPUT.updateSkillPath}).`,
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
      `Return the summary object with mode:"update" and is_new_proposition:false.`,
    ].join('\n'),
    { label: `update:${p.proposition_id}`, phase: 'Extend', schema: RESULT_SCHEMA },
  )
)

// Evaluate mode — fully evaluate each newly discovered proposition against the whole bundle.
const evalTasks = INPUT.newPropositions.map((p) => () =>
  agent(
    [
      `You are evaluating ONE newly discovered legal proposition against the WHOLE case bundle.`,
      `Follow the procedure in the evidence-evaluation skill exactly`,
      `(read it at: ${INPUT.evalSkillPath}).`,
      ``,
      `proposition_id: ${p.proposition_id}`,
      `group_id: ${p.group_id}`,
      `group_title: ${p.group_title}`,
      `proposition text (verbatim): ${p.text}`,
      `document index JSON: ${INPUT.documentIndexPath}`,
      `uploads directory: ${INPUT.uploadsDir}`,
      ``,
      `Go through EVERY document in the index (old AND new), grade each one's relevance,`,
      `verify every excerpt against its source, reach an overall judgement,`,
      `record the proposition group (group_id + group_title) in the output,`,
      `and WRITE a fresh result JSON to: ${INPUT.outputDir}/${p.proposition_id}.json.`,
      `Return the summary object with mode:"evaluate" and is_new_proposition:true.`,
    ].join('\n'),
    { label: `eval:${p.proposition_id}`, phase: 'Extend', schema: RESULT_SCHEMA },
  )
)

const results = await parallel([...updateTasks, ...evalTasks])

return results.filter(Boolean)
```

Notes:
- Update-mode subagents read their existing `output/<proposition_id>.json`, evaluate **only** the new documents, verify quotes, merge, recompute, and **write the file back** — exactly as the **update-evidence-evaluation** skill specifies.
- Evaluate-mode subagents perform a full first-time evaluation against the whole bundle — exactly as the **evidence-evaluation** skill specifies — and write a fresh result file.
- `parallel()` caps concurrency and queues the rest, so passing every proposition (existing + new) at once is safe for large sets.
- The workflow returns per-proposition summaries (mode, whether each judgement changed, whether it is a new proposition); use them for the final report, but treat the written `output/*.json` files as authoritative.

## Output contract

The `output/` directory remains the final artifact consumed by the frontend, now **extended**:

- Existing `output/<proposition_id>.json` files are overwritten in place with the merged result (existing evidence preserved, new-document evidence appended, judgement recomputed). Shape unchanged from the initial run, enforced by the **update-evidence-evaluation** skill.
- New `output/<proposition_id>.json` files are created for the newly discovered propositions. Shape enforced by the **evidence-evaluation** skill (including the `group` block).

`work/propositions.json` is extended with the new propositions (and any new group); `work/document_index.json` is extended with the new documents. No existing entry in either file is modified or renumbered.

## Orchestrator rules

- Do the orchestration yourself (detect new documents, index them, discover new propositions, confirm existing results); do the **judging** only via the workflow's subagents.
- Preserve everything from the first run: never re-extract or renumber existing propositions, never re-evaluate already-judged documents, never overwrite existing evidence entries. The update only **adds** — new evidence to existing propositions, and new propositions.
- Adding new propositions is expected behaviour, not an error: if the new documents raise a materially new checkable claim, capture it as a new proposition. If they raise none, only update the existing propositions.
- Assign new `doc_id`s and new `proposition_id`s that never collide with existing ones; append to `work/document_index.json` and `work/propositions.json` without renumbering existing entries.
- Always fan out through a **Claude Code Workflow**; one proposition per `agent()` call; existing propositions use the update skill, new propositions use the evaluation skill.
- Ensure every in-scope proposition's `output/<proposition_id>.json` exists and is current before reporting completion. If any failed, re-run the workflow for just those `proposition_id`s.
- Report a final summary: number of new documents added, number of existing propositions updated and how many judgements changed (with before→after for those that did), and number of new propositions added (with their judgements).
