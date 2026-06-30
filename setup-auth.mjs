#!/usr/bin/env node
/* ============================================================
   Projects Hub — one-time auth setup
   Generates the credentials the launcher needs for REMOTE access
   and writes them to ~/.config/my-projects-hub/.env (outside the
   iCloud-synced repo, so your password / 2FA secret never sync).

   Interactive:   node setup-auth.mjs
   Non-interactive (for scripting/tests):
       SETUP_USERNAME=luis SETUP_PASSWORD='…' node setup-auth.mjs
   ============================================================ */

import { mkdirSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, scryptSync } from "node:crypto";
import os from "node:os";
import readline from "node:readline";

const ENV_DIR = join(os.homedir(), ".config", "my-projects-hub");
const ENV_FILE = process.env.HUB_ENV_FILE || join(ENV_DIR, ".env");

function base32Encode(buf) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, out = "";
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += A[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
}

function ask(rl, q, { hidden = false } = {}) {
  return new Promise((resolve) => {
    if (!hidden) return rl.question(q, (a) => resolve(a));
    const out = process.stdout;
    out.write(q);
    const onData = (ch) => {
      ch = ch.toString();
      if (ch === "\n" || ch === "\r" || ch === "") return;
      out.clearLine(0); out.cursorTo(0); out.write(q + "*".repeat(rl.line.length));
    };
    process.stdin.on("data", onData);
    rl.question("", (a) => { process.stdin.removeListener("data", onData); out.write("\n"); resolve(a); });
  });
}

async function getInputs() {
  if (process.env.SETUP_USERNAME && process.env.SETUP_PASSWORD) {
    return { username: process.env.SETUP_USERNAME, password: process.env.SETUP_PASSWORD };
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const username = (await ask(rl, "Choose a username: ")).trim() || "admin";
  const password = await ask(rl, "Choose a strong password: ", { hidden: true });
  const confirm = await ask(rl, "Confirm password: ", { hidden: true });
  rl.close();
  if (!password || password.length < 8) { console.error("\n✗ Password must be at least 8 characters."); process.exit(1); }
  if (password !== confirm) { console.error("\n✗ Passwords did not match."); process.exit(1); }
  return { username, password };
}

const { username, password } = await getInputs();

const salt = randomBytes(16).toString("hex");
const passwordHash = scryptSync(password, Buffer.from(salt, "hex"), 64).toString("hex");
const sessionSecret = randomBytes(32).toString("hex");
const totpSecret = base32Encode(randomBytes(20));

if (existsSync(ENV_FILE)) {
  const stamp = Date.now();
  const bak = ENV_FILE + ".bak." + stamp;
  try { writeFileSync(bak, "# previous config backed up here\n"); chmodSync(bak, 0o600); } catch {}
  console.log("\n⚠  An existing config was found; writing a fresh one (old TOTP/sessions will stop working).");
}

mkdirSync(ENV_DIR, { recursive: true });
const body =
`# Projects Hub auth — generated ${new Date().toISOString()}
# Keep this file private. It is intentionally OUTSIDE the iCloud repo.
HUB_USERNAME=${username}
HUB_PASSWORD_SALT=${salt}
HUB_PASSWORD_HASH=${passwordHash}
SESSION_SECRET=${sessionSecret}
TOTP_SECRET=${totpSecret}
`;
writeFileSync(ENV_FILE, body, { mode: 0o600 });
chmodSync(ENV_FILE, 0o600);

const label = encodeURIComponent("Projects Hub:" + username);
const otpauth = `otpauth://totp/${label}?secret=${totpSecret}&issuer=Projects%20Hub&period=30&digits=6`;

console.log(`
✓ Auth configured.   ${ENV_FILE}

  Add this to your authenticator app (Google Authenticator, 1Password, Authy):

    Secret (manual entry):  ${totpSecret}

    Or open this otpauth URI on your phone:
    ${otpauth}

  Then restart the launcher. Remote login will require:
    username · password · the 6-digit code from your app.
`);
