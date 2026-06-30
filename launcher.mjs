#!/usr/bin/env node
/* ============================================================
   Projects Hub — local launcher (v3, authenticated)
   Zero-dependency Node server. Serves the static hub AND runs the
   whitelisted actions from projects.json on this machine.

   Access model:
     - LOCAL  (Host = localhost / 127.0.0.1): trusted, no login, all actions.
     - REMOTE (Host = anything else, e.g. Tailscale Funnel *.ts.net):
         * requires login (username + password + TOTP) -> HMAC session cookie
         * "sensitive" actions are blocked (local-only)
         * if auth isn't configured yet -> 503 (set up before exposing)

   Security:
     - binds to 127.0.0.1 only (Tailscale Funnel forwards here over TLS)
     - executes ONLY actions defined in projects.json (no arbitrary cmds)
     - same-origin check, CSRF header on mutating remote calls, login lockout
     - secrets read from ~/.config/my-projects-hub/.env (outside the iCloud repo)

   Run:  node launcher.mjs [--open] [--port 4317]
   ============================================================ */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, extname, basename, normalize } from "node:path";
import { randomUUID, createHmac, scryptSync, timingSafeEqual, randomBytes } from "node:crypto";
import tls from "node:tls";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(process.env.WORKSPACE_ROOT || join(__dirname, "..", "..", ".."));
const VERSION = "3.0";
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const LOCK_MAX = 5;          // failed logins before lockout
const LOCK_MS = 15 * 60 * 1000;

const argv = process.argv.slice(2);
const OPEN = argv.includes("--open");
const portArg = argv[argv.indexOf("--port") + 1];
const BASE_PORT = Number(process.env.PORT || (argv.includes("--port") ? portArg : 4317)) || 4317;

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};
// Only these files are ever served as static assets. Everything else (source,
// docs, setup scripts, plist, .env*) is never exposed — even locally — so the
// public Funnel can't fetch them. projects.json is handled separately (auth-gated).
const PUBLIC_STATIC = new Set(["/index.html", "/styles.css", "/app.js", "/set-password.html", "/favicon.ico"]);

// ── config / secrets (outside the iCloud repo) ──────────────
function loadConfig() {
  const file = process.env.HUB_ENV_FILE || join(os.homedir(), ".config", "my-projects-hub", ".env");
  const cfg = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i > 0) cfg[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  }
  for (const k of ["HUB_USERNAME", "HUB_PASSWORD_HASH", "HUB_PASSWORD_SALT", "SESSION_SECRET", "TOTP_SECRET"]) {
    if (process.env[k]) cfg[k] = process.env[k];
  }
  return { file, cfg };
}
const { file: ENV_FILE, cfg: CFG } = loadConfig();
const AUTH_ON = !!(CFG.HUB_USERNAME && CFG.HUB_PASSWORD_HASH && CFG.HUB_PASSWORD_SALT && CFG.SESSION_SECRET && CFG.TOTP_SECRET);

// Email (GMX SMTP) — used for the "set/reset password via link" flow.
const SMTP = {
  host: CFG.SMTP_HOST || "mail.gmx.com",
  port: CFG.SMTP_PORT || "465",
  user: CFG.SMTP_USER,
  pass: CFG.SMTP_PASS,
  from: CFG.MAIL_FROM || CFG.SMTP_USER,
  to: CFG.MAIL_TO || CFG.SMTP_USER || CFG.HUB_USERNAME,
};
const EMAIL_ON = !!(SMTP.host && SMTP.user && SMTP.pass && SMTP.to);

