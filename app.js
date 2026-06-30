/* ============================================================
   Projects Hub — client logic (v3, authenticated)
   - light/dark theme toggle (localStorage, system default)
   - three contexts:
       LOCAL  (served by launcher on localhost)  → straight in, all actions
       REMOTE (served via Tailscale Funnel)       → login (user+pass+TOTP); sensitive hidden
       STATIC (GitHub Pages, no launcher)         → minimalist landing only
   - renders cards + action buttons from projects.json, streams output via SSE
   ============================================================ */

const THEME_KEY = "mph_theme";
const HQ_ORDER = ["personal", "airnest", "pilot"];
const HQ_LABEL = { personal: "Personal", airnest: "Airnest", pilot: "Pilot" };

const $ = (id) => document.getElementById(id);
const els = {
  gate: $("gate"), gateKicker: $("gate-kicker"), gateTitle: $("gate-title"), gateNote: $("gate-note"),
  loginForm: $("login-form"), lgUser: $("lg-user"), lgPass: $("lg-pass"), lgTotp: $("lg-totp"),
  gateAction: $("gate-action"), gateErr: $("gate-error"), resetLink: $("reset-link"),
  app: $("app"), groups: $("groups"), empty: $("empty"), count: $("count"), introSub: $("intro-sub"),
  search: $("search"), filters: $("filters"),
  status: $("launcher-status"), themeToggle: $("theme-toggle"), logoutBtn: $("logout-btn"),
  drawer: $("drawer"), drawerOut: $("drawer-out"), runCmd: $("run-cmd"),
  runState: $("run-state"), runStop: $("run-stop"), runClear: $("run-clear"),
  runLink: $("run-link"), drawerClose: $("drawer-close"),
  footHint: $("foot-hint"), toast: $("toast"),
};

let MODE = "static";      // "live" once launcher responds
let REMOTE = false;       // true when served via the Funnel
let HEALTH = null;        // last /api/health payload
let CSRF = null;          // CSRF token from login (remote)
let PROJECTS = [];
let FILTER_HQ = "all";
let FILTER_Q = "";
const RUNS = new Map();
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
//  Boot
// ════════════════════════════════════════════════════════════
init();

async function init() {
  const health = await probeLauncher();
  if (!health) { MODE = "static"; return showLanding(); }
  HEALTH = health;

  MODE = "live";
  REMOTE = !!health.remote;

  if (REMOTE && health.authConfigured && !health.authed) return showLogin(true);
  if (REMOTE && !health.authConfigured) return showLogin(false);

  // local, or remote already authed
  setStatus("live", REMOTE ? "Connected · remote" : "Launcher connected");
  els.footHint.textContent = REMOTE ? "Remote session" : ("Launcher live · " + (health.workspaceRoot || ""));
  els.logoutBtn.hidden = !REMOTE;
  await enterApp();
}

async function probeLauncher() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch("api/health", { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(t);
    const j = await res.json();
    return res.ok && j && j.ok ? j : null;
  } catch (e) { return null; }
}

function setStatus(cls, text) {
  els.status.className = "status " + cls;
  els.status.querySelector(".status-text").textContent = text;
}

// ════════════════════════════════════════════════════════════
//  Gate states
// ════════════════════════════════════════════════════════════
function showGate() { document.body.classList.add("locked"); els.gate.hidden = false; els.app.hidden = true; }

function showLanding() {
  setStatus("static", "Offline");
  els.footHint.textContent = "Start the launcher on your Mac to sign in";
  els.gateKicker.textContent = "Projects Hub";
  els.gateTitle.textContent = "Runs from my Mac";
  els.gateNote.textContent = "This is a one-click launcher for everything I'm building. It comes online when my Mac is awake and the launcher is running — sign in there to launch scripts and automations.";
  els.loginForm.hidden = true;
  // optional deep-link to the launcher if configured in projects.json
  loadLauncherUrl().then((url) => {
    if (url) { els.gateAction.hidden = false; els.gateAction.href = url; els.gateAction.textContent = "Open launcher ↗"; }
  });
  showGate();
}

