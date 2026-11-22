"use strict";
// ============================================================
//  Executor: سرویس کوچک اجرای کد برای ایجنت (بدون هیچ وابستگی)
//  - POST /run          اجرای کد (python | node | bash) با سقف زمان
//  - GET  /files/:id/:n دانلود فایل‌هایی که کد ساخته (تا ۱۰ دقیقه)
//  - GET  /health       برای بیدار کردن/بررسی (بدون توکن)
//  همه‌ی مسیرها جز /health و / نیاز به هدر Authorization: Bearer EXEC_TOKEN دارند.
// ============================================================
const http = require("http");
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PORT = parseInt(process.env.PORT || "10000", 10);
const TOKEN = process.env.EXEC_TOKEN || "";
if (TOKEN.length < 16) {
  console.error("EXEC_TOKEN باید تنظیم شده و حداقل ۱۶ کاراکتر باشد.");
  process.exit(1);
}

const MAX_BODY = 300000;
const MAX_CODE = 200000;
const MAX_OUT = 20000;        // کاراکتر برای هر جریان خروجی
const DEFAULT_TIMEOUT = 20;
const MAX_TIMEOUT = 90;
const KEEP_MS = 10 * 60 * 1000;
const MAX_DOC = 25 * 1024 * 1024;        // حداکثر حجم فایل ورودی
const DOC_TTL_MS = 60 * 60 * 1000;       // فایل‌های ورودی یک ساعت می‌مانند
const MAX_DOCS = 5;
const EXTRACT = path.join(__dirname, "extract.py");
const RENDER = path.join(__dirname, "render_page.py");
const DOCS_DIR = path.join(os.tmpdir(), "agent-docs");
fs.mkdirSync(DOCS_DIR, { recursive: true });

const LANGS = {
  python: { file: "main.py", cmd: "python3 main.py" },
  node: { file: "main.js", cmd: "node main.js" },
  bash: { file: "main.sh", cmd: "bash main.sh" }
};

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const tokenHash = sha(TOKEN);
const authed = (req) => {
  const m = (req.headers.authorization || "").match(/^Bearer (.+)$/);
  return !!m && crypto.timingSafeEqual(sha(m[1]), tokenHash);
};

let busy = false;
let lastRun = null; // { id, dir, timer }

function dropRun() {
  if (!lastRun) return;
  clearTimeout(lastRun.timer);
  try { fs.rmSync(lastRun.dir, { recursive: true, force: true }); } catch {}
  lastRun = null;
}

// ---------- اسناد ورودی (فایل‌های کاربر): آپلود، استخراج متن، خواندن تکه‌ای، جستجو ----------
const docs = new Map(); // id -> { id, dir, file, textFile, name, size, chars, pages, kind, note, timer }
const baseName = (x) => {
  let n = String(x || "file").replace(/[\\/:*?"<>|\r\n]+/g, "_").slice(0, 80) || "file";
  return n.startsWith(".") ? "_" + n : n;
};

function dropDoc(id) {
  const d = docs.get(id);
  if (!d) return;
  clearTimeout(d.timer);
  try { fs.rmSync(d.dir, { recursive: true, force: true }); } catch {}
  docs.delete(id);
}

function saveUpload(req, dest, max) {
  return new Promise((resolve, reject) => {
    let size = 0, tooBig = false, settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const ws = fs.createWriteStream(dest);
    req.on("data", (c) => {
      size += c.length;
      if (size > max && !tooBig) {   // ذخیره را متوقف کن ولی بقیه‌ی بدنه را بخوان تا پاسخ ۴۱۳ برسد
        tooBig = true;
        req.unpipe(ws);
        ws.destroy();
        req.resume();
      }
      if (size > max * 2) req.destroy();   // سقف مطلق
    });
    req.pipe(ws);
    ws.on("finish", () => { if (!tooBig) done(resolve, size); });
    ws.on("error", (e) => { if (!tooBig) done(reject, e); });
    req.on("end", () => { if (tooBig) done(reject, new HttpError(413, `file too large (max ${max} bytes)`)); });
    req.on("close", () => { if (tooBig) done(reject, new HttpError(413, `file too large (max ${max} bytes)`)); });
    req.on("error", (e) => done(reject, e));
  });
}

function runPy(script, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn("python3", [script, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, LANG: "C.UTF-8", PYTHONIOENCODING: "utf-8" } });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { err += d.toString("utf8").slice(0, 2000); });
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", () => { clearTimeout(t); resolve({ out, err }); });
    child.on("error", (e) => { clearTimeout(t); resolve({ out: "", err: String(e) }); });
  });
}

