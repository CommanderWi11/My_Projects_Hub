# My Projects Hub — Project Instructions

A personal index + **authenticated one-click launcher** for every project across all
three HQs. Three runtime contexts from the *same* code:

- **Local** (`http://localhost:4317`, served by the launcher on the Mac) — trusted,
  no login, every action runs (including sensitive ones).
- **Remote** (`https://bobmac.tail6dba15.ts.net`, via Tailscale Funnel) — requires
  login (username + password + TOTP); **sensitive actions are blocked** (local-only).
- **Public** (`https://commanderwi11.github.io/My_Projects_Hub/`) — minimalist landing
  only. The manifest and server files are NOT published (see `_config.yml`).

Built personal-only: Tailscale (personal tailnet), GitHub Pages (CommanderWi11), the
Mac. No Airnest infra.

## Files

| File | Role |
|---|---|
| `index.html` · `styles.css` · `app.js` | UI — minimalist light/dark, login form, cards, output drawer. |
| `projects.json` | **Source of truth** — projects + runnable actions (+ `sensitive` flags). Not public. |
| `launcher.mjs` | Zero-dependency Node server: serves the UI + runs whitelisted actions; auth, CSRF, lockout. |
| `setup-auth.mjs` | One-time: generates password hash + TOTP secret → `~/.config/my-projects-hub/.env`. |
| `setup-smtp.mjs` | One-time: stores GMX SMTP creds (for the emailed set-password link). |
| `set-password.html` | Page opened from the emailed reset link to set a new password. |
| `.env.example` | Reference for the secrets file (real secrets live outside the repo). |
| `com.commanderwi11.projects-hub.plist` | launchd auto-start (keeps the launcher running). |
| `Launch Hub.command` | Double-click to start the launcher locally. |
| `_config.yml` | Restricts GitHub Pages to the public landing only. |

## House style — minimalist console
Bricolage Grotesque (display) / Hanken Grotesk (body) / IBM Plex Mono (mono),
single green accent, hairline borders. Light + dark toggle (system default,
persisted in `localStorage` `mph_theme`).

## Manifest schema (`projects.json`)
Top level: `{ version, projects: [...] }`. Each project:
```jsonc
{ "hq":"personal|airnest|pilot", "id":"slug", "name":"…", "url":"https://…",
  "desc":"…", "path":"01_Personal_HQ/Projects/.../Dir",
  "actions":[ { "id":"sync","label":"Sync","kind":"npm","run":"sync",
               "long":false, "cwd":"sub", "service":"com.x.y", "sensitive":false } ] }
```
- `kind`: `npm`(`npm run <run>`) · `node`(`node <run>`) · `python`(venv python if present;
  `run` may be `-m pytest`) · `shell`(`bash <run>`) · `launchd`(`launchctl load/unload/kickstart`).
- `cwd` optional subdir; file actions otherwise run from the script's own dir.
- `long:true` long-running; `sensitive:true` → blocked over the Funnel (local-only).
- Adding a project/action = edit `projects.json` only. Unknown fields are ignored
  (forward-compatible).

## Auth model
- Secrets in `~/.config/my-projects-hub/.env` (outside iCloud): `HUB_USERNAME`,
  `HUB_PASSWORD_SALT`, `HUB_PASSWORD_HASH` (scrypt), `SESSION_SECRET`, `TOTP_SECRET`.
- Login = username + password + 6-digit TOTP → HMAC-signed httpOnly `mph_session`
  cookie (7d) + a CSRF token. Mutating remote calls require the `X-CSRF` header.
  5 failed logins → 15-min lockout. Mirrors `Flight_Portal` auth, extended with TOTP.
- Local requests bypass login (anyone reaching localhost is already on the Mac).
- If auth isn't configured, remote is refused (503); local still works.

## Operating
- Auto-start: `com.commanderwi11.projects-hub.plist` in `~/Library/LaunchAgents`.
  After `setup-auth.mjs`: `launchctl kickstart -k gui/$(id -u)/com.commanderwi11.projects-hub`.
- Funnel: `tailscale funnel --bg 4317` (Funnel must be enabled once in the admin console).
- Deploy public landing: push to `main` with the **CommanderWi11** credential.

## API (all under `/api`, same-origin enforced)
`GET /health` (public) · `POST /login` `{username,password,totp}` → cookie + `{csrf}` ·
`POST /logout` · `POST /run` `{projectId,actionId,op?}` (auth+CSRF; sensitive blocked remote) →
`{runId}` · `GET /stream?runId=` (SSE) · `POST /stop` `{runId}`.

**Password set/reset by email (GMX SMTP):** `POST /request-reset` (public, rate-limited) emails
`MAIL_TO` a tokenized link `set-password.html?token=…` (HMAC-signed, 20-min, single-use);
`POST /set-password` `{token,password}` writes a new scrypt hash to the env file + in-memory.
Configure the sender with `setup-smtp.mjs` (SMTP_HOST/PORT/USER/PASS, MAIL_FROM/TO). Email is
sent via a tiny built-in SMTP-over-TLS client (port 465) — still zero-dependency.

## Extending — built for future capabilities
Keep these extension points clean when adding features:
- **New action kind** → add a `case` in `buildCommand()` (launcher.mjs) and a dot color
  in `styles.css` (`--kind-*`). The client renders any kind generically.
- **New capability/endpoint** → add under `/api/*`; it inherits the auth + CSRF + remote
  gating already in the request handler. Put the auth check before the logic.
- **Action parameters / scheduling / run history / status indicators / notifications**
  are natural next steps — extend the manifest (unknown fields are ignored) and the
  drawer UI. Prefer manifest-driven config over hardcoding.
- Anything that can email, post externally, move money, or control the car/home must be
  flagged `sensitive:true` (and reviewed) before it can run remotely.

## Rules
- Never expose `projects.json` or secrets publicly (the `_config.yml` exclude guards this).
- Reference secrets via the env file only; never hardcode credentials/tokens.
- Render order: Personal → Airnest → Pilot.
- Never add an action that resolves outside the workspace root.
