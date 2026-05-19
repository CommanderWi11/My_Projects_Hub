# My Projects Hub — Memory

## Status
- Created: 2026-05-19
- State: Local build complete, awaiting GitHub repo + Pages deploy

## Deployed URL
- Planned: https://commanderwi11.github.io/my-projects-hub/
- Repo: CommanderWi11/my-projects-hub (to be created)

## Access
- Password gate (client-side): `airnest2020`
- Stored in `script.js`; sessionStorage key `mph_unlocked`

## Conventions
- All project entries live in `projects.json`
- Schema: `{ hq: "personal" | "airnest" | "pilot", name: string, url: string }`
- HQ render order: Personal → Airnest → Pilot
- Adding a project = edit `projects.json`, commit, push. No HTML edits.

## Open loops
- Create GitHub repo and push
- Enable GitHub Pages on `main`
- Verify deployed URL renders, gate works, every link opens