// ── crypto helpers ──────────────────────────────────────────
function safeEqStr(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
function hmac(data) { return createHmac("sha256", CFG.SESSION_SECRET || "").update(data).digest("hex"); }
function makeSession() { const exp = Date.now() + SESSION_TTL_MS; return exp + "." + hmac(String(exp)); }
function verifySession(val) {
  if (!val) return false;
  const i = val.lastIndexOf(".");
  if (i < 0) return false;
  const exp = val.slice(0, i), sig = val.slice(i + 1);
  if (!safeEqStr(sig, hmac(exp))) return false;
  return Number(exp) > Date.now();
}
function csrfFor(sessionVal) { return hmac("csrf:" + (sessionVal || "")); }
function verifyPassword(pw) {
  if (!pw) return false;
  try {
    const h = scryptSync(pw, Buffer.from(CFG.HUB_PASSWORD_SALT, "hex"), 64).toString("hex");
    return safeEqStr(h, CFG.HUB_PASSWORD_HASH);
  } catch { return false; }
}
// RFC 4648 base32 decode
function base32Decode(s) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  s = String(s).toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0, value = 0; const out = [];
  for (const c of s) {
    const idx = A.indexOf(c);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
// RFC 6238 TOTP (SHA1, 6 digits, 30s)
function totpAt(secretB32, tMs) {
  const counter = Math.floor(tMs / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secretB32)).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return (code % 1_000_000).toString().padStart(6, "0");
}
function totpVerify(secret, token) {
  token = String(token || "").trim();
  if (!/^\d{6}$/.test(token)) return false;
  const now = Date.now();
  for (const w of [-1, 0, 1]) if (safeEqStr(totpAt(secret, now + w * 30000), token)) return true;
  return false;
}

// ── password reset (emailed link) ───────────────────────────
const usedResetNonces = new Set();
function updateEnvFile(kv) {
  let lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split("\n") : [];
  for (const [k, v] of Object.entries(kv)) {
    let done = false;
    lines = lines.map((l) => (l.startsWith(k + "=") ? ((done = true), k + "=" + v) : l));
    if (!done) lines.push(k + "=" + v);
  }
  writeFileSync(ENV_FILE, lines.join("\n"), { mode: 0o600 });
}
function setNewPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pw, Buffer.from(salt, "hex"), 64).toString("hex");
  updateEnvFile({ HUB_PASSWORD_SALT: salt, HUB_PASSWORD_HASH: hash });
  CFG.HUB_PASSWORD_SALT = salt; CFG.HUB_PASSWORD_HASH = hash;
}
function makeResetToken() {
  const exp = Date.now() + 20 * 60 * 1000;
  const nonce = randomBytes(9).toString("base64url");
  return exp + "." + nonce + "." + createHmac("sha256", CFG.SESSION_SECRET).update("reset:" + exp + ":" + nonce).digest("hex");
}
function verifyResetToken(tok) {
  const p = String(tok || "").split(".");
  if (p.length !== 3) return false;
  const [exp, nonce, sig] = p;
  if (usedResetNonces.has(nonce)) return false;
  if (!safeEqStr(sig, createHmac("sha256", CFG.SESSION_SECRET).update("reset:" + exp + ":" + nonce).digest("hex"))) return false;
  if (Number(exp) < Date.now()) return false;
  return nonce;
}

