const fs = require("node:fs");
const path = require("node:path");

const wrapperPath = process.env.ROUTER_CODEX_WRAPPER_FILE;
const strictMarker = "codex-multi-auth local compatibility: forbid every model fallback";
const requiredRouterMarker = "codex-multi-auth local compatibility: runtime account router is mandatory";
const canonicalExecMarker = "codex-multi-auth local compatibility: reuse canonical Codex index for exec";
const skipRepairMarker = "codex-multi-auth local compatibility: canonical index needs no full post-run repair";
const noStartupUpdateMarker = "codex-multi-auth local compatibility: no network update check during launch";
const interactiveOwnerMarker = "codex-multi-auth local compatibility: stop interactive helper with owner";
const sharedRouterMarker = "codex-multi-auth local policy: every Codex command uses the machine router";
// The published wrapper currently mixes CRLF and LF. Normalize the pinned
// source before exact structural matching so line endings cannot weaken the
// fail-closed layout guard.
let source = fs.readFileSync(wrapperPath, "utf8").replace(/\r\n/g, "\n");

if (!source.includes(noStartupUpdateMarker)) {
  const updateNeedle = "\tawait showUpdateNoticeIfAvailable(rawArgs, normalizedArgs);";
  const updateStart = source.indexOf(updateNeedle);
  if (updateStart < 0 ||
      source.indexOf(updateNeedle, updateStart + updateNeedle.length) >= 0) {
    throw new Error(
      "unsupported codex-multi-auth startup update layout; refusing an unsafe patch",
    );
  }
  const updateReplacement = [
    `\t// ${noStartupUpdateMarker}.`,
    "\t// Package upgrades are explicit setup operations. Public `codex` startup",
    "\t// performs no registry request and never mutates its executable runtime.",
  ].join("\n");
  source = source.slice(0, updateStart) + updateReplacement +
    source.slice(updateStart + updateNeedle.length);
}

if (!source.includes(interactiveOwnerMarker)) {
  const interactiveStartNeedle =
    "\tconst isRootTuiLaunch = isCodexInteractiveTuiCommand(rawArgs);";
  const interactiveStart = source.indexOf(interactiveStartNeedle);
  const interactiveEnd = source.indexOf("\n\tconst proxyModule =", interactiveStart);
  if (interactiveStart < 0 || interactiveEnd < 0 ||
      source.indexOf(interactiveStartNeedle, interactiveStart + interactiveStartNeedle.length) >= 0) {
    throw new Error(
      "unsupported codex-multi-auth interactive-helper boundary; refusing an unsafe patch",
    );
  }
  const interactiveBlock = source.slice(interactiveStart, interactiveEnd);
  const detachNeedle = "\t\t\tdetachOnExit: true,";
  const detachStart = interactiveBlock.indexOf(detachNeedle);
  if (detachStart < 0 ||
      interactiveBlock.indexOf(detachNeedle, detachStart + detachNeedle.length) >= 0 ||
      !interactiveBlock.includes("isCodexInteractiveResumeCommand(rawArgs)")) {
    throw new Error(
      "unsupported codex-multi-auth interactive-helper layout; refusing an unsafe patch",
    );
  }
  const detachReplacement = [
    `\t\t\t// ${interactiveOwnerMarker}.`,
    "\t\t\t// The forwarded TUI is the only consumer. Once it exits there is",
    "\t\t\t// nobody to hand the immutable proxy URL to, so retaining that helper",
    "\t\t\t// for the detached idle window only accumulates processes and memory.",
    "\t\t\tdetachOnExit: false,",
  ].join("\n");
  const patchedInteractiveBlock = interactiveBlock.slice(0, detachStart) +
    detachReplacement + interactiveBlock.slice(detachStart + detachNeedle.length);
  source = source.slice(0, interactiveStart) + patchedInteractiveBlock +
    source.slice(interactiveEnd);
}

