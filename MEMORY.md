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

## Remote access — LIVE (2026-06-30)
- ✅ Tailscale Funnel running: https://bobmac.tail6dba15.ts.net → 127.0.0.1:4317
  (persists across reboot; `tailscale funnel --https=443 off` to disable).
- ✅ Auth configured. Username = **luisnavm@gmx.com**. TOTP = the ORIGINAL secret
  (restored after a rotation; matches the authenticator Luis already has).
- ✅ End-to-end verified over the public URL: login (pwd+TOTP) → run → stream → exit;
  sensitive action correctly blocked 403 remote.
- Secrets in ~/.config/my-projects-hub/.env. NOT in git/chat.

## Password by email (set/reset link) — GMX SMTP
- Feature built: login page has "Email me a set-password link" → emails a 20-min,
  single-use link (set-password.html?token=…) from luisnavm@gmx.com to itself.
- ⚠ LAST STEP to enable it: get a GMX app-password, then run `node setup-smtp.mjs`
  (enter it privately) → `launchctl kickstart -k gui/$(id -u)/com.commanderwi11.projects-hub`.
- Sender = personal luisnavm@gmx.com only (no Airnest/professional addresses).
- Current password is whatever was last set; use the email link to set a known one.

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