// ── email via SMTP over TLS (implicit, port 465) ────────────
function mimeMessage({ from, to, subject, text, html }) {
  const b = "mph_" + randomBytes(8).toString("hex");
  return [
    "From: " + from, "To: " + to, "Subject: " + subject, "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="' + b + '"', "Date: " + new Date().toUTCString(), "",
    "--" + b, "Content-Type: text/plain; charset=utf-8", "", text, "",
    "--" + b, "Content-Type: text/html; charset=utf-8", "", html, "",
    "--" + b + "--", "",
  ].join("\r\n");
}
function sendMail({ subject, text, html }) {
  const steps = [
    { expect: 220 },
    { cmd: "EHLO localhost", expect: 250 },
    { cmd: "AUTH LOGIN", expect: 334 },
    { cmd: Buffer.from(SMTP.user).toString("base64"), expect: 334 },
    { cmd: Buffer.from(SMTP.pass).toString("base64"), expect: 235 },
    { cmd: "MAIL FROM:<" + SMTP.from + ">", expect: 250 },
    { cmd: "RCPT TO:<" + SMTP.to + ">", expect: 250 },
    { cmd: "DATA", expect: 354 },
    { cmd: mimeMessage({ from: SMTP.from, to: SMTP.to, subject, text, html }) + "\r\n.", expect: 250 },
    { cmd: "QUIT", expect: 221 },
  ];
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: SMTP.host, port: Number(SMTP.port), servername: SMTP.host });
    sock.setEncoding("utf8");
    let i = 0, buf = "";
    const fail = (m) => { try { sock.destroy(); } catch {} reject(new Error(m)); };
    sock.setTimeout(20000, () => fail("SMTP timeout"));
    sock.on("error", (e) => fail("SMTP socket: " + e.message));
    sock.on("data", (d) => {
      buf += d; let idx;
      while ((idx = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
        if (/^\d{3}-/.test(line)) continue; // multiline continuation
        const code = parseInt(line.slice(0, 3), 10);
        const step = steps[i];
        if (step.expect && code !== step.expect) return fail("SMTP step " + i + " expected " + step.expect + ", got: " + line);
        i++;
        if (i >= steps.length) { resolve(true); try { sock.end(); } catch {} return; }
        if (steps[i].cmd !== undefined) sock.write(steps[i].cmd + "\r\n");
      }
    });
  });
}

