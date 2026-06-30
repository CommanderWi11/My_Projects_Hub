#!/usr/bin/env node
/* ============================================================
   Projects Hub — configure outgoing email (GMX SMTP)
   Adds SMTP_* keys to ~/.config/my-projects-hub/.env so the hub can
   email you a "set password" link. Your app-password is entered
   hidden and never printed.

   Interactive:    node setup-smtp.mjs
   Non-interactive: SETUP_SMTP_PASS='…' node setup-smtp.mjs
   ============================================================ */

import { mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import readline from "node:readline";

const ENV_DIR = join(os.homedir(), ".config", "my-projects-hub");
const ENV_FILE = process.env.HUB_ENV_FILE || join(ENV_DIR, ".env");

const DEFAULTS = { SMTP_HOST: "mail.gmx.com", SMTP_PORT: "465", SMTP_USER: "luisnavm@gmx.com" };

function ask(rl, q, { hidden = false } = {}) {
  return new Promise((resolve) => {
    if (!hidden) return rl.question(q, (a) => resolve(a));
    const out = process.stdout;
    out.write(q);
    const onData = () => { out.clearLine(0); out.cursorTo(0); out.write(q + "*".repeat(rl.line.length)); };
    process.stdin.on("data", onData);
    rl.question("", (a) => { process.stdin.removeListener("data", onData); out.write("\n"); resolve(a); });
  });
}

async function getInputs() {
  if (process.env.SETUP_SMTP_PASS) {
    return {
      SMTP_HOST: process.env.SETUP_SMTP_HOST || DEFAULTS.SMTP_HOST,
      SMTP_PORT: process.env.SETUP_SMTP_PORT || DEFAULTS.SMTP_PORT,
      SMTP_USER: process.env.SETUP_SMTP_USER || DEFAULTS.SMTP_USER,
      SMTP_PASS: process.env.SETUP_SMTP_PASS,
    };
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const SMTP_USER = (await ask(rl, `GMX address [${DEFAULTS.SMTP_USER}]: `)).trim() || DEFAULTS.SMTP_USER;
  const SMTP_HOST = (await ask(rl, `SMTP host [${DEFAULTS.SMTP_HOST}]: `)).trim() || DEFAULTS.SMTP_HOST;
  const SMTP_PORT = (await ask(rl, `SMTP port [${DEFAULTS.SMTP_PORT}]: `)).trim() || DEFAULTS.SMTP_PORT;
  const SMTP_PASS = await ask(rl, "GMX app-password: ", { hidden: true });
  rl.close();
  if (!SMTP_PASS) { console.error("\n✗ No password entered."); process.exit(1); }
  return { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS };
}

const v = await getInputs();
const kv = { ...v, MAIL_FROM: v.SMTP_USER, MAIL_TO: v.SMTP_USER };

mkdirSync(ENV_DIR, { recursive: true });
let lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split("\n") : [];
for (const [k, val] of Object.entries(kv)) {
  let done = false;
  lines = lines.map((l) => (l.startsWith(k + "=") ? ((done = true), k + "=" + val) : l));
  if (!done) lines.push(k + "=" + val);
}
writeFileSync(ENV_FILE, lines.join("\n"), { mode: 0o600 });
chmodSync(ENV_FILE, 0o600);

console.log(`
✓ Email configured.  ${ENV_FILE}
  From/To: ${v.SMTP_USER}   via ${v.SMTP_HOST}:${v.SMTP_PORT}

  Restart the launcher to apply:
    launchctl kickstart -k gui/$(id -u)/com.commanderwi11.projects-hub

  Then on the sign-in screen, use “Email me a set-password link”.
`);
