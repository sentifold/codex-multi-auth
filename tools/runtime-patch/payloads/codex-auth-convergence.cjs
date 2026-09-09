#!/usr/bin/env node
"use strict";

// Canonical source: sentifold/codex-multi-auth tools/runtime-patch/payloads/codex-auth-convergence.cjs
// Apply only to a staged package before immutable runtime publication.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = process.argv[2];
const check = process.argv.includes("--check");
if (!root || !path.isAbsolute(root)) throw new Error("absolute package root required");
const file = path.join(root, "dist/lib/accounts.js");
const marker = "codex-multi-auth r24: converge live credentials after persistence";
const method = `    // codex-multi-auth r24: converge live credentials after persistence
    adoptPersistedTokens(snapshot) {
        const storedByIdentity = new Map(snapshot.accounts.map((account) => [getAccountIdentityKey(account), account]));
        for (const account of this.accounts) {
            const key = getAccountIdentityKey(account);
            if (!key)
                continue;
            const stored = storedByIdentity.get(key);
            if (stored?.refreshToken && (stored.expiresAt ?? 0) > (account.expires ?? 0)) {
                account.refreshToken = stored.refreshToken;
                account.access = stored.accessToken;
                account.expires = stored.expiresAt;
            }
        }
    }
`;
const before = `                await persist(this.reconcileTokensFromDisk(this.buildStorageSnapshot(), current));`;
const after = `                const snapshot = this.reconcileTokensFromDisk(this.buildStorageSnapshot(), current);
                await persist(snapshot);
                this.adoptPersistedTokens(snapshot);`;
const anchor = "    buildStorageSnapshot() {";
const original = fs.readFileSync(file, "utf8");
let next = original;
if (original.includes(marker)) {
  if (!original.includes(method) || !original.includes(after) || original.includes(before)) {
    throw new Error("incomplete live credential convergence patch");
  }
} else {
  if (check) throw new Error("missing live credential convergence patch");
  if (original.split(before).length !== 2 || original.split(anchor).length !== 2 || original.includes("adoptPersistedTokens(")) {
    throw new Error("unsupported account persistence layout");
  }
  next = original.replace(before, after).replace(anchor, method + anchor);
}
const parsed = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: next, encoding: "utf8" });
if (parsed.status !== 0) throw new Error(`invalid patched accounts: ${parsed.stderr}`);
if (next !== original) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, next, { mode: fs.statSync(file).mode & 0o777, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
console.log(`Live credential convergence: ${check ? "verified" : "patched"}`);
