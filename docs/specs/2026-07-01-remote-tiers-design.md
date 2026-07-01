# My Projects Hub — Safe Remote Execution of All Actions

**Date:** 2026-07-01
**Status:** Approved design — pending spec review, then implementation plan
**Author:** Luis (CommanderWi11) + Claude

## Goal

Make it safe to trigger **every** project action remotely — including the
high-consequence ones currently blocked (`sensitive:true`): publishing public
listings, sending the CEO briefing, driving Binter/eCrew, launchd scheduling —
**except** BYD Control (the car app), which stays off the network entirely.

Today the perimeter (password + TOTP + HMAC session + lockout + CSRF + CSP +
funnel) is solid, but it's binary: sensitive actions are simply refused
remotely. This design raises the bar with **defense in depth** so the dangerous
actions can run remotely without the perimeter being a single point of failure.

## Decisions (locked)

1. **Friction model:** Two-tier + per-action step-up. Harmless actions stay
   one-tap; sensitive actions require step-up at run time.
2. **Network gating:** Sensitive actions are **tailnet-only** (not on the public
   Funnel).
3. **Step-up mechanism:** **WebAuthn passkey** (Touch ID / Face ID), per action,
   single-use, action-bound.
4. **BYD Control:** kept **Local-only** (localhost only) — the whole app, not
   just the dashboard action. Relaxable later via one manifest edit.

## Tier model

Replaces the binary `sensitive` flag with three tiers.

| Tier | Reachable from | Gate | Contents |
|---|---|---|---|
| **open** | public Funnel (`:4317`) + localhost | login | builds, tests, lint, dev servers, dry-runs, search |
| **guarded** | tailnet `serve` (`:4318`) + localhost | login **+ WebAuthn step-up per action** | all current `sensitive:true` except BYD, plus 3 reclassified drifts |
| **local** | localhost only | none (trusted machine) | BYD Control (entire app) |

`open` is the default (unflagged). The internet-facing Funnel never exposes the
`guarded` or `local` surfaces.

### Guarded tier (tailnet + WebAuthn) — explicit list

