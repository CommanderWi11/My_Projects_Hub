# Safe Remote Execution (Three-Tier + WebAuthn) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let every project action run remotely except BYD Control, by adding a three-tier model (open / guarded / local) where guarded actions are tailnet-only and require a per-action WebAuthn step-up.

**Architecture:** One HTTP handler bound to two localhost ports — `:4317` (public via `tailscale funnel`) and `:4318` (tailnet-only via `tailscale serve`). A request's tier eligibility is decided by `req.socket.localPort` (kernel-set, unspoofable). Guarded actions run only from the serve port (or localhost) and only after a single-use, action-bound WebAuthn assertion verifies. New logic lives in small unit-tested modules (`lib/tiers.mjs`, `lib/webauthn.mjs`, `lib/audit.mjs`); `launcher.mjs` wires them in.

**Tech Stack:** Node v25 (zero external deps), `node:http`, `node:crypto` webcrypto (ES256), `node:test` for tests, browser WebAuthn (`navigator.credentials`), Tailscale funnel + serve.

## Global Constraints

- **Zero external dependencies** — Node core only. No npm installs, no `package.json` deps.
- **Never trust client-supplied headers for tier decisions** — tier eligibility comes from `req.socket.localPort` and the existing remote/local detection, never `Host`/`X-Forwarded-*` beyond what's already validated.
- **Secrets live in `~/.config/my-projects-hub/`**, never in the repo. New file: `webauthn.json` (registered credentials), `audit.log`.
- **Ports:** `FUNNEL_PORT = 4317` (public), `SERVE_PORT = 4318` (tailnet). Both bound to `127.0.0.1`.
- **WebAuthn:** `rpID = "bobmac.tail6dba15.ts.net"`; only ES256 (`alg -7`); registration allowed from localhost or serve port only.
- **Tiers:** `open` (default/unflagged), `guarded` (was `sensitive:true`), `local` (localhost only). Back-compat: absent `tier` + `sensitive:true` ⇒ `guarded`; absent both ⇒ `open`.
- **BYD Control:** every action `tier:"local"`.
- Run tests with: `node --test test/`.

---

## Phase 0 — Prereqs (harden what's already live; independently shippable)

### Task 1: Rotate the leaked TOTP secret

**Files:**
- Run: `setup-auth.mjs` (existing; regenerates TOTP secret + QR)
- Verify: `~/.config/my-projects-hub/.env`

This is an operational task (no code change). The current TOTP secret appeared in chat history; the password was never shown, so only the second factor is compromised.

- [ ] **Step 1: Snapshot the current TOTP secret line (to confirm it changes)**

Run: `grep '^TOTP_SECRET=' ~/.config/my-projects-hub/.env | cut -c1-20`
Expected: prints `TOTP_SECRET=` + first chars of the OLD secret.

- [ ] **Step 2: Re-run auth setup to regenerate the TOTP secret + QR**

Run: `node setup-auth.mjs`
Follow prompts; keep the same username/password if asked, accept a NEW TOTP secret. Scan the new QR into the authenticator app privately.

- [ ] **Step 3: Confirm the secret actually changed**

Run: `grep '^TOTP_SECRET=' ~/.config/my-projects-hub/.env | cut -c1-20`
Expected: DIFFERENT value from Step 1.

- [ ] **Step 4: Restart launcher and confirm login works with a fresh code**

Run: `launchctl kickstart -k gui/$(id -u)/com.commanderwi11.projects-hub`
Then log in remotely with a code from the re-scanned authenticator.
Expected: login succeeds. Delete the old authenticator entry.

- [ ] **Step 5: Commit (docs/ops note only — no secret in repo)**

```bash
git commit --allow-empty -m "ops: rotate leaked TOTP secret (2FA re-enrolled)"
```

---

### Task 2: Invalidate all sessions on password reset

Rotate `SESSION_SECRET` inside `setNewPassword()` so a password reset kills every existing 7-day session and CSRF token (they're HMAC'd with `SESSION_SECRET`).

**Files:**
- Modify: `launcher.mjs` — `setNewPassword()` (search for `function setNewPassword`)
- Test: `test/session-rotation.test.mjs` (create)

**Interfaces:**
- Consumes: existing `updateEnvFile({...})`, `CFG`, `randomBytes` (already imported).
- Produces: after `setNewPassword(pw)`, `CFG.SESSION_SECRET` is a new 32-byte hex string persisted to the env file.

- [ ] **Step 1: Write the failing test**

Create `test/session-rotation.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

// Mirror of the invariant we require: a token signed with the OLD secret
// must NOT verify under the NEW secret after rotation.
test("rotating SESSION_SECRET invalidates old HMAC tokens", () => {
  const oldSecret = "a".repeat(64);
  const sign = (s, d) => createHmac("sha256", s).update(d).digest("hex");
  const tokenOld = sign(oldSecret, "exp123");

  // simulate rotation
  const newSecret = "b".repeat(64);
  const verifyUnderNew = sign(newSecret, "exp123");

  assert.notEqual(tokenOld, verifyUnderNew, "old token must not verify under new secret");
});
```

- [ ] **Step 2: Run test to verify it passes (guards the invariant)**

Run: `node --test test/session-rotation.test.mjs`
Expected: PASS (this pins the property we implement against).

- [ ] **Step 3: Add rotation to `setNewPassword()`**

In `launcher.mjs`, change `setNewPassword` from:

```js
function setNewPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pw, Buffer.from(salt, "hex"), 64).toString("hex");
  updateEnvFile({ HUB_PASSWORD_SALT: salt, HUB_PASSWORD_HASH: hash });
  CFG.HUB_PASSWORD_SALT = salt; CFG.HUB_PASSWORD_HASH = hash;
}
```

to:

