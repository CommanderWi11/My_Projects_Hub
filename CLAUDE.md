# My Projects Hub — Project Instructions

A single, password-gated webpage that lists every project Luis has with a deployed URL, grouped by HQ (Personal / Airnest / Pilot). Acts as a personal table of contents across all three workstations.

## Scope

- Maintain a clean index of all live project URLs
- Add a new entry whenever a project ships a deployed URL
- Keep the gate simple (client-side password, sessionStorage)

## Startup

Read on entry:
1. This file
2. `MEMORY.md` — current status, deployed URL, password
3. `projects.json` — the canonical list of project links

## House Style — "Night Ledger" (since 2026-05-23)

Matches the Shared·Airnest portal aesthetic: dark warm-near-black background,
parchment text, ember accent, Instrument Serif display / Hanken Grotesk body /
IBM Plex Mono labels, paper-grain + vignette atmosphere.

- Markup lives in `index.html`; styling in `styles.css`; row rendering in
  `script.js`. The visual language is one-to-one with
  `02_Airnest_HQ/Projects/Shared_Airnest/index.html` — when in doubt, mirror
  its tokens / spacing.
- Each HQ is a `band` (`hq-personal`, `hq-airnest`, `hq-pilot`). Personal is
  highlighted ember; the others use paper / faint marks.
- Project rows reuse the ledger row pattern: ember chip + serif title + mono
  URL + host tag + arrow.

## Working Style

- **Adding a project = edit `projects.json` only.** No HTML or CSS changes per
  project. `script.js` does all the row rendering from JSON.
- Commit & push to `main`; GitHub Pages redeploys automatically.
- Style changes go in `styles.css`; never inline per-row styles.

## Rules

- Password gate is client-side only; never put truly sensitive URLs here
- Don't expose tokens, internal endpoints, or PII in `projects.json`
- Group by HQ in order: Personal → Airnest → Pilot
