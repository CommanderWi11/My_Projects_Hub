# My Projects Hub — Memory

## Status
- Created 2026-05-19 · "Night Ledger" restyle 2026-05-23
- **v2** minimalist console + hybrid local launcher: 2026-06-30
- **v3** authenticated remote launching (Tailscale Funnel + TOTP): 2026-06-30
- State: built & locally verified. Remote pending two user actions (below).

## What it is
Index + one-click launcher for every project. Same code, three contexts:
- **Local** localhost:4317 — no login, all actions.
- **Remote** https://bobmac.tail6dba15.ts.net (Tailscale Funnel) — login + TOTP; sensitive blocked.
- **Public** https://commanderwi11.github.io/My_Projects_Hub/ — minimalist landing only.

## ⚠ Two user actions to finish remote access
1. **Enable Tailscale Funnel** (one-time, admin console):
   https://login.tailscale.com/f/funnel?node=nNLyPLWnM911CNTRL
   then: `/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --bg 4317`
2. **Set credentials**: in the hub folder run `node setup-auth.mjs`, scan the TOTP
   secret into an authenticator, then
   `launchctl kickstart -k gui/$(id -u)/com.commanderwi11.projects-hub`
Then open https://bobmac.tail6dba15.ts.net on any device → log in.

## Key facts
- This Mac on Tailscale = node **bobmac** (100.114.123.54), tailnet `tail6dba15.ts.net`.
- Auto-start LaunchAgent installed + loaded: `com.commanderwi11.projects-hub` (port 4317).
  Logs: `~/Library/Logs/projects-hub.log`.
- Secrets live OUTSIDE the repo at `~/.config/my-projects-hub/.env` (not iCloud-synced).
- GitHub push needs the **CommanderWi11** gh account (not airnest-homes):
  `gh auth switch -u CommanderWi11` then push, switch back if needed.
- `_config.yml` keeps projects.json / launcher / docs OFF the public GitHub Pages site.

## Auth & gating (verified at API level 2026-06-30)
- Local bypass ✓ · remote-unconfigured→503 ✓ · wrong creds→401 ✓ ·
  correct login (password+TOTP)→cookie+csrf ✓ · cross-site origin→403 ✓ ·
  remote non-sensitive run→202+stream ✓ · remote sensitive→403 local-only ✓ ·
  missing CSRF→403 ✓ · local sensitive→202 ✓.
- 31 actions flagged sensitive (briefings, portal logins/creates, Mews writes,
  BYD car UI dev/start, all launchd toggles). Full list approved by Luis in the plan.

## Open loops
- Finish the two user actions above to bring remote online.
- launchd Run/On/Off still not live-fired in test (avoid triggering real automations).
- Future expansions expected — see CLAUDE.md "Extending" (new action kinds, params,
  scheduling, run history, status indicators) before adding.