if (!source.includes(sharedRouterMarker)) {
  const functionNeedle = "async function createRuntimeRotationProxyContextIfEnabled(\n\tbaseContext,\n\trawArgs,\n) {";
  const functionFirst = source.indexOf(functionNeedle);
  if (functionFirst < 0 || source.indexOf(functionNeedle, functionFirst + functionNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth proxy-context boundary; refusing an unsafe patch");
  }
  const sharedHelper = [
    `// ${sharedRouterMarker}.`,
    "function createSharedMachineRouterContext(baseContext, rawArgs, configTomlModule) {",
    "\tconst proxyBaseUrl = (baseContext.env.CODEX_MULTI_AUTH_SHARED_PROXY_URL ?? \"\").trim();",
    "\tconst clientApiKey = (baseContext.env.CODEX_MULTI_AUTH_SHARED_PROXY_CLIENT_KEY ?? \"\").trim();",
    "\tif (!proxyBaseUrl && !clientApiKey) return null;",
    "\tif (!/^http:\\/\\/(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):[0-9]+$/.test(proxyBaseUrl) || !clientApiKey) {",
    "\t\tthrow new Error(\"managed machine router requires a loopback URL and client key\");",
    "\t}",
    "\tconst sharedContext = createRuntimeRotationProxyCanonicalCodexHome(",
    "\t\tbaseContext.env,",
    "\t\tproxyBaseUrl,",
    "\t\tclientApiKey,",
    "\t\tconfigTomlModule,",
    "\t);",
    "\tconst providerArgs = [",
    "\t\t...(sharedContext.args ?? []),",
    "\t\t\"-c\",",
    "\t\t`model_provider=${configTomlModule.tomlStringLiteral(RUNTIME_ROTATION_PROXY_PROVIDER_ID)}` ,",
    "\t\t\"-c\",",
    "\t\t`model_providers.${RUNTIME_ROTATION_PROXY_PROVIDER_ID}.request_max_retries=0`,",
    "\t];",
    "\tlet appServerShimDir = null;",
    "\tif (isCodexAppCommand(rawArgs)) {",
    "\t\tappServerShimDir = installRuntimeRotationAppServerCliShim(sharedContext.env, providerArgs);",
    "\t}",
    "\tif (isCodexAppServerCommand(rawArgs)) {",
    "\t\tsharedContext.env[APP_SERVER_ACCOUNT_LABEL_ENV] = \"1\";",
    "\t}",
    "\tconst isRootTuiLaunch = isCodexInteractiveTuiCommand(rawArgs);",
    "\tconst args = isRootTuiLaunch",
    "\t\t? insertArgsBeforeRootPrompt(baseContext.args, providerArgs)",
    "\t\t: insertArgsBeforeForwardedSeparator(baseContext.args, providerArgs);",
    "\treturn {",
    "\t\targs,",
    "\t\tenv: sharedContext.env,",
    "\t\tproxyAppServerAccountRead: isCodexAppServerCommand(rawArgs),",
    "\t\tcleanup: async (details = {}) => {",
    "\t\t\ttry {",
    "\t\t\t\t// A successful `codex app` hands this shim to the desktop app;",
    "\t\t\t\t// its stable machine-router URL remains valid after the launcher exits.",
    "\t\t\t\tif (appServerShimDir && details.exitCode !== 0) {",
    "\t\t\t\t\tremoveDirectoryWithRetry(appServerShimDir);",
    "\t\t\t\t}",
    "\t\t\t} finally {",
    "\t\t\t\tsharedContext.cleanup?.();",
    "\t\t\t\tbaseContext.cleanup?.();",
    "\t\t\t}",
    "\t\t},",
    "\t};",
    "}",
    functionNeedle,
  ].join("\n");
  source = source.slice(0, functionFirst) + sharedHelper +
    source.slice(functionFirst + functionNeedle.length);
}

if (!source.includes(strictMarker)) {
  const mapStartNeedle = "const WRAPPER_UNSUPPORTED_MODEL_FALLBACK_CHAIN = {";
  const mapEndNeedle = "\n\nfunction canonicalizeRequestedModelName";
  const mapStart = source.indexOf(mapStartNeedle);
  const mapEnd = source.indexOf(mapEndNeedle, mapStart + mapStartNeedle.length);
  if (mapStart < 0 || mapEnd < 0 ||
      source.indexOf(mapStartNeedle, mapStart + mapStartNeedle.length) >= 0) {
    throw new Error(
      "unsupported codex-multi-auth fallback-map layout; refusing an unsafe patch",
    );
  }
  const emptyMap = [
    `// ${strictMarker}.`,
    "// The wrapper may recognize an entitlement error for diagnostics, but it",
    "// must never rewrite the caller's requested model.",
    "const WRAPPER_UNSUPPORTED_MODEL_FALLBACK_CHAIN = Object.freeze({});",
  ].join("\n");
  source = source.slice(0, mapStart) + emptyMap + source.slice(mapEnd);

  const forwardStartNeedle = "async function forwardToRealCodex(";
  const forwardEndNeedle = "\nfunction hasCliAuthCredentialsStoreOverride(";
  const forwardStart = source.indexOf(forwardStartNeedle);
  const forwardEnd = source.indexOf(forwardEndNeedle, forwardStart + forwardStartNeedle.length);
  if (forwardStart < 0 || forwardEnd < 0 ||
      source.indexOf(forwardStartNeedle, forwardStart + forwardStartNeedle.length) >= 0) {
    throw new Error(
      "unsupported codex-multi-auth forwarder layout; refusing an unsafe patch",
    );
  }
  const strictForwarder = [
    "async function forwardToRealCodex(codexBin, rawArgs, baseEnv = process.env) {",
    "\tconst { args: forwardArgs, requestedModel } = buildForwardArgs(rawArgs);",
    "\tconst compatibility = createCompatibilityCodexHome(",
    "\t\tforwardArgs,",
    "\t\trequestedModel,",
    "\t\tbaseEnv,",
    "\t);",
    "\tconst runtimeProxyContext = await createRuntimeRotationProxyContextIfEnabled(",
    "\t\tcompatibility,",
    "\t\trawArgs,",
    "\t);",
    "\tif (runtimeProxyContext.startupError) {",
    "\t\tconsole.error(runtimeProxyContext.startupError);",
    "\t\treturn 1;",
    "\t}",
    "\tconst result = await forwardToRealCodexOnce(",
    "\t\tcodexBin,",
    "\t\truntimeProxyContext.args,",
    "\t\truntimeProxyContext.env,",
    "\t\truntimeProxyContext.cleanup,",
    "\t\t{",
    "\t\t\tcaptureOutput: shouldCaptureForwardedOutputForArgs(",
    "\t\t\t\trawArgs,",
    "\t\t\t\truntimeProxyContext.env,",
    "\t\t\t),",
    "\t\t\tproxyAppServerAccountRead:",
    "\t\t\t\tisCodexAppServerCommand(rawArgs) &&",
    "\t\t\t\t(runtimeProxyContext.proxyAppServerAccountRead === true ||",
    "\t\t\t\t\t(runtimeProxyContext.env[APP_SERVER_ACCOUNT_LABEL_ENV] ?? \"\").trim() === \"1\"),",
    "\t\t},",
    "\t);",
    "\tif (result.exitCode === 0) {",
    "\t\trepairCodexSessionIndex(resolveCodexHomeDir(baseEnv));",
    "\t}",
    "\treturn result.exitCode;",
    "}",
  ].join("\n");
  source = source.slice(0, forwardStart) + strictForwarder + source.slice(forwardEnd);
}

if (!source.includes(requiredRouterMarker)) {
  const configFallback = [
    "\tif (!configTomlModule) {",
    "\t\tconsole.error(",
    "\t\t\t\"codex-multi-auth runtime rotation config helpers are unavailable; continuing without runtime rotation.\",",
    "\t\t);",
    "\t\treturn baseContext;",
    "\t}",
  ].join("\n");
  const configRequired = [
    `\t// ${requiredRouterMarker}.`,
    "\tif (!configTomlModule) {",
    "\t\tbaseContext.cleanup?.();",
    "\t\treturn {",
    "\t\t\tstartupError: \"codex-multi-auth runtime rotation config helpers are unavailable; refusing single-account fallback.\",",
    "\t\t};",
    "\t}",
  ].join("\n");
  const proxyFallback = [
    "\tif (!proxyModule) {",
    "\t\tconsole.error(",
    "\t\t\t\"codex-multi-auth runtime rotation proxy is unavailable; continuing without runtime rotation.\",",
    "\t\t);",
    "\t\treturn baseContext;",
    "\t}",
  ].join("\n");
  const proxyRequired = [
    "\tif (!proxyModule) {",
    "\t\tbaseContext.cleanup?.();",
    "\t\treturn {",
    "\t\t\tstartupError: \"codex-multi-auth runtime rotation proxy is unavailable; refusing single-account fallback.\",",
    "\t\t};",
    "\t}",
  ].join("\n");
  const catchFallback = [
    "\t\tconsole.error(",
    "\t\t\t`codex-multi-auth runtime rotation proxy failed to start; continuing without runtime rotation: ${error instanceof Error ? error.message : String(error)}`,",
    "\t\t);",
    "\t\treturn baseContext;",
  ].join("\n");
  const catchRequired = [
    "\t\tbaseContext.cleanup?.();",
    "\t\treturn {",
    "\t\t\tstartupError: `codex-multi-auth runtime rotation proxy failed to start; refusing single-account fallback: ${error instanceof Error ? error.message : String(error)}`,",
    "\t\t};",
  ].join("\n");
  for (const [needle, replacement, label] of [
    [configFallback, configRequired, "config-helper fallback"],
    [proxyFallback, proxyRequired, "runtime-proxy fallback"],
    [catchFallback, catchRequired, "runtime-start fallback"],
  ]) {
    const first = source.indexOf(needle);
    if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
      throw new Error(`unsupported codex-multi-auth ${label} layout; refusing an unsafe patch`);
    }
    source = source.slice(0, first) + replacement + source.slice(first + needle.length);
  }
}

