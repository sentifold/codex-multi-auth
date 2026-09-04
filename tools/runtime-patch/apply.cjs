#!/usr/bin/env node
/**
 * Apply the reliability patch to an installed codex-multi-auth.
 *
 * This edits the INSTALLED npm package in place, not this repository: the
 * patch targets the shipped `dist/lib/*.js` and `scripts/codex.js`, which are
 * build output and do not exist in a source checkout.
 *
 * What it changes:
 *   - preserves the client-stated originator / OpenAI-Beta identity, so newer
 *     model tiers pass entitlement checks instead of being downgraded to the
 *     legacy client identity;
 *   - rotates to another account on an exact-model entitlement rejection, and
 *     on confirmed quota or billing exhaustion, without ever substituting the
 *     requested model;
 *   - hides bounded transient failures (short 429s, transport errors,
 *     retryable 5xx) behind same-account retries before spending the pool,
 *     with whole-pool waits and a per-request deadline;
 *   - answers a spent pool with a retryable 503 carrying Retry-After instead
 *     of a raw 429 that would stop the Codex session;
 *   - gives the session-affinity delete path versioned tombstones, so a stale
 *     in-flight write cannot resurrect affinity to an abandoned account;
 *   - bounds advisory quota deferrals to a fixed probe horizon and stops
 *     persisting them as durable rate limits;
 *   - serves /models locally, makes the account router mandatory (no silent
 *     single-account fallback), forbids model substitution in the wrapper, and
 *     reuses the canonical Codex session index for `exec`;
 *   - exposes an authenticated, loopback-only GET /managed/pool-status for a
 *     local pool-readiness view.
 *
 * It is idempotent (marker comments), fail-closed (an unexpected layout aborts
 * before any write), staged (files are syntax-checked before being swapped in)
 * and post-checked.
 *
 * Usage:
 *   node tools/runtime-patch/apply.cjs          # patch the global install
 *   node tools/runtime-patch/apply.cjs --check  # report status, change nothing
 *
 * Override the package root with AGENT_ROUTER_NPM_ROOT_OVERRIDE when testing
 * against an extracted tarball instead of a global install.
 */
"use strict";

const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PACKAGE_NAME = "codex-multi-auth";
// The patch matches exact compiled layouts, so it is pinned to the version it
// was written against. A different version must be re-verified rather than
// patched on a best-effort basis.
const PINNED_VERSION = "2.9.1";

function fail(message) {
	process.stderr.write(`error: ${message}\n`);
	process.exit(1);
}

function resolvePackageRoot() {
	const override = process.env.AGENT_ROUTER_NPM_ROOT_OVERRIDE;
	if (override) return path.join(override, PACKAGE_NAME);
	let npmRoot;
	try {
		npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
	} catch (error) {
		fail(`could not resolve the global npm root: ${error.message}`);
	}
	return path.join(npmRoot, PACKAGE_NAME);
}

function targetsFor(packageRoot) {
	return {
		ROUTER_CODEX_PROXY_FILE: path.join(packageRoot, "dist/lib/runtime-rotation-proxy.js"),
		ROUTER_CODEX_SESSION_AFFINITY_FILE: path.join(packageRoot, "dist/lib/session-affinity.js"),
		ROUTER_CODEX_WRAPPER_FILE: path.join(packageRoot, "scripts/codex.js"),
	};
}

function runPayload(name, env, { quiet = false } = {}) {
	const payload = path.join(__dirname, "payloads", name);
	return spawnSync(process.execPath, [payload], {
		env: { ...process.env, ...env },
		stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
		encoding: "utf8",
	});
}

// Verification reuses the same check payloads the patch author runs, rather
// than a re-stated list of markers here: a hand-maintained copy drifts from
// what the patch actually writes, and would report success for a patch that
// silently did nothing.
const CHECKS = [
	["check-proxy.cjs", "runtime rotation proxy"],
	["check-session-affinity.cjs", "session affinity store"],
	["check-wrapper.cjs", "codex wrapper"],
];

function verify(env, { quiet }) {
	let ok = true;
	for (const [payloadName, label] of CHECKS) {
		const result = runPayload(payloadName, env, { quiet: true });
		if (result.status === 0) {
			if (!quiet) process.stdout.write(`ok       ${label}\n`);
			continue;
		}
		ok = false;
		const detail = (result.stderr || "").trim().split("\n")[0] || "check failed";
		process.stdout.write(`MISSING  ${label}: ${detail}\n`);
	}
	return ok;
}

function main() {
	const checkOnly = process.argv.includes("--check");
	const packageRoot = resolvePackageRoot();

	const manifestPath = path.join(packageRoot, "package.json");
	if (!fs.existsSync(manifestPath)) {
		fail(
			`${PACKAGE_NAME} is not installed at ${packageRoot}.\n` +
				`Install the pinned version first:\n` +
				`  npm install -g --ignore-scripts ${PACKAGE_NAME}@${PINNED_VERSION}`,
		);
	}
	const installedVersion = JSON.parse(fs.readFileSync(manifestPath, "utf8")).version;
	if (installedVersion !== PINNED_VERSION) {
		fail(
			`${PACKAGE_NAME} ${installedVersion} is installed, but this patch is pinned to ` +
				`${PINNED_VERSION}.\nThe patch matches exact compiled layouts and refuses to run ` +
				`against an unverified version.\nInstall the pinned version:\n` +
				`  npm install -g --ignore-scripts ${PACKAGE_NAME}@${PINNED_VERSION}`,
		);
	}

	const targets = targetsFor(packageRoot);
	for (const [name, filePath] of Object.entries(targets)) {
		if (!fs.existsSync(filePath)) fail(`${name} is missing: ${filePath}`);
	}

	if (checkOnly) {
		const catalog = spawnSync(process.execPath, [path.join(__dirname, "payloads/codex-model-catalog.cjs"), packageRoot, "--check"], { stdio: "inherit" });
		process.exit(verify(targets, { quiet: false }) && catalog.status === 0 ? 0 : 1);
	}

	const runtime = runPayload("codex-runtime.cjs", targets);
	if (runtime.status !== 0) {
		fail("the runtime patch aborted; the package was left unchanged");
	}
	const wrapper = runPayload("codex-wrapper.cjs", targets);
	if (wrapper.status !== 0) {
		fail("the wrapper patch aborted; the package was left partially patched");
	}
	const catalog = spawnSync(process.execPath, [path.join(__dirname, "payloads/codex-model-catalog.cjs"), packageRoot], { stdio: "inherit" });
	if (catalog.status !== 0) fail("the model catalog patch aborted");

	for (const filePath of Object.values(targets)) {
		const checked = spawnSync(process.execPath, ["--check", filePath], { encoding: "utf8" });
		if (checked.status !== 0) {
			fail(`patched file failed syntax validation: ${filePath}\n${checked.stderr}`);
		}
	}

	if (!verify(targets, { quiet: true })) {
		fail("the patch reported success but its own verification did not pass");
	}

	process.stdout.write(
		`patched ${PACKAGE_NAME}@${PINNED_VERSION} at ${packageRoot}\n` +
			`  client identity preserved; exact model never substituted\n` +
			`  bounded hidden retries, failover, pool waits and a retryable 503\n` +
			`  versioned affinity tombstones; advisory quota deferrals bounded\n` +
			`  account router mandatory - no silent single-account fallback\n`,
	);
}

main();