function showLogin(configured) {
  setStatus("live", "Locked · remote");
  els.footHint.textContent = "Remote access";
  els.gateAction.hidden = true;
  if (configured) {
    els.gateKicker.textContent = "Restricted · Remote";
    els.gateTitle.textContent = "Sign in";
    els.gateNote.textContent = "Enter your credentials and the 6-digit code from your authenticator app.";
    els.loginForm.hidden = false;
    els.resetLink.hidden = !(HEALTH && HEALTH.emailConfigured);
    setTimeout(() => els.lgUser.focus(), 60);
  } else {
    els.gateKicker.textContent = "Setup required";
    els.gateTitle.textContent = "Not configured";
    els.gateNote.textContent = "Remote access isn't set up yet. On your Mac, run “node setup-auth.mjs” in the hub folder, then restart the launcher.";
    els.loginForm.hidden = true;
  }
  showGate();
}

els.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.gateErr.hidden = true;
  const btn = els.loginForm.querySelector("button");
  btn.disabled = true; btn.textContent = "Signing in…";
  try {
    const res = await fetch("api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: els.lgUser.value, password: els.lgPass.value, totp: els.lgTotp.value }),
    });
    const j = await res.json();
    if (!res.ok || !j.ok) throw new Error(j.error || "Sign in failed");
    CSRF = j.csrf || null;
    REMOTE = true;
    setStatus("live", "Connected · remote");
    els.footHint.textContent = "Remote session";
    els.logoutBtn.hidden = false;
    await enterApp();
  } catch (err) {
    els.gateErr.textContent = err.message || "Sign in failed";
    els.gateErr.hidden = false;
    els.lgTotp.value = "";
    els.lgPass.focus();
  } finally {
    btn.disabled = false; btn.textContent = "Sign in";
  }
});

els.logoutBtn.addEventListener("click", async () => {
  try { await fetch("api/logout", { method: "POST" }); } catch (e) {}
  location.reload();
});

els.resetLink.addEventListener("click", async () => {
  els.gateErr.hidden = true;
  els.resetLink.disabled = true;
  const orig = els.resetLink.textContent;
  els.resetLink.textContent = "Sending…";
  try {
    const res = await fetch("api/request-reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const j = await res.json();
    if (!res.ok || !j.ok) throw new Error(j.error || "Could not send link");
    els.resetLink.textContent = "✓ Link sent — check your email";
  } catch (e) {
    els.gateErr.textContent = e.message || "Could not send link";
    els.gateErr.hidden = false;
    els.resetLink.textContent = orig;
    els.resetLink.disabled = false;
  }
});

// ════════════════════════════════════════════════════════════
//  Enter app
// ════════════════════════════════════════════════════════════
async function enterApp() {
  document.body.classList.remove("locked");
  els.gate.hidden = true;
  els.app.hidden = false;
  els.introSub.textContent = REMOTE
    ? "Live index across every workstation. Sensitive actions (marked) are local-only."
    : "Live index across every workstation. The buttons run things on your Mac.";
  await loadProjects();
  render();
}

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

async function loadLauncherUrl() {
  try { const r = await fetch("projects.json", { cache: "no-store" }); const d = await r.json(); return d.launcherUrl || null; }
  catch (e) { return null; }
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
els.search.addEventListener("input", () => { FILTER_Q = els.search.value.trim().toLowerCase(); render(); });

function matches(p) {
  if (FILTER_HQ !== "all" && p.hq !== FILTER_HQ) return false;
  if (!FILTER_Q) return true;
  const hay = (p.name + " " + (p.desc || "") + " " + (p.actions || []).map((a) => a.label).join(" ")).toLowerCase();
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

  let n = 0;
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
    for (const p of list) grid.appendChild(card(p, n++));
    group.appendChild(grid);
    els.groups.appendChild(group);
  }

  const total = PROJECTS.length, shown = visible.length;
  els.count.textContent = shown === total ? total + " projects" : shown + " / " + total;
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
    '<div class="card-top"><h3 class="card-title">' + esc(p.name) + '</h3>' + open + '</div>' +
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
    const primary = actions.find((a) => a.primary);
    if (primary) {
      // One main button; everything else tucked behind a "more" toggle.
      wrap.appendChild(renderAction(p, primary, true));
      const others = actions.filter((a) => a !== primary);
      if (others.length) {
        const more = document.createElement("div");
        more.className = "more-actions";
        more.hidden = true;
        for (const a of others) more.appendChild(renderAction(p, a, false));
        const toggle = document.createElement("button");
        toggle.className = "more-toggle";
        toggle.type = "button";
        const label = (n) => "+ " + n + " more step" + (n === 1 ? "" : "s");
        toggle.textContent = label(others.length);
        toggle.addEventListener("click", () => {
          more.hidden = !more.hidden;
          toggle.textContent = more.hidden ? label(others.length) : "− hide steps";
        });
        wrap.appendChild(toggle);
        wrap.appendChild(more);
      }
    } else {
      for (const a of actions) wrap.appendChild(renderAction(p, a, false));
    }
    el.appendChild(wrap);
  }
  return el;
}

