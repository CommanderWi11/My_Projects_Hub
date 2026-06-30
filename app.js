/* ============================================================
   Projects Hub — client logic
   - password gate (sessionStorage)
   - light/dark theme toggle (localStorage, system default)
   - renders cards + action buttons from projects.json
   - hybrid: live execution via local launcher API, or static fallback
   ============================================================ */

const PASSWORD = "airnest2020";
const UNLOCK_KEY = "mph_unlocked";
const THEME_KEY = "mph_theme";

const HQ_ORDER = ["personal", "airnest", "pilot"];
const HQ_LABEL = { personal: "Personal", airnest: "Airnest", pilot: "Pilot" };

// ── element refs ──
const $ = (id) => document.getElementById(id);
const els = {
  gate: $("gate"), gateForm: $("gate-form"), pw: $("pw"), gateErr: $("gate-error"),
  app: $("app"), groups: $("groups"), empty: $("empty"), count: $("count"),
  search: $("search"), filters: $("filters"),
  status: $("launcher-status"), themeToggle: $("theme-toggle"),
  drawer: $("drawer"), drawerOut: $("drawer-out"), runCmd: $("run-cmd"),
  runState: $("run-state"), runStop: $("run-stop"), runClear: $("run-clear"),
  runLink: $("run-link"), drawerClose: $("drawer-close"),
  footHint: $("foot-hint"), toast: $("toast"),
};

// ── state ──
let MODE = "static";          // "live" once launcher responds
let PROJECTS = [];
let FILTER_HQ = "all";
let FILTER_Q = "";
const RUNS = new Map();        // runId -> run record
let ACTIVE_RUN = null;

// ════════════════════════════════════════════════════════════
//  Theme
// ════════════════════════════════════════════════════════════
els.themeToggle.addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
});

// ════════════════════════════════════════════════════════════
//  Gate
// ════════════════════════════════════════════════════════════
if (sessionStorage.getItem(UNLOCK_KEY) === "1") {
  unlock();
} else {
  els.gate.hidden = false;
  document.body.classList.add("locked");
}

els.gateForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (els.pw.value === PASSWORD) {
    try { sessionStorage.setItem(UNLOCK_KEY, "1"); } catch (e) {}
    unlock();
  } else {
    els.gateErr.hidden = false;
    els.pw.value = "";
    els.pw.focus();
  }
});

async function unlock() {
  document.body.classList.remove("locked");
  els.gate.hidden = true;
  els.app.hidden = false;
  await Promise.all([loadProjects(), probeLauncher()]);
  render();
}

// ════════════════════════════════════════════════════════════
//  Launcher detection
// ════════════════════════════════════════════════════════════
async function probeLauncher() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch("api/health", { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(t);
    const j = await res.json();
    if (res.ok && j && j.ok) {
      MODE = "live";
      setStatus("live", "Launcher connected");
      els.footHint.textContent = "Launcher live · " + (j.workspaceRoot || "");
      return;
    }
  } catch (e) { /* not running */ }
  MODE = "static";
  setStatus("static", "Static mode");
  els.footHint.textContent = "Run “Launch Hub.command” to enable buttons";
}

function setStatus(cls, text) {
  els.status.className = "status " + cls;
  els.status.querySelector(".status-text").textContent = text;
  els.status.title = cls === "live"
    ? "Local launcher is running — buttons execute"
    : "Open via the local launcher to run scripts";
}

// ════════════════════════════════════════════════════════════
//  Data
// ════════════════════════════════════════════════════════════
async function loadProjects() {
  try {
    const res = await fetch("projects.json", { cache: "no-store" });
    const data = await res.json();
    PROJECTS = data.projects || [];
  } catch (e) {
    PROJECTS = [];
    els.groups.innerHTML = '<p class="empty">Could not load projects.json.</p>';
  }
}

// ════════════════════════════════════════════════════════════
//  Filters
// ════════════════════════════════════════════════════════════
els.filters.addEventListener("click", (e) => {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  els.filters.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
  btn.classList.add("active");
  FILTER_HQ = btn.dataset.hq;
  render();
});
els.search.addEventListener("input", () => {
  FILTER_Q = els.search.value.trim().toLowerCase();
  render();
});

