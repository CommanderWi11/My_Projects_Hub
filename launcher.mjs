#!/usr/bin/env node
/* ============================================================
   Projects Hub — local launcher
   Zero-dependency Node server. Serves the static hub AND runs the
   whitelisted actions from projects.json on this machine.

   Security:
     - binds to 127.0.0.1 only (never exposed on the network)
     - executes ONLY actions defined in projects.json (no arbitrary cmds)
     - rejects /api requests whose Origin isn't the localhost hub

   Run:  node launcher.mjs [--open] [--port 4317]
   ============================================================ */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, extname, basename, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(process.env.WORKSPACE_ROOT || join(__dirname, "..", "..", ".."));
const VERSION = "2.0";

const argv = process.argv.slice(2);
const OPEN = argv.includes("--open");
const portArg = argv[argv.indexOf("--port") + 1];
const BASE_PORT = Number(process.env.PORT || (argv.includes("--port") ? portArg : 4317)) || 4317;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ── manifest index ──────────────────────────────────────────
let INDEX = {}; // projectId -> { path, actions: {actionId -> action} }

async function loadManifest() {
  const raw = await readFile(join(__dirname, "projects.json"), "utf8");
  const data = JSON.parse(raw);
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
const runs = new Map(); // runId -> { proc, events:[], clients:Set, done, code }
const MAX_EVENTS = 5000;

function pushEvent(run, type, data) {
  const ev = { type, data };
  run.events.push(ev);
  if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
  for (const res of run.clients) writeSSE(res, ev);
}

function writeSSE(res, ev) {
  try {
    res.write("event: " + ev.type + "\n");
    res.write("data: " + JSON.stringify(ev.data) + "\n\n");
  } catch (e) { /* client gone */ }
}

// ── command resolution ──────────────────────────────────────
function venvPython(dirs) {
  const names = [".venv", ".venv.nosync", "venv", "env"];
  for (const d of dirs) {
    for (const n of names) {
      const p = join(d, n, "bin", "python");
      if (existsSync(p)) return p;
    }
  }
  return process.platform === "win32" ? "python" : "python3";
}

// Returns { cmd, args, cwd } or throws.
function buildCommand(project, action, op) {
  const projectDir = resolve(WORKSPACE_ROOT, project.path);
  if (!projectDir.startsWith(WORKSPACE_ROOT)) throw new Error("Path escapes workspace");
  const base = action.cwd ? resolve(projectDir, action.cwd) : projectDir;

  switch (action.kind) {
    case "npm":
      return { cmd: "npm", args: ["run", action.run], cwd: base };

    case "node": {
      const { cwd, file } = splitRun(base, action);
      return { cmd: process.execPath, args: [file], cwd };
    }

    case "python": {
      // "-m pytest" style has no file path
      if (action.run.trim().startsWith("-")) {
        const py = venvPython([base, projectDir]);
        return { cmd: py, args: action.run.split(/\s+/), cwd: base };
      }
      const { cwd, file } = splitRun(base, action);
      const py = venvPython([cwd, base, projectDir]);
      return { cmd: py, args: [file], cwd };
    }

    case "shell": {
      const { cwd, file } = splitRun(base, action);
      return { cmd: "bash", args: [file], cwd };
    }

    case "launchd": {
      const plist = resolve(base, action.run);
      const uid = typeof process.getuid === "function" ? process.getuid() : 0;
      const svc = action.service;
      if (op === "load")   return { cmd: "launchctl", args: ["load", "-w", plist], cwd: base };
      if (op === "unload") return { cmd: "launchctl", args: ["unload", "-w", plist], cwd: base };
      // default: kickstart (run now)
      return { cmd: "launchctl", args: ["kickstart", "-k", `gui/${uid}/${svc}`], cwd: base };
    }

    default:
      throw new Error("Unknown action kind: " + action.kind);
  }
}

// For file-based actions, run from the script's own directory.
function splitRun(base, action) {
  const run = action.run;
  if (action.cwd || !run.includes("/")) {
    return { cwd: base, file: run };
  }
  return { cwd: resolve(base, dirname(run)), file: basename(run) };
}

// ── start a run ─────────────────────────────────────────────
function startRun(project, action, op) {
  const built = buildCommand(project, action, op);
  if (!existsSync(built.cwd)) throw new Error("Working dir not found: " + built.cwd);

  const runId = randomUUID();
  const run = { proc: null, events: [], clients: new Set(), done: false, code: null };
  runs.set(runId, run);

  const shown = built.cmd === process.execPath ? "node" : built.cmd;
  pushEvent(run, "meta", "$ " + shown + " " + built.args.join(" "));
  pushEvent(run, "meta", "  cwd: " + built.cwd.replace(WORKSPACE_ROOT, "."));

  const proc = spawn(built.cmd, built.args, {
    cwd: built.cwd,
    env: process.env,
    detached: true, // own process group so we can kill children too
  });
  run.proc = proc;

  proc.stdout.on("data", (d) => pushEvent(run, "out", d.toString()));
  proc.stderr.on("data", (d) => pushEvent(run, "err", d.toString()));
  proc.on("error", (err) => pushEvent(run, "err", "spawn error: " + err.message));
  proc.on("close", (code) => {
    run.done = true;
    run.code = code;
    pushEvent(run, "exit", { code });
    for (const res of run.clients) { try { res.end(); } catch (e) {} }
    run.clients.clear();
    setTimeout(() => runs.delete(runId), 5 * 60 * 1000); // GC after 5 min
  });

  return runId;
}

function stopRun(runId) {
  const run = runs.get(runId);
  if (!run || !run.proc || run.done) return false;
  try {
    process.kill(-run.proc.pid, "SIGTERM"); // kill whole group
  } catch (e) {
    try { run.proc.kill("SIGTERM"); } catch (e2) {}
  }
  setTimeout(() => {
    if (!run.done) { try { process.kill(-run.proc.pid, "SIGKILL"); } catch (e) {} }
  }, 4000);
  return true;
}

// ── http helpers ────────────────────────────────────────────
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req) {
  return new Promise((res) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => { try { res(JSON.parse(data || "{}")); } catch (e) { res({}); } });
  });
}

