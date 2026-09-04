#!/usr/bin/env node
"use strict";

// Backport the Astra catalog and exact-model forecast DTO to pinned 2.9.1.
// Canonical source: sentifold/codex-multi-auth tools/runtime-patch/payloads/.
// Run only against a staging package, never a published immutable runtime.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = process.argv[2];
const check = process.argv.includes("--check");
if (!root || !path.isAbsolute(root)) throw new Error("absolute package root required");
const marker = "codex-multi-auth r21: Astra defaults and exact-model quota diagnostics";
const edits = [
  ["dist/lib/request/helpers/model-map.js", [
    ['export const DEFAULT_MODEL = "gpt-5.5";', 'export const DEFAULT_MODEL = "gpt-6-astra";'],
    ['export const DEFAULT_PROBE_MODEL = "gpt-5.6-sol";', 'export const DEFAULT_PROBE_MODEL = "gpt-6-astra";'],
    ['        base: DEFAULT_MODEL,', '        base: GPT_5_5_CANONICAL_MODEL,'],
    ['    base: DEFAULT_MODEL,', '    base: GPT_5_5_CANONICAL_MODEL,'],
    ['addReasoningAliases("gpt-5", DEFAULT_MODEL);', 'addReasoningAliases("gpt-5", GPT_5_5_CANONICAL_MODEL);'],
    ['addReasoningAliases("gpt-5-chat-latest", DEFAULT_MODEL);', 'addReasoningAliases("gpt-5-chat-latest", GPT_5_5_CANONICAL_MODEL);'],
    [`export const QUOTA_PROBE_MODEL_CHAIN = [
    DEFAULT_PROBE_MODEL,
    DEFAULT_MODEL,
    "gpt-5.4",
    "gpt-5.3-codex",
    "gpt-5.2-codex",
    "gpt-5-codex",
];`, 'export const QUOTA_PROBE_MODEL_CHAIN = [DEFAULT_PROBE_MODEL];'],
    ["export const MODEL_PROFILES = {", `export const MODEL_PROFILES = {
    // ${marker}
    "gpt-6-astra": {
        normalizedModel: "gpt-6-astra",
        promptFamily: "gpt-5.2",
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        capabilities: TOOL_CAPABILITIES.full,
    },`],
    ["addGpt56Aliases();", 'addGpt56Aliases();\naddEffortAliases("gpt-6-astra", "gpt-6-astra", ["low", "medium", "high", "xhigh", "max"]);'],
  ]],
  ["dist/lib/codex-manager.js", [
    ['import { CURRENT_CODEX_MODEL } from "./request/helpers/model-map.js";', `// ${marker}
import { DEFAULT_MODEL, getModelProfile } from "./request/helpers/model-map.js";`],
    ['getManagedAccountRuntimeSkipReason(runtimeAccount, "codex", CURRENT_CODEX_MODEL)', 'getManagedAccountRuntimeSkipReason(runtimeAccount, getModelProfile(DEFAULT_MODEL).promptFamily, DEFAULT_MODEL)'],
    ['model: CURRENT_CODEX_MODEL,', 'model: DEFAULT_MODEL,'],
  ]],
  ["dist/lib/codex-manager/commands/forecast.js", [
    ['deps.resolveActiveIndex(storage, "codex")', 'deps.resolveActiveIndex(storage, getModelProfile(probeModel).promptFamily)'],
    [`const forecastFamily = options.modelProvided
        ? getModelProfile(requestedModel).promptFamily
        : undefined;`, 'const forecastFamily = getModelProfile(probeModel).promptFamily;'],
    ['const forecastModel = options.modelProvided ? probeModel : undefined;', 'const forecastModel = probeModel;'],
    ["DEFAULT_PROBE_MODEL, getModelProfile, resolveNormalizedModel,", "DEFAULT_PROBE_MODEL, getModelProfile, getNormalizedModel, resolveNormalizedModel,"],
    ["    const probeModel = resolveNormalizedModel(requestedModel);", `    // ${marker}
    if (options.modelProvided && !getNormalizedModel(requestedModel)) {
        logError(\`Unknown probe model: \${requestedModel}; refusing model substitution\`);
        return 1;
    }
    const probeModel = resolveNormalizedModel(requestedModel);`],
    ["                model: probeModel,", "                model: probeModel,\n                fallbackModels: [],"],
    ["            liveQuotaByIndex.set(i, liveQuota);", `            if (liveQuota.model !== probeModel) {
                throw new Error(\`Probe model mismatch: requested \${probeModel}, received \${liveQuota.model}\`);
            }
            liveQuotaByIndex.set(i, liveQuota);`],
    ["            model: requestedModel,", "            model: requestedModel,\n            requestedModel,\n            probeModel,"],
    ["model ${requestedModel}, live check", 'model ${requestedModel}${requestedModel !== probeModel ? ` -> ${probeModel}` : ""}, live check'],
  ]],
  ["dist/lib/codex-manager/commands/report.js", [
    ['deps.resolveActiveIndex(storage, "codex")', 'deps.resolveActiveIndex(storage, modelInspection.promptFamily)'],
    ['deps.formatRateLimitEntry(account, now, "codex")', 'deps.formatRateLimitEntry(account, now, modelInspection.promptFamily)'],
    ['DEFAULT_PROBE_MODEL, getModelCapabilities, getModelProfile, resolveNormalizedModel,', 'DEFAULT_PROBE_MODEL, getModelCapabilities, getModelProfile, getNormalizedModel, resolveNormalizedModel,'],
    ['    const modelInspection = inspectRequestedModel(requestedModel);', `    if (options.modelProvided && !getNormalizedModel(requestedModel)) {
        logError(\`Unknown probe model: \${requestedModel}; refusing model substitution\`);
        return 1;
    }
    const modelInspection = inspectRequestedModel(requestedModel);`],
    [`const forecastFamily = options.modelProvided
        ? modelInspection.promptFamily
        : undefined;`, `// ${marker}
    const forecastFamily = modelInspection.promptFamily;`],
    [`const forecastModel = options.modelProvided
        ? modelInspection.normalized
        : undefined;`, 'const forecastModel = modelInspection.normalized;'],
    ['                    model: modelInspection.normalized,', '                    model: modelInspection.normalized,\n                    fallbackModels: [],'],
    ['                liveQuotaByIndex.set(i, liveQuota);', `                if (liveQuota.model !== modelInspection.normalized) {
                    throw new Error(\`Probe model mismatch: requested \${modelInspection.normalized}, received \${liveQuota.model}\`);
                }
                liveQuotaByIndex.set(i, liveQuota);`],
  ]],
  ["dist/lib/codex-manager/forecast-report-shared.js", [
    ["                    model: liveQuota.model,", `                    // ${marker}
                    model: liveQuota.model,
                    primary: { ...liveQuota.primary },
                    secondary: { ...liveQuota.secondary },`],
  ]],
];

// Plan and syntax-check every result before writing any target. A partial
// marker/shape is rejected; reapplication must be byte-identical.
const planned = [];
for (const [relative, replacements] of edits) {
  const target = path.join(root, relative);
  const original = fs.readFileSync(target, "utf8");
  let next = original;
  if (original.includes(marker)) {
    if (!replacements.every(([, value]) => original.includes(value))) {
      throw new Error(`incomplete Astra patch: ${relative}`);
    }
  } else {
    if (check) throw new Error(`missing Astra patch: ${relative}`);
    for (const [before, after] of replacements) {
      if (next.split(before).length !== 2) throw new Error(`unsupported Astra patch layout: ${relative}`);
      next = next.replace(before, after);
    }
  }
  const parsed = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: next, encoding: "utf8" });
  if (parsed.status !== 0) throw new Error(`invalid patched ${relative}: ${parsed.stderr}`);
  planned.push({ target, original, next });
}
for (const { target, original, next } of planned) {
  if (next === original) continue;
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, next, { mode: fs.statSync(target).mode & 0o777 });
  fs.renameSync(temporary, target);
}
console.log(`Astra catalog and exact-model quota diagnostics: ${check ? "verified" : "patched"}`);