function matches(p) {
  if (FILTER_HQ !== "all" && p.hq !== FILTER_HQ) return false;
  if (!FILTER_Q) return true;
  const hay = (p.name + " " + (p.desc || "") + " " + (p.actions || []).map(a => a.label).join(" ")).toLowerCase();
  return hay.includes(FILTER_Q);
}

// ════════════════════════════════════════════════════════════
//  Render
// ════════════════════════════════════════════════════════════
function render() {
  const visible = PROJECTS.filter(matches);
  els.groups.innerHTML = "";
  els.empty.hidden = visible.length > 0;

  const byHq = {};
  for (const p of visible) (byHq[p.hq] ||= []).push(p);

  let cardN = 0;
  for (const hq of HQ_ORDER) {
    const list = byHq[hq];
    if (!list || !list.length) continue;

    const group = document.createElement("section");
    group.className = "group";
    group.innerHTML =
      '<div class="group-head">' +
        '<span class="group-name">' + HQ_LABEL[hq] + '</span>' +
        '<span class="group-rule"></span>' +
        '<span class="group-count">' + list.length + (list.length === 1 ? " project" : " projects") + '</span>' +
      '</div>';

    const grid = document.createElement("div");
    grid.className = "grid";
    for (const p of list) {
      grid.appendChild(card(p, cardN++));
    }
    group.appendChild(grid);
    els.groups.appendChild(group);
  }

  const total = PROJECTS.length;
  const shown = visible.length;
  els.count.textContent = shown === total
    ? total + " projects"
    : shown + " / " + total;
}

function card(p, n) {
  const el = document.createElement("article");
  el.className = "card";
  el.style.animationDelay = Math.min(n * 0.035, 0.5) + "s";

  const open = p.url
    ? '<a class="card-open" href="' + attr(p.url) + '" target="_blank" rel="noopener noreferrer">' +
        'Open <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8"/></svg></a>'
    : "";

  el.innerHTML =
    '<div class="card-top">' +
      '<h3 class="card-title">' + esc(p.name) + '</h3>' + open +
    '</div>' +
    '<p class="card-desc">' + esc(p.desc || "") + '</p>';

  const actions = p.actions || [];
  if (!actions.length) {
    const e = document.createElement("p");
    e.className = "actions-empty";
    e.textContent = "Web only — open above";
    el.appendChild(e);
  } else {
    const wrap = document.createElement("div");
    wrap.className = "actions";
    for (const a of actions) {
      wrap.appendChild(a.kind === "launchd" ? jobControl(p, a) : actButton(p, a));
    }
    el.appendChild(wrap);
  }
  return el;
}

function actButton(p, a) {
  const b = document.createElement("button");
  b.className = "act" + (a.long ? " long" : "");
  b.dataset.kind = a.kind;
  b.dataset.project = p.id;
  b.dataset.action = a.id;
  b.innerHTML = '<span class="dot"></span><span class="spin"></span><span class="lbl">' + esc(a.label) + '</span>';
  if (MODE !== "live") {
    b.disabled = true;
    b.title = "Start the local launcher to run this";
  } else {
    b.title = (a.long ? "Start (long-running): " : "Run: ") + a.label;
    b.addEventListener("click", () => onRun(p, a, b));
  }
  return b;
}

function jobControl(p, a) {
  const wrap = document.createElement("div");
  wrap.className = "job";
  wrap.title = "launchd · " + (a.service || a.label);
  wrap.innerHTML = '<span class="job-label"><span class="dot"></span>' + esc(a.label) + '</span>';
  const ops = [
    ["kickstart", "Run"],
    ["load", "On"],
    ["unload", "Off"],
  ];
  for (const [op, lbl] of ops) {
    const btn = document.createElement("button");
    btn.className = "job-op";
    btn.textContent = lbl;
    if (MODE !== "live") {
      btn.disabled = true;
      btn.title = "Start the local launcher";
    } else {
      btn.title = lbl + " · " + (a.service || a.label);
      btn.addEventListener("click", () => onRun(p, a, btn, op));
    }
    wrap.appendChild(btn);
  }
  return wrap;
}

