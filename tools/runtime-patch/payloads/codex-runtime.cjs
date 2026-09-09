const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const proxyPath = process.env.ROUTER_CODEX_PROXY_FILE;
const sessionAffinityPath = process.env.ROUTER_CODEX_SESSION_AFFINITY_FILE;
const identityMarker = "codex-multi-auth local compatibility: preserve official Codex client identity";
const rotationMarker = "codex-multi-auth local compatibility: rotate accounts for exact-model entitlement errors";
const fastTierMarker = "codex-multi-auth local policy: force Fast service tier";
const fastRoutingHintMarker = "codex-multi-auth r9 policy: bind canonical Fast routing hint to exact model";
const nonResponsesRoutingHintMarker = "codex-multi-auth r9 policy: strip Fast routing hint from non-Responses requests";
const standardTierMarker = "codex-multi-auth r14 policy: force Standard service tier";
const standardRoutingHintMarker = "codex-multi-auth r14 policy: bind canonical Standard routing hint to exact model";
const standardNonResponsesRoutingHintMarker = "codex-multi-auth r14 policy: strip managed routing hint from non-Responses requests";
const clientTierMarker = "codex-multi-auth r23 policy: honor per-request service tier";
const managedTierMarker = "codex-multi-auth r15 policy: enforce machine-local service tier";
const managedRoutingHintMarker = "codex-multi-auth r15 policy: bind canonical machine-local routing hint";
const managedNonResponsesRoutingHintMarker = "codex-multi-auth r15 policy: strip managed routing hint from non-Responses requests";
const legacyFastRoutingHintMarkers = [
  "codex-multi-auth local policy: bind Fast routing hint to exact model",
  "codex-multi-auth r8 policy: bind canonical Fast routing hint to exact model",
];
const sharedAdmissionMarker = "codex-multi-auth local policy: machine router owns request admission";
const sameAccountRetryMarker = "codex-multi-auth local policy: retry transient 429 on the sticky account";
const transientRetryMarker = "codex-multi-auth local policy: hide retryable transport and server failures";
const quotaBillingFailoverMarker = "codex-multi-auth r7 policy: rotate confirmed quota and billing failures";
const legacyLocalModelsMarker = "codex-multi-auth local policy: model discovery never reaches upstream";
const localModelsMarker = "codex-multi-auth r14 policy: serve local empty model catalog";
const terminalExhaustionMarker = "codex-multi-auth r10 policy: sanitize terminal pool exhaustion as retryable 503";
const poolStatusMarker = "codex-multi-auth r13 policy: authenticated aggregate pool status";
const advisoryQuotaMarker = "codex-multi-auth r16 policy: never persist advisory quota deferrals as rate limits";
const legacyStandardTierMarker = "codex-multi-auth local policy: force Standard service tier";
const quotaBillingFailoverLines = [
  `                // ${quotaBillingFailoverMarker}.`,
  "                if (!isPinned && isConfirmedQuotaExhaustion(errorCode)) {",
  "                    const retryAfterMs = managedClampRetryAfterMs(",
  "                        parseRetryAfterHeaderMs(upstream.headers, state.now()) ??",
  "                            parseRetryAfterBodyMs(bodyText, state.now()) ?? 60_000) ?? 60_000;",
  "                    admission.defer(retryAfterMs);",
  "                    state.preemptiveQuotaScheduler.markRateLimited(",
  "                        quotaScheduleKey, retryAfterMs, state.now());",
  "                    accountManager.recordRateLimit(",
  "                        refreshed.account, context.family, context.model);",
  "                    accountManager.markRateLimitedWithReason(",
  "                        refreshed.account, retryAfterMs, context.family, \"quota\", context.model);",
  "                    accountManager.saveToDiskDebounced();",
  "                    accountSkipReasons.set(refreshed.account.index, \"rate-limit\");",
  "                    exhaustionReason = \"rate-limit\";",
  "                    transientAttempts += 1;",
  "                    transientExhaustionReason = \"rate-limit\";",
  "                    state.status.retries += 1;",
  "                    state.status.rotations += 1;",
  "                    admissionRelease();",
  "                    if (await waitForManagedPoolIfReady({",
  "                        accountManager, family: context.family, model: context.model,",
  "                        attemptedIndexes, accountCount, isPinned,",
  "                        waitRounds: managedPoolWaitRounds, accountSkipReasons,",
  "                        lifecycle: managedLifecycle,",
  "                    })) {",
  "                        managedPoolWaitRounds += 1;",
  "                        transientAttempts = 0;",
  "                        transientExhaustionReason = null;",
  "                    }",
  "                    continue;",
  "                }",
];
const forcedHeaders = [
  "    headers.set(OPENAI_HEADERS.BETA, OPENAI_HEADER_VALUES.BETA_RESPONSES);",
  "    headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);",
];
const replacement = [
  `    // ${identityMarker}.`,
  "    // GPT-5.6 entitlement is keyed to the official client's originator/header",
  "    // contract. Keep the incoming values instead of downgrading them to the",
  "    // legacy codex_cli_rs + responses=experimental identity.",
].join("\n");

let source = fs.readFileSync(proxyPath, "utf8");
if (!source.includes(identityMarker)) {
  const needle = forcedHeaders.join("\n");
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(
      "unsupported codex-multi-auth runtime proxy layout; refusing an unsafe patch",
    );
  }
  source = source.slice(0, first) + replacement + source.slice(first + needle.length);
}

for (const forcedHeader of forcedHeaders) {
  if (source.includes(forcedHeader)) {
    throw new Error("legacy Codex client identity override remains after patching");
  }
}

if (source.includes(legacyStandardTierMarker)) {
  const legacyRewrites = [
    [legacyStandardTierMarker, fastTierMarker],
    ["function forceStandardServiceTier(parsedBody) {", "function forceFastServiceTier(parsedBody) {"],
    ["before Standard tier can be enforced.", "before Fast tier can be enforced."],
    ['service_tier: "default"', 'service_tier: "priority"'],
    ["const standardTierBody = forceStandardServiceTier(parsedBody);", "const fastTierBody = forceFastServiceTier(parsedBody);"],
    ["body: standardTierBody", "body: fastTierBody"],
  ];
  for (const [needle, replacementValue] of legacyRewrites) {
    const first = source.indexOf(needle);
    if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
      throw new Error(
        "unsupported codex-multi-auth Standard-tier migration layout; refusing an unsafe patch",
      );
    }
    source = source.slice(0, first) + replacementValue +
      source.slice(first + needle.length);
  }
}

if (!source.includes(fastTierMarker) && !source.includes(standardTierMarker) &&
    !source.includes(managedTierMarker)) {
  const contextNeedle = "function buildResponsesRequestContext(req, body) {";
  const contextFirst = source.indexOf(contextNeedle);
  if (contextFirst < 0 ||
      source.indexOf(contextNeedle, contextFirst + contextNeedle.length) >= 0) {
    throw new Error(
      "unsupported codex-multi-auth Responses context layout; refusing an unsafe patch",
    );
  }

  const helper = [
    `// ${fastTierMarker}.`,
    "function forceFastServiceTier(parsedBody) {",
    "    if (!parsedBody) {",
    "        throw new Error(\"Codex Responses body must be a JSON object before Fast tier can be enforced.\");",
    "    }",
    "    return Buffer.from(JSON.stringify({",
    "        ...parsedBody,",
    "        service_tier: \"priority\",",
    "    }), \"utf8\");",
    "}",
  ].join("\n");
  source = source.slice(0, contextFirst) + helper + "\n" +
    source.slice(contextFirst);

  const patchedContextFirst = source.indexOf(contextNeedle);
  const nextFunction = source.indexOf("\nfunction ", patchedContextFirst + contextNeedle.length);
  if (nextFunction < 0) {
    throw new Error(
      "unsupported codex-multi-auth Responses context boundary; refusing an unsafe patch",
    );
  }
  const parsedNeedle = "    const parsedBody = parseRequestBody(body);";
  const parsedFirst = source.indexOf(parsedNeedle, patchedContextFirst);
  const parsedSecond = source.indexOf(parsedNeedle, parsedFirst + parsedNeedle.length);
  if (parsedFirst < 0 || parsedFirst >= nextFunction ||
      (parsedSecond >= 0 && parsedSecond < nextFunction)) {
    throw new Error(
      "unsupported codex-multi-auth Responses body parser layout; refusing an unsafe patch",
    );
  }
  const parsedReplacement = [
    parsedNeedle,
    "    const fastTierBody = forceFastServiceTier(parsedBody);",
  ].join("\n");
  source = source.slice(0, parsedFirst) + parsedReplacement +
    source.slice(parsedFirst + parsedNeedle.length);

  const bodyNeedle = "        body,";
  const bodyFirst = source.indexOf(bodyNeedle, patchedContextFirst);
  const updatedNextFunction = source.indexOf("\nfunction ", patchedContextFirst + contextNeedle.length);
  const bodySecond = source.indexOf(bodyNeedle, bodyFirst + bodyNeedle.length);
  if (bodyFirst < 0 || bodyFirst >= updatedNextFunction ||
      (bodySecond >= 0 && bodySecond < updatedNextFunction)) {
    throw new Error(
      "unsupported codex-multi-auth Responses outbound body layout; refusing an unsafe patch",
    );
  }
  source = source.slice(0, bodyFirst) + "        body: fastTierBody," +
    source.slice(bodyFirst + bodyNeedle.length);
}

for (const legacyMarker of legacyFastRoutingHintMarkers) {
  const markerFirst = source.indexOf(legacyMarker);
  if (markerFirst < 0) continue;
  if (source.indexOf(legacyMarker, markerFirst + legacyMarker.length) >= 0) {
    throw new Error(
      "duplicate legacy Fast routing-hint markers; refusing an unsafe migration",
    );
  }
  const commonPrefix = [
    `    // ${legacyMarker}.`,
    "    // A custom local provider makes official Codex omit this ChatGPT routing",
    "    // contract. Canonicalize it once before retries or account failover.",
    "    headers.delete(\"x-codex-routing-hint\");",
  ];
  const legacyBlocks = [
    [
      ...commonPrefix,
      "    if (model) {",
      "        headers.set(\"x-codex-routing-hint\", `model=${model};tier=priority`);",
      "    }",
    ].join("\n"),
    [
      ...commonPrefix,
      "    if (!model || parsedBody.model !== model ||",
      "        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)) {",
      "        throw new Error(\"Codex Responses model must be a canonical model slug before Fast routing can be enforced.\");",
      "    }",
      "    headers.set(\"x-codex-routing-hint\", `model=${model};tier=priority`);",
    ].join("\n"),
  ];
  const matches = legacyBlocks.filter((block) => source.includes(block));
  if (matches.length !== 1) {
    throw new Error(
      "unsupported legacy Fast routing-hint layout; refusing an unsafe migration",
    );
  }
  const legacyBlock = matches[0];
  if (source.indexOf(legacyBlock, source.indexOf(legacyBlock) + legacyBlock.length) >= 0) {
    throw new Error(
      "duplicate legacy Fast routing-hint blocks; refusing an unsafe migration",
    );
  }
  source = source.replace(legacyBlock, "");
}

if (!source.includes(fastRoutingHintMarker) && !source.includes(standardRoutingHintMarker) &&
    !source.includes(managedRoutingHintMarker)) {
  const contextNeedle = "function buildResponsesRequestContext(req, body) {";
  const contextFirst = source.indexOf(contextNeedle);
  let nextFunction = source.indexOf("\nfunction ", contextFirst + contextNeedle.length);
  if (contextFirst < 0 || nextFunction < 0 ||
      source.indexOf(contextNeedle, contextFirst + contextNeedle.length) >= 0) {
    throw new Error(
      "unsupported codex-multi-auth Fast routing context; refusing an unsafe patch",
    );
  }
  const modelNeedle = [
    "    const model = typeof parsedBody?.model === \"string\" && parsedBody.model.trim().length > 0",
    "        ? parsedBody.model.trim()",
    "        : null;",
  ].join("\n");
  let modelFirst = source.indexOf(modelNeedle, contextFirst);
  if (modelFirst < 0) {
    const tierBodyNeedle = "    const fastTierBody = forceFastServiceTier(parsedBody);";
    const tierBodyFirst = source.indexOf(tierBodyNeedle, contextFirst);
    const tierBodySecond = source.indexOf(tierBodyNeedle, tierBodyFirst + tierBodyNeedle.length);
    if (tierBodyFirst < 0 || tierBodyFirst >= nextFunction ||
        (tierBodySecond >= 0 && tierBodySecond < nextFunction)) {
      throw new Error(
        "unsupported codex-multi-auth Responses model insertion boundary; refusing an unsafe patch",
      );
    }
    const insertionAt = tierBodyFirst + tierBodyNeedle.length;
    source = source.slice(0, insertionAt) + "\n" + modelNeedle +
      source.slice(insertionAt);
    modelFirst = source.indexOf(modelNeedle, contextFirst);
    nextFunction = source.indexOf("\nfunction ", contextFirst + contextNeedle.length);
  }
  const modelSecond = source.indexOf(modelNeedle, modelFirst + modelNeedle.length);
  if (modelFirst < 0 || modelFirst >= nextFunction ||
      (modelSecond >= 0 && modelSecond < nextFunction)) {
    throw new Error(
      "unsupported codex-multi-auth Responses model layout; refusing an unsafe patch",
    );
  }
  const modelReplacement = [
    modelNeedle,
    `    // ${fastRoutingHintMarker}.`,
    "    // A custom local provider makes official Codex omit this ChatGPT routing",
    "    // contract. Canonicalize it once before retries or account failover.",
    "    headers.delete(\"x-codex-routing-hint\");",
    "    if (!model || parsedBody.model !== model ||",
    "        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)) {",
    "        throw new Error(\"Codex Responses model must be a canonical model slug before Fast routing can be enforced.\");",
    "    }",
    "    headers.set(\"x-codex-routing-hint\", `model=${model};tier=priority`);",
  ].join("\n");
  source = source.slice(0, modelFirst) + modelReplacement +
    source.slice(modelFirst + modelNeedle.length);
}

if (!source.includes(nonResponsesRoutingHintMarker) &&
    !source.includes(standardNonResponsesRoutingHintMarker) &&
    !source.includes(managedNonResponsesRoutingHintMarker)) {
  const contextNeedle = "function buildThreadGoalRequestContext(req, body, pathname) {";
  const contextFirst = source.indexOf(contextNeedle);
  const nextFunction = source.indexOf("\nfunction ", contextFirst + contextNeedle.length);
  if (contextFirst < 0 || nextFunction < 0 ||
      source.indexOf(contextNeedle, contextFirst + contextNeedle.length) >= 0) {
    throw new Error(
      "unsupported codex-multi-auth thread-goal context; refusing an unsafe patch",
    );
  }
  const headersNeedle = "    const headers = headersFromIncoming(req);";
  const headersFirst = source.indexOf(headersNeedle, contextFirst);
  const headersSecond = source.indexOf(headersNeedle, headersFirst + headersNeedle.length);
  if (headersFirst < 0 || headersFirst >= nextFunction ||
      (headersSecond >= 0 && headersSecond < nextFunction)) {
    throw new Error(
      "unsupported codex-multi-auth thread-goal headers layout; refusing an unsafe patch",
    );
  }
  const headersReplacement = [
    headersNeedle,
    `    // ${nonResponsesRoutingHintMarker}.`,
    "    headers.delete(\"x-codex-routing-hint\");",
  ].join("\n");
  source = source.slice(0, headersFirst) + headersReplacement +
    source.slice(headersFirst + headersNeedle.length);
}

if (!source.includes(standardTierMarker) && !source.includes(managedTierMarker)) {
  const standardTierRewrites = [
    [fastTierMarker, standardTierMarker],
    ["function forceFastServiceTier(parsedBody) {", "function forceStandardServiceTier(parsedBody) {"],
    ["before Fast tier can be enforced.", "before Standard tier can be enforced."],
    ['service_tier: "priority"', 'service_tier: "default"'],
    ["const fastTierBody = forceFastServiceTier(parsedBody);", "const standardTierBody = forceStandardServiceTier(parsedBody);"],
    ["body: fastTierBody", "body: standardTierBody"],
    [fastRoutingHintMarker, standardRoutingHintMarker],
    ["before Fast routing can be enforced.", "before Standard routing can be enforced."],
    ['headers.set("x-codex-routing-hint", `model=${model};tier=priority`);',
      'headers.set("x-codex-routing-hint", `model=${model};tier=default`);'],
    [nonResponsesRoutingHintMarker, standardNonResponsesRoutingHintMarker],
  ];
  for (const [needle, replacementValue] of standardTierRewrites) {
    const first = source.indexOf(needle);
    if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
      throw new Error(
        "unsupported Codex Standard-tier migration layout; refusing an unsafe patch",
      );
    }
    source = source.slice(0, first) + replacementValue +
      source.slice(first + needle.length);
  }
}

