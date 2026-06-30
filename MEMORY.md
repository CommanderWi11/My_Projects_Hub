# My Projects Hub — Memory

## Status
- Created: 2026-05-19
- "Night Ledger" restyle: 2026-05-23
- **v2 rebuild (minimalist console + hybrid launcher): 2026-06-30**
- State: built & verified locally; ready to commit/deploy

## What it is
Password-gated index of every project across Personal/Airnest/Pilot HQs, AND a
one-click launcher for their scripts/automations. Hybrid:
- Local launcher running → buttons execute real commands, output streams in a drawer.
- GitHub Pages (no launcher) → executable buttons disabled + hint; "Open" links work.

## Run it locally
- Double-click **`Launch Hub.command`**, or `node launcher.mjs --open`.
- Serves at `http://localhost:4317`. Status pill shows "Launcher connected".

## Deployed URL
- Live: https://commanderwi11.github.io/My_Projects_Hub/ (static, buttons disabled)
- Repo: https://github.com/CommanderWi11/My_Projects_Hub

## Access
- Password gate (client-side): `airnest2020` — in `app.js`, sessionStorage key `mph_unlocked`.

## Conventions
- All projects + actions live in `projects.json` (see CLAUDE.md for schema).
- Adding a project / action = edit `projects.json` only, commit, push.
- Theme: light/dark toggle, system default, persisted in `localStorage` (`mph_theme`).
- Fonts: Bricolage Grotesque / Hanken Grotesk / IBM Plex Mono. One green accent.

## Action coverage (20 projects)
- Richest: BSA Options (23), Flight Bag (5 scripts + 4 launchd), eCrew (8), BYD (7),
  Crew Briefing (4), Flight Portal (5), Whoop (4), Guesty–Mews (5), AI Supastack (4).
- Web-only (Open link only): Family Plan, Family Trip Japan, Airnest Shared,
  Mews API Connector, Airnest Ops Brain, Conduit, My Projects Hub.

## Launcher safety
- 127.0.0.1-bound; whitelist-only (actions from projects.json); Origin-checked.
- `python` actions auto-use a project venv (`.venv` / `.venv.nosync` / `venv`) if present.
- Long-running actions: Stop kills the whole process group (verified — no orphans).

## Verified 2026-06-30
- health / static / origin-403 / unknown-404 / traversal-404 ✅
- run + live stdout/stderr + exit code ✅ (jest 10 passed, exit 0)
- next dev start + localhost-link detect + Stop (port freed) ✅
- full browser flow: click action → drawer streams → exit 0 ✅
- light + dark themes verified visually ✅

## Open loops
- `launchd` Run/On/Off buttons are wired but not live-fired in test (to avoid
  triggering real automations). Verify once when convenient.
- Not yet committed/pushed (awaiting Luis's go-ahead).