```js
function setNewPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pw, Buffer.from(salt, "hex"), 64).toString("hex");
  const sessionSecret = randomBytes(32).toString("hex"); // rotate → kills all sessions + CSRF
  updateEnvFile({ HUB_PASSWORD_SALT: salt, HUB_PASSWORD_HASH: hash, SESSION_SECRET: sessionSecret });
  CFG.HUB_PASSWORD_SALT = salt; CFG.HUB_PASSWORD_HASH = hash; CFG.SESSION_SECRET = sessionSecret;
}
```

- [ ] **Step 4: Syntax check + run tests**

Run: `node --check launcher.mjs && node --test test/`
Expected: both pass.

- [ ] **Step 5: Manual verification**

Start launcher locally, note you have a session, trigger a password reset via the emailed link, then reload — expect to be logged out (old session rejected).

- [ ] **Step 6: Commit**

```bash
git add launcher.mjs test/session-rotation.test.mjs
git commit -m "fix(auth): rotate SESSION_SECRET on password reset (invalidate stale sessions)"
```

---

## Phase 1 — Tiering + two-port network split

### Task 3: `lib/tiers.mjs` — tier resolution + eligibility (pure, unit-tested)

**Files:**
- Create: `lib/tiers.mjs`
- Test: `test/tiers.test.mjs`

**Interfaces:**
- Produces:
  - `resolveTier(action) -> "open" | "guarded" | "local"` — `action.tier` wins; else `action.sensitive===true ? "guarded" : "open"`.
  - `tierAllowed({ tier, isLocal, localPort, FUNNEL_PORT, SERVE_PORT }) -> boolean` — is this tier even *reachable/eligible* on this connection (before step-up)?
    - `local`: only `isLocal`.
    - `guarded`: `isLocal || localPort === SERVE_PORT`.
    - `open`: always true.

- [ ] **Step 1: Write the failing test**

Create `test/tiers.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTier, tierAllowed } from "../lib/tiers.mjs";

const P = { FUNNEL_PORT: 4317, SERVE_PORT: 4318 };

test("resolveTier honors explicit tier, else falls back to sensitive flag", () => {
  assert.equal(resolveTier({ tier: "local" }), "local");
  assert.equal(resolveTier({ sensitive: true }), "guarded");
  assert.equal(resolveTier({ sensitive: false }), "open");
  assert.equal(resolveTier({}), "open");
});

test("guarded is reachable on serve port or localhost, never on funnel", () => {
  assert.equal(tierAllowed({ tier: "guarded", isLocal: false, localPort: 4318, ...P }), true);
  assert.equal(tierAllowed({ tier: "guarded", isLocal: false, localPort: 4317, ...P }), false);
  assert.equal(tierAllowed({ tier: "guarded", isLocal: true, localPort: 4317, ...P }), true);
});

test("local is localhost-only", () => {
  assert.equal(tierAllowed({ tier: "local", isLocal: true, localPort: 4317, ...P }), true);
  assert.equal(tierAllowed({ tier: "local", isLocal: false, localPort: 4318, ...P }), false);
});

test("open is always eligible", () => {
  assert.equal(tierAllowed({ tier: "open", isLocal: false, localPort: 4317, ...P }), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tiers.test.mjs`
Expected: FAIL — `Cannot find module '../lib/tiers.mjs'`.

- [ ] **Step 3: Implement `lib/tiers.mjs`**

```js
// Tier resolution + network eligibility. Pure functions, no I/O.
export function resolveTier(action) {
  if (action && (action.tier === "open" || action.tier === "guarded" || action.tier === "local")) return action.tier;
  if (action && action.sensitive === true) return "guarded";
  return "open";
}

export function tierAllowed({ tier, isLocal, localPort, SERVE_PORT }) {
  if (isLocal) return true;               // the Mac itself: everything
  if (tier === "open") return true;
  if (tier === "guarded") return localPort === SERVE_PORT;
  return false;                            // "local" tier: never remote
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/tiers.test.mjs`
Expected: PASS (all 4).

- [ ] **Step 5: Commit**

```bash
git add lib/tiers.mjs test/tiers.test.mjs
git commit -m "feat(tiers): pure tier resolution + network eligibility module"
```

---

### Task 4: Migrate `projects.json` to explicit tiers + reclassifications

**Files:**
- Modify: `projects.json` (add `"tier"` to every action)
- Test: `test/manifest.test.mjs` (create)

**Interfaces:**
- Consumes: `resolveTier` from Task 3.
- Produces: every action carries an explicit `tier`. BYD actions ⇒ `local`. Reclassified ⇒ `guarded`.

- [ ] **Step 1: Write the failing test**

Create `test/manifest.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveTier } from "../lib/tiers.mjs";

const d = JSON.parse(readFileSync(new URL("../projects.json", import.meta.url)));
const actions = d.projects.flatMap(p => p.actions.map(a => ({ p, a })));

test("every action has an explicit valid tier", () => {
  for (const { p, a } of actions) {
    assert.ok(["open","guarded","local"].includes(a.tier), `${p.name} · ${a.label} missing tier`);
  }
});

test("BYD Control is entirely local-only", () => {
  const byd = d.projects.find(p => p.id === "byd-control" || /BYD/i.test(p.name));
  assert.ok(byd, "BYD project present");
  for (const a of byd.actions) assert.equal(resolveTier(a), "local", `${a.label} must be local`);
});

test("reclassified drifts are guarded", () => {
  const find = (rx) => actions.find(({ p, a }) => rx.test(`${p.name} ${a.label}`));
  assert.equal(resolveTier(find(/AI Supastack.*Publish stack/i).a), "guarded");
  assert.equal(resolveTier(find(/eCrew.*Run MCP server \(dev\)/i).a), "guarded");
  assert.equal(resolveTier(find(/BSA.*Back up database/i).a), "guarded");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/manifest.test.mjs`