async function addDoc(req, name) {
  // قدیمی‌ترین‌ها را کنار بگذار
  while (docs.size >= MAX_DOCS) dropDoc(docs.keys().next().value);
  const id = crypto.randomBytes(6).toString("hex");
  const dir = path.join(DOCS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  try {
    const size = await saveUpload(req, file, MAX_DOC);
    const textFile = path.join(dir, ".text.txt");
    const { out, err } = await runPy(EXTRACT, [file, textFile, name], 150000);
    let meta = null;
    try { meta = JSON.parse(out.trim().split("\n").pop()); } catch {}
    if (!meta) throw new HttpError(500, "extract failed: " + (err || "no output").slice(0, 200));
    if (!meta.ok) throw new HttpError(422, meta.error || "extract failed");
    const d = { id, dir, file, textFile, name, size, chars: meta.chars, pages: meta.pages, kind: meta.kind, note: meta.note, timer: setTimeout(() => dropDoc(id), DOC_TTL_MS) };
    docs.set(id, d);
    return d;
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    throw e;
  }
}

const docInfo = (d) => ({ ok: true, id: d.id, name: d.name, size: d.size, chars: d.chars, pages: d.pages, kind: d.kind, note: d.note });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function runCode(body) {
  const lang = LANGS[String(body.language || "python").toLowerCase()];
  if (!lang) throw new HttpError(400, "language must be python, node or bash");
  const code = String(body.code || "");
  if (!code.trim()) throw new HttpError(400, "code is empty");
  if (code.length > MAX_CODE) throw new HttpError(413, "code too large");
  const timeout = Math.min(MAX_TIMEOUT, Math.max(1, parseInt(body.timeout, 10) || DEFAULT_TIMEOUT));

  const inputDoc = body.input ? docs.get(String(body.input)) : null;
  if (body.input && !inputDoc) throw new HttpError(404, "doc not found");

  dropRun();
  const id = crypto.randomBytes(6).toString("hex");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `run-${id}-`));
  fs.writeFileSync(path.join(dir, lang.file), code);
  let inputName = null;
  if (inputDoc) {
    inputName = inputDoc.name === lang.file ? "input_" + inputDoc.name : inputDoc.name;
    fs.copyFileSync(inputDoc.file, path.join(dir, inputName));
  }

  const started = Date.now();
  // سقف CPU و حجم فایل؛ محیط تمیز بدون هیچ رمزی
  const shell = `ulimit -t ${timeout + 5} -f 40000 2>/dev/null; exec ${lang.cmd}`;
  const child = spawn("bash", ["-c", shell], {
    cwd: dir,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH, HOME: dir, TMPDIR: dir, LANG: "C.UTF-8",
      PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", MPLBACKEND: "Agg", MPLCONFIGDIR: dir
    }
  });

  let stdout = "", stderr = "", truncated = false;
  const capped = (cur, chunk) => {
    const room = MAX_OUT - cur.length;
    if (room <= 0) { truncated = true; return cur; }
    const s = chunk.toString("utf8");
    if (s.length > room) { truncated = true; return cur + s.slice(0, room); }
    return cur + s;
  };
  child.stdout.on("data", (d) => { stdout = capped(stdout, d); });
  child.stderr.on("data", (d) => { stderr = capped(stderr, d); });

  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }, timeout * 1000);

  const { code: exitCode, signal } = await new Promise((resolve) => {
    child.on("close", (c, s) => resolve({ code: c, signal: s }));
    child.on("error", (e) => { stderr += String(e); resolve({ code: -1, signal: null }); });
  });
  clearTimeout(killer);
  try { process.kill(-child.pid, "SIGKILL"); } catch {} // هر فرایند باقی‌مانده

  let files = [];
  try {
    files = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name !== lang.file && e.name !== inputName && !e.name.startsWith("."))
      .slice(0, 20)
      .map((e) => ({ name: e.name, size: fs.statSync(path.join(dir, e.name)).size }));
  } catch {}

  lastRun = { id, dir, files: new Set(files.map((f) => f.name)), timer: setTimeout(dropRun, KEEP_MS) };
  return {
    ok: true, runId: id, exitCode, signal, timedOut, inputName,
    durationMs: Date.now() - started, stdout, stderr, truncated, files
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, "body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const send = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
};