function originOk(req, port) {
  const o = req.headers.origin;
  if (!o) return true; // same-origin GET / EventSource omit Origin
  return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
}

// ── server ──────────────────────────────────────────────────
function makeServer(port) {
  return createServer(async (req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${port}`);
    const path = u.pathname;

    // ---- API ----
    if (path.startsWith("/api/")) {
      if (!originOk(req, port)) return json(res, 403, { error: "bad origin" });

      if (path === "/api/health") {
        return json(res, 200, { ok: true, version: VERSION, workspaceRoot: WORKSPACE_ROOT });
      }

      if (path === "/api/run" && req.method === "POST") {
        const body = await readBody(req);
        const project = INDEX[body.projectId];
        if (!project) return json(res, 404, { error: "unknown project" });
        const action = project.actions[body.actionId];
        if (!action) return json(res, 404, { error: "unknown action" });
        try {
          const runId = startRun(project, action, body.op);
          return json(res, 202, { runId });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }

      if (path === "/api/stream" && req.method === "GET") {
        const run = runs.get(u.searchParams.get("runId"));
        if (!run) return json(res, 404, { error: "unknown run" });
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });
        for (const ev of run.events) writeSSE(res, ev); // replay buffer
        if (run.done) return res.end();
        run.clients.add(res);
        req.on("close", () => run.clients.delete(res));
        return;
      }

      if (path === "/api/stop" && req.method === "POST") {
        const body = await readBody(req);
        return json(res, 200, { ok: stopRun(body.runId) });
      }

      return json(res, 404, { error: "no such endpoint" });
    }

    // ---- static ----
    let rel = decodeURIComponent(path === "/" ? "/index.html" : path);
    const filePath = normalize(join(__dirname, rel));
    if (!filePath.startsWith(__dirname)) { res.writeHead(403); return res.end("forbidden"); }
    try {
      const s = await stat(filePath);
      if (s.isDirectory()) throw new Error("dir");
      const buf = await readFile(filePath);
      res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
      res.end(buf);
    } catch (e) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  });
}

// ── boot (with port fallback) ───────────────────────────────
async function listen(port, attempts = 8) {
  const server = makeServer(port);
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && attempts > 0) {
      listen(port + 1, attempts - 1);
    } else {
      console.error("Server error:", err.message);
      process.exit(1);
    }
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://localhost:${port}`;
    console.log("\n  Projects Hub launcher  ·  v" + VERSION);
    console.log("  ───────────────────────────────────");
    console.log("  Serving:   " + url);
    console.log("  Workspace: " + WORKSPACE_ROOT);
    console.log("  Projects:  " + Object.keys(INDEX).length);
    console.log("\n  Press Ctrl+C to stop.\n");
    if (OPEN) execFile("open", [url], () => {});
  });
}

await loadManifest();
await listen(BASE_PORT);

process.on("SIGINT", () => { console.log("\n  Shutting down…"); process.exit(0); });