// ════════════════════════════════════════════════════════════
//  Run / stream
// ════════════════════════════════════════════════════════════
async function onRun(p, a, btn, op) {
  // re-focus an already-running long task instead of starting twice
  if (btn.dataset.runId && RUNS.has(btn.dataset.runId)) {
    focusRun(btn.dataset.runId);
    return;
  }
  const label = (op ? op + " · " : "") + p.name + " — " + a.label;
  try {
    const res = await fetch("api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: p.id, actionId: a.id, op: op || undefined }),
    });
    const j = await res.json();
    if (!res.ok || !j.runId) throw new Error(j.error || "Launch failed");

    const run = {
      runId: j.runId, label, kind: a.kind, long: !!a.long,
      btn, buffer: [], state: "running", link: null, es: null,
    };
    RUNS.set(j.runId, run);
    btn.dataset.runId = j.runId;
    if (btn.classList.contains("act")) btn.classList.add("running");
    focusRun(j.runId);
    streamRun(run);
  } catch (e) {
    toast(e.message || "Launch failed");
  }
}

function streamRun(run) {
  const es = new EventSource("api/stream?runId=" + encodeURIComponent(run.runId));
  run.es = es;
  es.addEventListener("meta", (ev) => append(run, "meta", safeData(ev.data)));
  es.addEventListener("out", (ev) => append(run, "", safeData(ev.data)));
  es.addEventListener("err", (ev) => append(run, "err", safeData(ev.data)));
  es.addEventListener("exit", (ev) => {
    let code = 0;
    try { code = (JSON.parse(ev.data) || {}).code; } catch (e) {}
    finishRun(run, code);
    es.close();
  });
  es.onerror = () => {
    // stream dropped; if still marked running, treat as ended
    if (run.state === "running") finishRun(run, null);
    es.close();
  };
}

function finishRun(run, code) {
  run.state = code === 0 ? "ok" : (code === null ? "ok" : "fail");
  if (run.btn) {
    run.btn.classList.remove("running");
    delete run.btn.dataset.runId;
  }
  const tag = code === null ? "(ended)" : "(exit " + code + ")";
  append(run, "meta", "— finished " + tag);
  if (ACTIVE_RUN === run.runId) paintRunState(run);
}

function append(run, cls, text) {
  if (text == null) return;
  run.buffer.push({ cls, text });
  if (run.buffer.length > 4000) run.buffer.splice(0, run.buffer.length - 4000);
  detectLink(run, text);
  if (ACTIVE_RUN === run.runId) {
    appendLine(cls, text);
    els.drawerOut.scrollTop = els.drawerOut.scrollHeight;
  }
}

function detectLink(run, text) {
  if (run.link) return;
  const m = String(text).match(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[^\s]*)?/);
  if (m) {
    run.link = m[0];
    if (ACTIVE_RUN === run.runId) showLink(run.link);
  }
}

// ── drawer painting ──
function focusRun(runId) {
  const run = RUNS.get(runId);
  if (!run) return;
  ACTIVE_RUN = runId;
  els.drawer.hidden = false;
  els.runCmd.textContent = run.label;
  els.drawerOut.innerHTML = "";
  for (const line of run.buffer) appendLine(line.cls, line.text);
  els.drawerOut.scrollTop = els.drawerOut.scrollHeight;
  paintRunState(run);
  if (run.link) showLink(run.link); else els.runLink.hidden = true;
}

function paintRunState(run) {
  els.runState.className = "run-state " + run.state;
  els.runStop.hidden = run.state !== "running";
}

function appendLine(cls, text) {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text;
  els.drawerOut.appendChild(span);
}

function showLink(url) {
  els.runLink.hidden = false;
  els.runLink.href = url;
  els.runLink.textContent = "↗ " + url.replace(/^https?:\/\//, "");
}

function safeData(d) {
  try { return JSON.parse(d); } catch (e) { return d; }
}

// ── drawer controls ──
els.runStop.addEventListener("click", async () => {
  if (!ACTIVE_RUN) return;
  try {
    await fetch("api/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: ACTIVE_RUN }),
    });
    toast("Stopping…");
  } catch (e) { toast("Could not stop"); }
});
els.runClear.addEventListener("click", () => {
  const run = RUNS.get(ACTIVE_RUN);
  if (run) run.buffer = [];
  els.drawerOut.innerHTML = "";
});
els.drawerClose.addEventListener("click", () => { els.drawer.hidden = true; ACTIVE_RUN = null; });

// ════════════════════════════════════════════════════════════
//  Toast
// ════════════════════════════════════════════════════════════
let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
}

// ════════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════════
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function attr(s) { return esc(s).replace(/'/g, "&#39;"); }