if (!source.includes("const sharedContext = createSharedMachineRouterContext(baseContext, rawArgs, configTomlModule);")) {
  const configGateNeedle = [
    "\tif (!configTomlModule) {",
    "\t\tbaseContext.cleanup?.();",
    "\t\treturn {",
    "\t\t\tstartupError: \"codex-multi-auth runtime rotation config helpers are unavailable; refusing single-account fallback.\",",
    "\t\t};",
    "\t}",
    "",
    "\t// A helper that cannot start is a hard failure for these branches",
  ].join("\n");
  const configGateReplacement = [
    "\tif (!configTomlModule) {",
    "\t\tbaseContext.cleanup?.();",
    "\t\treturn {",
    "\t\t\tstartupError: \"codex-multi-auth runtime rotation config helpers are unavailable; refusing single-account fallback.\",",
    "\t\t};",
    "\t}",
    "",
    "\ttry {",
    "\t\tconst sharedContext = createSharedMachineRouterContext(baseContext, rawArgs, configTomlModule);",
    "\t\tif (sharedContext) return sharedContext;",
    "\t} catch (error) {",
    "\t\tbaseContext.cleanup?.();",
    "\t\treturn {",
    "\t\t\tstartupError: `managed Codex machine router is invalid: ${error instanceof Error ? error.message : String(error)}` ,",
    "\t\t};",
    "\t}",
    "",
    "\t// A helper that cannot start is a hard failure for these branches",
  ].join("\n");
  const configGateFirst = source.indexOf(configGateNeedle);
  if (configGateFirst < 0 || source.indexOf(configGateNeedle, configGateFirst + configGateNeedle.length) >= 0) {
    throw new Error("unsupported codex-multi-auth shared-router insertion point; refusing an unsafe patch");
  }
  source = source.slice(0, configGateFirst) + configGateReplacement +
    source.slice(configGateFirst + configGateNeedle.length);
}