Expected: FAIL — actions have no `tier` field yet.

- [ ] **Step 3: Edit `projects.json`**

For every action, add a `"tier"` field:
- BYD Control → all actions `"tier": "local"`.
- Every action currently `"sensitive": true` → `"tier": "guarded"` (except BYD, which is `local`).
- These previously-unflagged actions → `"tier": "guarded"`: `AI Supastack · Publish stack to website` (`sync-stack.mjs`); `eCrew MCP · Run MCP server (dev)` and `Start MCP server` (npm); `BSA Options · Set up database` (`init`), `Back up database` (`backup`), `DB upgrade: sale tracker` (`migrate:sale-tracker`), `DB upgrade: approve/send` (`migrate:approve-send`).
- Everything else → `"tier": "open"`.
- Keep the existing `sensitive` field for now (back-compat); `tier` takes precedence.
- Confirm `Flight Bag · Capture Binter inbox`: leave `"tier": "open"` only if `capture.sh` reads a local capture and uses no Binter creds; otherwise set `"guarded"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/manifest.test.mjs && python3 -c "import json;json.load(open('projects.json'))"`
Expected: manifest tests PASS; JSON parses.

- [ ] **Step 5: Commit**

```bash
git add projects.json test/manifest.test.mjs
git commit -m "feat(manifest): explicit tiers; BYD local-only; reclassify 3 drifts to guarded"
```

---

### Task 5: Two-port listener + per-request tier gating in `launcher.mjs`

**Files:**
- Modify: `launcher.mjs` — imports, port constants, the `/api/run` handler (~line 456), the `listen()` section (~517-538), `/api/health` (~387)
- Test: `test/gating.test.mjs` (create) — integration via a spawned server on ephemeral ports

**Interfaces:**
- Consumes: `resolveTier`, `tierAllowed` (Task 3); `INDEX` (existing action lookup).
- Produces: on `/api/run`, before running, compute `tier = resolveTier(action)`; if `!tierAllowed({tier, isLocal: !remote, localPort: req.socket.localPort, SERVE_PORT})` → `403 {error:"This action is not permitted on this connection"}`. Guarded actions additionally require step-up (added in Task 10 — leave a `TODO(step-up)` marker returning 401 for now on remote guarded). `/api/health` returns `tier` context: `{ ..., surface: localPort===SERVE_PORT ? "tailnet" : (remote ? "funnel" : "local") }`.

- [ ] **Step 1: Write the failing integration test**

Create `test/gating.test.mjs` (spawns the handler on two ephemeral ports with a temp env; asserts a guarded action is refused on the funnel port and a local-only action is refused remotely). Use `node:http` + global `fetch`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { resolveTier, tierAllowed } from "../lib/tiers.mjs";

