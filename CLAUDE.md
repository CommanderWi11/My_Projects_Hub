# My Projects Hub — Project Instructions

A password-gated webpage that indexes every project across all three HQs **and**
acts as a one-click launcher for their scripts and automations. Hybrid by design:

- Opened via the **local launcher** (`node launcher.mjs`, or double-click
  `Launch Hub.command`) → buttons actually run commands on this Mac.
- Deployed to **GitHub Pages** → same page, but executable buttons are disabled
  (with a hint) and only the "Open" links work.

## Files

| File | Role |
|---|---|
| `index.html` | Markup: topbar, gate, app shell, output drawer. |
| `styles.css` | Minimalist "console" theme — light + dark via `[data-theme]`, one green accent. |
| `app.js` | Gate, theme toggle, rendering, hybrid detection, run/stop/launchd, SSE streaming. |
| `projects.json` | **Source of truth** — every project + its runnable actions. |
| `launcher.mjs` | Zero-dependency Node server: serves the hub + runs whitelisted actions. |
| `Launch Hub.command` | Double-click to start the launcher and open the browser. |

## House Style — minimalist console (since 2026-06-30)

Replaced the old "Night Ledger" editorial look. Clean, neutral, lots of
whitespace, hairline borders, a single green accent (run / connected semantics).
Fonts: **Bricolage Grotesque** (display), **Hanken Grotesk** (body),
**IBM Plex Mono** (labels, commands, tags). Light + dark with a header toggle;
defaults to system preference, remembers choice in `localStorage` (`mph_theme`).

## Working Style — adding / changing projects

**Edit `projects.json` only.** No HTML/CSS per project. Schema:

```jsonc
{
  "hq": "personal | airnest | pilot",
  "id": "kebab-slug",            // stable; used by the launcher to whitelist
  "name": "Display Name",
  "url": "https://…",           // the "Open" button
  "desc": "one-line description",
  "path": "01_Personal_HQ/Projects/.../Dir",   // local path, relative to workspace root
  "actions": [
    { "id": "sync", "label": "Sync portals", "kind": "npm",    "run": "sync" },
    { "id": "x",    "label": "Run x",         "kind": "node",   "run": "scripts/x.mjs" },
    { "id": "y",    "label": "Run y",         "kind": "python", "run": "main.py", "cwd": "engine" },
    { "id": "z",    "label": "Do z",          "kind": "shell",  "run": "scripts/z.sh", "long": true },
    { "id": "job",  "label": "Nightly",       "kind": "launchd","run": "x.plist", "service": "com.foo.x" }
  ]
}
```

- `kind`: `npm` (→ `npm run <run>`), `node` (→ `node <run>`), `python`
  (→ venv python if found, else `python3`; `run` may be `-m pytest`),
  `shell` (→ `bash <run>`), `launchd` (→ `launchctl load/unload/kickstart`).
- `cwd` (optional): subdir under `path`. For file actions without `cwd`, the
  command runs from the script's own directory.
- `long: true`: long-running (dev servers, dashboards) — button stays active;
  Stop in the drawer kills the process group. The drawer auto-detects a
  printed `localhost:PORT` and shows a clickable link.
- Projects with no local actions just show the "Open" link.

## Launcher (`launcher.mjs`)

- Resolves the workspace root as three levels up from this folder (override with
  `WORKSPACE_ROOT`). Default port `4317` (override with `--port` / `PORT`).
- **Security:** binds to `127.0.0.1` only; executes **only** actions defined in
  `projects.json` (never arbitrary commands); rejects `/api` requests whose
  `Origin` isn't the localhost hub.
- API: `GET /api/health`, `POST /api/run {projectId,actionId,op?}` → `{runId}`,
  `GET /api/stream?runId=` (SSE), `POST /api/stop {runId}`.

## Deploy

- Commit & push to `main`; GitHub Pages redeploys (static index, buttons
  disabled). The launcher is **local only** — never deployed, never network-exposed.

## Rules

- Password gate is client-side only; don't put truly sensitive URLs here.
- Don't expose tokens, internal endpoints, or PII in `projects.json`.
- Group/render order: Personal → Airnest → Pilot.
- Never add an action that points outside the workspace root.