if (!source.includes(canonicalExecMarker)) {
  const shadowNeedle = [
    "\t\tshadowContext = createRuntimeRotationProxyCodexHome(",
    "\t\t\tbaseContext.env,",
    "\t\t\tproxyServer.baseUrl,",
    "\t\t\tclientApiKey,",
    "\t\t\tconfigTomlModule,",
    "\t\t);",
  ].join("\n");
  const canonicalReplacement = [
    `\t\t// ${canonicalExecMarker}.`,
    "\t\t// A fresh shadow omits state_*.sqlite and makes official Codex rebuild",
    "\t\t// its complete session index before every exec. The canonical provider",
    "\t\t// args below isolate auth without discarding the existing index.",
    "\t\tshadowContext = createRuntimeRotationProxyCanonicalCodexHome(",
    "\t\t\tbaseContext.env,",
    "\t\t\tproxyServer.baseUrl,",
    "\t\t\tclientApiKey,",
    "\t\t\tconfigTomlModule,",
    "\t\t);",
  ].join("\n");
  const shadowFirst = source.indexOf(shadowNeedle);
  if (shadowFirst < 0 || source.indexOf(shadowNeedle, shadowFirst + shadowNeedle.length) >= 0) {
    throw new Error(
      "unsupported codex-multi-auth exec-home layout; refusing an unsafe patch",
    );
  }
  source = source.slice(0, shadowFirst) + canonicalReplacement +
    source.slice(shadowFirst + shadowNeedle.length);

  const argsNeedle = [
    "\t\targs: [",
    "\t\t\t...baseContext.args,",
    "\t\t\t\"-c\",",
    "\t\t\t`model_provider=${configTomlModule.tomlStringLiteral(RUNTIME_ROTATION_PROXY_PROVIDER_ID)}`,",
    "\t\t],",
  ].join("\n");
  const argsReplacement = [
    "\t\targs: [",
    "\t\t\t...baseContext.args,",
    "\t\t\t...(shadowContext.args ?? []),",
    "\t\t\t\"-c\",",
    "\t\t\t`model_provider=${configTomlModule.tomlStringLiteral(RUNTIME_ROTATION_PROXY_PROVIDER_ID)}`,",
    "\t\t],",
  ].join("\n");
  const argsFirst = source.indexOf(argsNeedle);
  if (argsFirst < 0 || source.indexOf(argsNeedle, argsFirst + argsNeedle.length) >= 0) {
    throw new Error(
      "unsupported codex-multi-auth exec-provider layout; refusing an unsafe patch",
    );
  }
  source = source.slice(0, argsFirst) + argsReplacement +
    source.slice(argsFirst + argsNeedle.length);
}