let pyVersion = "";
try { pyVersion = execFileSync("python3", ["--version"]).toString().trim(); } catch {}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");

    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      return send(res, 200, { ok: true, node: process.version, python: pyVersion, busy });
    }

    if (!authed(req)) return send(res, 401, { ok: false, error: "unauthorized" });

    if (req.method === "POST" && url.pathname === "/run") {
      if (busy) return send(res, 429, { ok: false, error: "busy: another run is in progress" });
      busy = true;
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        return send(res, 200, await runCode(body));
      } finally {
        busy = false;
      }
    }

    // ----- اسناد -----
    if (req.method === "POST" && url.pathname === "/doc") {
      const d = await addDoc(req, baseName(url.searchParams.get("name")));
      return send(res, 200, docInfo(d));
    }
    const dm = url.pathname.match(/^\/doc\/([a-f0-9]+)(?:\/(text|search|page|info))?$/);
    if (dm) {
      const d = docs.get(dm[1]);
      if (!d) return send(res, 404, { ok: false, error: "doc not found" });
      if (req.method === "DELETE" && !dm[2]) { dropDoc(d.id); return send(res, 200, { ok: true }); }
      if (req.method === "GET" && (!dm[2] || dm[2] === "info")) return send(res, 200, docInfo(d));

      if (req.method === "GET" && dm[2] === "text") {
        const text = fs.readFileSync(d.textFile, "utf8");
        const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
        const length = Math.min(30000, Math.max(500, parseInt(url.searchParams.get("length") || "15000", 10) || 15000));
        const slice = text.slice(offset, offset + length);
        return send(res, 200, { ok: true, name: d.name, offset, end: offset + slice.length, total: text.length, pages: d.pages, text: slice });
      }

      if (req.method === "GET" && dm[2] === "search") {
        const q = String(url.searchParams.get("q") || "").slice(0, 200);
        if (!q) return send(res, 400, { ok: false, error: "q is empty" });
        const max = Math.min(8, Math.max(1, parseInt(url.searchParams.get("max") || "3", 10) || 3));
        const text = fs.readFileSync(d.textFile, "utf8");
        const low = text.toLowerCase(), needle = q.toLowerCase();
        const hits = [];
        let pos = 0;
        while (hits.length < max) {
          const i = low.indexOf(needle, pos);
          if (i < 0) break;
          hits.push({ offset: i, context: text.slice(Math.max(0, i - 300), i + q.length + 500) });
          pos = i + q.length;
        }
        return send(res, 200, { ok: true, name: d.name, total: text.length, hits });
      }

      if (req.method === "GET" && dm[2] === "page") {
        if (d.kind !== "pdf") return send(res, 400, { ok: false, error: "not a pdf" });
        const n = parseInt(url.searchParams.get("n") || "1", 10) || 1;
        const jpg = path.join(d.dir, `.page-${n}.jpg`);
        const { out } = await runPy(RENDER, [d.file, String(n), jpg], 60000);
        let meta = null;
        try { meta = JSON.parse(out.trim().split("\n").pop()); } catch {}
        if (!meta || !meta.ok) return send(res, 422, { ok: false, error: (meta && meta.error) || "render failed" });
        const size = fs.statSync(jpg).size;
        res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": size, "X-Pages": String(meta.pages) });
        return fs.createReadStream(jpg).pipe(res);
      }
    }

    const m = url.pathname.match(/^\/files\/([a-f0-9]+)\/([^/]+)$/);
    if (req.method === "GET" && m) {
      const name = decodeURIComponent(m[2]);
      if (!lastRun || lastRun.id !== m[1] || name !== path.basename(name) || !lastRun.files.has(name)) {
        return send(res, 404, { ok: false, error: "not found" });
      }
      const full = path.join(lastRun.dir, name);
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return send(res, 404, { ok: false, error: "not found" });
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": fs.statSync(full).size });
      return fs.createReadStream(full).pipe(res);
    }

    return send(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : e instanceof SyntaxError ? 400 : 500;
    if (!res.headersSent) send(res, status, { ok: false, error: e.message });
    else res.end();
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`executor listening on ${PORT}`));
process.on("uncaughtException", (e) => console.error("uncaught", e));
process.on("unhandledRejection", (e) => console.error("unhandled", e));