if (!source.includes(managedTierMarker)) {
  const managedTierRewrites = [
    [standardTierMarker, managedTierMarker],
    ["function forceStandardServiceTier(parsedBody) {", "function forceManagedServiceTier(parsedBody) {"],
    ["before Standard tier can be enforced.", "before the managed service tier can be enforced."],
    ['service_tier: "default"', 'service_tier: managedServiceTierWireValue()'],
    ["const standardTierBody = forceStandardServiceTier(parsedBody);", "const managedTierBody = forceManagedServiceTier(parsedBody);"],
    ["body: standardTierBody", "body: managedTierBody"],
    [standardRoutingHintMarker, managedRoutingHintMarker],
    ["before Standard routing can be enforced.", "before managed service-tier routing can be enforced."],
    ['headers.set("x-codex-routing-hint", `model=${model};tier=default`);',
      'headers.set("x-codex-routing-hint", `model=${model};tier=${managedServiceTierWireValue()}`);'],
    [standardNonResponsesRoutingHintMarker, managedNonResponsesRoutingHintMarker],
  ];
  for (const [needle, replacementValue] of managedTierRewrites) {
    const first = source.indexOf(needle);
    if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
      throw new Error(
        "unsupported Codex machine-local tier migration layout; refusing an unsafe patch",
      );
    }
    source = source.slice(0, first) + replacementValue +
      source.slice(first + needle.length);
  }

  const managedTierBoundary = `// ${managedTierMarker}.`;
  const managedTierFirst = source.indexOf(managedTierBoundary);
  if (managedTierFirst < 0 ||
      source.indexOf(managedTierBoundary, managedTierFirst + managedTierBoundary.length) >= 0) {
    throw new Error("managed Codex service-tier boundary is missing or duplicated");
  }
  const managedTierHelper = [
    "const MANAGED_SERVICE_TIER = (() => {",
    "    const configured = String(process.env.CODEX_MANAGED_SERVICE_TIER ?? \"default\").trim();",
    "    if (configured === \"default\") return Object.freeze({ label: \"default\", wire: \"default\" });",
    "    if (configured === \"fast\") return Object.freeze({ label: \"fast\", wire: \"priority\" });",
    "    if (configured === \"ultrafast\") return Object.freeze({ label: \"ultrafast\", wire: \"ultrafast\" });",
    "    throw new Error(\"CODEX_MANAGED_SERVICE_TIER must be default, fast, or ultrafast\");",
    "})();",
    "function managedServiceTierWireValue() { return MANAGED_SERVICE_TIER.wire; }",
    "function managedServiceTierLabel() { return MANAGED_SERVICE_TIER.label; }",
  ].join("\n");
  source = source.slice(0, managedTierFirst) + managedTierHelper + "\n" +
    source.slice(managedTierFirst);
}

// Runtimes already carrying the r15 machine-tier boundary predate Codex's
// Ultrafast wire value. Upgrade the helper in place so patch-codex-runtime is
// idempotent across that published revision as well as on a pristine package.
const legacyManagedTierHelper = [
  "const MANAGED_SERVICE_TIER = (() => {",
  "    const configured = String(process.env.CODEX_MANAGED_SERVICE_TIER ?? \"default\").trim();",
  "    if (configured === \"default\") return Object.freeze({ label: \"default\", wire: \"default\" });",
  "    if (configured === \"fast\") return Object.freeze({ label: \"fast\", wire: \"priority\" });",
  "    throw new Error(\"CODEX_MANAGED_SERVICE_TIER must be default or fast\");",
  "})();",
].join("\n");
if (source.includes(managedTierMarker) && !source.includes(clientTierMarker) &&
    !source.includes('if (configured === "ultrafast") return Object.freeze({ label: "ultrafast", wire: "ultrafast" });')) {
  const legacyManagedTierFirst = source.indexOf(legacyManagedTierHelper);
  if (legacyManagedTierFirst < 0 ||
      source.indexOf(legacyManagedTierHelper,
        legacyManagedTierFirst + legacyManagedTierHelper.length) >= 0) {
    throw new Error(
      "unsupported Codex managed-tier helper migration layout; refusing an unsafe patch",
    );
  }
  const ultrafastManagedTierHelper = legacyManagedTierHelper
    .replace(
      '    throw new Error("CODEX_MANAGED_SERVICE_TIER must be default or fast");',
      [
        '    if (configured === "ultrafast") return Object.freeze({ label: "ultrafast", wire: "ultrafast" });',
        '    throw new Error("CODEX_MANAGED_SERVICE_TIER must be default, fast, or ultrafast");',
      ].join("\n"),
    );
  source = source.slice(0, legacyManagedTierFirst) + ultrafastManagedTierHelper +
    source.slice(legacyManagedTierFirst + legacyManagedTierHelper.length);
}

if (!source.includes(rotationMarker)) {
  const helperNeedle = "function writeJson(res, status, payload) {";
  const helperFirst = source.indexOf(helperNeedle);
  if (helperFirst < 0 || source.indexOf(helperNeedle, helperFirst + helperNeedle.length) >= 0) {
    throw new Error(
      "unsupported codex-multi-auth runtime helper layout; refusing an unsafe patch",
    );
  }
  const helperReplacement = [
    `// ${rotationMarker}.`,
    "function isAccountModelEntitlementError(status, model, errorCode, bodyText) {",
    "    if ((status !== HTTP_STATUS.BAD_REQUEST && status !== HTTP_STATUS.FORBIDDEN) ||",
    "        typeof model !== \"string\" || !model.trim()) {",
    "        return false;",
    "    }",
    "    const normalizedCode = (errorCode ?? \"\").trim().toLowerCase();",
    "    if (normalizedCode === \"unsupported_model\" || normalizedCode === \"model_not_supported\") {",
    "        return true;",
    "    }",
    "    return bodyText.toLowerCase().includes(\"model is not supported when using codex with a chatgpt account\");",
    "}",
    helperNeedle,
  ].join("\n");
  source = source.slice(0, helperFirst) + helperReplacement +
    source.slice(helperFirst + helperNeedle.length);

  const badRequestNeedle = "            if (upstream.status === 402 || upstream.status === HTTP_STATUS.FORBIDDEN) {";
  const badRequestFirst = source.indexOf(badRequestNeedle);
  if (badRequestFirst < 0 || source.indexOf(badRequestNeedle, badRequestFirst + badRequestNeedle.length) >= 0) {
    throw new Error(
      "unsupported codex-multi-auth runtime response layout; refusing an unsafe patch",
    );
  }
  const badRequestReplacement = [
    "            if (!isThreadGoalRequest && upstream.status === HTTP_STATUS.BAD_REQUEST) {",
    "                const bodyText = await readErrorBody(upstream, state.streamStallTimeoutMs);",
    "                const errorCode = extractErrorCodeFromBody(bodyText);",
    "                if (!isPinned &&",
    "                    isAccountModelEntitlementError(upstream.status, context.model, errorCode, bodyText)) {",
    "                    // Retry the immutable request against another account. The exact",
    "                    // requested model remains in context.body; substitution is forbidden.",
    "                    accountManager.refundToken(refreshed.account, context.family, context.model);",
    "                    accountSkipReasons.set(refreshed.account.index, \"model-unsupported\");",
    "                    exhaustionReason = \"model-unsupported\";",
    "                    transientAttempts += 1;",
    "                    transientExhaustionReason = \"model-unsupported\";",
    "                    state.status.retries += 1;",
    "                    state.status.rotations += 1;",
    "                    continue;",
    "                }",
    "                res.writeHead(upstream.status, responseHeadersForClient(upstream.headers));",
    "                res.end(bodyText);",
    "                await usageRecorder.record({",
    "                    outcome: \"failure\",",
    "                    statusCode: upstream.status,",
    "                    errorCode,",
    "                    account: refreshed.account,",
    "                });",
    "                return;",
    "            }",
    badRequestNeedle,
  ].join("\n");
  source = source.slice(0, badRequestFirst) + badRequestReplacement +
    source.slice(badRequestFirst + badRequestNeedle.length);

  const forbiddenNeedle = [
    "                const errorCode = extractErrorCodeFromBody(bodyText);",
    "                if (isWorkspaceDisabledError(upstream.status, errorCode, bodyText)) {",
  ].join("\n");
  const forbiddenFirst = source.indexOf(forbiddenNeedle);
  if (forbiddenFirst < 0 || source.indexOf(forbiddenNeedle, forbiddenFirst + forbiddenNeedle.length) >= 0) {
    throw new Error(
      "unsupported codex-multi-auth forbidden-response layout; refusing an unsafe patch",
    );
  }
  const forbiddenReplacement = [
    "                const errorCode = extractErrorCodeFromBody(bodyText);",
    "                if (!isPinned &&",
    "                    isAccountModelEntitlementError(upstream.status, context.model, errorCode, bodyText)) {",
    "                    accountManager.refundToken(refreshed.account, context.family, context.model);",
    "                    accountSkipReasons.set(refreshed.account.index, \"model-unsupported\");",
    "                    exhaustionReason = \"model-unsupported\";",
    "                    transientAttempts += 1;",
    "                    transientExhaustionReason = \"model-unsupported\";",
    "                    state.status.retries += 1;",
    "                    state.status.rotations += 1;",
    "                    continue;",
    "                }",
    ...quotaBillingFailoverLines,
    "                if (isWorkspaceDisabledError(upstream.status, errorCode, bodyText)) {",
  ].join("\n");
  source = source.slice(0, forbiddenFirst) + forbiddenReplacement +
    source.slice(forbiddenFirst + forbiddenNeedle.length);
}

// r6 already carries rotationMarker, so quota/billing failover needs its own
// migration marker and structural insertion point. This also makes later r7
// policy changes independently auditable instead of hiding behind an old marker.
if (!source.includes(quotaBillingFailoverMarker)) {
  const workspaceDisabledNeedle =
    "                if (isWorkspaceDisabledError(upstream.status, errorCode, bodyText)) {";
  const workspaceDisabledFirst = source.indexOf(workspaceDisabledNeedle);
  if (workspaceDisabledFirst < 0 ||
      source.indexOf(workspaceDisabledNeedle,
        workspaceDisabledFirst + workspaceDisabledNeedle.length) >= 0) {
    throw new Error(
      "unsupported codex-multi-auth r7 quota/billing failover boundary; refusing an unsafe patch",
    );
  }
  source = source.slice(0, workspaceDisabledFirst) +
    quotaBillingFailoverLines.join("\n") + "\n" +
    source.slice(workspaceDisabledFirst);
}

const localModelsLines = [
  `        // ${localModelsMarker}.`,
  "        // A successful empty catalog makes official Codex retain its bundled",
  "        // definitions without logging a startup error. Keep discovery local so",
  "        // it never selects an account, attaches OAuth, or consumes quota.",
  "        if (isModelsRequest) {",
  "            writeJson(res, HTTP_STATUS.OK, { models: [] });",
  "            return;",
  "        }",
];
if (source.includes(legacyLocalModelsMarker)) {
  if (source.includes(localModelsMarker)) {
    throw new Error("mixed legacy/current local model-catalog policies; refusing an unsafe patch");
  }
  const legacyLocalModelsLines = [
    `        // ${legacyLocalModelsMarker}.`,
    "        // ChatGPT OAuth normally rejects /models, while resident app servers",
    "        // poll it every few seconds. Forwarding that diagnostic traffic adds",
    "        // thousands of useless requests to the same provider rate-limit lane.",
    "        if (isModelsRequest) {",
    "            writeJson(res, HTTP_STATUS.FORBIDDEN, {",
    "                error: {",
    "                    message: \"Model discovery is unavailable for the managed ChatGPT account pool; Codex uses its built-in catalog.\",",
    "                    code: \"codex_managed_model_discovery_disabled\",",
    "                },",
    "            });",
    "            return;",
    "        }",
  ];
  const legacyLocalModelsBlock = legacyLocalModelsLines.join("\n");
  const legacyLocalModelsFirst = source.indexOf(legacyLocalModelsBlock);
  if (legacyLocalModelsFirst < 0 ||
      source.indexOf(legacyLocalModelsBlock,
        legacyLocalModelsFirst + legacyLocalModelsBlock.length) >= 0) {
    throw new Error("unsupported legacy local model-catalog policy; refusing an unsafe patch");
  }
  source = source.slice(0, legacyLocalModelsFirst) + localModelsLines.join("\n") +
    source.slice(legacyLocalModelsFirst + legacyLocalModelsBlock.length);
}