if (!source.includes(skipRepairMarker)) {
  const repairNeedle = [
    "\tif (result.exitCode === 0) {",
    "\t\trepairCodexSessionIndex(resolveCodexHomeDir(baseEnv));",
    "\t}",
    "\treturn result.exitCode;",
  ].join("\n");
  const repairReplacement = [
    `\t// ${skipRepairMarker}.`,
    "\t// Official Codex updates the canonical SQLite index itself. Re-scanning",
    "\t// every transcript here can retain multiple gigabytes after each exec.",
    "\treturn result.exitCode;",
  ].join("\n");
  const repairFirst = source.indexOf(repairNeedle);
  if (repairFirst < 0 || source.indexOf(repairNeedle, repairFirst + repairNeedle.length) >= 0) {
    throw new Error(
      "unsupported codex-multi-auth post-run repair layout; refusing an unsafe patch",
    );
  }
  source = source.slice(0, repairFirst) + repairReplacement +
    source.slice(repairFirst + repairNeedle.length);
}

const forbidden = [
  "continuing without runtime rotation",
  "const fallbackModel = resolveUnsupportedModelRetryTarget(",
  "Retrying with ${fallbackModel}",
  "replaceRequestedModel(currentArgs, fallbackModel)",
  '\"gpt-5.5\": [\"gpt-5.4\"]',
  "repairCodexSessionIndex(resolveCodexHomeDir(baseEnv));",
  "await showUpdateNoticeIfAvailable(rawArgs, normalizedArgs)",
  "\t\t\tdetachOnExit: true,",
];
const requiredOwnerManagedLifetimeSupport = [
  "CODEX_MULTI_AUTH_APP_ROTATION_MAX_LIFETIME_MS",
  "parsed >= 0",
  "maxLifetimeMs > 0",
];
if (!source.includes(strictMarker) || !source.includes(requiredRouterMarker) ||
    !source.includes(canonicalExecMarker) || !source.includes(skipRepairMarker) ||
    !source.includes(noStartupUpdateMarker) || !source.includes(interactiveOwnerMarker) ||
    !source.includes(sharedRouterMarker) ||
    requiredOwnerManagedLifetimeSupport.some((value) => !source.includes(value)) ||
    forbidden.some((value) => source.includes(value))) {
  const missingLifetimeSupport = requiredOwnerManagedLifetimeSupport.filter(
    (value) => !source.includes(value),
  );
  throw new Error(
    `codex-multi-auth wrapper lacks a required managed runtime invariant; lifetime support missing: ${missingLifetimeSupport.join(", ") || "none"}`,
  );
}

const originalSource = fs.readFileSync(wrapperPath, "utf8");
if (source !== originalSource) {
  const stats = fs.statSync(wrapperPath);
  const temporaryPath = path.join(
    path.dirname(wrapperPath),
    `.${path.basename(wrapperPath)}.${process.pid}.tmp`,
  );
  fs.writeFileSync(temporaryPath, source, { mode: stats.mode & 0o777 });
  fs.chmodSync(temporaryPath, stats.mode & 0o777);
  fs.renameSync(temporaryPath, wrapperPath);
}
