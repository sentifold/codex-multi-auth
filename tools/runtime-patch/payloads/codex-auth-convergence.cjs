#!/usr/bin/env node
"use strict";

// Canonical source: sentifold/codex-multi-auth tools/runtime-patch/payloads/codex-auth-convergence.cjs
// Apply only to a staged package before immutable runtime publication.
// Usage: node codex-auth-convergence.cjs <absolute-package-root> [--check]
//
// r24 made a resident AccountManager adopt newer persisted credentials. r28
// also drops the explicit invalidation and auth-failure cooldown a replaced
// credential earned, in the persisted record and the live account, so a
// re-login is routable again without a restart. An r24-patched file is
// upgraded in place; the result is byte-identical to patching the unpatched
// file. Any other layout is refused before a write.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const r24Marker = "codex-multi-auth r24: converge live credentials after persistence";
const r28Marker = "codex-multi-auth r28: a replaced credential releases its invalidation";
const anchor = "    buildStorageSnapshot() {";
const r24Method = `    // ${r24Marker}
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
const r28Methods = `    // ${r28Marker}
    adoptPersistedTokens(snapshot) {
        const storedByIdentity = new Map(snapshot.accounts.map((account) => [getAccountIdentityKey(account), account]));
        for (const account of this.accounts) {
            const key = getAccountIdentityKey(account);
            if (!key)
                continue;
            const stored = storedByIdentity.get(key);
            if (stored?.refreshToken && (stored.expiresAt ?? 0) > (account.expires ?? 0)) {
                if (stored.refreshToken !== account.refreshToken &&
                    !this.isAccountAuthInvalidated(stored)) {
                    this.releaseReplacedCredentialAuthState(account);
                    this.clearAuthFailures(account);
                }
                account.refreshToken = stored.refreshToken;
                account.access = stored.accessToken;
                account.expires = stored.expiresAt;
            }
        }
    }
    releaseReplacedCredentialAuthState(account) {
        delete account.authInvalidatedAt;
        delete account.authInvalidationErrorCode;
        if (account.cooldownReason === "auth-failure") {
            delete account.coolingDownUntil;
            delete account.cooldownReason;
        }
    }
`;
const saveBase = `                await persist(this.reconcileTokensFromDisk(this.buildStorageSnapshot(), current));`;
const saveAdopting = `                const snapshot = this.reconcileTokensFromDisk(this.buildStorageSnapshot(), current);
                await persist(snapshot);
                this.adoptPersistedTokens(snapshot);`;
const reconcileBase = `            if (diskExpires > memExpires && disk.refreshToken) {
                account.refreshToken = disk.refreshToken;`;
const reconcileReleasing = `            if (diskExpires > memExpires && disk.refreshToken) {
                // A different credential from disk that is not itself invalidated
                // drops the old one's markers before this snapshot is persisted.
                if (disk.refreshToken !== account.refreshToken &&
                    !this.isAccountAuthInvalidated(disk)) {
                    this.releaseReplacedCredentialAuthState(account);
                }
                account.refreshToken = disk.refreshToken;`;
const refreshSnapshotBase = `            return await withAccountStorageTransaction(async (_current, persist) => {
                // Snapshot the live in-memory pool under the storage lock so refresh
                // persistence merges against the latest account state.
                const nextStorage = structuredClone(this.buildStorageSnapshot());`;
const refreshSnapshotReconciled = `            return await withAccountStorageTransaction(async (current, persist) => {
                // Snapshot the live in-memory pool under the storage lock so refresh
                // persistence merges against the latest account state. Reconcile
                // the other accounts like a routine save so a refresh never reverts
                // a login written for another account or writes its stale markers.
                const nextStorage = structuredClone(this.reconcileTokensFromDisk(this.buildStorageSnapshot(), current));`;
const refreshPersistBase = `                        throw error;
                    }
                    return liveAccount;
                }
                await persist(nextStorage);
                log.warn(`;
const refreshPersistAdopting = `                        throw error;
                    }
                    this.adoptPersistedTokens(nextStorage);
                    return liveAccount;
                }
                await persist(nextStorage);
                this.adoptPersistedTokens(nextStorage);
                log.warn(`;

// Each site's exact text in every supported layout of dist/lib/accounts.js.
// "base" is the file without this patch (other staged patches may be present).
const sites = [
  { base: saveBase, r24: saveAdopting, r28: saveAdopting },
  { base: anchor, r24: r24Method + anchor, r28: r28Methods + anchor },
  { base: reconcileBase, r24: reconcileBase, r28: reconcileReleasing },
  { base: refreshSnapshotBase, r24: refreshSnapshotBase, r28: refreshSnapshotReconciled },
  { base: refreshPersistBase, r24: refreshPersistBase, r28: refreshPersistAdopting },
];
const layouts = ["base", "r24", "r28"];

function convert(source, from, to) {
  let next = source;
  for (const site of sites) {
    if (next.split(site[from]).length !== 2) {
      throw new Error(`unsupported account persistence layout for live credential convergence (${from})`);
    }
    next = next.replace(site[from], () => site[to]);
  }
  return next;
}

// Render a supported accounts.js source in the requested layout. The input
// must be exactly one known layout; partial or drifted patches are refused.
function render(source, target) {
  if (!layouts.includes(target)) throw new Error(`unknown live credential convergence layout: ${target}`);
  const current = source.includes(r28Marker) ? "r28" : source.includes(r24Marker) ? "r24" : "base";
  const base = convert(source, current, "base");
  if (base.includes("adoptPersistedTokens(") || base.includes("releaseReplacedCredentialAuthState(") ||
      base.includes("codex-multi-auth r24:") || base.includes("codex-multi-auth r28:")) {
    throw new Error("incomplete live credential convergence patch");
  }
  return { current, text: convert(base, "base", target) };
}

function main() {
  const root = process.argv[2];
  const check = process.argv.includes("--check");
  if (!root || !path.isAbsolute(root)) throw new Error("absolute package root required");
  const file = path.join(root, "dist/lib/accounts.js");
  const original = fs.readFileSync(file, "utf8");
  const { current, text: next } = render(original, "r28");
  if (check && current !== "r28") {
    throw new Error(current === "r24"
      ? "live credential convergence is r24; re-run without --check to upgrade it to r28"
      : "missing live credential convergence patch");
  }
  if (current === "r28" && next !== original) throw new Error("incomplete live credential convergence patch");
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
  const outcome = check || current === "r28" ? "verified" : current === "r24" ? "upgraded r24 to r28" : "patched";
  console.log(`Live credential convergence (r28): ${outcome}`);
}

// Tests require this file to derive the base and r24 layouts of a staged copy.
if (require.main === module) main();
else module.exports = { render };