function blockedRemote(a) { return REMOTE && a.sensitive; }

function renderAction(p, a, isPrimary) {
  return a.kind === "launchd" ? jobControl(p, a) : actButton(p, a, isPrimary);
}

function infoIcon(text) {
  const s = document.createElement("span");
  s.className = "info";
  s.tabIndex = 0;
  s.setAttribute("role", "button");
  s.setAttribute("aria-label", text);
  s.textContent = "i";
  const tip = document.createElement("span");
  tip.className = "tip";
  tip.textContent = text;
  s.appendChild(tip);
  // clicking the icon must NOT run the action; toggle for touch screens
  s.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); s.classList.toggle("show"); });
  return s;
}

function actButton(p, a, isPrimary) {
  const b = document.createElement("button");
  b.className = "act" + (isPrimary ? " act-primary" : "") + (a.long ? " long" : "") + (a.sensitive ? " sensitive" : "");
  b.dataset.kind = a.kind;
  const lead = isPrimary
    ? '<span class="play" aria-hidden="true">▶</span><span class="spin"></span>'
    : '<span class="dot"></span><span class="spin"></span>';
  b.innerHTML = lead + '<span class="lbl">' + esc(a.label) + '</span>'
    + (a.sensitive ? '<span class="lock" aria-hidden="true">·</span>' : '');
  if (blockedRemote(a)) {
    b.disabled = true;
    b.title = "Local-only — run this on the Mac";
    b.classList.add("locked-action");
  } else {
    b.title = (a.long ? "Start (long-running): " : "Run: ") + a.label;
    b.addEventListener("click", () => onRun(p, a, b));
  }
  if (!a.info) return b;
  const wrap = document.createElement("span");
  wrap.className = "act-wrap" + (isPrimary ? " act-wrap-primary" : "");
  wrap.appendChild(b);
  wrap.appendChild(infoIcon(a.info));
  return wrap;
}

function jobControl(p, a) {
  const wrap = document.createElement("div");
  wrap.className = "job" + (a.sensitive ? " sensitive" : "");
  wrap.title = "launchd · " + (a.service || a.label);
  const label = document.createElement("span");
  label.className = "job-label";
  label.innerHTML = '<span class="dot"></span>' + esc(a.label);
  if (a.info) label.appendChild(infoIcon(a.info));
  wrap.appendChild(label);
  const ops = [["kickstart", "Run"], ["load", "On"], ["unload", "Off"]];
  for (const [op, lbl] of ops) {
    const btn = document.createElement("button");
    btn.className = "job-op";
    btn.textContent = lbl;
    if (blockedRemote(a)) {
      btn.disabled = true;
      btn.title = "Local-only — run on the Mac";
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
  if (btn.dataset.runId && RUNS.has(btn.dataset.runId)) { focusRun(btn.dataset.runId); return; }
  const label = (op ? op + " · " : "") + p.name + " — " + a.label;
  try {
    const res = await fetch("api/run", {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ projectId: p.id, actionId: a.id, op: op || undefined }),
    });
    const j = await res.json();
    if (!res.ok || !j.runId) throw new Error(j.error || "Launch failed");
    const run = { runId: j.runId, label, kind: a.kind, long: !!a.long, btn, buffer: [], state: "running", link: null, es: null };
    RUNS.set(j.runId, run);
    btn.dataset.runId = j.runId;
    if (btn.classList.contains("act")) btn.classList.add("running");
    focusRun(j.runId);
    streamRun(run);
  } catch (e) { toast(e.message || "Launch failed"); }
}

