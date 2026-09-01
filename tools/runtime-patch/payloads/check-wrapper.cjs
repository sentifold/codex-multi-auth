const fs = require("node:fs");
const source = fs.readFileSync(process.env.ROUTER_CODEX_WRAPPER_FILE, "utf8");
const required = [
  "codex-multi-auth local compatibility: forbid every model fallback",
  "codex-multi-auth local compatibility: runtime account router is mandatory",
  "codex-multi-auth local compatibility: reuse canonical Codex index for exec",
  "codex-multi-auth local compatibility: canonical index needs no full post-run repair",
  "codex-multi-auth local compatibility: no network update check during launch",
  "codex-multi-auth local compatibility: stop interactive helper with owner",
  "codex-multi-auth local policy: every Codex command uses the machine router",
  "const WRAPPER_UNSUPPORTED_MODEL_FALLBACK_CHAIN = Object.freeze({});",
  "refusing single-account fallback",
  "...(shadowContext.args ?? []),",
  "CODEX_MULTI_AUTH_APP_ROTATION_MAX_LIFETIME_MS",
  "parsed >= 0",
  "maxLifetimeMs > 0",
  "createSharedMachineRouterContext(baseContext, rawArgs, configTomlModule)",
  "CODEX_MULTI_AUTH_SHARED_PROXY_URL",
  '`model_providers.${RUNTIME_ROTATION_PROXY_PROVIDER_ID}.request_max_retries=0`',
];
const forbidden = [
  "continuing without runtime rotation",
  "const fallbackModel = resolveUnsupportedModelRetryTarget(",
  "Retrying with ${fallbackModel}",
  "replaceRequestedModel(currentArgs, fallbackModel)",
  '\"gpt-5.5\": [\"gpt-5.4\"]',
  "\t\tshadowContext = createRuntimeRotationProxyCodexHome(",
  "repairCodexSessionIndex(resolveCodexHomeDir(baseEnv));",
  "await showUpdateNoticeIfAvailable(rawArgs, normalizedArgs)",
  "\t\t\tdetachOnExit: true,",
];
if (required.some((value) => !source.includes(value)) ||
    forbidden.some((value) => source.includes(value))) {
  process.exit(1);
}
