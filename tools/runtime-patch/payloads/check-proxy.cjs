const fs = require("node:fs");
const source = fs.readFileSync(process.env.ROUTER_CODEX_PROXY_FILE, "utf8");
const required = [
  "codex-multi-auth local compatibility: preserve official Codex client identity",
  "codex-multi-auth local compatibility: rotate accounts for exact-model entitlement errors",
  "codex-multi-auth r15 policy: enforce machine-local service tier",
  "codex-multi-auth r15 policy: bind canonical machine-local routing hint",
  "codex-multi-auth r15 policy: strip managed routing hint from non-Responses requests",
  "codex-multi-auth local policy: machine router owns request admission",
  "codex-multi-auth local policy: retry transient 429 on the sticky account",
  "codex-multi-auth local policy: hide retryable transport and server failures",
  "codex-multi-auth r7 policy: rotate confirmed quota and billing failures",
  "codex-multi-auth r14 policy: serve local empty model catalog",
  "codex-multi-auth r10 policy: sanitize terminal pool exhaustion as retryable 503",
  "codex-multi-auth r16 policy: never persist advisory quota deferrals as rate limits",
  'const MANAGED_SERVICE_TIER = (() => {',
  'if (configured === "default") return Object.freeze({ label: "default", wire: "default" });',
  'if (configured === "fast") return Object.freeze({ label: "fast", wire: "priority" });',
  'if (configured === "ultrafast") return Object.freeze({ label: "ultrafast", wire: "ultrafast" });',
  'CODEX_MANAGED_SERVICE_TIER must be default, fast, or ultrafast',
  'service_tier: managedServiceTierWireValue()',
  'headers.delete("x-codex-routing-hint");',
  "    if (!model || parsedBody.model !== model ||",
  "        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)) {",
  'Codex Responses model must be a canonical model slug before managed service-tier routing can be enforced.',
  'headers.set("x-codex-routing-hint", `model=${model};tier=${managedServiceTierWireValue()}`);',
  "const managedTierBody = forceManagedServiceTier(parsedBody);",
  "body: managedTierBody",
  'accountSkipReasons.set(refreshed.account.index, "model-unsupported")',
  'isAccountModelEntitlementError(upstream.status, context.model, errorCode, bodyText)',
  "managedMachineRouter",
  "managedAdmissionLanes",
  "MANAGED_MAX_UPSTREAM_ATTEMPTS",
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
  "writeJson(res, HTTP_STATUS.OK, { models: [] });",
  "managedSameAccountRetryCountByAccount",
  "revalidateManagedAdmission",
  "managedLifecycle.cleanup()",
  "managedSessionAffinityKey",
  "clearAllWithVersion(state.managedAffinityWriteVersion * 4 + 3)",
  "forgetSessionWithVersion(managedSessionAffinityKey",
  "rememberWithVersion(managedSessionAffinityKey",
  "const delivered = forwarded && !managedLifecycle.cancelled",
  "if (!isThreadGoalRequest && upstream.status >= 400)",
  'serviceTier: managedServiceTierLabel()',
];
const forbidden = [
  "headers.set(OPENAI_HEADERS.BETA, OPENAI_HEADER_VALUES.BETA_RESPONSES)",
  "headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX)",
  "codex-multi-auth local policy: force Standard service tier",
  "codex-multi-auth r14 policy: force Standard service tier",
  "codex-multi-auth r14 policy: bind canonical Standard routing hint to exact model",
  "codex-multi-auth r14 policy: strip managed routing hint from non-Responses requests",
  "codex-multi-auth local policy: force Fast service tier",
  "codex-multi-auth r9 policy: bind canonical Fast routing hint to exact model",
  "codex-multi-auth r9 policy: strip Fast routing hint from non-Responses requests",
  "forceFastServiceTier",
  "fastTierBody",
  'service_tier: "priority"',
  "accountManager.consumeToken(",
  "accountManager.refundToken(",
  "codex-multi-auth local policy: model discovery never reaches upstream",
  "codex_managed_model_discovery_disabled",
  "managed429RetryCountByAccount",
  "managedTransientRetryCountByAccount",
  "forgetSession(context.sessionKey)",
  "rememberWithVersion(context.sessionKey",
  "writeJson(res, normalizeExhaustionStatus(reason)",
  "statusCode: normalizeExhaustionStatus(exhaustionReason)",
];
if (required.some((value) => !source.includes(value)) ||
    forbidden.some((value) => source.includes(value))) {
  process.exit(1);
}
const exactRoutingSnippetCounts = new Map([
  ["codex-multi-auth r15 policy: bind canonical machine-local routing hint", 1],
  ["codex-multi-auth r15 policy: strip managed routing hint from non-Responses requests", 1],
  ['headers.delete("x-codex-routing-hint");', 2],
  ['headers.set("x-codex-routing-hint", `model=${model};tier=${managedServiceTierWireValue()}`);', 1],
  ["    if (!model || parsedBody.model !== model ||", 1],
  ['Codex Responses model must be a canonical model slug before managed service-tier routing can be enforced.', 1],
]);
for (const [snippet, expectedCount] of exactRoutingSnippetCounts) {
  if (source.split(snippet).length - 1 !== expectedCount) process.exit(1);
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
  process.exit(1);
}
const quotaBillingFailoverBoundary = source.indexOf(
  "                // codex-multi-auth r7 policy: rotate confirmed quota and billing failures.",
);
const workspaceDisabledBoundary = source.indexOf(
  "                if (isWorkspaceDisabledError(upstream.status, errorCode, bodyText)) {",
  quotaBillingFailoverBoundary,
);
const quotaBillingFailoverBranch = source.slice(
  quotaBillingFailoverBoundary,
  workspaceDisabledBoundary,
);
if (quotaBillingFailoverBoundary < 0 || workspaceDisabledBoundary < 0 ||
    quotaBillingFailoverBoundary > workspaceDisabledBoundary ||
    !quotaBillingFailoverBranch.includes(
      "if (!isPinned && isConfirmedQuotaExhaustion(errorCode)) {",
    ) ||
    !quotaBillingFailoverBranch.includes("accountManager.markRateLimitedWithReason(") ||
    !quotaBillingFailoverBranch.includes("continue;")) {
  process.exit(1);
}