function csrfHeaders() {
  const h = { "Content-Type": "application/json" };
  if (CSRF) h["X-CSRF"] = CSRF;
  return h;
}

function streamRun(run) {
  const es = new EventSource("api/stream?runId=" + encodeURIComponent(run.runId));
  run.es = es;
  es.addEventListener("meta", (ev) => append(run, "meta", safeData(ev.data)));
  es.addEventListener("out", (ev) => append(run, "", safeData(ev.data)));
  es.addEventListener("err", (ev) => append(run, "err", safeData(ev.data)));
  es.addEventListener("exit", (ev) => {
    let code = 0; try { code = (JSON.parse(ev.data) || {}).code; } catch (e) {}
    finishRun(run, code); es.close();
  });
  es.onerror = () => { if (run.state === "running") finishRun(run, null); es.close(); };
}

function finishRun(run, code) {
  run.state = code === 0 ? "ok" : (code === null ? "ok" : "fail");
  if (run.btn) { run.btn.classList.remove("running"); delete run.btn.dataset.runId; }
  append(run, "meta", "— finished " + (code === null ? "(ended)" : "(exit " + code + ")"));
  if (ACTIVE_RUN === run.runId) paintRunState(run);
}

function append(run, cls, text) {
  if (text == null) return;
  run.buffer.push({ cls, text });
  if (run.buffer.length > 4000) run.buffer.splice(0, run.buffer.length - 4000);
  detectLink(run, text);
  if (ACTIVE_RUN === run.runId) { appendLine(cls, text); els.drawerOut.scrollTop = els.drawerOut.scrollHeight; }
}

function detectLink(run, text) {
  if (run.link) return;
  const m = String(text).match(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[^\s]*)?/);
  if (m) { run.link = m[0]; if (ACTIVE_RUN === run.runId) showLink(run.link); }
}

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

function paintRunState(run) { els.runState.className = "run-state " + run.state; els.runStop.hidden = run.state !== "running"; }
function appendLine(cls, text) { const s = document.createElement("span"); if (cls) s.className = cls; s.textContent = text; els.drawerOut.appendChild(s); }
function showLink(url) { els.runLink.hidden = false; els.runLink.href = url; els.runLink.textContent = "↗ " + url.replace(/^https?:\/\//, ""); }
function safeData(d) { try { return JSON.parse(d); } catch (e) { return d; } }

els.runStop.addEventListener("click", async () => {
  if (!ACTIVE_RUN) return;
  try { await fetch("api/stop", { method: "POST", headers: csrfHeaders(), body: JSON.stringify({ runId: ACTIVE_RUN }) }); toast("Stopping…"); }
  catch (e) { toast("Could not stop"); }
});
els.runClear.addEventListener("click", () => { const r = RUNS.get(ACTIVE_RUN); if (r) r.buffer = []; els.drawerOut.innerHTML = ""; });
els.drawerClose.addEventListener("click", () => { els.drawer.hidden = true; ACTIVE_RUN = null; });

// ════════════════════════════════════════════════════════════
//  Toast + helpers
// ════════════════════════════════════════════════════════════
let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg; els.toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
}
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function attr(s) { return esc(s).replace(/'/g, "&#39;"); }
