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

const PORT = 8080;
const PROJECT_DIR = "/home/sprite/propCheck";
const JOBS_DIR = path.join(PROJECT_DIR, "jobs");
const CLAUDE = "/home/sprite/.local/bin/claude";
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
      files[name] = { filename: fileMatch[1], data: body };
    } else {
      fields[name] = body.toString("utf8");
    }
  }
  return { fields, files };
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

// safe: only allow our own job-id pattern, never arbitrary paths
function safeJobDir(id) {
  if (!/^job-[A-Za-z0-9-]+$/.test(id)) return null;
  const dir = path.join(JOBS_DIR, id);
  if (!dir.startsWith(JOBS_DIR + path.sep)) return null;
  if (!fs.existsSync(dir)) return null;
  return dir;
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
    const html = fs.readFileSync(path.join(__dirname, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  if (req.method === "POST" && url.pathname === "/api/upload") {
    return handleUpload(req, res);
  }

  const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && jobMatch) {
    return handleJobStatus(res, decodeURIComponent(jobMatch[1]));
  }

  sendJSON(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log(`propCheck web listening on ${PORT}`));
