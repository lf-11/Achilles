"use strict";

/**
 * propCheck web service.
 *
 * Serves a small frontend that lets a user upload a zipped bundle of case
 * documents (plus a set of propositions). On upload the bundle is unzipped into
 * a per-job directory and analyzed headlessly by Claude Code using the
 * `case-proposition-orchestrator` skill, which fans out one subagent per
 * proposition via a Claude Code Workflow. Per-proposition JSON results land in
 * the job's `output/` directory and are surfaced back through the UI.
 */

const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn, execFile } = require("child_process");

const PORT = Number(process.env.PORT) || 8080;
const PROJECT_DIR = process.env.PROPCHECK_DIR || path.resolve(__dirname, "..");
const JOBS_DIR = path.join(PROJECT_DIR, "jobs");
const CLAUDE = process.env.CLAUDE_BIN || "claude";
const MAX_UPLOAD = 200 * 1024 * 1024; // 200 MB

fs.mkdirSync(JOBS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function newJobId() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `job-${ts}-${rand}`;
}

// Binary-safe multipart/form-data parser for the few fields we need.
function parseMultipart(buf, boundary) {
  const fields = {};
  const files = {};
  // every file part in order, so a single field name can carry many files
  // (the /api/update drop accepts multiple documents at once)
  const fileList = [];
  const delim = Buffer.from("--" + boundary);
  const parts = [];

  let start = buf.indexOf(delim);
  if (start === -1) return { fields, files };
  start += delim.length;

  while (start < buf.length) {
    // end of multipart body is "--" right after a boundary
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;
    // skip the CRLF after the boundary
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;

    const next = buf.indexOf(delim, start);
    if (next === -1) break;
    // the part payload, minus the trailing CRLF before the next boundary
    let end = next;
    if (buf[end - 2] === 0x0d && buf[end - 1] === 0x0a) end -= 2;
    parts.push(buf.slice(start, end));
    start = next + delim.length;
  }

  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const header = part.slice(0, headerEnd).toString("utf8");
    const body = part.slice(headerEnd + 4);

    const nameMatch = /name="([^"]*)"/.exec(header);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const fileMatch = /filename="([^"]*)"/.exec(header);

    if (fileMatch && fileMatch[1]) {
      const file = { field: name, filename: fileMatch[1], data: body };
      files[name] = file; // last-wins, kept for single-file callers (bundle)
      fileList.push(file);
    } else {
      fields[name] = body.toString("utf8");
    }
  }
  return { fields, files, fileList };
}

// ---------------------------------------------------------------------------
// job execution
// ---------------------------------------------------------------------------

function writeStatus(jobDir, status) {
  fs.writeFileSync(
    path.join(jobDir, "status.json"),
    JSON.stringify(status, null, 2)
  );
}

