Claude Vorbereitung Hochzeit.md

I'll start by reading the frontend and the key data files to compare what the app expects against what the backend produces.Now the frontend. Let me read Achilles.html to see what data shape it expects.Line 180 holds the app + embedded data. Let me extract the data model portion.Now let me check the backend prop files' full key vocabulary and judgement values across all of them.I've now mapped the frontend's data model against the backend's output. Here's what I found.

## 1. Do the JSONs contain everything the app shows? — No. Three layers are missing.

The backend produces a **single-snapshot, per-proposition analysis**. The frontend (Achilles) is built around a richer model with a stress-test score and a living-diff. Here's the field-by-field reality:

**Per-proposition mapping**

| Frontend field | Backend source | Status |
|---|---|---|
| `id` (P01…) | `proposition_id` (prop_001…) | ✓ rename only |
| `text` | `proposition_text` | ✓ |
| `status` (`supported`/`partial`/`not_addressed`/`conflicted`) | `judgement` (`supported`/`adverse`/`somewhat_adverse`) | ⚠️ **vocabularies don't match** — needs a mapping table |
| `src:{doc, ref}` | `source` (free string: `"doc_002 (Particulars of Claim, para 3)"`) | ⚠️ needs parsing into structured form |
| `frag:{score, single, note}` | — | ❌ **entirely missing** (this is the stress-test core feature) |
| `issue` (I1/I2/I3 grouping) | — | ❌ no issue-clustering field at all |
| — | `summary` (rich narrative) | backend has it, frontend doesn't display it |

**Per-evidence mapping**

| Frontend `ev[]` field | Backend `evidence[]` | Status |
|---|---|---|
| `quote` | `excerpt` | ✓ (but empty on neutral/not_addressed items) |
| `docId` | `doc_id` (`doc_001` vs `D09`) | ⚠️ id-format mismatch |
| `for` (boolean for/against) | `relevance` (6 values: supported / somewhat_supported / neutral / not_addressed / somewhat_adverse / adverse) | ⚠️ 6-state → binary loses information |
| `type` (contract, witness_expert…) | — | ❌ but recoverable: join `doc_id` → `document_index.category` |
| `doc` (title) | — | ❌ recoverable: join → `document_index.title` |
| `conf` (per-evidence) | — | ❌ backend only has confidence **per proposition**, not per evidence |
| `ref` (pinpoint) | — | ❌ no per-evidence pinpoint |
| `id` (E01…) | — | ❌ must be synthesized |

**The living-diff — completely absent from the backend.** The frontend's headline feature expects:
- `DIFF.changed[]` and diff entries `{prop, from, to, kind:'flip'|'weakened'|'newly', dir:'worse'|'better', causeEvId, why}`
- load-bearing-source list + "what if I lose this source" preview

The backend currently emits **one snapshot with no versioning, no run-to-run comparison, no `from→to`, no `why` narrative, no load-bearing analysis.** Right now Achilles fakes all of this with a single boolean `a` toggle in the seed data. This is the biggest gap — it's literally the pitch ("git diff for the case theory").

**Two other concrete issues:**
- **Coverage mismatch:** `propositions.json` lists **18** propositions (prop_001–018), but only **16** analysis files exist (prop_001–016). prop_017/018 have no analysis.
- **Demo richness:** the backend `summary` and per-evidence `reasoning` are genuinely good text that the frontend throws away — could feed `frag.note` / drawer copy instead of being unused.

## 2. What it takes to connect them

**A. Adapter layer (no new backend logic — do this first).** A small transform that reads `propositions.json` + `prop_0NN.json` + `document_index.json` and emits the frontend's shape:
- rename ids, parse `source` → `{doc, ref}`, join `doc_id` to the index for `type`/`doc` title, map `excerpt`→`quote`, synthesize evidence ids.
- a `judgement`/`relevance` → `status`/`for` mapping table (you need to **pick one canonical vocabulary** — note the backend, the frontend, and your own CLAUDE.md spec all use *three different* status sets).
- derive `frag.single` cheaply (= exactly one supporting evidence item).

**B. Backend must genuinely add (frontend can't fabricate these):**
1. **Fragility / stress-test score** + note (the `frag` object).
2. **Versioning + diff engine** — persist each run, compare against the prior, emit `changed/from/to/kind/dir/causeEvId/why`. Essential for the demo's "new document arrives" moment.
3. Per-evidence **confidence** and ideally a **pinpoint ref**.
4. Load-bearing source identification (for the what-if toggle).
5. Fill the **2 missing propositions** (017/018).
6. Optional: issue-clustering (or assign issues manually for the demo).

**C. Frontend changes:** replace the hardcoded `PROPS` array + `a` toggle in `componentDidMount` with a loader that consumes the adapted JSON, and decide whether to keep the 4-state status UI or expand to the backend's 6-point relevance scale.

The fastest path to a working demo: build the **adapter (A)** now so real data flows, then add **diff + fragility (B1/B2)** since those are what the judges are scoring.

Want me to write the adapter script (backend-JSON → Achilles data model) and a short spec for the diff/fragility fields the backend team needs to add?