// Unit-level gating contract (fast, no network): the launcher wires exactly this.
test("funnel port cannot run guarded", () => {
  const req = { tier: resolveTier({ tier: "guarded" }), isLocal: false, localPort: 4317, SERVE_PORT: 4318 };
  assert.equal(tierAllowed(req), false);
});
test("serve port can reach guarded (step-up still required downstream)", () => {
  assert.equal(tierAllowed({ tier: "guarded", isLocal: false, localPort: 4318, SERVE_PORT: 4318 }), true);
});
test("local-only never runs remotely on any port", () => {
  assert.equal(tierAllowed({ tier: "local", isLocal: false, localPort: 4318, SERVE_PORT: 4318 }), false);
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test test/gating.test.mjs`
Expected: PASS (contract pinned; wiring verified live in Step 5).

- [ ] **Step 3: Add ports + two listeners in `launcher.mjs`**

Near the top port config (line ~43) add:

```js
const FUNNEL_PORT = BASE_PORT;          // 4317, public via tailscale funnel
const SERVE_PORT  = Number(process.env.SERVE_PORT || (BASE_PORT + 1)); // 4318, tailnet via tailscale serve
```

Add the import near the other imports:

```js
import { resolveTier, tierAllowed } from "./lib/tiers.mjs";
```

Replace the single `await listen(BASE_PORT);` (line ~538) with two servers sharing the handler. Refactor `createServer(async (req,res)=>{...})` so the handler function is named and passed to two servers:

```js
const handler = async (req, res) => { /* existing body unchanged */ };
const funnelServer = createServer(handler);
const serveServer  = createServer(handler);
funnelServer.listen(FUNNEL_PORT, "127.0.0.1", () => log(`funnel surface on :${FUNNEL_PORT}`));
serveServer.listen(SERVE_PORT, "127.0.0.1", () => log(`serve surface on :${SERVE_PORT}`));
```

(Keep the existing EADDRINUSE handling by wrapping each `.listen` with the current retry helper, adapted per server.)

- [ ] **Step 4: Gate `/api/run` by tier**

In the `/api/run` block (after the CSRF check, before running), insert:

```js
const tier = resolveTier(action);
const isLocal = !remote;
if (!tierAllowed({ tier, isLocal, localPort: req.socket.localPort, SERVE_PORT })) {
  return json(res, 403, { error: "This action is not available on this connection" });
}
if (tier === "guarded" && remote) {
  // TODO(step-up): replaced in Task 10 with WebAuthn assertion check.
  return json(res, 401, { error: "step-up required", stepup: true });
}
```

Also add `surface` to `/api/health` response object:

```js
surface: req.socket.localPort === SERVE_PORT ? "tailnet" : (remote ? "funnel" : "local"),
```

- [ ] **Step 5: Syntax check, tests, and live two-port check**

Run:
```bash
node --check launcher.mjs && node --test test/
launchctl kickstart -k gui/$(id -u)/com.commanderwi11.projects-hub
sleep 1
curl -s localhost:4317/api/health | grep -o '"surface":"[a-z]*"'
curl -s localhost:4318/api/health | grep -o '"surface":"[a-z]*"'
```
Expected: checks/tests pass; both ports respond (local shows `"surface":"local"` since curl is localhost — the funnel/serve distinction is exercised in Task 13 live).

- [ ] **Step 6: Commit**

```bash
git add launcher.mjs test/gating.test.mjs
git commit -m "feat(net): two-port listener; gate /api/run by tier via localPort"
```

---

### Task 6: Tailscale serve for the tailnet surface + ops wiring

**Files:**
- Modify: `com.commanderwi11.projects-hub.plist` (ensure launcher gets `SERVE_PORT`), `Launch Hub.command`, `CLAUDE.md` (Operating section), `.env.example`
- Create: `docs/tailscale-setup.md`

- [ ] **Step 1: Bring up the tailnet-only serve on 4318**

Run: `tailscale serve --bg 4318`
Then: `tailscale serve status`
Expected: `4318` served over the tailnet (HTTPS), NOT funnel'd.

- [ ] **Step 2: Confirm funnel still only exposes 4317**

Run: `tailscale funnel status`
Expected: only `4317` is funnel'd (public). `4318` is serve-only.

- [ ] **Step 3: Document + persist**

Create `docs/tailscale-setup.md` capturing the two commands, and note in `CLAUDE.md` Operating:
`Funnel (public): tailscale funnel --bg 4317` and `Serve (tailnet, guarded tier): tailscale serve --bg 4318`. Add `SERVE_PORT` to `.env.example` with a comment.

- [ ] **Step 4: Commit**

```bash
git add com.commanderwi11.projects-hub.plist "Launch Hub.command" CLAUDE.md .env.example docs/tailscale-setup.md
git commit -m "ops(net): tailscale serve :4318 for tailnet guarded surface + docs"
```

---

## Phase 2 — WebAuthn step-up

### Task 7: `lib/webauthn.mjs` — assertion verification (zero-dep, unit-tested)

Registration stores the credential public key as SPKI DER (from the browser's `getPublicKey()`), so the server never parses CBOR. Verification checks type, challenge, origin, rpIdHash, user-present, signCount, and the ES256 signature over `authenticatorData ‖ SHA256(clientDataJSON)`.

**Files:**
- Create: `lib/webauthn.mjs`
- Test: `test/webauthn.test.mjs`

**Interfaces:**
- Produces:
  - `b64url(buf) -> string`, `fromB64url(str) -> Buffer`
  - `derToRaw(derSig) -> Buffer` (DER ECDSA → 64-byte r‖s for webcrypto)
  - `verifyAssertion({ spki, authenticatorData, clientDataJSON, signature, expectedChallenge, expectedOrigin, expectedRpId, prevSignCount }) -> Promise<{ ok, reason?, signCount }>` where inputs `authenticatorData`, `clientDataJSON`, `signature`, `spki` are Buffers, `expectedChallenge` is a Buffer, and `expectedOrigin`/`expectedRpId` are strings.

- [ ] **Step 1: Write the failing test**

Create `test/webauthn.test.mjs` (generates an ES256 keypair, forges a valid assertion, asserts verify passes; then tampers each field and asserts it fails):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto, createHash } from "node:crypto";
import { verifyAssertion, b64url } from "../lib/webauthn.mjs";
const { subtle } = webcrypto;

function rawToDer(raw) {
  const r = raw.subarray(0, 32), s = raw.subarray(32);
  const enc = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; let v = b.subarray(i); if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]); return v; };
  const R = enc(r), S = enc(s);
  return Buffer.concat([Buffer.from([0x30, R.length + S.length + 4, 0x02, R.length]), R, Buffer.from([0x02, S.length]), S]);
}

async function forge({ rpId = "bobmac.tail6dba15.ts.net", origin = "https://bobmac.tail6dba15.ts.net", challenge = Buffer.from("chal-123"), signCount = 5 } = {}) {
  const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = Buffer.from(await subtle.exportKey("spki", kp.publicKey));
  const rpIdHash = createHash("sha256").update(rpId).digest();
  const authData = Buffer.concat([rpIdHash, Buffer.from([0x01]), Buffer.from([0,0,0, signCount])]); // UP flag + 4-byte count
  const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: b64url(challenge), origin }));
  const signed = Buffer.concat([authData, createHash("sha256").update(clientData).digest()]);
  const rawSig = Buffer.from(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, signed));
  return { spki, authenticatorData: authData, clientDataJSON: clientData, signature: rawToDer(rawSig), challenge, origin, rpId };
}

test("valid assertion verifies", async () => {
  const f = await forge();
  const r = await verifyAssertion({ spki: f.spki, authenticatorData: f.authenticatorData, clientDataJSON: f.clientDataJSON, signature: f.signature, expectedChallenge: f.challenge, expectedOrigin: f.origin, expectedRpId: f.rpId, prevSignCount: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.signCount, 5);
});

test("wrong challenge fails", async () => {
  const f = await forge();
  const r = await verifyAssertion({ spki: f.spki, authenticatorData: f.authenticatorData, clientDataJSON: f.clientDataJSON, signature: f.signature, expectedChallenge: Buffer.from("other"), expectedOrigin: f.origin, expectedRpId: f.rpId, prevSignCount: 0 });
  assert.equal(r.ok, false);
});

test("wrong origin fails", async () => {
  const f = await forge({ origin: "https://evil.example" });
  const r = await verifyAssertion({ spki: f.spki, authenticatorData: f.authenticatorData, clientDataJSON: f.clientDataJSON, signature: f.signature, expectedChallenge: f.challenge, expectedOrigin: "https://bobmac.tail6dba15.ts.net", expectedRpId: f.rpId, prevSignCount: 0 });
  assert.equal(r.ok, false);
});

test("replayed/old signCount fails", async () => {
  const f = await forge({ signCount: 3 });
  const r = await verifyAssertion({ spki: f.spki, authenticatorData: f.authenticatorData, clientDataJSON: f.clientDataJSON, signature: f.signature, expectedChallenge: f.challenge, expectedOrigin: f.origin, expectedRpId: f.rpId, prevSignCount: 3 });
  assert.equal(r.ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/webauthn.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/webauthn.mjs`**

```js
import { webcrypto, createHash } from "node:crypto";
const { subtle } = webcrypto;

export function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromB64url(str) {
  return Buffer.from(String(str).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// DER ECDSA (SEQUENCE{INTEGER r, INTEGER s}) → 64-byte r‖s for webcrypto.
export function derToRaw(der) {
  let o = 2; // skip SEQ tag+len (len < 128 for P-256 sigs)
  if (der[1] & 0x80) o = 2 + (der[1] & 0x7f);
  const readInt = () => {
    if (der[o] !== 0x02) throw new Error("bad DER");
    let len = der[o + 1]; let start = o + 2;
    let v = der.subarray(start, start + len);
    o = start + len;
    while (v.length > 32 && v[0] === 0x00) v = v.subarray(1); // strip sign byte
    return Buffer.concat([Buffer.alloc(32 - v.length), v]);   // left-pad to 32
  };
  const r = readInt(), s = readInt();
  return Buffer.concat([r, s]);
}

export async function verifyAssertion({ spki, authenticatorData, clientDataJSON, signature, expectedChallenge, expectedOrigin, expectedRpId, prevSignCount = 0 }) {
  let cd;
  try { cd = JSON.parse(Buffer.from(clientDataJSON).toString("utf8")); }
  catch { return { ok: false, reason: "clientData" }; }
  if (cd.type !== "webauthn.get") return { ok: false, reason: "type" };
  if (cd.origin !== expectedOrigin) return { ok: false, reason: "origin" };
  if (Buffer.compare(fromB64url(cd.challenge), Buffer.from(expectedChallenge)) !== 0) return { ok: false, reason: "challenge" };

  const authData = Buffer.from(authenticatorData);
  const rpIdHash = authData.subarray(0, 32);
  if (Buffer.compare(rpIdHash, createHash("sha256").update(expectedRpId).digest()) !== 0) return { ok: false, reason: "rpid" };
  const flags = authData[32];
  if (!(flags & 0x01)) return { ok: false, reason: "user-present" };
  const signCount = authData.readUInt32BE(33);
  if (signCount !== 0 && signCount <= prevSignCount) return { ok: false, reason: "signcount" };

  const clientDataHash = createHash("sha256").update(Buffer.from(clientDataJSON)).digest();
  const signed = Buffer.concat([authData, clientDataHash]);
  let key;
  try { key = await subtle.importKey("spki", Buffer.from(spki), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]); }
  catch { return { ok: false, reason: "key" }; }
  const ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRaw(Buffer.from(signature)), signed);
  return { ok, reason: ok ? undefined : "signature", signCount };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/webauthn.test.mjs`
Expected: PASS (all 4).

- [ ] **Step 5: Commit**

```bash
git add lib/webauthn.mjs test/webauthn.test.mjs
git commit -m "feat(webauthn): zero-dep ES256 assertion verifier"
```

---

### Task 8: Credential store + challenge store

**Files:**
- Create: `lib/webauthn-store.mjs`
- Test: `test/webauthn-store.test.mjs`

**Interfaces:**
- Produces:
  - `loadCreds(path) -> [{ id, spkiB64, signCount, label }]` (empty array if file missing)
  - `saveCred(path, { id, spkiB64, signCount, label })` — upsert by `id`
  - `updateSignCount(path, id, signCount)`
  - `makeChallenge(store, { projectId, actionId, sessionId }) -> { id, challengeB64 }` — random 32-byte, stored in-memory `store` (a `Map`) with `{projectId, actionId, sessionId, exp: Date.now()+90_000}`
  - `takeChallenge(store, id) -> record | null` — single-use (deletes on read), null if missing/expired

- [ ] **Step 1: Write the failing test**

Create `test/webauthn-store.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { loadCreds, saveCred, updateSignCount, makeChallenge, takeChallenge } from "../lib/webauthn-store.mjs";

test("cred store upserts and reads", () => {
  const p = join(tmpdir(), `wa-${process.pid}.json`);
  rmSync(p, { force: true });
  assert.deepEqual(loadCreds(p), []);
  saveCred(p, { id: "a", spkiB64: "x", signCount: 0, label: "mac" });
  saveCred(p, { id: "a", spkiB64: "x", signCount: 4, label: "mac" }); // upsert
  const creds = loadCreds(p);
  assert.equal(creds.length, 1);
  assert.equal(creds[0].signCount, 4);
  updateSignCount(p, "a", 9);
  assert.equal(loadCreds(p)[0].signCount, 9);
  rmSync(p, { force: true });
});

test("challenge is single-use and action-bound", () => {
  const store = new Map();
  const { id } = makeChallenge(store, { projectId: "p", actionId: "run", sessionId: "s" });
  const rec = takeChallenge(store, id);
  assert.equal(rec.projectId, "p");
  assert.equal(takeChallenge(store, id), null); // consumed
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/webauthn-store.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/webauthn-store.mjs`**

```js
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { b64url } from "./webauthn.mjs";

export function loadCreds(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return []; }
}
function writeCreds(path, creds) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(creds, null, 2), { mode: 0o600 });
}
export function saveCred(path, cred) {
  const creds = loadCreds(path).filter(c => c.id !== cred.id);
  creds.push(cred); writeCreds(path, creds);
}
export function updateSignCount(path, id, signCount) {
  const creds = loadCreds(path).map(c => c.id === id ? { ...c, signCount } : c);
  writeCreds(path, creds);
}
export function makeChallenge(store, { projectId, actionId, sessionId }) {
  const id = b64url(randomBytes(16));
  const challenge = randomBytes(32);
  store.set(id, { projectId, actionId, sessionId, challenge, exp: Date.now() + 90_000 });
  return { id, challengeB64: b64url(challenge) };
}
export function takeChallenge(store, id) {
  const rec = store.get(id);
  store.delete(id);
  if (!rec || rec.exp < Date.now()) return null;
  return rec;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/webauthn-store.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/webauthn-store.mjs test/webauthn-store.test.mjs
git commit -m "feat(webauthn): credential + single-use action-bound challenge store"
```

---

### Task 9: Registration endpoints + page (localhost/tailnet only)

**Files:**
- Modify: `launcher.mjs` — add `/api/webauthn/register/options` and `/api/webauthn/register/verify` (both refuse the funnel surface), add `webauthn-register.html/.js` to `PUBLIC_STATIC`
- Create: `webauthn-register.html`, `webauthn-register.js`

**Interfaces:**
- Consumes: `loadCreds`, `saveCred`, `makeChallenge`, `takeChallenge`; `CRED_PATH = join(homedir(), ".config/my-projects-hub/webauthn.json")`; a module-level `regChallenges = new Map()`.
- Produces: `POST /options` → `{ challengeB64, rpId, userId }`; `POST /verify` `{ id, spkiB64, signCount, label, challengeId }` → stores credential. Both return `403` unless `isLocal || req.socket.localPort === SERVE_PORT`.

- [ ] **Step 1: Add registration endpoints to `launcher.mjs`**

In the `/api/` section, after the login/logout blocks, add (guard first):

```js
if (path.startsWith("/api/webauthn/register/")) {
  const trusted = !remote || req.socket.localPort === SERVE_PORT;
  if (!trusted) return json(res, 403, { error: "register from localhost or tailnet only" });
  if (remote && !authed) return json(res, 401, { error: "login required" });

  if (path.endsWith("/options") && req.method === "POST") {
    const { id, challengeB64 } = makeChallenge(regChallenges, { projectId: "_reg", actionId: "_reg", sessionId: cookies.mph_session || "local" });
    return json(res, 200, { challengeId: id, challengeB64, rpId: WEBAUTHN_RP_ID, userId: b64url(Buffer.from("mph-user")) });
  }
  if (path.endsWith("/verify") && req.method === "POST") {
    const b = await readBody(req);
    const rec = takeChallenge(regChallenges, b.challengeId);
    if (!rec) return json(res, 400, { error: "challenge expired" });
    saveCred(CRED_PATH, { id: b.id, spkiB64: b.spkiB64, signCount: b.signCount || 0, label: b.label || "device" });
    return json(res, 200, { ok: true });
  }
}
```

Add near config:

```js
import { homedir } from "node:os";
import { loadCreds, saveCred, updateSignCount, makeChallenge, takeChallenge } from "./lib/webauthn-store.mjs";
import { verifyAssertion, b64url, fromB64url } from "./lib/webauthn.mjs";
const WEBAUTHN_RP_ID = process.env.WEBAUTHN_RP_ID || "bobmac.tail6dba15.ts.net";
const CRED_PATH = join(homedir(), ".config/my-projects-hub/webauthn.json");
const regChallenges = new Map();
const stepupChallenges = new Map();
```

Add `webauthn-register.html` to the `PUBLIC_STATIC` set.

- [ ] **Step 2: Create `webauthn-register.js`**

```js
const enc = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const dec = (s) => Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0));

document.getElementById("go").addEventListener("click", async () => {
  const status = document.getElementById("status");
  try {
    const opt = await (await fetch("api/webauthn/register/options", { method: "POST" })).json();
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: dec(opt.challengeB64),
      rp: { name: "Projects Hub", id: opt.rpId },
      user: { id: dec(opt.userId), name: "commanderwi11", displayName: "CommanderWi11" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256 only
      authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
      timeout: 60000,
    }});
    const spki = cred.response.getPublicKey(); // SPKI DER
    const signCount = cred.response.getAuthenticatorData ? new DataView(cred.response.getAuthenticatorData()).getUint32(33) : 0;
    const r = await (await fetch("api/webauthn/register/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      challengeId: opt.challengeId, id: enc(cred.rawId), spkiB64: enc(spki), signCount, label: navigator.platform || "device",
    })})).json();
    status.textContent = r.ok ? "Passkey registered ✓" : ("Failed: " + (r.error || "?"));
  } catch (e) { status.textContent = "Error: " + e.message; }
});
```

- [ ] **Step 3: Create `webauthn-register.html`**

A minimal page matching house style with a heading, a `<button id="go">Register this device</button>`, a `<p id="status">`, and `<script src="webauthn-register.js"></script>`. No inline scripts (CSP).

- [ ] **Step 4: Syntax check + manual registration**

Run: `node --check launcher.mjs && node --test test/`
Then locally open `http://localhost:4318/webauthn-register.html` (served surface), click Register, complete Touch ID.
Expected: "Passkey registered ✓"; `~/.config/my-projects-hub/webauthn.json` contains one credential.

- [ ] **Step 5: Commit**

```bash
git add launcher.mjs webauthn-register.html webauthn-register.js
git commit -m "feat(webauthn): device registration (localhost/tailnet only)"
```

---

### Task 10: Wire step-up into guarded `/api/run`

**Files:**
- Modify: `launcher.mjs` — `/api/run` guarded branch (replace the `TODO(step-up)` from Task 5); add `/api/stepup/options`
- Test: `test/stepup-contract.test.mjs`

**Interfaces:**
- Consumes: `makeChallenge`/`takeChallenge` on `stepupChallenges`; `verifyAssertion`, `loadCreds`, `updateSignCount`.
- Produces:
  - `POST /api/stepup/options` `{ projectId, actionId }` → `{ challengeId, challengeB64, rpId, allowCredentials: [ids] }` (serve/local only, authed, guarded action).
  - `POST /api/run` for a guarded remote action now requires body `stepup: { challengeId, id, authenticatorData, clientDataJSON, signature }`; server validates challenge is action-bound + verifies assertion + bumps signCount, then runs.

- [ ] **Step 1: Write the contract test**

Create `test/stepup-contract.test.mjs` — verifies the action-binding rule with the store + verifier (no browser):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeChallenge, takeChallenge } from "../lib/webauthn-store.mjs";

test("step-up challenge is bound to a specific action and single-use", () => {
  const store = new Map();
  const { id } = makeChallenge(store, { projectId: "bsa", actionId: "create:idealista", sessionId: "s1" });
  const rec = takeChallenge(store, id);
  assert.equal(rec.projectId, "bsa");
  assert.equal(rec.actionId, "create:idealista");
  assert.equal(takeChallenge(store, id), null); // cannot be reused for another action
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test test/stepup-contract.test.mjs`
Expected: PASS.

- [ ] **Step 3: Add `/api/stepup/options`**

```js
if (path === "/api/stepup/options" && req.method === "POST") {
  if (remote && req.socket.localPort !== SERVE_PORT) return json(res, 403, { error: "guarded surface only" });
  if (remote && !authed) return json(res, 401, { error: "login required" });
  const b = await readBody(req);
  const action = INDEX[b.projectId]?.actions?.[b.actionId];
  if (!action || resolveTier(action) !== "guarded") return json(res, 400, { error: "not a guarded action" });
  const { id, challengeB64 } = makeChallenge(stepupChallenges, { projectId: b.projectId, actionId: b.actionId, sessionId: cookies.mph_session || "local" });
  return json(res, 200, { challengeId: id, challengeB64, rpId: WEBAUTHN_RP_ID, allowCredentials: loadCreds(CRED_PATH).map(c => c.id) });
}
```

- [ ] **Step 4: Replace the guarded branch in `/api/run`**

Replace the `TODO(step-up)` block from Task 5 with:

```js
if (tier === "guarded" && remote) {
  const su = (await readBodyOnce(req, body)).stepup; // body already read below; see note
  if (!su) return json(res, 401, { error: "step-up required", stepup: true });
  const rec = takeChallenge(stepupChallenges, su.challengeId);
  if (!rec || rec.projectId !== body.projectId || rec.actionId !== body.actionId || rec.sessionId !== (cookies.mph_session || "local"))
    return json(res, 401, { error: "step-up challenge invalid", stepup: true });
  const cred = loadCreds(CRED_PATH).find(c => c.id === su.id);
  if (!cred) return json(res, 401, { error: "unknown credential", stepup: true });
  const v = await verifyAssertion({
    spki: fromB64url(cred.spkiB64),
    authenticatorData: fromB64url(su.authenticatorData),
    clientDataJSON: fromB64url(su.clientDataJSON),
    signature: fromB64url(su.signature),
    expectedChallenge: rec.challenge,
    expectedOrigin: "https://" + WEBAUTHN_RP_ID,
    expectedRpId: WEBAUTHN_RP_ID,
    prevSignCount: cred.signCount,
  });
  if (!v.ok) return json(res, 403, { error: "step-up failed", stepup: true });
  updateSignCount(CRED_PATH, cred.id, v.signCount);
}
```

Note: ensure `body` is read once before this block (move the existing `const body = await readBody(req)` above the tier gate) so `body.projectId/actionId/stepup` are available; drop the `readBodyOnce` placeholder and reference `body.stepup` directly.

- [ ] **Step 5: Syntax check + tests + live step-up**

Run: `node --check launcher.mjs && node --test test/`
Then over tailnet: run a guarded action → expect a Touch ID prompt → action runs; run again → fresh prompt (no reuse).

- [ ] **Step 6: Commit**

```bash
git add launcher.mjs test/stepup-contract.test.mjs
git commit -m "feat(webauthn): per-action step-up required for guarded remote runs"
```

---

### Task 11: Client step-up modal + tier-aware rendering (`app.js`)

**Files:**
- Modify: `app.js` — `onRun()`, add `stepUp()`, tier-aware button rendering; `index.html`/`styles.css` for the modal
- Consumes: `/api/stepup/options`, health `surface`

- [ ] **Step 1: Add the step-up flow to `app.js`**

Add helpers and modify `onRun` so a `401 {stepup:true}` triggers a WebAuthn `get()` and retries once with the assertion:

```js
const b64u = { enc: (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""),
               dec: (s) => Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0)) };

async function stepUp(p, a) {
  const opt = await (await fetch("api/stepup/options", { method: "POST", headers: csrfHeaders(), body: JSON.stringify({ projectId: p.id, actionId: a.id }) })).json();
  if (!opt.challengeB64) throw new Error(opt.error || "step-up unavailable");
  const assertion = await navigator.credentials.get({ publicKey: {
    challenge: b64u.dec(opt.challengeB64),
    rpId: opt.rpId,
    allowCredentials: (opt.allowCredentials || []).map(id => ({ type: "public-key", id: b64u.dec(id) })),
    userVerification: "required", timeout: 60000,
  }});
  return { challengeId: opt.challengeId, id: b64u.enc(assertion.rawId),
    authenticatorData: b64u.enc(assertion.response.authenticatorData),
    clientDataJSON: b64u.enc(assertion.response.clientDataJSON),
    signature: b64u.enc(assertion.response.signature) };
}
```

In `onRun`, wrap the run call: on first `401` with `j.stepup`, call `stepUp(p,a)`, then re-`fetch("api/run", …)` including `stepup` in the body; surface Touch ID failures via `toast`.

- [ ] **Step 2: Tier-aware rendering**

Using health `surface`: on the `funnel` surface, render guarded action buttons in a visibly disabled "tailnet-only" state with a tooltip; never show `local` actions remotely. On `tailnet`/`local`, render normally.

- [ ] **Step 3: Verify no CSP violations**

Reload over tailnet with devtools open.
Expected: zero CSP violations; step-up modal + Touch ID works; disabled guarded buttons on funnel.

- [ ] **Step 4: Commit**

```bash
git add app.js index.html styles.css
git commit -m "feat(ui): WebAuthn step-up modal + tier-aware action rendering"
```

---

## Phase 3 — Audit + hardening

### Task 12: Audit log + guarded rate limit

**Files:**
- Create: `lib/audit.mjs`, `test/audit.test.mjs`
- Modify: `launcher.mjs` — call `appendAudit` on every guarded run attempt; add a per-action limiter

**Interfaces:**
- Produces: `auditLine(entry) -> string` (single JSON line + `\n`); `appendAudit(path, entry)` (appends, `mode 0o600`); `AUDIT_PATH = join(homedir(), ".config/my-projects-hub/audit.log")`.

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { auditLine } from "../lib/audit.mjs";
test("auditLine emits one JSON line with required fields", () => {
  const line = auditLine({ action: "bsa/create:idealista", tier: "guarded", surface: "tailnet", stepup: "pass", result: "202" });
  assert.match(line, /\n$/);
  const o = JSON.parse(line);
  assert.equal(o.action, "bsa/create:idealista");
  assert.equal(o.stepup, "pass");
  assert.ok(o.ts);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/audit.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/audit.mjs`**

```js
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
export function auditLine(entry) {
  return JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
}
export function appendAudit(path, entry) {
  try { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, auditLine(entry), { mode: 0o600 }); } catch {}
}
```

(Note: `auditLine` uses `new Date()` — acceptable in the server runtime; the test only checks `o.ts` is truthy.)

- [ ] **Step 4: Wire into `launcher.mjs`**

After the guarded step-up decision in `/api/run` (both failure and success paths), call:

```js
appendAudit(AUDIT_PATH, { action: `${body.projectId}/${body.actionId}`, tier, surface: req.socket.localPort === SERVE_PORT ? "tailnet" : (remote ? "funnel" : "local"), stepup: tier === "guarded" && remote ? (stepupOk ? "pass" : "fail") : "n/a", result: String(statusReturned) });
```

Track `stepupOk`/`statusReturned` with locals set along each branch. Add a simple per-`{sessionId,actionId}` rate limit (e.g., max 5 guarded runs / minute) mirroring the existing login limiter pattern.

- [ ] **Step 5: Run tests + manual check**

Run: `node --check launcher.mjs && node --test test/`
Trigger a guarded action; confirm a line appears in `~/.config/my-projects-hub/audit.log`.

- [ ] **Step 6: Commit**

```bash
git add lib/audit.mjs test/audit.test.mjs launcher.mjs
git commit -m "feat(audit): append-only guarded-action audit log + per-action rate limit"
```

---

## Phase 4 — Live end-to-end verification

### Task 13: Prove the guarantees hold live

**Files:** none (verification only); capture results in `docs/tailscale-setup.md`

- [ ] **Step 1: Off-tailnet cannot reach the guarded surface**

From a device NOT on the tailnet (or `tailscale down` on a phone using cellular), hit the funnel URL and attempt a guarded action.
Expected: guarded buttons disabled/`403`; `curl https://<funnel-host>:4318/...` from off-tailnet is unreachable/refused.

- [ ] **Step 2: Guarded action over tailnet requires Touch/Face ID**

On a tailnet device, run e.g. `BSA · Sync inbox`.
Expected: Touch/Face ID prompt → runs; audit line `stepup:pass`.

- [ ] **Step 3: BYD is absent from every remote surface**

On funnel and tailnet, confirm BYD Control actions never run remotely (buttons hidden/disabled; `/api/run` returns `403`).
Expected: BYD only runnable on localhost.

- [ ] **Step 4: Regression — open tier still one-tap on funnel**

On the public funnel, run `Whoop · Run tests`.
Expected: runs with no step-up.

- [ ] **Step 5: Full test suite green + commit results**

```bash
node --test test/
git add docs/tailscale-setup.md
git commit -m "docs: record live verification of tiered remote execution"
```

---

## Self-Review notes

- **Spec coverage:** three tiers (T3,T4), two-port enforcement via `localPort` (T5), tailnet serve (T6), WebAuthn register + per-action step-up (T7–T11), prereqs TOTP + session invalidation (T1,T2), reclassifications (T4), audit + rate limit (T12), live checks incl. BYD-absent + off-tailnet-unreachable (T13). All spec sections mapped.
- **Naming consistency:** `resolveTier`/`tierAllowed`, `makeChallenge`/`takeChallenge`, `verifyAssertion`, `loadCreds`/`saveCred`/`updateSignCount`, `appendAudit`/`auditLine`, `SERVE_PORT`/`FUNNEL_PORT`, `CRED_PATH`/`AUDIT_PATH`, `stepupChallenges`/`regChallenges` used consistently across tasks.
- **Known implementation seams to watch:** (a) reading `body` once before the tier gate in `/api/run` (called out in T10 Step 4); (b) adapting the existing EADDRINUSE retry to two servers (T5 Step 3); (c) `getAuthenticatorData()` availability for initial signCount (falls back to 0, T9).