- **AI Supastack** — Weekly capture (launchd); **Publish stack to website**
  *(reclassified from open — it's an external publish)*
- **BSA Options** — Sync inbox, Sync sale data, Sign in to Idealista/Fotocasa,
  Publish on Idealista/Fotocasa, all `larga:*` sync/triage/login/publish; **plus
  `init`, `backup`, `migrate:sale-tracker`, `migrate:approve-send`**
  *(reclassified — destructive/state-changing DB ops)*
- **Weekly Ops Briefing** — Generate CEO briefing draft; Check approval & send
- **Guesty–Mews Migration** — Create a test reservation
- **Crew Briefing** — Run full pre-flight brief; Run scheduled briefing; Run
  pipeline (raw)
- **Flight Bag** — Send schedule digest; Download from Binter portal; Promote
  latest revision; all launchd digest/download/capture schedules
- **eCrew MCP** — Download roster; Pre-warm login (shell); Start MCP (shell);
  **Run/Start MCP server (npm dev + start)** *(reclassified — same credentialed
  service as the shell variant that was already sensitive)*; Pre-warm launchd

### Local-only tier — explicit list

- **BYD Control** — every action (Start dashboard dev/prod, build, build:cli,
  lint, test, test:watch). Off the network entirely.

### Open tier

Everything not listed above (~40 actions): all remaining builds, tests, lints,
dev servers, dry-runs, `search.py`, Guesty–Mews read-only probes, Parte tests,
Crew scheduler, Flight Bag local capture/highlights, eCrew build/test/dev.

> Borderline to confirm during implementation: `Flight Bag · Capture Binter
> inbox` — stays **open** only if it reads a local capture and touches no Binter
> credentials; otherwise → guarded.

## Enforcement: two ports, not trusted headers

The prior auth-bypass bug came from trusting a spoofable `Host` header. This
design does **not** repeat that — reachability is enforced by the OS/Tailscale,
not by parsing client-supplied headers.

The launcher runs one handler bound to **two listeners**:

- **`:4317`** — exposed via `tailscale funnel` (public internet). Handler treats
  requests here as the **open** surface and **refuses** guarded/local actions
  (403 local-only), exactly like today.
- **`:4318`** — exposed via `tailscale serve` (**tailnet-only**, never funnel'd).
  Handler treats requests here as the **guarded** surface and permits guarded
  actions *after* WebAuthn step-up.

The tier of a request is decided by **`req.socket.localPort`** — the actual TCP
port the connection arrived on. This is set by the kernel, not the client, so it
cannot be spoofed. An internet attacker cannot open a socket to `:4318` at all
(Tailscale `serve` only accepts connections from enrolled tailnet peers).

`localhost` requests (the Mac itself) remain fully trusted and can run every
tier including `local`.

Result — three independent factors guard a sensitive action:

1. **Network:** must reach `:4318` → must be an enrolled tailnet device.
2. **Identity:** must hold a valid login session.
3. **Presence:** must pass a fresh WebAuthn step-up for that specific action.

## WebAuthn step-up

### Registration (one-time, trusted context)
- Performed locally or over tailnet.
- Register a **platform authenticator** passkey. On the all-Apple setup an
  iCloud-synced passkey covers Mac + iPhone + iPad from one registration.
- `rpID = bobmac.tail6dba15.ts.net`. Store credential id + COSE public key +
  signCount in `~/.config/my-projects-hub/webauthn.json` (outside the repo).
- Support **multiple** registered credentials (add a backup device).

### Per-action assertion (the step-up)
1. Client requests to run a guarded action → server returns a **challenge**,
   random 32 bytes, bound server-side to `{projectId, actionId, sessionId}`,
   single-use, ~90s TTL.
2. Browser calls `navigator.credentials.get()` → Touch/Face ID → returns
   assertion (authenticatorData, clientDataJSON, signature).
3. Server verifies:
   - challenge matches the pending, unexpired, single-use record for this
     `{action, session}`;
   - `clientDataJSON.origin` is the tailnet serve origin, `.type ===
     "webauthn.get"`;
   - `rpIdHash` matches; user-present flag set;
   - signature verifies over `authenticatorData ‖ SHA-256(clientDataJSON)` using
     the stored public key (ES256 via Node `webcrypto`);
   - `signCount` strictly increases (clone detection) where provided.
4. On success, run **that one** action. No session-level "remember" — every
   guarded action re-challenges.

### Zero-dependency verification
Node core only: `crypto.webcrypto.subtle.verify` for ES256; hand-rolled minimal
COSE→SPKI key conversion and CBOR reading limited to what registration needs
(`none` attestation). This is the bulk of the build; kept in a single focused
`webauthn.mjs` module with its own tests.

## Manifest schema change

Extend `projects.json` actions, backward-compatible:

- Add optional `tier: "open" | "guarded" | "local"`.
- Back-compat: absent `tier` + `sensitive:true` → `guarded`; absent both →
  `open`. Existing `sensitive` flags keep working during migration; new field
  wins when present.
- One-time migration pass rewrites flags to explicit `tier` and applies the
  reclassifications above and the BYD `local` carve-out.

## Prerequisites (ship FIRST, as a separate small change)

These harden what is already live and are independent of the tiering build.

1. **Rotate the TOTP secret** — the old one appeared in chat; primary login
   still uses TOTP. Regenerate secret + QR privately, re-scan.
2. **Session invalidation on reset** — `setNewPassword()` also rotates
   `SESSION_SECRET` (it currently does not), invalidating all stale 7-day
   sessions and their CSRF tokens; forces one clean re-login.
3. **Apply the 3 reclassifications** in the manifest (Publish stack, eCrew npm
   MCP starts, BSA init/backup/migrate → guarded).

## Audit log

Every **guarded** (and attempted-guarded) action appends one line to a local
append-only log (`~/.config/my-projects-hub/audit.log`):
`{ts, action, tier, sourcePort, sessionId, stepup: pass|fail|absent, result}`.
Never served over HTTP. Essential once a phone tap can drive the car-adjacent /
employer / listing actions.

## Additional hardening

- Per-action rate limit on guarded runs (independent of the login limiter).
- Single-use, short-TTL challenges (above) prevent replay.
- Step-up failures are audited and rate-limited.

## Assumptions to verify during implementation

- `tailscale serve --bg 4318` is tailnet-only and is **not** promoted to public
  by the existing `tailscale funnel 4317` (they are independent). Confirm with a
  reachability test from off-tailnet.
- `req.socket.localPort` reliably reflects 4317 vs 4318 behind Tailscale's local
  proxy (Tailscale proxies to the target port; the launcher sees the real local
  port). Confirm by logging both ports during a live funnel vs serve hit.
- WebAuthn origin/port handling: registration and assertion both occur on the
  `:4318` serve origin, so origins match; confirm `rpID` (host, port-independent)
  validates correctly.
- Tailscale provides a valid HTTPS cert for the serve port (required for
  WebAuthn). Confirm.

## Out of scope (YAGNI)

- No WebAuthn for the *primary* login (TOTP stays there; rotated). Step-up is
  the added factor for guarded actions only.
- No per-action "remember for N minutes" — every guarded action re-challenges.
- No remote registration of new passkeys from the public Funnel (registration is
  local/tailnet only).
- No changes to the BYD app beyond marking it `local`.

## Rollout order

1. **Prereqs** (§ Prerequisites) — small, ships immediately, hardens live system.
2. **Tiering + two-port network split** — manifest `tier`, `:4318` serve,
   `localPort` gating, refuse guarded on Funnel.
3. **WebAuthn** — registration flow, `webauthn.mjs` verifier, per-action
   challenge/assert, step-up modal in `app.js`.
4. **Audit log + rate limits.**
5. Live verification: off-tailnet cannot reach `:4318`; guarded action requires
   Touch/Face ID; BYD absent from every remote surface.