function startAnalysis(jobDir) {
  const uploadsDir = path.join(jobDir, "uploads");
  const workDir = path.join(jobDir, "work");
  const outputDir = path.join(jobDir, "output");
  const propsFile = path.join(jobDir, "propositions.txt");
  const hasPropsOverride = fs.existsSync(propsFile);

  const promptLines = [
    "Use the case-proposition-orchestrator skill to analyze this uploaded case bundle.",
    "",
    "Use these ABSOLUTE paths (ignore the relative work/ and output/ paths in the skill text):",
    `- Case documents (uploads directory): ${uploadsDir}`,
    `- Intermediate state directory (write document_index.json and propositions.json here): ${workDir}`,
    `- Final per-proposition results directory: ${outputDir}`,
    "",
  ];
  if (hasPropsOverride) {
    promptLines.push(
      `The caller explicitly supplied a propositions list at: ${propsFile}`,
      "Use those propositions (one per non-empty line) verbatim as the set to evaluate (override mode).",
    );
  } else {
    promptLines.push(
      "No propositions were supplied — this is the normal case. DISCOVER the propositions",
      "dynamically from the CONTENT of the documents in the bundle, exactly as Step 2 of the skill",
      "describes: read the documents, surface the material checkable assertions they make,",
      "de-duplicate them into a clean proposition set, then test each against the whole bundle.",
      "Do NOT look for a pre-written propositions/issues file and do NOT treat an ordinary",
      "case document as a predetermined propositions list.",
    );
  }
  promptLines.push(
    "",
    "Follow the skill's workflow end to end: survey the bundle, extract propositions,",
    "then fan out the per-proposition judgement using a Claude Code Workflow (the Workflow tool),",
    "one subagent per proposition. Each subagent must write output/<proposition_id>.json.",
    "When finished, report the count of propositions and the breakdown of judgements.",
  );
  const prompt = promptLines.join("\n");

  const args = [
    "-p",
    prompt,
    "--permission-mode",
    "bypassPermissions",
    "--output-format",
    "json",
    "--add-dir",
    jobDir,
  ];

  writeStatus(jobDir, { state: "running", startedAt: new Date().toISOString() });

  const logStream = fs.createWriteStream(path.join(jobDir, "run.log"));
  const child = spawn(CLAUDE, args, {
    cwd: PROJECT_DIR,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  child.on("close", (code) => {
    writeStatus(jobDir, {
      state: code === 0 ? "done" : "error",
      startedAt: readStatus(jobDir).startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: code,
    });
  });
  child.on("error", (err) => {
    writeStatus(jobDir, {
      state: "error",
      finishedAt: new Date().toISOString(),
      error: String(err.message || err),
    });
  });
}

// Fold newly added documents into an already-analysed job. The new files are
// already sitting in the job's uploads/ dir; this drives the update-orchestrator
// skill, which (1) re-tests every existing proposition against the new documents
// and (2) discovers any new propositions the documents raise — extending the
// existing output/ + work/propositions.json in place rather than replacing them.
function startUpdate(jobDir) {
  const uploadsDir = path.join(jobDir, "uploads");
  const workDir = path.join(jobDir, "work");
  const outputDir = path.join(jobDir, "output");
  const skillsDir = path.join(PROJECT_DIR, ".claude", "skills");

  const prompt = [
    "Use the update-orchestrator skill to fold newly added documents into this already-analysed case.",
    "",
    "Use these ABSOLUTE paths (ignore the relative work/ and output/ paths in the skill text):",
    `- Case documents (uploads directory, now containing the new files): ${uploadsDir}`,
    `- Existing intermediate state (document_index.json + propositions.json live here): ${workDir}`,
    `- Existing per-proposition results directory (extend these in place): ${outputDir}`,
    `- Skills directory (resolve update-evidence-evaluation and evidence-evaluation SKILL.md here): ${skillsDir}`,
    "",
    "This is an INCREMENTAL UPDATE of an existing analysis, not a fresh run. Follow the",
    "update-orchestrator workflow end to end:",
    "1. Detect which uploaded files are NEW (not already in document_index.json) and index them.",
    "2. Discover any genuinely NEW propositions the new documents raise (de-duplicated against the",
    "   propositions already in propositions.json) and append them, with new non-colliding ids.",
    "3. Fan out ONE Claude Code Workflow that does both at once: update each EXISTING proposition",
    "   against the new documents only (update-evidence-evaluation), and fully evaluate each NEW",
    "   proposition against the whole bundle (evidence-evaluation). Each subagent writes",
    "   output/<proposition_id>.json itself.",
    "",
    "Preserve everything from the first run: never re-extract or renumber existing propositions and",
    "never re-evaluate already-judged documents. The result must be the previous analysis EXTENDED —",
    "added propositions plus changed judgements on the existing ones.",
    "When finished, report: new documents added, existing propositions whose judgement changed",
    "(before→after), and new propositions added (with their judgements).",
  ].join("\n");

  const args = [
    "-p",
    prompt,
    "--permission-mode",
    "bypassPermissions",
    "--output-format",
    "json",
    "--add-dir",
    jobDir,
  ];

  writeStatus(jobDir, {
    state: "running",
    mode: "update",
    startedAt: new Date().toISOString(),
  });

  const logStream = fs.createWriteStream(path.join(jobDir, "update.log"));
  const child = spawn(CLAUDE, args, {
    cwd: PROJECT_DIR,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  child.on("close", (code) => {
    writeStatus(jobDir, {
      state: code === 0 ? "done" : "error",
      mode: "update",
      startedAt: readStatus(jobDir).startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: code,
    });
  });
  child.on("error", (err) => {
    writeStatus(jobDir, {
      state: "error",
      mode: "update",
      finishedAt: new Date().toISOString(),
      error: String(err.message || err),
    });
  });
}

function readStatus(jobDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(jobDir, "status.json"), "utf8"));
  } catch {
    return {};
  }
}

function collectResults(jobDir) {
  const outDir = path.join(jobDir, "output");
  const results = [];
  let files = [];
  try {
    files = fs.readdirSync(outDir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    /* no output yet */
  }
  for (const f of files) {
    try {
      results.push(JSON.parse(fs.readFileSync(path.join(outDir, f), "utf8")));
    } catch {
      /* skip partial/unreadable file */
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Achilles view adapter — maps backend output (prop_<NNN>.json + document_index
// + propositions.json) into the shape the Achilles dashboard consumes:
//   { jobId, issues:[{id,title}], props:[{id,issue,text,src,status,frag,ev:[...]}] }
// Done server-side so it is testable with curl and keeps the bundled frontend
// edits minimal.
// ---------------------------------------------------------------------------

function readJSONSafe(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function analysisDirs(jobId) {
  const base =
    jobId === "sample"
      ? path.join(PROJECT_DIR, "examples", "cms-challenge-synthetic")
      : path.join(JOBS_DIR, jobId);
  return { outDir: path.join(base, "output"), workDir: path.join(base, "work") };
}

// proposition_id "prop_007" -> "P07" for compact display
function shortPropId(pid) {
  const m = /(\d+)/.exec(pid || "");
  return m ? "P" + m[1].slice(-2).padStart(2, "0") : pid || "P?";
}

// document_index category -> Achilles evidence-type key (must be a valid ET key)
function categoryToType(cat) {
  const c = (cat || "").toLowerCase();
  if (c.includes("expert")) return "witness_expert";
  if (c.includes("witness") || c.includes("statement")) return "witness_fact";
  if (c.includes("contract") || c.includes("agreement") || c.includes("deed") || c.includes("order") || c.includes("certificate"))
    return "contract";
  if (c.includes("email") || c.includes("letter") || c.includes("correspond")) return "correspondence";
  if (c.includes("log") || c.includes("minute") || c.includes("internal") || c.includes("memo")) return "internal_record";
  return "record";
}

// "doc_002 (Particulars of Claim, para 3)" -> { doc:"Particulars of Claim", ref:"para 3" }
function parseSource(src) {
  if (!src) return { doc: "", ref: "" };
  const m = /\(([^)]*)\)/.exec(src);
  if (m) {
    const parts = m[1].split(",");
    return { doc: (parts[0] || "").trim(), ref: parts.slice(1).join(",").trim() };
  }
  return { doc: String(src).trim(), ref: "" };
}

function buildView(jobId) {
  const { outDir, workDir } = analysisDirs(jobId);
  let files = [];
  try {
    files = fs.readdirSync(outDir).filter((f) => /^prop_.*\.json$/.test(f)).sort();
  } catch {
    /* no output yet */
  }
  const docIndex = readJSONSafe(path.join(workDir, "document_index.json"), { documents: [] });
  const propsFile = readJSONSafe(path.join(workDir, "propositions.json"), { propositions: [], groups: [] });

  const docMap = {};
  for (const d of docIndex.documents || []) docMap[d.doc_id] = d;
  const propMeta = {};
  for (const p of propsFile.propositions || []) propMeta[p.proposition_id] = p;

  const order = [];
  const titles = {};
  const seenGroup = (id, title) => {
    if (!id) return;
    if (!(id in titles)) {
      titles[id] = title || id;
      order.push(id);
    } else if (title) {
      titles[id] = title;
    }
  };
  for (const g of propsFile.groups || []) seenGroup(g.group_id, g.title);

  const props = [];
  for (const f of files) {
    const r = readJSONSafe(path.join(outDir, f), null);
    if (!r) continue;
    const meta = propMeta[r.proposition_id] || {};
    const groupId = (r.group && r.group.group_id) || meta.group_id || "all";
    const groupTitle = (r.group && r.group.title) || titles[groupId] || (groupId === "all" ? "Propositions" : groupId);
    seenGroup(groupId, groupTitle);

    const ev = (r.evidence || [])
      .filter((e) => e.relevance && e.relevance !== "not_addressed")
      .map((e) => {
        const d = docMap[e.doc_id] || {};
        return {
          id: e.evidence_id || r.proposition_id + "__" + e.doc_id,
          rel: e.relevance,
          type: categoryToType(d.category),
          doc: d.title || e.doc_id,
          docId: e.doc_id,
          ref: "",
          quote: e.excerpt || "",
          conf: typeof r.confidence === "number" ? r.confidence : 0,
          url: "",
        };
      });
    const supporting = ev.filter((e) => e.rel === "supported" || e.rel === "somewhat_supported").length;
    props.push({
      id: shortPropId(r.proposition_id),
      issue: groupId,
      text: r.proposition_text || meta.text || "",
      src: parseSource(meta.source),
      status: r.judgement || "not_addressed",
      frag: { score: 0, single: supporting === 1, note: "" },
      summary: r.summary || "",
      ev,
    });
  }
  if (!order.length) {
    order.push("all");
    titles.all = "Propositions";
  }
  return { jobId, issues: order.map((id) => ({ id, title: titles[id] })), props };
}

// newest job that has produced output; falls back to the bundled sample
function latestJobId() {
  let dirs = [];
  try {
    dirs = fs.readdirSync(JOBS_DIR).filter((d) => /^job-/.test(d));
  } catch {
    /* none */
  }
  const ready = dirs
    .filter((d) => {
      const st = readStatus(path.join(JOBS_DIR, d));
      if (st.state === "done") return true;
      try {
        return fs.readdirSync(path.join(JOBS_DIR, d, "output")).some((f) => /^prop_.*\.json$/.test(f));
      } catch {
        return false;
      }
    })
    .sort();
  return ready.length ? ready[ready.length - 1] : "sample";
}

// safe: only allow our own job-id pattern, never arbitrary paths
function safeJobDir(id) {
  if (!/^job-[A-Za-z0-9-]+$/.test(id)) return null;
  const dir = path.join(JOBS_DIR, id);
  if (!dir.startsWith(JOBS_DIR + path.sep)) return null;
  if (!fs.existsSync(dir)) return null;
  return dir;
}

// The drop-in-document update needs a real, writable job to extend. When the UI
// is still showing the bundled read-only "sample", seed a fresh job from it
// (copy its output/ + work/) so the new documents can be folded in non-destructively.
function seedJobFromSample() {
  const sampleBase = path.join(PROJECT_DIR, "examples", "cms-challenge-synthetic");
  const jobId = newJobId();
  const jobDir = path.join(JOBS_DIR, jobId);
  fs.mkdirSync(path.join(jobDir, "uploads"), { recursive: true });
  for (const sub of ["output", "work"]) {
    const src = path.join(sampleBase, sub);
    const dst = path.join(jobDir, sub);
    if (fs.existsSync(src)) {
      fs.cpSync(src, dst, { recursive: true });
    } else {
      fs.mkdirSync(dst, { recursive: true });
    }
  }
  writeStatus(jobDir, { state: "seeded", seededFrom: "sample" });
  return { jobId, jobDir };
}

// turn an uploaded filename into a safe, non-colliding path inside uploadsDir
function uniqueUploadPath(uploadsDir, rawName) {
  let base = path.basename(String(rawName || "document"));
  base = base.replace(/[/\\]/g, "").replace(/[\u0000-\u001f]/g, "").replace(/^\.+/, "").trim() || "document";
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length) || "document";
  let candidate = base;
  let n = 1;
  while (fs.existsSync(path.join(uploadsDir, candidate))) {
    candidate = `${stem} (${n})${ext}`;
    n++;
  }
  return path.join(uploadsDir, candidate);
}

// ---------------------------------------------------------------------------
// request handling
// ---------------------------------------------------------------------------

function handleUpload(req, res) {
  const ct = req.headers["content-type"] || "";
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
  if (!ct.startsWith("multipart/form-data") || !m) {
    return sendJSON(res, 400, { error: "expected multipart/form-data" });
  }
  const boundary = (m[1] || m[2]).trim();

  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_UPLOAD) {
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    let parsed;
    try {
      parsed = parseMultipart(Buffer.concat(chunks), boundary);
    } catch (e) {
      return sendJSON(res, 400, { error: "could not parse upload" });
    }
    const bundle = parsed.files.bundle;
    const propositions = (parsed.fields.propositions || "").trim();
    if (!bundle || !bundle.data || !bundle.data.length) {
      return sendJSON(res, 400, { error: 'missing "bundle" zip file' });
    }

    const jobId = newJobId();
    const jobDir = path.join(JOBS_DIR, jobId);
    const uploadsDir = path.join(jobDir, "uploads");
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.mkdirSync(path.join(jobDir, "work"), { recursive: true });
    fs.mkdirSync(path.join(jobDir, "output"), { recursive: true });

    const zipPath = path.join(jobDir, "bundle.zip");
    fs.writeFileSync(zipPath, bundle.data);
    // propositions are optional — only written when the user supplies an override;
    // otherwise the orchestrator locates them inside the bundle.
    if (propositions) {
      fs.writeFileSync(path.join(jobDir, "propositions.txt"), propositions);
    }

    // unzip (junk-paths-safe: -o overwrite; let unzip create the tree)
    execFile(
      "/usr/bin/unzip",
      ["-o", "-qq", zipPath, "-d", uploadsDir],
      { maxBuffer: 10 * 1024 * 1024 },
      (err) => {
        if (err) {
          writeStatus(jobDir, {
            state: "error",
            error: "failed to unzip bundle: " + String(err.message || err),
          });
          return sendJSON(res, 400, { error: "could not unzip bundle" });
        }
        try {
          startAnalysis(jobDir);
        } catch (e) {
          writeStatus(jobDir, { state: "error", error: String(e) });
        }
        sendJSON(res, 200, { jobId });
      }
    );
  });
}

// Fold newly added documents into an existing analysis. Accepts one or more
// document files (the "drop in document" gesture) plus the jobId being viewed,
// drops them into that job's uploads/, and runs the update-orchestrator skill so
// the existing output/ is EXTENDED (existing propositions re-tested, new ones added).
function handleUpdate(req, res) {
  const ct = req.headers["content-type"] || "";
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
  if (!ct.startsWith("multipart/form-data") || !m) {
    return sendJSON(res, 400, { error: "expected multipart/form-data" });
  }
  const boundary = (m[1] || m[2]).trim();

  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_UPLOAD) {
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    let parsed;
    try {
      parsed = parseMultipart(Buffer.concat(chunks), boundary);
    } catch (e) {
      return sendJSON(res, 400, { error: "could not parse upload" });
    }
    const docs = (parsed.fileList || []).filter((f) => f && f.data && f.data.length);
    if (!docs.length) {
      return sendJSON(res, 400, { error: "no documents to add" });
    }

    // resolve a real, writable job to extend; seed from the sample when the UI is
    // still showing the read-only sample (or the id is blank/unknown).
    const reqJobId = (parsed.fields.jobId || "").trim();
    let jobId, jobDir;
    const existing = safeJobDir(reqJobId);
    if (existing) {
      jobId = reqJobId;
      jobDir = existing;
    } else {
      try {
        ({ jobId, jobDir } = seedJobFromSample());
      } catch (e) {
        return sendJSON(res, 500, {
          error: "could not seed job from sample: " + String(e.message || e),
        });
      }
    }

    const uploadsDir = path.join(jobDir, "uploads");
    fs.mkdirSync(uploadsDir, { recursive: true });

    // write plain documents straight into uploads/; unzip any dropped .zip there too
    const zips = [];
    docs.forEach((f, i) => {
      if (/\.zip$/i.test(f.filename || "")) {
        const zp = path.join(jobDir, `drop-${i}.zip`);
        fs.writeFileSync(zp, f.data);
        zips.push(zp);
      } else {
        fs.writeFileSync(uniqueUploadPath(uploadsDir, f.filename), f.data);
      }
    });

    const begin = () => {
      try {
        startUpdate(jobDir);
      } catch (e) {
        writeStatus(jobDir, { state: "error", mode: "update", error: String(e) });
      }
      sendJSON(res, 200, { jobId });
    };

    if (!zips.length) return begin();
    let pending = zips.length;
    let failed = false;
    for (const zp of zips) {
      execFile(
        "/usr/bin/unzip",
        ["-o", "-qq", zp, "-d", uploadsDir],
        { maxBuffer: 10 * 1024 * 1024 },
        (err) => {
          if (err) failed = true;
          if (--pending === 0) {
            if (failed) {
              writeStatus(jobDir, {
                state: "error",
                mode: "update",
                error: "failed to unzip dropped bundle",
              });
              return sendJSON(res, 400, { error: "could not unzip dropped bundle" });
            }
            begin();
          }
        }
      );
    }
  });
}

function handleJobStatus(res, id) {
  const jobDir = safeJobDir(id);
  if (!jobDir) return sendJSON(res, 404, { error: "unknown job" });
  const status = readStatus(jobDir);
  const results = collectResults(jobDir);

  let propositionCount = null;
  try {
    const props = JSON.parse(
      fs.readFileSync(path.join(jobDir, "work", "propositions.json"), "utf8")
    );
    propositionCount = (props.propositions || []).length;
  } catch {
    /* not extracted yet */
  }

  // judgement breakdown
  const breakdown = {};
  for (const r of results) {
    const j = r.judgement || "unknown";
    breakdown[j] = (breakdown[j] || 0) + 1;
  }

  sendJSON(res, 200, {
    jobId: id,
    state: status.state || "unknown",
    startedAt: status.startedAt,
    finishedAt: status.finishedAt,
    exitCode: status.exitCode,
    propositionCount,
    completedCount: results.length,
    breakdown,
    results,
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/") {
    let html;
    try {
      html = fs.readFileSync(path.join(PROJECT_DIR, "Achilles.html"));
    } catch {
      return sendJSON(res, 500, { error: "Achilles.html not found" });
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  // legacy upload-form frontend, kept for debugging
  if (req.method === "GET" && url.pathname === "/classic") {
    const html = fs.readFileSync(path.join(__dirname, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  if (req.method === "POST" && url.pathname === "/api/upload") {
    return handleUpload(req, res);
  }

  // fold newly added documents into an existing analysis (drop-in-document)
  if (req.method === "POST" && url.pathname === "/api/update") {
    return handleUpdate(req, res);
  }

  // newest job that has results (or "sample")
  if (req.method === "GET" && url.pathname === "/api/latest") {
    return sendJSON(res, 200, { jobId: latestJobId() });
  }

  // adapted, dashboard-shaped view of a job's analysis
  const viewMatch = /^\/api\/view\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && viewMatch) {
    const id = decodeURIComponent(viewMatch[1]);
    if (id !== "sample" && !safeJobDir(id)) {
      return sendJSON(res, 404, { error: "unknown job" });
    }
    return sendJSON(res, 200, buildView(id));
  }

  const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && jobMatch) {
    return handleJobStatus(res, decodeURIComponent(jobMatch[1]));
  }

  sendJSON(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log(`propCheck web listening on ${PORT}`));
