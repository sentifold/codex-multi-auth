#!/usr/bin/env node
"use strict";

// Canonical source: sentifold/codex-multi-auth tools/runtime-patch/payloads/codex-quota-scope.cjs
// A prompt family is not a quota bucket. Astra and Sol share gpt-5.2 prompt
// formatting, but an observed model limit must not disable the other model.
// Apply only to a staged package before immutable runtime publication.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = process.argv[2];
const check = process.argv.includes("--check");
if (!root || !path.isAbsolute(root)) throw new Error("absolute package root required");
const file = path.join(root, "dist/lib/accounts.js");
const marker = "codex-multi-auth r22: exact-model persisted quota limits";
const before = `        if (!model || reason === "quota" || reason === "unknown") {
            const currentResetAt = account.rateLimitResetTimes[baseKey] ?? 0;
            account.rateLimitResetTimes[baseKey] = Math.max(currentResetAt, resetAt);
        }
        if (model &&
            (reason === "tokens" || reason === "concurrent" || reason === "unknown")) {`;
const after = `        // ${marker}
        // Without a model, retain the explicitly family-wide operation.
        // With a model, preserve the full observed retry deadline for it only.
        if (!model) {
            const currentResetAt = account.rateLimitResetTimes[baseKey] ?? 0;
            account.rateLimitResetTimes[baseKey] = Math.max(currentResetAt, resetAt);
        }
        if (model) {`;
const original = fs.readFileSync(file, "utf8");
let next = original;
if (original.includes(marker)) {
  if (!original.includes(after) || original.includes(before)) throw new Error("incomplete quota scope patch");
} else {
  if (check) throw new Error("missing exact-model quota scope patch");
  if (original.split(before).length !== 2) throw new Error("unsupported account quota layout");
  next = original.replace(before, after);
}
const parsed = spawnSync(process.execPath, ["--input-type=module", "--check"], {input: next, encoding: "utf8"});
if (parsed.status !== 0) throw new Error(`invalid patched accounts: ${parsed.stderr}`);
if (next !== original) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, next, {mode: fs.statSync(file).mode & 0o777, flag: "wx"});
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
console.log(`Exact-model persisted quota limits: ${check ? "verified" : "patched"}`);