if (!source.includes(localModelsMarker)) {
  const pathGateNeedle = [
    "        if (!isResponsesRequest && !isModelsRequest && !isThreadGoalRequest) {",
    "            writeMethodOrPathError(res);",
    "            return;",
    "        }",
    "        state.status.totalRequests += 1;",
  ].join("\n");
  const pathGateReplacement = [
    "        if (!isResponsesRequest && !isModelsRequest && !isThreadGoalRequest) {",
    "            writeMethodOrPathError(res);",
    "            return;",
    "        }",
    ...localModelsLines,
    "        state.status.totalRequests += 1;",
  ].join("\n");
  const first = source.indexOf(pathGateNeedle);
  if (first < 0 || source.indexOf(pathGateNeedle, first + pathGateNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth request path gate; refusing an unsafe patch");
  }
  source = source.slice(0, first) + pathGateReplacement +
    source.slice(first + pathGateNeedle.length);
}

if (!source.includes(sharedAdmissionMarker)) {
  const tokenGateNeedle = [
    "            if (!accountManager.consumeToken(selected, context.family, context.model)) {",
    "                accountSkipReasons.set(selected.index, \"token-exhausted\");",
    "                exhaustionReason = \"rate-limit\";",
    "                continue;",
    "            }",
  ].join("\n");
  const tokenGateReplacement = [
    `            // ${sharedAdmissionMarker}.`,
    "            // The upstream package's 50-token/6-RPM bucket is process-local:",
    "            // it both false-exhausts a busy multi-agent session and fails to",
    "            // coordinate parallel helpers. The managed singleton provides the",
    "            // shared admission/cooldown boundary and reacts to real upstream 429s.",
  ].join("\n");
  const first = source.indexOf(tokenGateNeedle);
  if (first < 0 || source.indexOf(tokenGateNeedle, first + tokenGateNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth token admission gate; refusing an unsafe patch");
  }
  source = source.slice(0, first) + tokenGateReplacement +
    source.slice(first + tokenGateNeedle.length);

  const stateNeedle = [
    "        preemptiveQuotaScheduler,",
    "        sessionAffinityStore,",
    "        lastObservedAffinityGeneration,",
  ].join("\n");
  const stateReplacement = [
    "        preemptiveQuotaScheduler,",
    "        sessionAffinityStore,",
    "        managedMachineRouter: options.managedMachineRouter === true,",
    "        managedAdmissionLanes: new Map(),",
    "        managedAffinityWriteVersion: 0,",
    "        lastObservedAffinityGeneration,",
  ].join("\n");
  const stateFirst = source.indexOf(stateNeedle);
  if (stateFirst < 0 || source.indexOf(stateNeedle, stateFirst + stateNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth proxy-state initialization; refusing an unsafe patch");
  }
  source = source.slice(0, stateFirst) + stateReplacement +
    source.slice(stateFirst + stateNeedle.length);
}

if (!source.includes(sameAccountRetryMarker)) {
  const helperNeedle = "function writeJson(res, status, payload) {";
  const helperFirst = source.indexOf(helperNeedle);
  if (helperFirst < 0 || source.indexOf(helperNeedle, helperFirst + helperNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth JSON helper layout; refusing an unsafe patch");
  }
  const retryHelpers = [
    `// ${sameAccountRetryMarker}.`,
    "const MANAGED_SAME_ACCOUNT_TRANSIENT_RETRIES = 2;",
    "const MANAGED_MAX_BACKGROUND_WAIT_MS = 15_000;",
    "const MANAGED_POOL_WAIT_ROUNDS = 2;",
    "const MANAGED_TRANSIENT_429_COOLDOWN_MS = 5_000;",
    "const MANAGED_REQUEST_RETRY_DEADLINE_MS = 120_000;",
    "const MANAGED_MAX_UPSTREAM_ATTEMPTS = 64;",
    "const MANAGED_MAX_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;",
    "const MANAGED_MAX_PREHEADER_IN_FLIGHT_PER_ACCOUNT = 4;",
    "function managedDeadlineNow() {",
    "    return performance.now();",
    "}",
    "function managedClampRetryAfterMs(value) {",
    "    if (!Number.isFinite(value) || value <= 0) return null;",
    "    return Math.min(MANAGED_MAX_RETRY_AFTER_MS, Math.floor(value));",
    "}",
    "function isConfirmedQuotaExhaustion(errorCode) {",
    "    const normalized = (errorCode ?? \"\").trim().toLowerCase();",
    "    return normalized.includes(\"quota\") ||",
    "        normalized.includes(\"usage_limit\") ||",
    "        normalized.includes(\"spend_limit\") ||",
    "        normalized.includes(\"credit_balance\") ||",
    "        normalized.includes(\"billing_hard_limit\") ||",
    "        normalized.includes(\"payment_required\");",
    "}",
    "function shouldRetry429OnSameAccount(errorCode, explicitRetryAfterMs) {",
    "    if (isConfirmedQuotaExhaustion(errorCode)) return false;",
    "    return explicitRetryAfterMs === null ||",
    "        explicitRetryAfterMs <= MANAGED_MAX_BACKGROUND_WAIT_MS;",
    "}",
    "function isManagedRetryableStatus(status) {",
    "    if (status === 408 || status === 409 || status === 425) return true;",
    "    return status >= 500 && status < 600 && ![501, 505, 511].includes(status);",
    "}",
    "function managedRetryDelayMs(attempt, explicitRetryAfterMs = null) {",
    "    const exponential = Math.min(4_000, 500 * (2 ** Math.max(0, attempt)));",
    "    const requiredDelay = managedClampRetryAfterMs(explicitRetryAfterMs) ?? 0;",
    "    return Math.min(MANAGED_MAX_BACKGROUND_WAIT_MS,",
    "        Math.max(exponential, requiredDelay) + Math.floor(Math.random() * 250));",
    "}",
    "function createManagedRequestLifecycle(req, res) {",
    "    const controller = new AbortController();",
    "    let cancelled = false;",
    "    const abort = () => {",
    "        if (controller.signal.aborted) return;",
    "        cancelled = true;",
    "        const error = new Error(\"managed Codex request cancelled\");",
    "        error.code = \"CODEX_MANAGED_REQUEST_CANCELLED\";",
    "        controller.abort(error);",
    "    };",
    "    const onResponseClose = () => {",
    "        if (!res.writableEnded) abort();",
    "    };",
    "    req.once(\"aborted\", abort);",
    "    res.once(\"close\", onResponseClose);",
    "    return {",
    "        signal: controller.signal,",
    "        deadlineAt: managedDeadlineNow() + MANAGED_REQUEST_RETRY_DEADLINE_MS,",
    "        get cancelled() { return cancelled; },",
    "        cleanup() {",
    "            req.off(\"aborted\", abort);",
    "            res.off(\"close\", onResponseClose);",
    "        },",
    "    };",
    "}",
    "function managedCancellationError(message, code = \"CODEX_MANAGED_REQUEST_CANCELLED\") {",
    "    const error = new Error(message);",
    "    error.code = code;",
    "    return error;",
    "}",
    "function managedSleep(ms, lifecycle) {",
    "    const delayMs = Math.max(0, Math.floor(ms));",
    "    if (lifecycle.signal.aborted ||",
    "        managedDeadlineNow() + delayMs > lifecycle.deadlineAt) {",
    "        return Promise.resolve(false);",
    "    }",
    "    return new Promise((resolve) => {",
    "        let settled = false;",
    "        const finish = (completed) => {",
    "            if (settled) return;",
    "            settled = true;",
    "            clearTimeout(timer);",
    "            lifecycle.signal.removeEventListener(\"abort\", onAbort);",
    "            resolve(completed);",
    "        };",
    "        const onAbort = () => finish(false);",
    "        const timer = setTimeout(() => finish(true), delayMs);",
    "        lifecycle.signal.addEventListener(\"abort\", onAbort, { once: true });",
    "    });",
    "}",
    "function managedAwaitLifecycle(promise, lifecycle, onCancel = () => undefined) {",
    "    if (lifecycle.signal.aborted) {",
    "        onCancel();",
    "        return Promise.reject(managedCancellationError(\"managed Codex request cancelled\"));",
    "    }",
    "    const remainingMs = Math.max(1, lifecycle.deadlineAt - managedDeadlineNow());",
    "    return new Promise((resolve, reject) => {",
    "        let settled = false;",
    "        const finish = (callback, value) => {",
    "            if (settled) return;",
    "            settled = true;",
    "            clearTimeout(timer);",
    "            lifecycle.signal.removeEventListener(\"abort\", onAbort);",
    "            callback(value);",
    "        };",
    "        const cancel = (message, code = \"CODEX_MANAGED_REQUEST_CANCELLED\") => {",
    "            try { onCancel(); } catch { /* cancellation remains best-effort */ }",
    "            finish(reject, managedCancellationError(message, code));",
    "        };",
    "        const onAbort = () => cancel(\"managed Codex request cancelled\");",
    "        const timer = setTimeout(() => cancel(\"managed Codex request deadline exceeded\",",
    "            \"CODEX_MANAGED_REQUEST_DEADLINE\"),",
    "            remainingMs);",
    "        lifecycle.signal.addEventListener(\"abort\", onAbort, { once: true });",
    "        Promise.resolve(promise).then(",
    "            (value) => finish(resolve, value),",
    "            (error) => finish(reject, error),",
    "        );",
    "    });",
    "}",
    "async function managedReadErrorBody(response, timeoutMs, lifecycle, maxBytes = 1024 * 1024) {",
    "    const body = response.body;",
    "    if (!body || typeof body.getReader !== \"function\") {",
    "        const cancelBody = () => {",
    "            try { void body?.cancel?.()?.catch(() => undefined); }",
    "            catch { /* body cancellation remains best-effort */ }",
    "        };",
    "        return managedAwaitLifecycle(response.text(), lifecycle, cancelBody);",
    "    }",
    "    const reader = body.getReader();",
    "    const cancelReader = () => { void reader.cancel().catch(() => undefined); };",
    "    const chunks = [];",
    "    let total = 0;",
    "    try {",
    "        for (;;) {",
    "            let result;",
    "            try {",
    "                result = await managedAwaitLifecycle(withTimeout(",
    "                    reader.read(), timeoutMs, cancelReader, \"error body stalled\"),",
    "                    lifecycle, cancelReader);",
    "            }",
    "            catch (error) {",
    "                if (lifecycle.cancelled ||",
    "                    error?.code === \"CODEX_MANAGED_REQUEST_CANCELLED\" ||",
    "                    error?.code === \"CODEX_MANAGED_REQUEST_DEADLINE\") throw error;",
    "                break;",
    "            }",
    "            if (result.done) break;",
    "            if (!result.value) continue;",
    "            total += result.value.byteLength;",
    "            if (total > maxBytes) break;",
    "            chunks.push(result.value);",
    "        }",
    "    }",
    "    finally {",
    "        await reader.cancel().catch(() => undefined);",
    "    }",
    "    try { return Buffer.concat(chunks).toString(\"utf8\"); }",
    "    catch { return \"\"; }",
    "}",
    "function managedAffinityKey(model, sessionKey) {",
    "    if (typeof sessionKey !== \"string\" || !sessionKey.trim()) return null;",
    "    const exactModel = typeof model === \"string\" && model.trim() ? model.trim() : \"<none>\";",
    "    return `managed-v1:${createHash(\"sha256\")",
    "        .update(`v1\\0${exactModel}\\0${sessionKey.trim()}`)",
    "        .digest(\"hex\")}`;",
    "}",
    "function managedAdmissionLane(state, accountIndex) {",
    "    let lane = state.managedAdmissionLanes.get(accountIndex);",
    "    if (!lane) {",
    "        lane = { inFlight: 0, retryNotBefore: 0 };",
    "        state.managedAdmissionLanes.set(accountIndex, lane);",
    "    }",
    "    return lane;",
    "}",
    "function deferManagedAdmission(state, accountIndex, retryAfterMs) {",
    "    const boundedRetryAfterMs = managedClampRetryAfterMs(retryAfterMs);",
    "    if (boundedRetryAfterMs === null) return;",
    "    const lane = managedAdmissionLane(state, accountIndex);",
    "    lane.retryNotBefore = Math.max(lane.retryNotBefore, Date.now() + boundedRetryAfterMs);",
    "}",
    "async function acquireManagedAdmission(state, accountIndex, lifecycle) {",
    "    if (lifecycle.signal.aborted || managedDeadlineNow() >= lifecycle.deadlineAt) return null;",
    "    const lane = managedAdmissionLane(state, accountIndex);",
    "    while (lane.inFlight >= MANAGED_MAX_PREHEADER_IN_FLIGHT_PER_ACCOUNT) {",
    "        if (lane.retryNotBefore > Date.now())",
    "            return { reselect: true, reason: \"admission-deferred\" };",
    "        const remainingMs = lifecycle.deadlineAt - managedDeadlineNow();",
    "        if (remainingMs <= 0 ||",
    "            !await managedSleep(Math.min(250, Math.max(25, remainingMs)), lifecycle))",
    "            return null;",
    "    }",
    "    if (lane.retryNotBefore > Date.now())",
    "        return { reselect: true, reason: \"admission-deferred\" };",
    "    lane.inFlight += 1;",
    "    let released = false;",
    "    const defer = (retryAfterMs) => deferManagedAdmission(state, accountIndex, retryAfterMs);",
    "    const release = () => {",
    "        if (released) return;",
    "        released = true;",
    "        lane.inFlight = Math.max(0, lane.inFlight - 1);",
    "    };",
    "    return { reselect: false, defer, release };",
    "}",
    "function revalidateManagedAdmission(params) {",
    "    const { state, accountManager, selected, family, model, policyDecision,",
    "        preemptiveQuotaScheduler, quotaScheduleKey, now } = params;",
    "    const lane = managedAdmissionLane(state, selected.index);",
    "    if (lane.retryNotBefore > Date.now())",
    "        return { account: null, reason: \"admission-deferred\" };",
    "    const account = accountManager.getAccountByIndex(selected.index);",
    "    if (!account) return { account: null, reason: \"missing\" };",
    "    if (account.enabled === false) return { account, reason: \"disabled\" };",
    "    if (policyDecision?.blockedAccountIndexes?.has(selected.index))",
    "        return { account, reason: \"policy-blocked\" };",
    "    const runtimeReason = accountManager.getManagedAccountRuntimeSkipReason(",
    "        account, family, model);",
    "    if (runtimeReason) return { account, reason: runtimeReason };",
    "    const quotaDeferral = preemptiveQuotaScheduler.getDeferral(quotaScheduleKey, now);",
    "    if (quotaDeferral.defer && quotaDeferral.waitMs > 0)",
    "        return { account, reason: quotaDeferral.reason ?? \"quota-near-exhaustion\" };",
    "    return { account, reason: null };",
    "}",
    "async function waitForManagedPoolIfReady(params) {",
    "    const { accountManager, family, model, attemptedIndexes, accountCount,",
    "        isPinned, waitRounds, accountSkipReasons, lifecycle,",
    "        allUnavailable = false } = params;",
    "    if (isPinned || (!allUnavailable && attemptedIndexes.size < accountCount) ||",
    "        waitRounds >= MANAGED_POOL_WAIT_ROUNDS) return false;",
    "    const poolWaitMs = accountManager.getMinWaitTimeForFamily(family, model);",
    "    if (poolWaitMs <= 0 || poolWaitMs > MANAGED_MAX_BACKGROUND_WAIT_MS) return false;",
    "    const boundedWaitMs = Math.min(MANAGED_MAX_BACKGROUND_WAIT_MS,",
    "        poolWaitMs + Math.floor(Math.random() * 250));",
    "    if (!await managedSleep(boundedWaitMs, lifecycle)) return false;",
    "    attemptedIndexes.clear();",
    "    accountSkipReasons.clear();",
    "    return true;",
    "}",
    helperNeedle,
  ].join("\n");
  source = source.slice(0, helperFirst) + retryHelpers +
    source.slice(helperFirst + helperNeedle.length);

  const requestArrivalNeedle = [
    "    const traceId = randomUUID();",
    "    return runWithCorrelationId(traceId, () => handleRequestInner(state, req, res, traceId));",
    "}",
    "async function handleRequestInner(state, req, res, traceId) {",
    "    let usageRecorder = null;",
    "    let accountManager = state.activeAccountManager;",
    "    try {",
  ].join("\n");
  const requestArrivalReplacement = [
    "    const traceId = randomUUID();",
    "    // Allocate arrival order before handleRequestInner reaches its first await.",
    "    const managedAffinityWriteVersion = (++state.managedAffinityWriteVersion) * 4;",
    "    return runWithCorrelationId(traceId, () => handleRequestInner(",
    "        state, req, res, traceId, managedAffinityWriteVersion));",
    "}",
    "async function handleRequestInner(state, req, res, traceId, managedAffinityWriteVersion) {",
    "    let usageRecorder = null;",
    "    let accountManager = state.activeAccountManager;",
    "    const managedLifecycle = createManagedRequestLifecycle(req, res);",
    "    try {",
  ].join("\n");
  const requestArrivalFirst = source.indexOf(requestArrivalNeedle);
  if (requestArrivalFirst < 0 ||
      source.indexOf(requestArrivalNeedle, requestArrivalFirst + requestArrivalNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth request arrival boundary; refusing an unsafe patch");
  }
  source = source.slice(0, requestArrivalFirst) + requestArrivalReplacement +
    source.slice(requestArrivalFirst + requestArrivalNeedle.length);

  const contextNeedle = "                : buildResponsesRequestContext(req, requestBody);";
  const contextReplacement = [
    contextNeedle,
    "        const managedSessionAffinityKey = managedAffinityKey(context.model, context.sessionKey);",
  ].join("\n");
  const contextFirst = source.indexOf(contextNeedle);
  if (contextFirst < 0 || source.indexOf(contextNeedle, contextFirst + contextNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth managed affinity-key boundary; refusing an unsafe patch");
  }
  source = source.slice(0, contextFirst) + contextReplacement +
    source.slice(contextFirst + contextNeedle.length);

  const loopStateNeedle = [
    "        let transientExhaustionReason = null;",
    "        const accountSkipReasons = new Map();",
    "        let reloadedAfterNoAccount = false;",
  ].join("\n");
  const loopStateReplacement = [
    "        let transientExhaustionReason = null;",
    "        const accountSkipReasons = new Map();",
    "        let reloadedAfterNoAccount = false;",
    "        let managedRetryAccountIndex = null;",
    "        let managedPoolWaitRounds = 0;",
    "        const managedSameAccountRetryCountByAccount = new Map();",
    "        const managedRetryDeadlineAt = managedLifecycle.deadlineAt;",
    "        let managedUpstreamAttempts = 0;",
    "        const managedUpstreamAttemptLimit = Math.min(MANAGED_MAX_UPSTREAM_ATTEMPTS,",
    "            Math.max(1, accountCount * (MANAGED_SAME_ACCOUNT_TRANSIENT_RETRIES + 1 +",
    "                MANAGED_POOL_WAIT_ROUNDS)));",
  ].join("\n");
  const loopStateFirst = source.indexOf(loopStateNeedle);
  if (loopStateFirst < 0 || source.indexOf(loopStateNeedle, loopStateFirst + loopStateNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth retry-loop state layout; refusing an unsafe patch");
  }
  source = source.slice(0, loopStateFirst) + loopStateReplacement +
    source.slice(loopStateFirst + loopStateNeedle.length);

  const attemptLimitNeedle = "        let transientAttemptLimit = Math.max(1, Math.min(accountCount, state.maxRuntimeAccountAttempts));";
  const attemptLimitReplacement = "        let transientAttemptLimit = state.managedMachineRouter ? accountCount : Math.max(1, Math.min(accountCount, state.maxRuntimeAccountAttempts));";
  const attemptLimitFirst = source.indexOf(attemptLimitNeedle);
  if (attemptLimitFirst < 0 || source.indexOf(attemptLimitNeedle, attemptLimitFirst + attemptLimitNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth account-attempt limit; refusing an unsafe patch");
  }
  source = source.slice(0, attemptLimitFirst) + attemptLimitReplacement +
    source.slice(attemptLimitFirst + attemptLimitNeedle.length);

  const reloadLimitNeedle = "                        transientAttemptLimit = Math.max(1, Math.min(accountCount, state.maxRuntimeAccountAttempts));";
  const reloadLimitReplacement = "                        transientAttemptLimit = state.managedMachineRouter ? accountCount : Math.max(1, Math.min(accountCount, state.maxRuntimeAccountAttempts));";
  const reloadLimitFirst = source.indexOf(reloadLimitNeedle);
  if (reloadLimitFirst < 0 || source.indexOf(reloadLimitNeedle, reloadLimitFirst + reloadLimitNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth reloaded attempt limit; refusing an unsafe patch");
  }
  source = source.slice(0, reloadLimitFirst) + reloadLimitReplacement +
    source.slice(reloadLimitFirst + reloadLimitNeedle.length);

  const loopGateNeedle = [
    "        while (attemptedIndexes.size < accountCount &&",
    "            transientAttempts < transientAttemptLimit) {",
  ].join("\n");
  const loopGateReplacement = [
    "        while (attemptedIndexes.size < accountCount &&",
    "            transientAttempts < transientAttemptLimit &&",
    "            managedUpstreamAttempts < managedUpstreamAttemptLimit &&",
    "            managedDeadlineNow() < managedRetryDeadlineAt &&",
    "            !managedLifecycle.signal.aborted) {",
  ].join("\n");
  const loopGateFirst = source.indexOf(loopGateNeedle);
  if (loopGateFirst < 0 || source.indexOf(loopGateNeedle, loopGateFirst + loopGateNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth retry-loop gate; refusing an unsafe patch");
  }
  source = source.slice(0, loopGateFirst) + loopGateReplacement +
    source.slice(loopGateFirst + loopGateNeedle.length);

  const pinnedNeedle = "                pinnedIndex,\n                skipReasons: accountSkipReasons,";
  const pinnedReplacement = [
    "                pinnedIndex: managedRetryAccountIndex ?? pinnedIndex,",
    "                skipReasons: accountSkipReasons,",
  ].join("\n");
  const pinnedFirst = source.indexOf(pinnedNeedle);
  if (pinnedFirst < 0 || source.indexOf(pinnedNeedle, pinnedFirst + pinnedNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth account selection layout; refusing an unsafe patch");
  }
  source = source.slice(0, pinnedFirst) + pinnedReplacement +
    source.slice(pinnedFirst + pinnedNeedle.length);

  const affinitySelectionNeedle = "                sessionKey: context.sessionKey,";
  const affinitySelectionFirst = source.indexOf(affinitySelectionNeedle);
  if (affinitySelectionFirst < 0 ||
      source.indexOf(affinitySelectionNeedle, affinitySelectionFirst + affinitySelectionNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth affinity selection boundary; refusing an unsafe patch");
  }
  source = source.slice(0, affinitySelectionFirst) +
    "                sessionKey: managedSessionAffinityKey," +
    source.slice(affinitySelectionFirst + affinitySelectionNeedle.length);

  const affinityGenerationNeedle = "            state.sessionAffinityStore?.clearAll();";
  const affinityGenerationFirst = source.indexOf(affinityGenerationNeedle);
  if (affinityGenerationFirst < 0 ||
      source.indexOf(affinityGenerationNeedle, affinityGenerationFirst + affinityGenerationNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth affinity generation boundary; refusing an unsafe patch");
  }
  source = source.slice(0, affinityGenerationFirst) +
    "            state.sessionAffinityStore?.clearAllWithVersion(" +
    "state.managedAffinityWriteVersion * 4 + 3);" +
    source.slice(affinityGenerationFirst + affinityGenerationNeedle.length);

  const selectedNeedle = "            attemptedIndexes.add(selected.index);";
  const selectedReplacement = [
    "            managedRetryAccountIndex = null;",
    selectedNeedle,
  ].join("\n");
  const selectedFirst = source.indexOf(selectedNeedle);
  if (selectedFirst < 0 || source.indexOf(selectedNeedle, selectedFirst + selectedNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth selected-account boundary; refusing an unsafe patch");
  }
  source = source.slice(0, selectedFirst) + selectedReplacement +
    source.slice(selectedFirst + selectedNeedle.length);

  const noAccountNeedle = [
    "            if (!selected) {",
    "                if (!reloadedAfterNoAccount &&",
  ].join("\n");
  const noAccountReplacement = [
    "            if (!selected) {",
    "                // A same-account retry is only a preference, never a manual pin.",
    "                // Concurrent cooldown publication may make it unavailable while",
    "                // this request sleeps; fall back to ordinary pool selection.",
    "                if (managedRetryAccountIndex !== null && !isPinned) {",
    "                    managedRetryAccountIndex = null;",
    "                    continue;",
    "                }",
    "                if (state.managedMachineRouter) {",
    "                    const waitedForPool = await waitForManagedPoolIfReady({",
    "                        accountManager, family: context.family, model: context.model,",
    "                        attemptedIndexes, accountCount, isPinned,",
    "                        waitRounds: managedPoolWaitRounds, accountSkipReasons,",
    "                        lifecycle: managedLifecycle, allUnavailable: true,",
    "                    });",
    "                    if (managedLifecycle.signal.aborted) return;",
    "                    if (waitedForPool) {",
    "                        managedPoolWaitRounds += 1;",
    "                        transientAttempts = 0;",
    "                        transientExhaustionReason = null;",
    "                        continue;",
    "                    }",
    "                    break;",
    "                }",
    "                if (!reloadedAfterNoAccount &&",
  ].join("\n");
  const noAccountFirst = source.indexOf(noAccountNeedle);
  if (noAccountFirst < 0 || source.indexOf(noAccountNeedle, noAccountFirst + noAccountNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth no-account recovery gate; refusing an unsafe patch");
  }
  source = source.slice(0, noAccountFirst) + noAccountReplacement +
    source.slice(noAccountFirst + noAccountNeedle.length);

  const preemptiveNeedle = [
    "                accountManager.saveToDiskDebounced();",
    "                state.status.rotations += 1;",
    "                continue;",
    "            }",
    `            // ${sharedAdmissionMarker}.`,
  ].join("\n");
  const preemptiveReplacement = [
    "                deferManagedAdmission(state, selected.index, preemptiveDeferral.waitMs);",
    "                accountManager.saveToDiskDebounced();",
    "                state.status.rotations += 1;",
    "                if (await waitForManagedPoolIfReady({",
    "                    accountManager, family: context.family, model: context.model,",
    "                    attemptedIndexes, accountCount, isPinned,",
    "                    waitRounds: managedPoolWaitRounds, accountSkipReasons,",
    "                    lifecycle: managedLifecycle,",
    "                })) {",
    "                    managedPoolWaitRounds += 1;",
    "                    transientAttempts = 0;",
    "                    transientExhaustionReason = null;",
    "                    managedRetryAccountIndex = null;",
    "                }",
    "                continue;",
    "            }",
    `            // ${sharedAdmissionMarker}.`,
  ].join("\n");
  const preemptiveFirst = source.indexOf(preemptiveNeedle);
  if (preemptiveFirst < 0 || source.indexOf(preemptiveNeedle, preemptiveFirst + preemptiveNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth preemptive-deferral branch; refusing an unsafe patch");
  }
  source = source.slice(0, preemptiveFirst) + preemptiveReplacement +
    source.slice(preemptiveFirst + preemptiveNeedle.length);

  const refreshNeedle = [
    "            const refreshed = await ensureFreshAccessToken({",
    "                accountManager,",
    "                account: selected,",
    "                family: context.family,",
    "                model: context.model,",
    "                now: state.now(),",
    "                tokenRefreshSkewMs: state.tokenRefreshSkewMs,",
    "                tokenInvalidationCooldownMs: state.tokenInvalidationCooldownMs,",
    "            });",
  ].join("\n");
  const refreshReplacement = [
    "            const admission = await acquireManagedAdmission(",
    "                state, selected.index, managedLifecycle);",
    "            if (!admission) {",
    "                if (managedLifecycle.cancelled) return;",
    "                exhaustionReason = \"deadline\";",
    "                break;",
    "            }",
    "            if (admission.reselect) {",
    "                accountSkipReasons.set(selected.index, admission.reason);",
    "                continue;",
    "            }",
    "            const revalidated = revalidateManagedAdmission({",
    "                state, accountManager, selected, family: context.family, model: context.model,",
    "                policyDecision, preemptiveQuotaScheduler: state.preemptiveQuotaScheduler,",
    "                quotaScheduleKey, now: state.now(),",
    "            });",
    "            if (revalidated.reason) {",
    "                admission.release();",
    "                accountSkipReasons.set(selected.index, revalidated.reason);",
    "                if (await waitForManagedPoolIfReady({",
    "                    accountManager, family: context.family, model: context.model,",
    "                    attemptedIndexes, accountCount, isPinned,",
    "                    waitRounds: managedPoolWaitRounds, accountSkipReasons,",
    "                    lifecycle: managedLifecycle,",
    "                })) {",
    "                    managedPoolWaitRounds += 1;",
    "                    transientAttempts = 0;",
    "                    transientExhaustionReason = null;",
    "                }",
    "                continue;",
    "            }",
    "            const admissionRelease = admission.release;",
    "            try {",
    "            const refreshed = await managedAwaitLifecycle(ensureFreshAccessToken({",
    "                accountManager,",
    "                account: revalidated.account,",
    "                family: context.family,",
    "                model: context.model,",
    "                now: state.now(),",
    "                tokenRefreshSkewMs: state.tokenRefreshSkewMs,",
    "                tokenInvalidationCooldownMs: state.tokenInvalidationCooldownMs,",
    "            }), managedLifecycle);",
  ].join("\n");
  const refreshFirst = source.indexOf(refreshNeedle);
  if (refreshFirst < 0 || source.indexOf(refreshNeedle, refreshFirst + refreshNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth token-refresh boundary; refusing an unsafe patch");
  }
  source = source.slice(0, refreshFirst) + refreshReplacement +
    source.slice(refreshFirst + refreshNeedle.length);

  const rateLimitNeedle = [
    "            if (upstream.status === HTTP_STATUS.TOO_MANY_REQUESTS) {",
    "                const bodyText = await readErrorBody(upstream, state.streamStallTimeoutMs);",
    "                const retryAfterMs = parseRetryAfterHeaderMs(upstream.headers, state.now()) ??",
    "                    parseRetryAfterBodyMs(bodyText, state.now()) ??",
    "                    60_000;",
    "                state.preemptiveQuotaScheduler.markRateLimited(quotaScheduleKey, retryAfterMs, state.now());",
    "                // A 429 is the upstream quota signal for the attempted account, so",
    "                // keep the consumed runtime token drained.",
    "                accountManager.recordRateLimit(refreshed.account, context.family, context.model);",
    "                accountManager.markRateLimitedWithReason(refreshed.account, retryAfterMs, context.family, \"quota\", context.model);",
    "                accountManager.saveToDiskDebounced();",
    "                exhaustionReason = \"rate-limit\";",
    "                transientAttempts += 1;",
    "                transientExhaustionReason = \"rate-limit\";",
    "                state.status.retries += 1;",
    "                state.status.rotations += 1;",
    "                continue;",
    "            }",
  ].join("\n");
  const rateLimitReplacement = [
    "            if (upstream.status === HTTP_STATUS.TOO_MANY_REQUESTS) {",
    "                const bodyText = await managedReadErrorBody(",
    "                    upstream, state.streamStallTimeoutMs, managedLifecycle);",
    "                const explicitRetryAfterMs = managedClampRetryAfterMs(",
    "                    parseRetryAfterHeaderMs(upstream.headers, state.now()) ??",
    "                        parseRetryAfterBodyMs(bodyText, state.now()));",
    "                const errorCode = extractErrorCodeFromBody(bodyText);",
    "                const confirmedQuotaExhaustion = isConfirmedQuotaExhaustion(errorCode);",
    "                const sameAccountRetryCount = managedSameAccountRetryCountByAccount.get(",
    "                    refreshed.account.index) ?? 0;",
    "                if (sameAccountRetryCount < MANAGED_SAME_ACCOUNT_TRANSIENT_RETRIES &&",
    "                    shouldRetry429OnSameAccount(errorCode, explicitRetryAfterMs)) {",
    "                    managedSameAccountRetryCountByAccount.set(",
    "                        refreshed.account.index, sameAccountRetryCount + 1);",
    "                    managedRetryAccountIndex = refreshed.account.index;",
    "                    attemptedIndexes.delete(refreshed.account.index);",
    "                    state.status.retries += 1;",
    "                    admissionRelease();",
    "                    if (await managedSleep(managedRetryDelayMs(sameAccountRetryCount, explicitRetryAfterMs),",
    "                        managedLifecycle)) continue;",
    "                    if (managedLifecycle.signal.aborted) return;",
    "                }",
    "                const retryAfterMs = managedClampRetryAfterMs(explicitRetryAfterMs ??",
    "                    (confirmedQuotaExhaustion ? 60_000 : MANAGED_TRANSIENT_429_COOLDOWN_MS));",
    "                admission.defer(retryAfterMs);",
    "                state.preemptiveQuotaScheduler.markRateLimited(quotaScheduleKey, retryAfterMs, state.now());",
    "                accountManager.recordRateLimit(refreshed.account, context.family, context.model);",
    "                accountManager.markRateLimitedWithReason(refreshed.account, retryAfterMs, context.family, \"quota\", context.model);",
    "                accountManager.saveToDiskDebounced();",
    "                exhaustionReason = \"rate-limit\";",
    "                transientAttempts += 1;",
    "                transientExhaustionReason = \"rate-limit\";",
    "                state.status.retries += 1;",
    "                state.status.rotations += 1;",
    "                admissionRelease();",
    "                if (await waitForManagedPoolIfReady({",
    "                    accountManager, family: context.family, model: context.model,",
    "                    attemptedIndexes, accountCount, isPinned,",
    "                    waitRounds: managedPoolWaitRounds, accountSkipReasons,",
    "                    lifecycle: managedLifecycle,",
    "                })) {",
    "                    managedPoolWaitRounds += 1;",
    "                    transientAttempts = 0;",
    "                    transientExhaustionReason = null;",
    "                    managedRetryAccountIndex = null;",
    "                }",
    "                continue;",
    "            }",
  ].join("\n");
  const rateLimitFirst = source.indexOf(rateLimitNeedle);
  if (rateLimitFirst < 0 || source.indexOf(rateLimitNeedle, rateLimitFirst + rateLimitNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth 429 branch; refusing an unsafe patch");
  }
  source = source.slice(0, rateLimitFirst) + rateLimitReplacement +
    source.slice(rateLimitFirst + rateLimitNeedle.length);

  const exhaustedNeedle = "        if (transientAttempts >= transientAttemptLimit &&";
  const exhaustedReplacement = [
    "        if (managedLifecycle.cancelled) return;",
    "        if (managedDeadlineNow() >= managedRetryDeadlineAt)",
    "            exhaustionReason = \"deadline\";",
    "        else if (managedUpstreamAttempts >= managedUpstreamAttemptLimit)",
    "            exhaustionReason = \"budget\";",
    "        else if (transientAttempts >= transientAttemptLimit &&",
  ].join("\n");
  const exhaustedFirst = source.indexOf(exhaustedNeedle);
  if (exhaustedFirst < 0 || source.indexOf(exhaustedNeedle, exhaustedFirst + exhaustedNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth exhaustion boundary; refusing an unsafe patch");
  }
  source = source.slice(0, exhaustedFirst) + exhaustedReplacement +
    source.slice(exhaustedFirst + exhaustedNeedle.length);

  const rememberNeedle = "                state.sessionAffinityStore?.remember(context.sessionKey, refreshed.account.index, state.now());";
  const rememberReplacement = "                state.sessionAffinityStore?.rememberWithVersion(managedSessionAffinityKey, refreshed.account.index, state.now(), managedAffinityWriteVersion + 2);";
  const rememberFirst = source.indexOf(rememberNeedle);
  if (rememberFirst < 0 || source.indexOf(rememberNeedle, rememberFirst + rememberNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth affinity commit boundary; refusing an unsafe patch");
  }
  source = source.slice(0, rememberFirst) + rememberReplacement +
    source.slice(rememberFirst + rememberNeedle.length);
}

if (!source.includes(transientRetryMarker)) {
  const fetchNeedle = [
    "            let upstream;",
    "            try {",
    "                state.status.upstreamRequests += 1;",
    "                const fetchAbortController = new AbortController();",
  ].join("\n");
  const fetchReplacement = [
    "            let upstream;",
    "            try {",
    "                managedUpstreamAttempts += 1;",
    "                state.status.upstreamRequests += 1;",
    "                const fetchAbortController = new AbortController();",
  ].join("\n");
  const fetchFirst = source.indexOf(fetchNeedle);
  if (fetchFirst < 0 || source.indexOf(fetchNeedle, fetchFirst + fetchNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth upstream fetch boundary; refusing an unsafe patch");
  }
  source = source.slice(0, fetchFirst) + fetchReplacement +
    source.slice(fetchFirst + fetchNeedle.length);

  const timeoutNeedle = "                upstream = await withTimeout(state.fetchImpl(upstreamUrl, upstreamRequestInit), state.fetchTimeoutMs, () => fetchAbortController.abort(), `upstream fetch timed out after ${state.fetchTimeoutMs}ms`);";
  const timeoutReplacement = [
    "                const onManagedClientAbort = () => fetchAbortController.abort(",
    "                    managedLifecycle.signal.reason);",
    "                managedLifecycle.signal.addEventListener(\"abort\", onManagedClientAbort,",
    "                    { once: true });",
    "                try {",
    "                    const managedFetchTimeoutMs = Math.max(1, Math.min(",
    "                        state.fetchTimeoutMs, managedRetryDeadlineAt - managedDeadlineNow()));",
    "                    upstream = await managedAwaitLifecycle(withTimeout(",
    "                        state.fetchImpl(upstreamUrl, upstreamRequestInit),",
    "                        managedFetchTimeoutMs, () => fetchAbortController.abort(),",
    "                        `upstream fetch timed out after ${managedFetchTimeoutMs}ms`),",
    "                        managedLifecycle, onManagedClientAbort);",
    "                } finally {",
    "                    managedLifecycle.signal.removeEventListener(\"abort\", onManagedClientAbort);",
    "                }",
  ].join("\n");
  const timeoutFirst = source.indexOf(timeoutNeedle);
  if (timeoutFirst < 0 || source.indexOf(timeoutNeedle, timeoutFirst + timeoutNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth upstream timeout boundary; refusing an unsafe patch");
  }
  source = source.slice(0, timeoutFirst) + timeoutReplacement +
    source.slice(timeoutFirst + timeoutNeedle.length);

  const catchNeedle = [
    "            catch (error) {",
    "                // errors-logging-08: a custom fetchImpl, a proxy agent, or an undici",
  ].join("\n");
  const catchReplacement = [
    "            catch (error) {",
    "                if (error?.code === \"CODEX_MANAGED_REQUEST_DEADLINE\") throw error;",
    "                if (managedLifecycle.cancelled ||",
    "                    error?.code === \"CODEX_MANAGED_REQUEST_CANCELLED\") return;",
    "                // errors-logging-08: a custom fetchImpl, a proxy agent, or an undici",
  ].join("\n");
  const catchFirst = source.indexOf(catchNeedle);
  if (catchFirst < 0 || source.indexOf(catchNeedle, catchFirst + catchNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth upstream catch boundary; refusing an unsafe patch");
  }
  source = source.slice(0, catchFirst) + catchReplacement +
    source.slice(catchFirst + catchNeedle.length);

  const quotaNeedle = "            const quotaSnapshot = readQuotaSchedulerSnapshot(upstream.headers, upstream.status, state.now());";
  const quotaReplacement = [
    "            // Admission bounds only token refresh and the pre-header fetch.",
    "            // Long response bodies must not occupy the per-account lane.",
    "            admissionRelease();",
    quotaNeedle,
  ].join("\n");
  const quotaFirst = source.indexOf(quotaNeedle);
  if (quotaFirst < 0 || source.indexOf(quotaNeedle, quotaFirst + quotaNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth quota snapshot boundary; refusing an unsafe patch");
  }
  source = source.slice(0, quotaFirst) + quotaReplacement +
    source.slice(quotaFirst + quotaNeedle.length);

  const networkNeedle = [
    "                accountManager.refundToken(refreshed.account, context.family, context.model);",
    "                // A pre-header transport exception is a property of the network path,",
    "                // not of this account's credentials or quota, so it must NOT feed the",
    "                // account's circuit breaker / health tracker: that is what would",
    "                // otherwise retire a healthy account for an outage it did not cause.",
    "                // See #677.",
    "                //",
    "                // The short timed cooldown IS still applied. It is self-healing, it",
    "                // keeps an account whose upstream hangs from stalling 1/N of every",
    "                // later request for the full fetch timeout, and it is what gives the",
    "                // exhaustion 503 a non-zero `retry_after_ms` to back the client off",
    "                // with (`getMinWaitTimeForFamily` returns 0 while any account is",
    "                // still selectable).",
    "                accountManager.markAccountCoolingDown(refreshed.account, state.networkErrorCooldownMs, \"network-error\");",
    "                accountManager.saveToDiskDebounced();",
    "                accountSkipReasons.set(refreshed.account.index, \"network-error\");",
    "                exhaustionReason = \"network-error\";",
    "                transientAttempts += 1;",
    "                transientExhaustionReason = \"network-error\";",
    "                state.status.retries += 1;",
    "                state.status.rotations += 1;",
    "                continue;",
  ].join("\n");
  const networkReplacement = [
    "                accountManager.refundToken(refreshed.account, context.family, context.model);",
    `                // ${transientRetryMarker}.`,
    "                const transportRetryCount = managedSameAccountRetryCountByAccount.get(",
    "                    refreshed.account.index) ?? 0;",
    "                if (transportRetryCount < MANAGED_SAME_ACCOUNT_TRANSIENT_RETRIES) {",
    "                    managedSameAccountRetryCountByAccount.set(",
    "                        refreshed.account.index, transportRetryCount + 1);",
    "                    managedRetryAccountIndex = refreshed.account.index;",
    "                    attemptedIndexes.delete(refreshed.account.index);",
    "                    state.status.retries += 1;",
    "                    admissionRelease();",
    "                    if (await managedSleep(managedRetryDelayMs(transportRetryCount),",
    "                        managedLifecycle)) continue;",
    "                    if (managedLifecycle.cancelled) return;",
    "                }",
    "                // Repeated pre-header transport failures still say nothing about",
    "                // account credentials, but a short cooldown permits pool failover.",
    "                accountManager.markAccountCoolingDown(refreshed.account, state.networkErrorCooldownMs, \"network-error\");",
    "                admission.defer(state.networkErrorCooldownMs);",
    "                accountManager.saveToDiskDebounced();",
    "                accountSkipReasons.set(refreshed.account.index, \"network-error\");",
    "                exhaustionReason = \"network-error\";",
    "                transientAttempts += 1;",
    "                transientExhaustionReason = \"network-error\";",
    "                state.status.retries += 1;",
    "                state.status.rotations += 1;",
    "                admissionRelease();",
    "                if (await waitForManagedPoolIfReady({",
    "                    accountManager, family: context.family, model: context.model,",
    "                    attemptedIndexes, accountCount, isPinned,",
    "                    waitRounds: managedPoolWaitRounds, accountSkipReasons,",
    "                    lifecycle: managedLifecycle,",
    "                })) {",
    "                    managedPoolWaitRounds += 1;",
    "                    transientAttempts = 0;",
    "                    transientExhaustionReason = null;",
    "                    managedRetryAccountIndex = null;",
    "                }",
    "                continue;",
  ].join("\n");
  const networkFirst = source.indexOf(networkNeedle);
  if (networkFirst < 0 || source.indexOf(networkNeedle, networkFirst + networkNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth transport retry branch; refusing an unsafe patch");
  }
  source = source.slice(0, networkFirst) + networkReplacement +
    source.slice(networkFirst + networkNeedle.length);

  const serverNeedle = [
    "            if (upstream.status >= 500) {",
    "                await readErrorBody(upstream, state.streamStallTimeoutMs);",
    "                accountManager.refundToken(refreshed.account, context.family, context.model);",
    "                accountManager.recordFailure(refreshed.account, context.family, context.model);",
    "                accountManager.markAccountCoolingDown(refreshed.account, state.serverErrorCooldownMs, \"server-error\");",
    "                accountManager.saveToDiskDebounced();",
    "                exhaustionReason = \"server-error\";",
    "                transientAttempts += 1;",
    "                transientExhaustionReason = \"server-error\";",
    "                state.status.retries += 1;",
    "                state.status.rotations += 1;",
    "                continue;",
    "            }",
  ].join("\n");
  const serverReplacement = [
    "            if (isManagedRetryableStatus(upstream.status)) {",
    "                const bodyText = await managedReadErrorBody(",
    "                    upstream, state.streamStallTimeoutMs, managedLifecycle);",
    "                accountManager.refundToken(refreshed.account, context.family, context.model);",
    "                const explicitRetryAfterMs = managedClampRetryAfterMs(",
    "                    parseRetryAfterHeaderMs(upstream.headers, state.now()) ??",
    "                        parseRetryAfterBodyMs(bodyText, state.now()));",
    "                const serverRetryCount = managedSameAccountRetryCountByAccount.get(",
    "                    refreshed.account.index) ?? 0;",
    "                if (serverRetryCount < MANAGED_SAME_ACCOUNT_TRANSIENT_RETRIES &&",
    "                    (explicitRetryAfterMs === null ||",
    "                        explicitRetryAfterMs <= MANAGED_MAX_BACKGROUND_WAIT_MS)) {",
    "                    managedSameAccountRetryCountByAccount.set(",
    "                        refreshed.account.index, serverRetryCount + 1);",
    "                    managedRetryAccountIndex = refreshed.account.index;",
    "                    attemptedIndexes.delete(refreshed.account.index);",
    "                    state.status.retries += 1;",
    "                    admissionRelease();",
    "                    if (await managedSleep(managedRetryDelayMs(serverRetryCount, explicitRetryAfterMs),",
    "                        managedLifecycle)) continue;",
    "                    if (managedLifecycle.cancelled) return;",
    "                }",
    "                accountManager.recordFailure(refreshed.account, context.family, context.model);",
    "                const serverCooldownMs = managedClampRetryAfterMs(",
    "                    explicitRetryAfterMs ?? state.serverErrorCooldownMs) ?? 500;",
    "                accountManager.markAccountCoolingDown(refreshed.account, serverCooldownMs, \"server-error\");",
    "                admission.defer(serverCooldownMs);",
    "                accountManager.saveToDiskDebounced();",
    "                exhaustionReason = \"server-error\";",
    "                transientAttempts += 1;",
    "                transientExhaustionReason = \"server-error\";",
    "                state.status.retries += 1;",
    "                state.status.rotations += 1;",
    "                admissionRelease();",
    "                if (await waitForManagedPoolIfReady({",
    "                    accountManager, family: context.family, model: context.model,",
    "                    attemptedIndexes, accountCount, isPinned,",
    "                    waitRounds: managedPoolWaitRounds, accountSkipReasons,",
    "                    lifecycle: managedLifecycle,",
    "                })) {",
    "                    managedPoolWaitRounds += 1;",
    "                    transientAttempts = 0;",
    "                    transientExhaustionReason = null;",
    "                    managedRetryAccountIndex = null;",
    "                }",
    "                continue;",
    "            }",
    "            if (!isThreadGoalRequest && upstream.status >= 400) {",
    "                const bodyText = await managedReadErrorBody(",
    "                    upstream, state.streamStallTimeoutMs, managedLifecycle);",
    "                const errorCode = extractErrorCodeFromBody(bodyText);",
    "                res.writeHead(upstream.status, responseHeadersForClient(upstream.headers));",
    "                res.end(bodyText);",
    "                await usageRecorder.record({",
    "                    outcome: \"failure\",",
    "                    statusCode: upstream.status,",
    "                    errorCode,",
    "                    account: refreshed.account,",
    "                });",
    "                return;",
    "            }",
  ].join("\n");
  const serverFirst = source.indexOf(serverNeedle);
  if (serverFirst < 0 || source.indexOf(serverNeedle, serverFirst + serverNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth server retry branch; refusing an unsafe patch");
  }
  source = source.slice(0, serverFirst) + serverReplacement +
    source.slice(serverFirst + serverNeedle.length);

  const successCommitNeedle =
    "            accountManager.recordSuccess(refreshed.account, context.family, context.model);";
  const usageScannerNeedle =
    "            // Recover the upstream token counts as the body streams past.";
  const successCommitFirst = source.indexOf(successCommitNeedle);
  const usageScannerFirst = source.indexOf(usageScannerNeedle, successCommitFirst);
  if (successCommitFirst < 0 || usageScannerFirst < 0 ||
      source.indexOf(successCommitNeedle, successCommitFirst + successCommitNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth success-commit boundary; refusing an unsafe patch");
  }
  const successCommitBlock = source.slice(successCommitFirst, usageScannerFirst);
  source = source.slice(0, successCommitFirst) + source.slice(usageScannerFirst);

  const successForwardFirst = source.indexOf(
    "            const forwarded = await forwardStreamingResponse(upstream, res, state.status, () => {",
    successCommitFirst,
  );
  const successReturnNeedle = [
    "            await usageRecorder.record({",
    "                outcome: forwarded ? \"success\" : \"failure\",",
    "                statusCode: upstream.status,",
    "                errorCode: forwarded ? null : \"stream_forward_failed\",",
    "                account: refreshed.account,",
    "                ...(usageTokens ?? {}),",
    "            });",
    "            return;",
  ].join("\n");
  const successReturnFirst = source.indexOf(successReturnNeedle, successForwardFirst);
  if (successForwardFirst < 0 || successReturnFirst < 0) {
    throw new Error("unsupported codex-multi-auth success-stream boundary; refusing an unsafe patch");
  }
  const successForwardReplacement = [
    "            const forwarded = await forwardStreamingResponse(",
    "                upstream, res, state.status, () => undefined,",
    "                state.streamStallTimeoutMs, usageScanner.push);",
    "            const delivered = forwarded && !managedLifecycle.cancelled;",
    "            if (delivered) {",
    successCommitBlock,
    "            }",
    "            else if (!managedLifecycle.cancelled) {",
    "                accountManager.recordFailure(refreshed.account, context.family, context.model);",
    "                accountManager.markAccountCoolingDown(",
    "                    refreshed.account, state.networkErrorCooldownMs, \"network-error\");",
    "                state.sessionAffinityStore?.forgetSessionWithVersion(",
    "                    managedSessionAffinityKey, state.now(), managedAffinityWriteVersion + 1);",
    "                accountManager.saveToDiskDebounced();",
    "            }",
    "            const usageTokens = usageScanner.result();",
    "            await usageRecorder.record({",
    "                outcome: delivered ? \"success\" : \"failure\",",
    "                statusCode: upstream.status,",
    "                errorCode: delivered ? null : (managedLifecycle.cancelled",
    "                    ? \"managed_request_cancelled\" : \"stream_forward_failed\"),",
    "                account: refreshed.account,",
    "                ...(usageTokens ?? {}),",
    "            });",
    "            return;",
    "            }",
    "            finally {",
    "                admissionRelease();",
    "            }",
  ].join("\n");
  source = source.slice(0, successForwardFirst) + successForwardReplacement +
    source.slice(successReturnFirst + successReturnNeedle.length);

  source = source.replaceAll(
    "await readErrorBody(upstream, state.streamStallTimeoutMs)",
    "await managedReadErrorBody(upstream, state.streamStallTimeoutMs, managedLifecycle)",
  );

  const modelUnsupportedNeedle =
    "                    accountSkipReasons.set(refreshed.account.index, \"model-unsupported\");";
  const modelUnsupportedCalls = source.split(modelUnsupportedNeedle).length - 1;
  if (modelUnsupportedCalls !== 2) {
    throw new Error(`unsupported codex-multi-auth entitlement-affinity layout (${modelUnsupportedCalls}); refusing an unsafe patch`);
  }
  source = source.replaceAll(
    modelUnsupportedNeedle,
    [
      "                    state.sessionAffinityStore?.forgetSessionWithVersion(",
      "                        managedSessionAffinityKey, state.now(), managedAffinityWriteVersion + 1);",
      modelUnsupportedNeedle,
    ].join("\n"),
  );

  const affinityForgetNeedle =
    "state.sessionAffinityStore?.forgetSession(context.sessionKey)";
  const affinityForgetCalls = source.split(affinityForgetNeedle).length - 1;
  if (affinityForgetCalls !== 4) {
    throw new Error(`unsupported codex-multi-auth affinity-delete layout (${affinityForgetCalls}); refusing an unsafe patch`);
  }
  source = source.replaceAll(
    affinityForgetNeedle,
    "state.sessionAffinityStore?.forgetSessionWithVersion(managedSessionAffinityKey, state.now(), managedAffinityWriteVersion + 1)",
  );

  const outerCatchNeedle = [
    "    catch (error) {",
    "        const rawErrorMessage = error instanceof Error ? error.message : String(error);",
  ].join("\n");
  const outerCatchReplacement = [
    "    catch (error) {",
    "        if (managedLifecycle.cancelled ||",
    "            error?.code === \"CODEX_MANAGED_REQUEST_CANCELLED\") return;",
    "        if (error?.code === \"CODEX_MANAGED_REQUEST_DEADLINE\") {",
    "            await usageRecorder?.record({",
    "                outcome: \"failure\",",
    "                statusCode: HTTP_STATUS.SERVICE_UNAVAILABLE,",
    "                errorCode: \"codex_managed_request_deadline\",",
    "            });",
    "            if (!res.headersSent) writeJson(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {",
    "                error: {",
    "                    message: \"Managed Codex request exceeded its retry deadline.\",",
    "                    code: \"codex_managed_request_deadline\",",
    "                },",
    "            });",
    "            else if (!res.destroyed) res.destroy(error);",
    "            return;",
    "        }",
    "        const rawErrorMessage = error instanceof Error ? error.message : String(error);",
  ].join("\n");
  const outerCatchFirst = source.indexOf(outerCatchNeedle);
  if (outerCatchFirst < 0 ||
      source.indexOf(outerCatchNeedle, outerCatchFirst + outerCatchNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth outer lifecycle catch; refusing an unsafe patch");
  }
  source = source.slice(0, outerCatchFirst) + outerCatchReplacement +
    source.slice(outerCatchFirst + outerCatchNeedle.length);

  const lifecycleCleanupNeedle = [
    "        else if (!res.destroyed) {",
    "            res.destroy(error instanceof Error ? error : undefined);",
    "        }",
    "    }",
    "}",
    "async function closeServer(server, sockets) {",
  ].join("\n");
  const lifecycleCleanupReplacement = [
    "        else if (!res.destroyed) {",
    "            res.destroy(error instanceof Error ? error : undefined);",
    "        }",
    "    }",
    "    finally {",
    "        managedLifecycle.cleanup();",
    "    }",
    "}",
    "async function closeServer(server, sockets) {",
  ].join("\n");
  const lifecycleCleanupFirst = source.indexOf(lifecycleCleanupNeedle);
  if (lifecycleCleanupFirst < 0 ||
      source.indexOf(lifecycleCleanupNeedle, lifecycleCleanupFirst + lifecycleCleanupNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth lifecycle cleanup boundary; refusing an unsafe patch");
  }
  source = source.slice(0, lifecycleCleanupFirst) + lifecycleCleanupReplacement +
    source.slice(lifecycleCleanupFirst + lifecycleCleanupNeedle.length);
}

if (!source.includes(terminalExhaustionMarker)) {
  const poolExhaustionStatusNeedle =
    "    writeJson(res, normalizeExhaustionStatus(reason), {";
  const poolExhaustionStatusReplacement = [
    `    // ${terminalExhaustionMarker}.`,
    "    // Upstream 429s are an account-selection signal and stay hidden while",
    "    // the router retries. Once the bounded pool policy is exhausted, expose",
    "    // a retryable service failure instead of making Codex stop on a raw 429.",
    "    const managedRetryAfterSeconds = Number.isFinite(waitMs) && waitMs > 0",
    "        ? Math.max(1, Math.ceil(waitMs / 1000)) : null;",
    "    if (managedRetryAfterSeconds !== null)",
    "        res.setHeader(\"retry-after\", String(managedRetryAfterSeconds));",
    "    writeJson(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {",
  ].join("\n");
  const poolExhaustionStatusFirst = source.indexOf(poolExhaustionStatusNeedle);
  if (poolExhaustionStatusFirst < 0 ||
      source.indexOf(poolExhaustionStatusNeedle,
        poolExhaustionStatusFirst + poolExhaustionStatusNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth terminal exhaustion response; refusing an unsafe patch");
  }
  source = source.slice(0, poolExhaustionStatusFirst) +
    poolExhaustionStatusReplacement +
    source.slice(poolExhaustionStatusFirst + poolExhaustionStatusNeedle.length);

  const exhaustionUsageStatusNeedle =
    "            statusCode: normalizeExhaustionStatus(exhaustionReason),";
  const exhaustionUsageStatusFirst = source.indexOf(exhaustionUsageStatusNeedle);
  if (exhaustionUsageStatusFirst < 0 ||
      source.indexOf(exhaustionUsageStatusNeedle,
        exhaustionUsageStatusFirst + exhaustionUsageStatusNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth terminal exhaustion telemetry; refusing an unsafe patch");
  }
  source = source.slice(0, exhaustionUsageStatusFirst) +
    "            statusCode: HTTP_STATUS.SERVICE_UNAVAILABLE," +
    source.slice(exhaustionUsageStatusFirst + exhaustionUsageStatusNeedle.length);
}

if (!source.includes(poolStatusMarker)) {
  const jsonHeadersNeedle = [
    "function writeJson(res, status, payload) {",
    "    res.writeHead(status, { \"content-type\": \"application/json; charset=utf-8\" });",
  ].join("\n");
  const jsonHeadersReplacement = [
    "function writeJson(res, status, payload) {",
    "    res.setHeader(\"cache-control\", \"no-store\");",
    "    res.setHeader(\"x-content-type-options\", \"nosniff\");",
    "    res.writeHead(status, { \"content-type\": \"application/json; charset=utf-8\" });",
  ].join("\n");
  const jsonHeadersFirst = source.indexOf(jsonHeadersNeedle);
  if (jsonHeadersFirst < 0 ||
      source.indexOf(jsonHeadersNeedle, jsonHeadersFirst + jsonHeadersNeedle.length) >= 0) {
    throw new Error("unsupported managed pool-status JSON header layout; refusing an unsafe patch");
  }
  source = source.slice(0, jsonHeadersFirst) + jsonHeadersReplacement +
    source.slice(jsonHeadersFirst + jsonHeadersNeedle.length);

  const poolHelperNeedle = "async function handleRequest(state, req, res) {";
  const poolHelperFirst = source.indexOf(poolHelperNeedle);
  if (poolHelperFirst < 0 ||
      source.indexOf(poolHelperNeedle, poolHelperFirst + poolHelperNeedle.length) >= 0) {
    throw new Error("unsupported managed pool-status helper boundary; refusing an unsafe patch");
  }
  const poolHelper = [
    `// ${poolStatusMarker}.`,
    "const MANAGED_POOL_STATUS_PATH = \"/managed/pool-status\";",
    "function managedPoolLatestBound(...values) {",
    "    const active = values.filter((value) =>",
    "        typeof value === \"number\" && Number.isFinite(value) && value > 0);",
    "    return active.length > 0 ? Math.max(...active) : null;",
    "}",
    "function writeManagedPoolStatusJson(res, status, payload) {",
    "    writeJson(res, status, payload);",
    "}",
    "async function managedPoolPolicyDecision(state, accountManager, model, observedAt) {",
    "    const policyState = await loadRuntimePolicyState();",
    "    return evaluateRuntimePolicy({",
    "        state: policyState,",
    "        accounts: accountManager.getAccountsSnapshot(),",
    "        model,",
    "        now: observedAt,",
    "    });",
    "}",
    "function managedPoolQuotaDeferral(scheduler, key, now) {",
    "    if (!scheduler.enabled) return { defer: false, waitMs: 0 };",
    "    const snapshot = scheduler.snapshots.get(key);",
    "    if (!snapshot) return { defer: false, waitMs: 0 };",
    "    const exhausted = (window) => {",
    "        const used = window?.usedPercent;",
    "        if (typeof used !== \"number\" || !Number.isFinite(used)) return true;",
    "        const left = Math.max(0, Math.min(100, Math.round(100 - used)));",
    "        return left === 0;",
    "    };",
    "    const activeWait = (window) => {",
    "        const resetAt = window?.resetAtMs;",
    "        return typeof resetAt === \"number\" && Number.isFinite(resetAt) && resetAt > now",
    "            ? resetAt - now : 0;",
    "    };",
    "    const rateLimitWait = snapshot.status === 429",
    "        ? Math.max(...[snapshot.primary, snapshot.secondary]",
    "            .filter(exhausted).map(activeWait), 0) : 0;",
    "    if (rateLimitWait > 0) {",
    "        return { defer: true, waitMs: Math.min(rateLimitWait, scheduler.maxDeferralMs) };",
    "    }",
    "    const trustedWait = (window) => {",
    "        const resetAt = window?.resetAtMs;",
    "        const updatedAt = snapshot.updatedAt;",
    "        if (typeof resetAt !== \"number\" || !Number.isFinite(resetAt) ||",
    "            typeof updatedAt !== \"number\" || !Number.isFinite(updatedAt) ||",
    "            updatedAt > now || now - updatedAt > MANAGED_MAX_RETRY_AFTER_MS) {",
    "            return scheduler.maxDeferralMs;",
    "        }",
    "        if (resetAt <= now) return 0;",
    "        return Math.min(resetAt - now, MANAGED_MAX_RETRY_AFTER_MS);",
    "    };",
    "    const primaryUsed = snapshot.primary?.usedPercent;",
    "    const secondaryUsed = snapshot.secondary?.usedPercent;",
    "    const primaryNear = typeof primaryUsed === \"number\" && Number.isFinite(primaryUsed) &&",
    "        primaryUsed >= 100 - scheduler.primaryRemainingPercentThreshold;",
    "    const secondaryNear = typeof secondaryUsed === \"number\" && Number.isFinite(secondaryUsed) &&",
    "        secondaryUsed >= 100 - scheduler.secondaryRemainingPercentThreshold;",
    "    const nearWait = snapshot.status === 429 ? 0 : Math.max(",
    "        primaryNear ? trustedWait(snapshot.primary) : 0,",
    "        secondaryNear ? trustedWait(snapshot.secondary) : 0);",
    "    return nearWait > 0 ? { defer: true, waitMs: nearWait } :",
    "        { defer: false, waitMs: 0 };",
    "}",
    "function managedPoolAccountState(",
    "    state, accountManager, account, family, model, observedAt) {",
    "    const runtimeReason = accountManager.getManagedAccountRuntimeSkipReason(",
    "        account, family, model);",
    "    const quotaDeferral = managedPoolQuotaDeferral(state.preemptiveQuotaScheduler,",
    "        buildQuotaScheduleKey(account, family, model), observedAt);",
    "    const admissionLane = state.managedAdmissionLanes.get(account.index);",
    "    const admissionRecoveryAt = typeof admissionLane?.retryNotBefore === \"number\" &&",
    "        Number.isFinite(admissionLane.retryNotBefore) &&",
    "        admissionLane.retryNotBefore > observedAt ? admissionLane.retryNotBefore : null;",
    "    if (runtimeReason === null && !quotaDeferral.defer && admissionRecoveryAt === null) {",
    "        return { ready: true, category: null, recoveryAt: null, recoveryKind: null };",
    "    }",
    "    const permanentReason = runtimeReason !== null &&",
    "        runtimeReason !== \"rate-limited\" &&",
    "        !runtimeReason.startsWith(\"cooling-down\") &&",
    "        runtimeReason !== \"circuit-open\";",
    "    if (permanentReason) {",
    "        return { ready: false, category: \"permanent\", recoveryAt: null, recoveryKind: null };",
    "    }",
    "    const bounds = getAccountRecoveryBoundsForFamily(",
    "        account, observedAt, family, model);",
    "    const quotaRecoveryAt = quotaDeferral.defer && quotaDeferral.waitMs > 0",
    "        ? observedAt + quotaDeferral.waitMs : null;",
    "    const circuitRecoveryAt = accountManager.getCircuitRecoveryTime(account, observedAt);",
    "    const recoveryAt = managedPoolLatestBound(",
    "        bounds.recoveryAtMs, quotaRecoveryAt, circuitRecoveryAt, admissionRecoveryAt);",
    "    const rateLimitAt = managedPoolLatestBound(bounds.rateLimitAtMs, quotaRecoveryAt);",
    "    const recoveryKind = recoveryAt !== null && rateLimitAt !== null &&",
    "        rateLimitAt >= recoveryAt ? \"rate-limit\" : recoveryAt !== null ? \"cooldown\" : null;",
    "    const category = runtimeReason === \"rate-limited\" || quotaDeferral.defer",
    "        ? \"rateLimited\"",
    "        : runtimeReason?.startsWith(\"cooling-down\") ||",
    "            runtimeReason === \"circuit-open\" || admissionRecoveryAt !== null",
    "            ? \"cooldown\" : \"permanent\";",
    "    return { ready: false, category, recoveryAt, recoveryKind };",
    "}",
    "async function buildManagedPoolStatus(state, model) {",
    "    const accountManager = state.activeAccountManager;",
    "    const accounts = accountManager.getAccountsSnapshot();",
    "    const observedAt = state.now();",
    "    const family = getModelFamily(model);",
    "    const policy = await managedPoolPolicyDecision(",
    "        state, accountManager, model, observedAt);",
    "    const unavailable = { rateLimited: 0, cooldown: 0, policy: 0, permanent: 0 };",
    "    let ready = 0;",
    "    let nextRecoveryAt = null;",
    "    let nextRecoveryKind = null;",
    "    for (const account of accounts) {",
    "        if (!policy.allowed || policy.blockedAccountIndexes.has(account.index)) {",
    "            unavailable.policy += 1;",
    "            continue;",
    "        }",
    "        const accountState = managedPoolAccountState(",
    "            state, accountManager, account, family, model, observedAt);",
    "        if (accountState.ready) {",
    "            ready += 1;",
    "            continue;",
    "        }",
    "        unavailable[accountState.category] += 1;",
    "        if (accountState.recoveryAt !== null && accountState.recoveryAt > observedAt &&",
    "            (nextRecoveryAt === null || accountState.recoveryAt < nextRecoveryAt)) {",
    "            nextRecoveryAt = accountState.recoveryAt;",
    "            nextRecoveryKind = accountState.recoveryKind;",
    "        }",
    "    }",
    "    return {",
    "        version: 1,",
    "        family: \"codex\",",
    "        model,",
    "        serviceTier: \"default\",",
    "        ready,",
    "        total: accounts.length,",
    "        unavailable,",
    "        nextRecoveryAt,",
    "        nextRecoveryKind,",
    "        observedAt,",
    "    };",
    "}",
    "async function handleManagedPoolStatusRequest(state, req, res) {",
    "    const incomingUrl = new URL(req.url ?? \"/\", \"http://127.0.0.1\");",
    "    const incomingHeaders = headersFromIncoming(req);",
    "    if (!isAuthorizedClient(incomingHeaders, state.clientApiKey)) {",
    "        writeUnauthorized(res);",
    "        return;",
    "    }",
    "    if (req.method !== \"GET\") {",
    "        res.setHeader(\"allow\", \"GET\");",
    "        writeManagedPoolStatusJson(res, 405, { error: {",
    "            message: \"Managed Codex pool status only accepts GET.\",",
    "            code: \"codex_managed_pool_status_method_not_allowed\",",
    "        } });",
    "        return;",
    "    }",
    "    if (!state.managedMachineRouter) {",
    "        writeMethodOrPathError(res);",
    "        return;",
    "    }",
    "    const modelValues = incomingUrl.searchParams.getAll(\"model\");",
    "    const hasOnlyModelQuery = [...incomingUrl.searchParams.keys()]",
    "        .every((key) => key === \"model\");",
    "    const model = modelValues.length === 1 ? modelValues[0] : null;",
    "    if (!hasOnlyModelQuery || !model ||",
    "        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)) {",
    "        writeManagedPoolStatusJson(res, 400, { error: {",
    "            message: \"Managed Codex pool status requires one canonical model.\",",
    "            code: \"codex_managed_pool_status_invalid_model\",",
    "        } });",
    "        return;",
    "    }",
    "    try {",
    "        writeManagedPoolStatusJson(res, HTTP_STATUS.OK,",
    "            await buildManagedPoolStatus(state, model));",
    "    }",
    "    catch {",
    "        writeManagedPoolStatusJson(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {",
    "            error: {",
    "                message: \"Managed Codex pool status is unavailable.\",",
    "                code: \"codex_managed_pool_status_unavailable\",",
    "            },",
    "        });",
    "    }",
    "}",
  ].join("\n");
  source = source.slice(0, poolHelperFirst) + poolHelper + "\n" +
    source.slice(poolHelperFirst);

  const poolDispatchNeedle = "async function handleRequest(state, req, res) {";
  const poolDispatchReplacement = [
    poolDispatchNeedle,
    "    const incomingHeaders = headersFromIncoming(req);",
    "    if (!isAuthorizedClient(incomingHeaders, state.clientApiKey)) {",
    "        writeUnauthorized(res);",
    "        return;",
    "    }",
    "    const incomingUrl = new URL(req.url ?? \"/\", \"http://127.0.0.1\");",
    "    if (incomingUrl.pathname === MANAGED_POOL_STATUS_PATH) {",
    "        await handleManagedPoolStatusRequest(state, req, res);",
    "        return;",
    "    }",
  ].join("\n");
  const poolDispatchFirst = source.indexOf(poolDispatchNeedle);
  if (poolDispatchFirst < 0 ||
      source.indexOf(poolDispatchNeedle,
        poolDispatchFirst + poolDispatchNeedle.length) >= 0) {
    throw new Error("unsupported managed pool-status dispatch boundary; refusing an unsafe patch");
  }
  source = source.slice(0, poolDispatchFirst) + poolDispatchReplacement +
    source.slice(poolDispatchFirst + poolDispatchNeedle.length);
}

if (!source.includes(advisoryQuotaMarker)) {
  const helperNeedle = "function writeJson(res, status, payload) {";
  const helperFirst = source.indexOf(helperNeedle);
  if (helperFirst < 0 || source.indexOf(helperNeedle, helperFirst + helperNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth r16 advisory-quota helper boundary; refusing an unsafe patch");
  }
  const advisoryHelpers = [
    `// ${advisoryQuotaMarker}.`,
    "// A near-exhaustion deferral is a routing preference derived from quota headers,",
    "// not an observed 429, and upstream treats it as both durable and self-renewing.",
    "// It was persisted into rateLimitResetTimes with a wait equal to the whole window",
    "// reset - days on a weekly window - and nothing revokes such a record early:",
    "// clearExpiredRateLimits only drops it once that window elapses, a later healthy",
    "// 200 never clears it, and it is serialized to disk so it outlives every restart.",
    "// The in-memory half is no better: the deferral is recomputed from the SAME",
    "// snapshot on every selection, so it stays positive until the real reset, and a",
    "// snapshot carrying no resetAtMs defers forever because prune() only drops",
    "// snapshots whose reset has passed. Either half alone benches a still-usable",
    "// account behind a 503 while it answers 200 to a direct probe, and because the",
    "// benched account is never selected no fresh snapshot can ever arrive.",
    "//",
    "// So: persist only what a real 429 produced, and let an advisory deferral EXPIRE.",
    "// It is trusted for one deferral cap measured from the snapshot that produced it,",
    "// which is a fixed horizon rather than a window that slides forward on each poll.",
    "// Once that lapses the account is admitted again; the response refreshes the",
    "// snapshot, and a genuine 429 then persists its own server-stated window.",
    "function managedQuotaDeferralIsObserved(deferral) {",
    "    return deferral?.reason === \"rate-limit\";",
    "}",
    "// A window at or over 100% used whose reset is both known and still ahead is",
    "// evidence, not inference. Upstream issue #656 removed the flat cap precisely",
    "// so such an account is not released every couple of hours to burn a live 429,",
    "// and that part was right: honour those in full and return null here. The",
    "// horizon exists for the rest -- a window merely NEAR its ceiling still has",
    "// quota, and a window claiming exhaustion with no trusted reset is an",
    "// unfalsifiable claim that would otherwise hold forever.",
    "function managedQuotaWindowProvesExhaustion(window, now) {",
    "    return Number.isFinite(window?.usedPercent) && window.usedPercent >= 100 &&",
    "        Number.isFinite(window?.resetAtMs) && window.resetAtMs > now;",
    "}",
    "function managedAdvisoryProbeRemainingMs(scheduler, key, now) {",
    "    const cap = scheduler?.maxDeferralMs;",
    "    if (!Number.isFinite(cap) || cap <= 0) return null;",
    "    const snapshot = scheduler.snapshots?.get(key);",
    "    const updatedAt = snapshot?.updatedAt;",
    "    if (!Number.isFinite(updatedAt)) return null;",
    "    if (managedQuotaWindowProvesExhaustion(snapshot.primary, now) ||",
    "        managedQuotaWindowProvesExhaustion(snapshot.secondary, now)) return null;",
    "    return Math.max(0, cap - Math.max(0, now - updatedAt));",
    "}",
    "// A pool held only by advisory deferrals reports no wait through the account",
    "// store, because r16 deliberately never writes that state there. The 503 would",
    "// then carry retry_after_ms 0 and no Retry-After, which invites a client to",
    "// hot-loop or abandon the turn instead of backing off. Reuse the horizon the",
    "// pool status already computes so the refusal states when to come back.",
    "function managedPoolExhaustionRetryAfterMs(state, accountManager, family, model, now) {",
    "    if (!state?.managedMachineRouter) return null;",
    "    try {",
    "        let earliest = null;",
    "        for (const account of accountManager.getAccountsSnapshot()) {",
    "            const accountState = managedPoolAccountState(",
    "                state, accountManager, account, family, model, now);",
    "            // Deliberately no short-circuit on a ready account: this runs only",
    "            // because the request already exhausted the pool, and returning 0",
    "            // here published a 503 with no backoff at all. A ready-looking",
    "            // account may also be policy-blocked, which this view cannot see.",
    "            const recoveryAt = accountState.recoveryAt;",
    "            if (!Number.isFinite(recoveryAt) || recoveryAt <= now) continue;",
    "            if (earliest === null || recoveryAt < earliest) earliest = recoveryAt;",
    "        }",
    "        return earliest === null ? null : earliest - now;",
    "    } catch { return null; }",
    "}",
    "function managedBoundQuotaDeferral(scheduler, key, deferral, now) {",
    "    if (!deferral?.defer || !Number.isFinite(deferral.waitMs) || deferral.waitMs <= 0) {",
    "        return deferral;",
    "    }",
    "    if (managedQuotaDeferralIsObserved(deferral)) return deferral;",
    "    const remaining = managedAdvisoryProbeRemainingMs(scheduler, key, now);",
    "    if (remaining === null) return deferral;",
    "    if (remaining <= 0) return { defer: false, waitMs: 0 };",
    "    return deferral.waitMs <= remaining ? deferral : { ...deferral, waitMs: remaining };",
    "}",
    helperNeedle,
  ].join("\n");
  source = source.slice(0, helperFirst) + advisoryHelpers +
    source.slice(helperFirst + helperNeedle.length);

  // Admission revalidation reads the same scheduler, so a lapsed advisory
  // deferral must stop blocking there too or a re-selected account is rejected
  // by state the selection loop already decided to trust no longer.
  const revalidateNeedle =
    "    const quotaDeferral = preemptiveQuotaScheduler.getDeferral(quotaScheduleKey, now);";
  const revalidateReplacement = [
    "    const quotaDeferral = managedBoundQuotaDeferral(preemptiveQuotaScheduler,",
    "        quotaScheduleKey,",
    "        preemptiveQuotaScheduler.getDeferral(quotaScheduleKey, now), now);",
  ].join("\n");
  const revalidateFirst = source.indexOf(revalidateNeedle);
  if (revalidateFirst < 0 ||
      source.indexOf(revalidateNeedle, revalidateFirst + revalidateNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth r16 admission revalidation read; refusing an unsafe patch");
  }
  source = source.slice(0, revalidateFirst) + revalidateReplacement +
    source.slice(revalidateFirst + revalidateNeedle.length);

  const preemptiveNeedle = [
    "            const preemptiveDeferral = state.preemptiveQuotaScheduler.getDeferral(quotaScheduleKey, state.now());",
    "            if (preemptiveDeferral.defer && preemptiveDeferral.waitMs > 0) {",
    "                accountSkipReasons.set(selected.index, preemptiveDeferral.reason ?? \"quota-near-exhaustion\");",
    "                exhaustionReason = \"rate-limit\";",
    "                accountManager.markRateLimitedWithReason(selected, preemptiveDeferral.waitMs, context.family, \"quota\", context.model);",
    "                accountManager.recordRateLimit(selected, context.family, context.model);",
    "                deferManagedAdmission(state, selected.index, preemptiveDeferral.waitMs);",
    "                accountManager.saveToDiskDebounced();",
  ].join("\n");
  const preemptiveReplacement = [
    "            const preemptiveDeferral = managedBoundQuotaDeferral(state.preemptiveQuotaScheduler,",
    "                quotaScheduleKey,",
    "                state.preemptiveQuotaScheduler.getDeferral(quotaScheduleKey, state.now()), state.now());",
    "            if (preemptiveDeferral.defer && preemptiveDeferral.waitMs > 0) {",
    "                accountSkipReasons.set(selected.index, preemptiveDeferral.reason ?? \"quota-near-exhaustion\");",
    "                exhaustionReason = \"rate-limit\";",
    "                // Only an observed 429 is evidence. An advisory deferral must",
    "                // not score the account down or ratchet its admission lane: the",
    "                // health penalty and the token drain feed the hybrid selector",
    "                // directly, so a derived signal would deprioritise a usable",
    "                // account and can strand it as token-exhausted long after the",
    "                // horizon lapses -- the same false exhaustion r16 exists to",
    "                // remove. The scheduler already withholds selection until that",
    "                // horizon, so the lane would add only a ratchet nothing clears.",
    "                if (managedQuotaDeferralIsObserved(preemptiveDeferral)) {",
    "                    accountManager.markRateLimitedWithReason(selected, preemptiveDeferral.waitMs, context.family, \"quota\", context.model);",
    "                    accountManager.recordRateLimit(selected, context.family, context.model);",
    "                    deferManagedAdmission(state, selected.index, preemptiveDeferral.waitMs);",
    "                    accountManager.saveToDiskDebounced();",
    "                }",
  ].join("\n");
  const preemptiveFirst = source.indexOf(preemptiveNeedle);
  if (preemptiveFirst < 0 ||
      source.indexOf(preemptiveNeedle, preemptiveFirst + preemptiveNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth r16 preemptive advisory branch; refusing an unsafe patch");
  }
  source = source.slice(0, preemptiveFirst) + preemptiveReplacement +
    source.slice(preemptiveFirst + preemptiveNeedle.length);

  const successNeedle = [
    "            const quotaDeferral = state.preemptiveQuotaScheduler.getDeferral(quotaScheduleKey, state.now());",
    "            const nearExhaustionWaitMs = quotaDeferral.defer",
    "                ? quotaDeferral.waitMs",
    "                : 0;",
    "            if (nearExhaustionWaitMs > 0) {",
    "                accountManager.markRateLimitedWithReason(refreshed.account, nearExhaustionWaitMs, context.family, \"quota\", context.model);",
    "                state.sessionAffinityStore?.forgetSessionWithVersion(managedSessionAffinityKey, state.now(), managedAffinityWriteVersion + 1);",
    "                accountManager.saveToDiskDebounced();",
    "            }",
  ].join("\n");
  const successReplacement = [
    "            const quotaDeferral = managedBoundQuotaDeferral(state.preemptiveQuotaScheduler,",
    "                quotaScheduleKey,",
    "                state.preemptiveQuotaScheduler.getDeferral(quotaScheduleKey, state.now()), state.now());",
    "            const nearExhaustionWaitMs = quotaDeferral.defer",
    "                ? quotaDeferral.waitMs",
    "                : 0;",
    "            if (nearExhaustionWaitMs > 0) {",
    "                // Drop session affinity either way: a request that just proved this",
    "                // account near its ceiling should not keep steering here. Only an",
    "                // observed 429 earns a persisted rate-limit window.",
    "                if (managedQuotaDeferralIsObserved(quotaDeferral)) {",
    "                    accountManager.markRateLimitedWithReason(refreshed.account, nearExhaustionWaitMs, context.family, \"quota\", context.model);",
    "                    accountManager.saveToDiskDebounced();",
    "                }",
    "                state.sessionAffinityStore?.forgetSessionWithVersion(managedSessionAffinityKey, state.now(), managedAffinityWriteVersion + 1);",
    "            }",
  ].join("\n");
  const successFirst = source.indexOf(successNeedle);
  if (successFirst < 0 ||
      source.indexOf(successNeedle, successFirst + successNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth r16 post-success advisory branch; refusing an unsafe patch");
  }
  source = source.slice(0, successFirst) + successReplacement +
    source.slice(successFirst + successNeedle.length);

  // Pool status must publish the same fixed probe horizon the selection loop
  // honours. Reporting `observedAt + cap` on every poll would advertise a
  // recovery that keeps sliding away and never arrives.
  // A pool-exhaustion 503 that names no backoff invites the client to retry
  // immediately and burn the turn -- which is what a client saw whenever the pool
  // was held only by state the account store cannot see. One second is the
  // minimum honest answer; a known horizon still wins.
  const retryAfterNeedle = [
    "    const managedRetryAfterSeconds = Number.isFinite(waitMs) && waitMs > 0",
    "        ? Math.max(1, Math.ceil(waitMs / 1000)) : null;",
    "    if (managedRetryAfterSeconds !== null)",
    "        res.setHeader(\"retry-after\", String(managedRetryAfterSeconds));",
  ].join("\n");
  const retryAfterReplacement = [
    "    const managedRetryAfterSeconds = Number.isFinite(waitMs) && waitMs > 0",
    "        ? Math.max(1, Math.ceil(waitMs / 1000)) : 1;",
    "    res.setHeader(\"retry-after\", String(managedRetryAfterSeconds));",
  ].join("\n");
  const retryAfterFirst = source.indexOf(retryAfterNeedle);
  if (retryAfterFirst < 0 ||
      source.indexOf(retryAfterNeedle, retryAfterFirst + retryAfterNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth r16 retry-after boundary; refusing an unsafe patch");
  }
  source = source.slice(0, retryAfterFirst) + retryAfterReplacement +
    source.slice(retryAfterFirst + retryAfterNeedle.length);

  const poolNearWaitNeedle = [
    "    const nearWait = snapshot.status === 429 ? 0 : Math.max(",
    "        primaryNear ? trustedWait(snapshot.primary) : 0,",
    "        secondaryNear ? trustedWait(snapshot.secondary) : 0);",
  ].join("\n");
  const poolNearWaitReplacement = [
    "    const advisoryRemaining = managedAdvisoryProbeRemainingMs(scheduler, key, now);",
    "    const nearWaitRaw = snapshot.status === 429 ? 0 : Math.max(",
    "        primaryNear ? trustedWait(snapshot.primary) : 0,",
    "        secondaryNear ? trustedWait(snapshot.secondary) : 0);",
    "    const nearWait = nearWaitRaw <= 0 || advisoryRemaining === null",
    "        ? nearWaitRaw",
    "        : Math.min(nearWaitRaw, advisoryRemaining);",
  ].join("\n");
  const exhaustedWaitNeedle = [
    "    const { res, accountManager, family, model, reason } = params;",
    "    const waitMs = accountManager.getMinWaitTimeForFamily(family, model);",
  ].join("\n");
  const exhaustedWaitReplacement = [
    "    const { res, accountManager, family, model, reason } = params;",
    "    const storeWaitMs = accountManager.getMinWaitTimeForFamily(family, model);",
    "    const waitMs = Number.isFinite(storeWaitMs) && storeWaitMs > 0",
    "        ? storeWaitMs",
    "        : (Number.isFinite(params.managedWaitMs) && params.managedWaitMs > 0",
    "            ? params.managedWaitMs",
    "            : storeWaitMs);",
  ].join("\n");
  const exhaustedWaitFirst = source.indexOf(exhaustedWaitNeedle);
  if (exhaustedWaitFirst < 0 ||
      source.indexOf(exhaustedWaitNeedle, exhaustedWaitFirst + exhaustedWaitNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth r16 pool-exhaustion wait; refusing an unsafe patch");
  }
  source = source.slice(0, exhaustedWaitFirst) + exhaustedWaitReplacement +
    source.slice(exhaustedWaitFirst + exhaustedWaitNeedle.length);

  const exhaustedCallNeedle = [
    "            writePoolExhausted({",
    "                res,",
    "                accountManager,",
    "                family: context.family,",
    "                model: context.model,",
    "                reason: exhaustionReason,",
  ].join("\n");
  const exhaustedCallReplacement = [
    "            writePoolExhausted({",
    "                res,",
    "                accountManager,",
    "                family: context.family,",
    "                model: context.model,",
    "                reason: exhaustionReason,",
    "                managedWaitMs: managedPoolExhaustionRetryAfterMs(",
    "                    state, accountManager, context.family, context.model, state.now()),",
  ].join("\n");
  const exhaustedCallFirst = source.indexOf(exhaustedCallNeedle);
  if (exhaustedCallFirst < 0 ||
      source.indexOf(exhaustedCallNeedle, exhaustedCallFirst + exhaustedCallNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth r16 pool-exhaustion call site; refusing an unsafe patch");
  }
  source = source.slice(0, exhaustedCallFirst) + exhaustedCallReplacement +
    source.slice(exhaustedCallFirst + exhaustedCallNeedle.length);

  const poolNearWaitFirst = source.indexOf(poolNearWaitNeedle);
  if (poolNearWaitFirst < 0 ||
      source.indexOf(poolNearWaitNeedle, poolNearWaitFirst + poolNearWaitNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth r16 pool-status advisory horizon; refusing an unsafe patch");
  }
  source = source.slice(0, poolNearWaitFirst) + poolNearWaitReplacement +
    source.slice(poolNearWaitFirst + poolNearWaitNeedle.length);
}

if (source.includes(managedTierMarker)) {
  const poolTierNeedle = 'serviceTier: "default",';
  const poolTierReplacement = 'serviceTier: managedServiceTierLabel(),';
  if (!source.includes(poolTierReplacement)) {
    const poolTierFirst = source.indexOf(poolTierNeedle);
    if (poolTierFirst < 0 ||
        source.indexOf(poolTierNeedle, poolTierFirst + poolTierNeedle.length) >= 0) {
      throw new Error("managed Codex pool tier is missing or duplicated");
    }
    source = source.slice(0, poolTierFirst) + poolTierReplacement +
      source.slice(poolTierFirst + poolTierNeedle.length);
  }
}

if (source.includes(sharedAdmissionMarker)) {
  const refundPattern = /^\s*accountManager\.refundToken\([^;\n]+;\n/gm;
  const refundCalls = source.match(refundPattern) ?? [];
  if (refundCalls.length !== 0 && refundCalls.length !== 8) {
    throw new Error(`unsupported codex-multi-auth token-refund layout (${refundCalls.length}); refusing an unsafe patch`);
  }
  if (refundCalls.length === 8) source = source.replace(refundPattern, "");
}

if (!source.includes(clientTierMarker)) {
  const oldHelper = [
    "const MANAGED_SERVICE_TIER = (() => {",
    "    const configured = String(process.env.CODEX_MANAGED_SERVICE_TIER ?? \"default\").trim();",
    "    if (configured === \"default\") return Object.freeze({ label: \"default\", wire: \"default\" });",
    "    if (configured === \"fast\") return Object.freeze({ label: \"fast\", wire: \"priority\" });",
    "    if (configured === \"ultrafast\") return Object.freeze({ label: \"ultrafast\", wire: \"ultrafast\" });",
    "    throw new Error(\"CODEX_MANAGED_SERVICE_TIER must be default, fast, or ultrafast\");",
    "})();",
    "function managedServiceTierWireValue() { return MANAGED_SERVICE_TIER.wire; }",
    "function managedServiceTierLabel() { return MANAGED_SERVICE_TIER.label; }",
  ].join("\n");
  const clientHelper = [
    "// codex-multi-auth r23 policy: honor per-request service tier.",
    "function managedServiceTierWireValue(parsedBody) {",
    "    switch (parsedBody?.service_tier) {",
    "        case undefined:",
    "        case null:",
    "        case \"auto\":",
    "        case \"default\": return \"default\";",
    "        case \"fast\":",
    "        case \"priority\": return \"priority\";",
    "        case \"ultrafast\": return \"ultrafast\";",
    "        default: throw createRuntimeProxyHttpError(\"Unsupported Codex request service_tier.\", 400, \"codex_invalid_service_tier\");",
    "    }",
    "}",
    "// Pool status has no session: serviceTier reports only the omitted-tier fallback.",
    "function managedServiceTierLabel() { return \"default\"; }",
  ].join("\n");
  const tierRewrites = [
    [oldHelper, clientHelper],
    ['service_tier: managedServiceTierWireValue()', 'service_tier: managedServiceTierWireValue(parsedBody)'],
    ['tier=${managedServiceTierWireValue()}', 'tier=${managedServiceTierWireValue(parsedBody)}'],
  ];
  for (const [needle, replacement] of tierRewrites) {
    const first = source.indexOf(needle);
    if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
      throw new Error("unsupported Codex per-request tier migration layout; refusing an unsafe patch");
    }
    source = source.slice(0, first) + replacement + source.slice(first + needle.length);
  }
}

const requiredSnippets = [
  identityMarker,
  rotationMarker,
  managedTierMarker,
  managedRoutingHintMarker,
  managedNonResponsesRoutingHintMarker,
  sharedAdmissionMarker,
  sameAccountRetryMarker,
  transientRetryMarker,
  quotaBillingFailoverMarker,
  localModelsMarker,
  terminalExhaustionMarker,
  poolStatusMarker,
  advisoryQuotaMarker,
  "codex-multi-auth r23 policy: honor per-request service tier",
  'function managedServiceTierWireValue(parsedBody) {',
  'switch (parsedBody?.service_tier)',
  'case "default": return "default";',
  'case "priority": return "priority";',
  'case "ultrafast": return "ultrafast";',
  'Unsupported Codex request service_tier.',
  '400, "codex_invalid_service_tier"',
  'service_tier: managedServiceTierWireValue(parsedBody)',
  'headers.delete("x-codex-routing-hint");',
  "    if (!model || parsedBody.model !== model ||",
  "        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)) {",
  'Codex Responses model must be a canonical model slug before managed service-tier routing can be enforced.',
  'headers.set("x-codex-routing-hint", `model=${model};tier=${managedServiceTierWireValue(parsedBody)}`);',
  "const managedTierBody = forceManagedServiceTier(parsedBody);",
  "body: managedTierBody",
  'accountSkipReasons.set(refreshed.account.index, "model-unsupported")',
  'isAccountModelEntitlementError(upstream.status, context.model, errorCode, bodyText)',
  "managedRetryAccountIndex = refreshed.account.index",
  "managedSameAccountRetryCountByAccount",
  "waitForManagedPoolIfReady",
  "managedQuotaDeferralIsObserved",
  "managedBoundQuotaDeferral",
  "managedQuotaWindowProvesExhaustion",
  "managedAdvisoryProbeRemainingMs",
  "managedPoolExhaustionRetryAfterMs",
  "                    accountManager.recordRateLimit(selected, context.family, context.model);",
  "                    deferManagedAdmission(state, selected.index, preemptiveDeferral.waitMs);",
  "        ? Math.max(1, Math.ceil(waitMs / 1000)) : 1;",
  "    const advisoryRemaining = managedAdvisoryProbeRemainingMs(scheduler, key, now);",
  "                managedWaitMs: managedPoolExhaustionRetryAfterMs(",
  "revalidateManagedAdmission",
  "createManagedRequestLifecycle",
  "managedLifecycle.cleanup()",
  "managedAdmissionLanes",
  "managedMachineRouter",
  "managedAffinityWriteVersion",
  "managedSessionAffinityKey",
  "clearAllWithVersion(state.managedAffinityWriteVersion * 4 + 3)",
  "forgetSessionWithVersion(managedSessionAffinityKey",
  "const delivered = forwarded && !managedLifecycle.cancelled",
  "if (!isThreadGoalRequest && upstream.status >= 400)",
  "MANAGED_MAX_UPSTREAM_ATTEMPTS",
  "writeJson(res, HTTP_STATUS.OK, { models: [] });",
  'const MANAGED_POOL_STATUS_PATH = "/managed/pool-status";',
  "async function buildManagedPoolStatus(state, model)",
  "function managedPoolQuotaDeferral(scheduler, key, now)",
  'serviceTier: managedServiceTierLabel()',
  '    res.setHeader("cache-control", "no-store");',
  '    res.setHeader("x-content-type-options", "nosniff");',
  "codex_managed_pool_status_method_not_allowed",
  "codex_managed_pool_status_unavailable",
];
const forbiddenTierSnippets = [
  "const MANAGED_SERVICE_TIER",
  "process.env.CODEX_MANAGED_SERVICE_TIER",
  "managedServiceTierWireValue()",
  legacyStandardTierMarker,
  standardTierMarker,
  standardRoutingHintMarker,
  standardNonResponsesRoutingHintMarker,
  fastTierMarker,
  fastRoutingHintMarker,
  nonResponsesRoutingHintMarker,
  "forceFastServiceTier",
  "fastTierBody",
  'service_tier: "priority"',
];
if (requiredSnippets.some((value) => !source.includes(value)) ||
    forbiddenTierSnippets.some((value) => source.includes(value)) ||
    source.includes(legacyLocalModelsMarker) ||
    source.includes("codex_managed_model_discovery_disabled") ||
    source.includes("writeJson(res, normalizeExhaustionStatus(reason)") ||
    source.includes("statusCode: normalizeExhaustionStatus(exhaustionReason)") ||
    source.includes("accountManager.refundToken(") ||
    source.includes("managed429RetryCountByAccount") ||
    source.includes("managedTransientRetryCountByAccount") ||
    source.includes("forgetSession(context.sessionKey)") ||
    source.includes("rememberWithVersion(context.sessionKey")) {
  throw new Error("codex-multi-auth strict exact-model rotation patch is incomplete");
}
const exactRoutingSnippetCounts = new Map([
  [managedRoutingHintMarker, 1],
  [managedNonResponsesRoutingHintMarker, 1],
  ['headers.delete("x-codex-routing-hint");', 2],
  ['headers.set("x-codex-routing-hint", `model=${model};tier=${managedServiceTierWireValue(parsedBody)}`);', 1],
  ["    if (!model || parsedBody.model !== model ||", 1],
  ['Codex Responses model must be a canonical model slug before managed service-tier routing can be enforced.', 1],
]);
for (const [snippet, expectedCount] of exactRoutingSnippetCounts) {
  if (source.split(snippet).length - 1 !== expectedCount) {
    throw new Error("Codex managed routing-hint normalization is duplicated or incomplete");
  }
}
const preHeaderRelease = source.indexOf(
  "            // Admission bounds only token refresh and the pre-header fetch.\n" +
  "            // Long response bodies must not occupy the per-account lane.\n" +
  "            admissionRelease();",
);
const quotaSnapshotBoundary = source.indexOf(
  "            const quotaSnapshot = readQuotaSchedulerSnapshot(upstream.headers, upstream.status, state.now());",
);
const streamingBoundary = source.indexOf(
  "            const forwarded = await forwardStreamingResponse(",
  quotaSnapshotBoundary,
);
if (preHeaderRelease < 0 || quotaSnapshotBoundary < 0 || streamingBoundary < 0 ||
    preHeaderRelease > quotaSnapshotBoundary || quotaSnapshotBoundary > streamingBoundary) {
  throw new Error("codex-multi-auth admission lane is not released at the pre-header boundary");
}
const quotaBillingFailoverBoundary = source.indexOf(`                // ${quotaBillingFailoverMarker}.`);
const workspaceDisabledBoundary = source.indexOf(
  "                if (isWorkspaceDisabledError(upstream.status, errorCode, bodyText)) {",
  quotaBillingFailoverBoundary,
);
if (quotaBillingFailoverBoundary < 0 || workspaceDisabledBoundary < 0 ||
    quotaBillingFailoverBoundary > workspaceDisabledBoundary ||
    !source.slice(quotaBillingFailoverBoundary, workspaceDisabledBoundary).includes(
      "if (!isPinned && isConfirmedQuotaExhaustion(errorCode)) {",
    ) ||
    !source.slice(quotaBillingFailoverBoundary, workspaceDisabledBoundary).includes(
      "accountManager.markRateLimitedWithReason(",
    ) ||
    !source.slice(quotaBillingFailoverBoundary, workspaceDisabledBoundary).includes(
      "continue;",
    )) {
  throw new Error("codex-multi-auth r7 quota/billing failover patch is incomplete");
}

const stats = fs.statSync(proxyPath);
const originalSource = fs.readFileSync(proxyPath, "utf8");

const affinityMarker = "codex-multi-auth local policy: versioned affinity tombstones";
let affinitySource = fs.readFileSync(sessionAffinityPath, "utf8");
function replaceAffinityUnique(needle, replacement, label) {
  const first = affinitySource.indexOf(needle);
  if (first < 0 || affinitySource.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`unsupported codex-multi-auth ${label} layout; refusing an unsafe patch`);
  }
  affinitySource = affinitySource.slice(0, first) + replacement +
    affinitySource.slice(first + needle.length);
}

if (!affinitySource.includes(affinityMarker)) {
  replaceAffinityUnique(
    "    writeVersionCounter = 0;\n",
    [
      `    // ${affinityMarker}.`,
      "    // A delete must participate in the same arrival-order protocol as a",
      "    // remember. The floor also prevents a request that predates a manual",
      "    // affinity-generation reset from resurrecting the cleared mapping.",
      "    writeVersionCounter = 0;",
      "    writeVersionFloor = 0;",
      "",
    ].join("\n"),
    "affinity write-version state",
  );
  replaceAffinityUnique(
    "        return entry.accountIndex;\n",
    "        if (entry.deleted === true)\n            return null;\n        return entry.accountIndex;\n",
    "affinity preferred-account read",
  );
  replaceAffinityUnique(
    [
      "        const normalizedWriteVersion = this.normalizeWriteVersion(writeVersion);",
      "        const existingEntry = this.entries.get(key);",
      "        if (existingEntry &&",
      "            existingEntry.expiresAt > now &&",
      "            existingEntry.writeVersion > normalizedWriteVersion) {",
      "            return;",
      "        }",
    ].join("\n"),
    [
      "        const normalizedWriteVersion = this.normalizeWriteVersion(writeVersion);",
      "        if (normalizedWriteVersion < this.writeVersionFloor)",
      "            return;",
      "        const existingEntry = this.entries.get(key);",
      "        if (existingEntry &&",
      "            existingEntry.expiresAt > now &&",
      "            (existingEntry.writeVersion > normalizedWriteVersion ||",
      "                (existingEntry.deleted === true &&",
      "                    existingEntry.writeVersion === normalizedWriteVersion))) {",
      "            return;",
      "        }",
    ].join("\n"),
    "versioned affinity remember",
  );
  replaceAffinityUnique(
    "        const lastResponseId = typeof entry.lastResponseId === \"string\" ? entry.lastResponseId.trim() : \"\";\n",
    "        if (entry.deleted === true)\n            return null;\n        const lastResponseId = typeof entry.lastResponseId === \"string\" ? entry.lastResponseId.trim() : \"\";\n",
    "affinity response-id read",
  );
  replaceAffinityUnique(
    [
      "        const normalizedWriteVersion = this.normalizeWriteVersion(writeVersion);",
      "        const entry = this.entries.get(key);",
      "        if (!entry)",
      "            return;",
    ].join("\n"),
    [
      "        const normalizedWriteVersion = this.normalizeWriteVersion(writeVersion);",
      "        if (normalizedWriteVersion < this.writeVersionFloor)",
      "            return;",
      "        const entry = this.entries.get(key);",
      "        if (!entry || entry.deleted === true)",
      "            return;",
    ].join("\n"),
    "versioned affinity response-id update",
  );
  replaceAffinityUnique(
    [
      "    forgetSession(sessionKey) {",
      "        const key = normalizeSessionKey(sessionKey);",
      "        if (!key)",
      "            return;",
      "        this.entries.delete(key);",
      "    }",
    ].join("\n"),
    [
      "    forgetSession(sessionKey) {",
      "        this.forgetSessionWithVersion(sessionKey);",
      "    }",
      "    forgetSessionWithVersion(sessionKey, now = Date.now(), writeVersion) {",
      "        const key = normalizeSessionKey(sessionKey);",
      "        if (!key)",
      "            return;",
      "        const normalizedWriteVersion = this.normalizeWriteVersion(writeVersion);",
      "        if (normalizedWriteVersion < this.writeVersionFloor)",
      "            return;",
      "        const existingEntry = this.entries.get(key);",
      "        if (existingEntry && existingEntry.expiresAt > now &&",
      "            existingEntry.writeVersion > normalizedWriteVersion)",
      "            return;",
      "        this.setEntry(key, {",
      "            accountIndex: -1,",
      "            deleted: true,",
      "            expiresAt: now + this.ttlMs,",
      "            updatedAt: now,",
      "            writeVersion: normalizedWriteVersion,",
      "        });",
      "    }",
    ].join("\n"),
    "versioned affinity delete",
  );
  replaceAffinityUnique(
    [
      "    clearAll() {",
      "        if (this.entries.size === 0)",
      "            return;",
      "        this.entries.clear();",
      "    }",
    ].join("\n"),
    [
      "    clearAll() {",
      "        if (this.entries.size === 0)",
      "            return;",
      "        this.entries.clear();",
      "    }",
      "    clearAllWithVersion(writeVersion) {",
      "        const normalizedWriteVersion = this.normalizeWriteVersion(writeVersion);",
      "        this.writeVersionFloor = Math.max(this.writeVersionFloor, normalizedWriteVersion);",
      "        for (const [key, entry] of this.entries.entries()) {",
      "            if (entry.writeVersion <= normalizedWriteVersion)",
      "                this.entries.delete(key);",
      "        }",
      "    }",
    ].join("\n"),
    "versioned affinity generation reset",
  );
}

for (const required of [
  affinityMarker,
  "writeVersionFloor = 0",
  "forgetSessionWithVersion(sessionKey",
  "clearAllWithVersion(writeVersion)",
  "entry.deleted === true",
]) {
  if (!affinitySource.includes(required)) {
    throw new Error(`codex-multi-auth versioned affinity patch is incomplete: ${required}`);
  }
}
const originalAffinitySource = fs.readFileSync(sessionAffinityPath, "utf8");
const affinityStats = fs.statSync(sessionAffinityPath);
function stageCheckedJavaScript(targetPath, content, mode, label) {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.tmp.js`,
  );
  fs.writeFileSync(temporaryPath, content, { mode });
  fs.chmodSync(temporaryPath, mode);
  const checked = spawnSync(process.execPath, ["--check", temporaryPath], {
    encoding: "utf8",
  });
  if (checked.status !== 0) {
    fs.rmSync(temporaryPath, { force: true });
    throw new Error(
      `generated codex-multi-auth ${label} failed syntax validation: ${checked.stderr.trim()}`,
    );
  }
  return temporaryPath;
}
let affinityTemporaryPath = null;
let proxyTemporaryPath = null;
try {
  if (affinitySource !== originalAffinitySource) {
    affinityTemporaryPath = stageCheckedJavaScript(
      sessionAffinityPath, affinitySource, affinityStats.mode & 0o777, "session affinity store",
    );
  }
  if (source !== originalSource) {
    proxyTemporaryPath = stageCheckedJavaScript(
      proxyPath, source, stats.mode & 0o777, "runtime proxy",
    );
  }
  // The affinity extension is backward-compatible with the old proxy. Commit it
  // first so an interruption can never leave new proxy calls against an old store.
  if (affinityTemporaryPath) {
    fs.renameSync(affinityTemporaryPath, sessionAffinityPath);
    affinityTemporaryPath = null;
  }
  if (proxyTemporaryPath) {
    fs.renameSync(proxyTemporaryPath, proxyPath);
    proxyTemporaryPath = null;
  }
}
finally {
  if (affinityTemporaryPath) fs.rmSync(affinityTemporaryPath, { force: true });
  if (proxyTemporaryPath) fs.rmSync(proxyTemporaryPath, { force: true });
}
