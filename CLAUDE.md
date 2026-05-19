# My Projects Hub — Project Instructions

A single, password-gated webpage that lists every project Luis has with a deployed URL, grouped by HQ (Personal / Airnest / Pilot). Acts as a personal table of contents across all three workstations.

## Scope

- Maintain a clean, minimalist index of all live project URLs
- Add a new entry whenever a project ships a deployed URL
- Keep the gate simple (client-side password, sessionStorage)

## Startup

Read on entry:
1. This file
2. `MEMORY.md` — current status, deployed URL, password
3. `projects.json` — the canonical list of project links

## Working Style

- Adding a project = edit `projects.json` only (no HTML changes)
- Commit & push to `main`; GitHub Pages redeploys automatically
- Keep design minimalist — no cards, shadows, or decoration

## Rules

- Password gate is client-side only; never put truly sensitive URLs here
- Don't expose tokens, internal endpoints, or PII in `projects.json`
- Group by HQ in order: Personal → Airnest → Pilot
