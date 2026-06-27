# propCheck

**Test the claims a legal case turns on against the evidence — automatically.**

Drop in a bundle of case documents (witness statements, contracts, emails,
expert reports, pleadings…) and propCheck reads the whole bundle, surfaces the
material **propositions** the case actually turns on, and judges each one against
*all* the evidence: is it `supported`, `adverse`, `neutral`, or somewhere in
between? Every judgement comes with the specific excerpts that back it, each
verified word-for-word against its source document, and the results are laid out
in an interactive dashboard.

Nobody hands it a list of questions to check — the propositions are **discovered
from the documents themselves**, grouped into the legal issues they cluster
around, and then each is stress-tested against the rest of the bundle.

## How it works

propCheck is a thin, dependency-free Node web service wrapped around
[Claude Code](https://claude.com/claude-code) running headlessly. The interesting
part is the orchestration:

1. **Upload** — you drop a `.zip` bundle into the web UI. The server unzips it
   into a per-job directory and launches `claude` in the background with the
   **`orchestrator`** skill.
2. **Survey & extract** — the orchestrator indexes every document, reads them,
   and distils a clean, de-duplicated set of propositions grouped by legal issue.
3. **Fan out** — here's the nice part: it uses **Claude Code's Workflow feature**
   to spawn **one subagent per proposition**, all running concurrently. Each
   proposition's evaluation is completely independent of the others, so this is a
   clean single-stage fan-out — the workflow caps concurrency, retries transient
   failures, and shows a live progress tree. Each subagent runs the
   **`evidence-evaluation`** skill: it grades every document for relevance, pulls
   and verifies the supporting/contradicting excerpts, and writes one
   `output/<proposition_id>.json`.
4. **View** — the dashboard reads those per-proposition JSON files and renders the
   issues, propositions, judgements, and evidence.

You can also **drop additional documents into a finished analysis** later — that
runs the **`update-orchestrator`** skill, which re-tests existing propositions
against the new files *and* discovers any new propositions they raise, extending
the analysis in place rather than starting over.

The skills under `.claude/skills/` are the source of truth for the pipeline; the
web server (`web/server.js`) is the glue that turns an HTTP upload into a headless
Claude Code run. Read those for the full detail.

## Running it

### Prerequisites

- **[Claude Code](https://claude.com/claude-code)** — the `claude` CLI must be on
  your `PATH` and authenticated. propCheck *is* Claude Code; it shells out to it
  for every analysis. (No Anthropic API key plumbing of its own — it uses your
  Claude Code auth.)
- **Node.js 18+** — the server uses only the standard library, so there's nothing
  to `npm install`.
- **`unzip`** — used to expand uploaded bundles (present by default on macOS/Linux).

### Start the server

```bash
node web/server.js
```

Then open **http://localhost:8080** and upload a zipped bundle of case documents.

### Configuration

All optional, via environment variables:

| Variable        | Default            | Purpose                                  |
| --------------- | ------------------ | ---------------------------------------- |
| `PORT`          | `8080`             | Port the web service listens on.         |
| `CLAUDE_BIN`    | `claude`           | Path to the Claude Code CLI.             |
| `PROPCHECK_DIR` | repository root    | Project root (where `jobs/` etc. live).  |

Each upload becomes a job under `jobs/<job-id>/` with `uploads/` (the documents),
`work/` (the document index and extracted propositions), and `output/` (the final
per-proposition results) — plus a `run.log` you can tail to watch the Claude Code
run in real time.