// ── login rate limiting ─────────────────────────────────────
const attempts = new Map(); // ip -> { n, until }
const resetAttempts = new Map(); // ip -> { n, until }
function clientIp(req) { return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?"; }
function rlAllowed(ip) { const a = attempts.get(ip); return !(a && a.until > Date.now()); }
function rlFail(ip) { const a = attempts.get(ip) || { n: 0, until: 0 }; a.n++; if (a.n >= LOCK_MAX) { a.until = Date.now() + LOCK_MS; a.n = 0; } attempts.set(ip, a); }
function rlReset(ip) { attempts.delete(ip); }

// ── request helpers ─────────────────────────────────────────
function hostOf(req) { return (req.headers.host || "").split(":")[0].toLowerCase(); }
function isLocalHost(h) { return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === ""; }
function isHttps(req, remote) { return remote || req.headers["x-forwarded-proto"] === "https"; }
function parseCookies(req) {
  const out = {}; const h = req.headers.cookie || "";
  for (const p of h.split(";")) { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
  return out;
}
function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { if (new URL(o).host.toLowerCase() === (req.headers.host || "").toLowerCase()) return true; } catch {}
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
}

// ── manifest index ──────────────────────────────────────────
let INDEX = {};
async function loadManifest() {
  const data = JSON.parse(await readFile(join(__dirname, "projects.json"), "utf8"));
  const idx = {};
  for (const p of data.projects || []) {
    if (!p.id) continue;
    const actions = {};
    for (const a of p.actions || []) actions[a.id] = a;
    idx[p.id] = { path: p.path || "", name: p.name, actions };
  }
  INDEX = idx;
}

// ── run registry ────────────────────────────────────────────
const runs = new Map();
const MAX_EVENTS = 5000;
function pushEvent(run, type, data) {
  const ev = { type, data };
  run.events.push(ev);
  if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
  for (const res of run.clients) writeSSE(res, ev);
}
function writeSSE(res, ev) {
  try { res.write("event: " + ev.type + "\n"); res.write("data: " + JSON.stringify(ev.data) + "\n\n"); } catch {}
}

// ── command resolution ──────────────────────────────────────
function venvPython(dirs) {
  const names = [".venv", ".venv.nosync", "venv", "env"];
  for (const d of dirs) for (const n of names) { const p = join(d, n, "bin", "python"); if (existsSync(p)) return p; }
  return process.platform === "win32" ? "python" : "python3";
}
function splitRun(base, action) {
  const run = action.run;
  if (action.cwd || !run.includes("/")) return { cwd: base, file: run };
  return { cwd: resolve(base, dirname(run)), file: basename(run) };
}
function buildCommand(project, action, op) {
  const projectDir = resolve(WORKSPACE_ROOT, project.path);
  if (!projectDir.startsWith(WORKSPACE_ROOT)) throw new Error("Path escapes workspace");
  const base = action.cwd ? resolve(projectDir, action.cwd) : projectDir;
  switch (action.kind) {
    case "npm": return { cmd: "npm", args: ["run", action.run], cwd: base };
    case "node": { const { cwd, file } = splitRun(base, action); return { cmd: process.execPath, args: [file], cwd }; }
    case "python": {
      if (action.run.trim().startsWith("-")) return { cmd: venvPython([base, projectDir]), args: action.run.split(/\s+/), cwd: base };
      const { cwd, file } = splitRun(base, action); return { cmd: venvPython([cwd, base, projectDir]), args: [file], cwd };
    }
    case "shell": { const { cwd, file } = splitRun(base, action); return { cmd: "bash", args: [file], cwd }; }
    case "launchd": {
      const plist = resolve(base, action.run);
      const uid = typeof process.getuid === "function" ? process.getuid() : 0;
      if (op === "load") return { cmd: "launchctl", args: ["load", "-w", plist], cwd: base };
      if (op === "unload") return { cmd: "launchctl", args: ["unload", "-w", plist], cwd: base };
      return { cmd: "launchctl", args: ["kickstart", "-k", `gui/${uid}/${action.service}`], cwd: base };
    }
    default: throw new Error("Unknown action kind: " + action.kind);
  }
}
function startRun(project, action, op) {
  const built = buildCommand(project, action, op);
  if (!existsSync(built.cwd)) throw new Error("Working dir not found: " + built.cwd);
  const runId = randomUUID();
  const run = { proc: null, events: [], clients: new Set(), done: false, code: null };
  runs.set(runId, run);
  const shown = built.cmd === process.execPath ? "node" : built.cmd;
  pushEvent(run, "meta", "$ " + shown + " " + built.args.join(" "));
  pushEvent(run, "meta", "  cwd: " + built.cwd.replace(WORKSPACE_ROOT, "."));
  const proc = spawn(built.cmd, built.args, { cwd: built.cwd, env: process.env, detached: true });
  run.proc = proc;
  proc.stdout.on("data", (d) => pushEvent(run, "out", d.toString()));
  proc.stderr.on("data", (d) => pushEvent(run, "err", d.toString()));
  proc.on("error", (err) => pushEvent(run, "err", "spawn error: " + err.message));
  proc.on("close", (code) => {
    run.done = true; run.code = code;
    pushEvent(run, "exit", { code });
    for (const res of run.clients) { try { res.end(); } catch {} }
    run.clients.clear();
    setTimeout(() => runs.delete(runId), 5 * 60 * 1000);
  });
  return runId;
}
function stopRun(runId) {
  const run = runs.get(runId);
  if (!run || !run.proc || run.done) return false;
  try { process.kill(-run.proc.pid, "SIGTERM"); } catch { try { run.proc.kill("SIGTERM"); } catch {} }
  setTimeout(() => { if (!run.done) { try { process.kill(-run.proc.pid, "SIGKILL"); } catch {} } }, 4000);
  return true;
}

// ── http helpers ────────────────────────────────────────────
function json(res, code, obj, extraHeaders) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", ...(extraHeaders || {}) });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((res) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => { try { res(JSON.parse(data || "{}")); } catch { res({}); } });
  });
}
function setSessionCookie(res, value, https) {
  const parts = [`mph_session=${value}`, "HttpOnly", "Path=/", "SameSite=Lax", `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (https) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "mph_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0");
}

// ── server ──────────────────────────────────────────────────
function makeServer(port) {
  return createServer(async (req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${port}`);
    const path = u.pathname;
    // A request is "remote" if it came through a proxy (Tailscale Funnel always
    // injects X-Forwarded-* headers) OR its Host isn't loopback. The Host header
    // alone is NOT trusted — the funnel forwards a client-spoofable Host, so a
    // genuine local request is one with NO forwarding headers and a loopback Host.
    const proxied = !!(req.headers["x-forwarded-for"] || req.headers["x-forwarded-proto"] || req.headers["x-forwarded-host"]);
    const remote = proxied || !isLocalHost(hostOf(req));
    const cookies = parseCookies(req);
    const authed = remote ? (AUTH_ON && verifySession(cookies.mph_session)) : true;

    // ---- API ----
    if (path.startsWith("/api/")) {
      if (!originOk(req)) return json(res, 403, { error: "bad origin" });

      // public: health
      if (path === "/api/health") {
        return json(res, 200, {
          ok: true, version: VERSION, remote, authConfigured: AUTH_ON, authed,
          emailConfigured: EMAIL_ON,
          workspaceRoot: remote ? undefined : WORKSPACE_ROOT,
        });
      }

      // public: login
      if (path === "/api/login" && req.method === "POST") {
        if (!AUTH_ON) return json(res, 400, { error: "auth not configured on the server" });
        const ip = clientIp(req);
        if (!rlAllowed(ip)) return json(res, 429, { error: "too many attempts — locked, try again later" });
        const b = await readBody(req);
        const ok = safeEqStr(b.username || "", CFG.HUB_USERNAME) && verifyPassword(b.password || "") && totpVerify(CFG.TOTP_SECRET, b.totp || "");
        if (!ok) { rlFail(ip); return json(res, 401, { error: "invalid credentials" }); }
        rlReset(ip);
        const sess = makeSession();
        setSessionCookie(res, sess, isHttps(req, remote));
        return json(res, 200, { ok: true, csrf: csrfFor(sess) });
      }
      if (path === "/api/logout" && req.method === "POST") { clearSessionCookie(res); return json(res, 200, { ok: true }); }

      // public: email me a set-password link
      if (path === "/api/request-reset" && req.method === "POST") {
        if (!AUTH_ON) return json(res, 400, { error: "auth not configured" });
        if (!EMAIL_ON) return json(res, 503, { error: "email not configured on the server" });
        const ip = clientIp(req);
        const ra = resetAttempts.get(ip) || { n: 0, until: 0 };
        if (ra.until > Date.now()) return json(res, 429, { error: "too many requests — try again later" });
        // Build the link from a TRUSTED base — never the spoofable Host header,
        // or an attacker could phish a valid reset token to their own domain.
        const base = CFG.PUBLIC_URL
          ? CFG.PUBLIC_URL.replace(/\/+$/, "")
          : (!proxied && isLocalHost(hostOf(req)) ? "http://" + req.headers.host : null);
        if (!base) return json(res, 500, { error: "PUBLIC_URL not set — cannot build a safe reset link" });
        const link = base + "/set-password.html?token=" + encodeURIComponent(makeResetToken());
        try {
          await sendMail({
            subject: "Set your Projects Hub password",
            text: "Open this link to set a new password (valid 20 minutes):\n\n" + link + "\n\nIf you didn't request this, ignore this email.",
            html: '<p>Open this link to set a new Projects Hub password (valid 20 minutes):</p>'
              + '<p><a href="' + link + '">Set my password</a></p>'
              + '<p style="color:#888;font-size:12px">If you didn\'t request this, you can ignore this email.</p>',
          });
        } catch (e) { return json(res, 500, { error: "could not send email: " + e.message }); }
        ra.n++; if (ra.n >= 3) ra.until = Date.now() + 10 * 60 * 1000;
        resetAttempts.set(ip, ra);
        return json(res, 200, { ok: true });
      }
      // public (token-gated): set a new password
      if (path === "/api/set-password" && req.method === "POST") {
        if (!AUTH_ON) return json(res, 400, { error: "auth not configured" });
        const b = await readBody(req);
        const nonce = verifyResetToken(b.token);
        if (!nonce) return json(res, 400, { error: "invalid or expired link" });
        if (!b.password || String(b.password).length < 8) return json(res, 400, { error: "password must be at least 8 characters" });
        setNewPassword(String(b.password));
        usedResetNonces.add(nonce);
        return json(res, 200, { ok: true });
      }

      // everything below requires auth (remote) or is open (local)
      if (remote && !AUTH_ON) return json(res, 503, { error: "auth not configured — set it up before remote use" });
      if (remote && !authed) return json(res, 401, { error: "login required" });

      // CSRF for mutating calls, remote only
      const csrfOk = !remote || safeEqStr(csrfFor(cookies.mph_session), req.headers["x-csrf"] || "");

      if (path === "/api/run" && req.method === "POST") {
        if (!csrfOk) return json(res, 403, { error: "bad csrf token" });
        const body = await readBody(req);
        const project = INDEX[body.projectId];
        if (!project) return json(res, 404, { error: "unknown project" });
        const action = project.actions[body.actionId];
        if (!action) return json(res, 404, { error: "unknown action" });
        if (remote && action.sensitive) return json(res, 403, { error: "This action is local-only" });
        try { return json(res, 202, { runId: startRun(project, action, body.op) }); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }

      if (path === "/api/stream" && req.method === "GET") {
        const run = runs.get(u.searchParams.get("runId"));
        if (!run) return json(res, 404, { error: "unknown run" });
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
        for (const ev of run.events) writeSSE(res, ev);
        if (run.done) return res.end();
        run.clients.add(res);
        req.on("close", () => run.clients.delete(res));
        return;
      }

      if (path === "/api/stop" && req.method === "POST") {
        if (!csrfOk) return json(res, 403, { error: "bad csrf token" });
        const body = await readBody(req);
        return json(res, 200, { ok: stopRun(body.runId) });
      }

      return json(res, 404, { error: "no such endpoint" });
    }

    // ---- static (allow-list only) ----
    let rel = decodeURIComponent(path === "/" ? "/index.html" : path);
    const filePath = normalize(join(__dirname, rel));
    if (!filePath.startsWith(__dirname)) { res.writeHead(403); return res.end("forbidden"); }
    if (rel === "/projects.json") {
      // project list: gated for unauthenticated remote visitors
      if (remote && !authed) { res.writeHead(401); return res.end("login required"); }
    } else if (!PUBLIC_STATIC.has(rel)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    try {
      const s = await stat(filePath);
      if (s.isDirectory()) throw new Error("dir");
      const buf = await readFile(filePath);
      res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
      res.end(buf);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  });
}

// ── boot ────────────────────────────────────────────────────
async function listen(port, attemptsLeft = 8) {
  const server = makeServer(port);
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && attemptsLeft > 0) listen(port + 1, attemptsLeft - 1);
    else { console.error("Server error:", err.message); process.exit(1); }
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://localhost:${port}`;
    console.log("\n  Projects Hub launcher  ·  v" + VERSION);
    console.log("  ───────────────────────────────────");
    console.log("  Serving:   " + url);
    console.log("  Workspace: " + WORKSPACE_ROOT);
    console.log("  Projects:  " + Object.keys(INDEX).length);
    console.log("  Auth:      " + (AUTH_ON ? "configured (remote login required)" : "NOT configured (local-only; run setup-auth.mjs to enable remote)"));
    console.log("  Secrets:   " + ENV_FILE);
    console.log("\n  Press Ctrl+C to stop.\n");
    if (OPEN) execFile("open", [url], () => {});
  });
}

await loadManifest();
await listen(BASE_PORT);
process.on("SIGINT", () => { console.log("\n  Shutting down…"); process.exit(0); });
