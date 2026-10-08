/**
 * Rate limiting utilities for account management.
 * Extracted from accounts.ts to reduce module size and improve cohesion.
 */

import { nowMs } from "../utils.js";
import type { ModelFamily } from "../prompts/codex.js";

export type BaseQuotaKey = ModelFamily;
export type QuotaKey = BaseQuotaKey | `${BaseQuotaKey}:${string}`;

export type RateLimitReason = "quota" | "tokens" | "concurrent" | "unknown";

export function parseRateLimitReason(code: string | undefined): RateLimitReason {
	if (!code) return "unknown";
	const lc = code.toLowerCase();
	if (lc.includes("quota") || lc.includes("usage_limit")) return "quota";
	if (lc.includes("token") || lc.includes("tpm") || lc.includes("rpm")) return "tokens";
	if (lc.includes("concurrent") || lc.includes("parallel")) return "concurrent";
	return "unknown";
}

/** Limit id upstream uses for the ordinary subscription pool. */
const ORDINARY_QUOTA_POOL = "codex";

/**
 * Name of the separately metered usage pool a 429 was charged to, or
 * `undefined` when it was charged to the ordinary subscription pool.
 *
 * Upstream names the pool behind a usage-limit 429 in `x-codex-active-limit`
 * (for example `codex_other`). The official Codex client reads that header to
 * pick the matching `x-<limit>-*` usage snapshot, and treats a missing header
 * as the ordinary `codex` pool. The value is normalized the same way
 * (trimmed, lowercased, `-` to `_`). Anything that does not read as a limit
 * id also counts as the ordinary pool, so an unexpected value keeps the
 * family-wide record rather than narrowing it.
 */
export function parseSeparateQuotaPool(headers: Headers): string | undefined {
	const limitId = headers
		.get("x-codex-active-limit")
		?.trim()
		.toLowerCase()
		.replaceAll("-", "_");
	if (!limitId || limitId === ORDINARY_QUOTA_POOL) return undefined;
	return /^[a-z][a-z0-9_]*$/.test(limitId) ? limitId : undefined;
}

export function getQuotaKey(family: ModelFamily, model?: string | null): QuotaKey {
	if (model) {
		return `${family}:${model}`;
	}
	return family;
}

export function clampNonNegativeInt(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	return value < 0 ? 0 : Math.floor(value);
}

export interface RateLimitState {
	[key: string]: number | undefined;
}

export interface RateLimitedEntity {
	rateLimitResetTimes: RateLimitState;
}

export function clearExpiredRateLimits(entity: RateLimitedEntity): void {
	const now = nowMs();
	const keys = Object.keys(entity.rateLimitResetTimes);
	for (const key of keys) {
		const resetTime = entity.rateLimitResetTimes[key];
		if (resetTime !== undefined && now >= resetTime) {
			delete entity.rateLimitResetTimes[key];
		}
	}
}

/**
 * Remove every rate-limit reset entry from `entity`, regardless of whether the
 * window has expired. Unlike {@link clearExpiredRateLimits}, this drops
 * still-future entries too. Used by the stale-runtime recovery path to give a
 * reloaded account pool a clean slate so transient state persisted to disk
 * cannot keep the pool wedged (issue #606).
 */
export function clearAllRateLimits(entity: RateLimitedEntity): void {
	const keys = Object.keys(entity.rateLimitResetTimes);
	for (const key of keys) {
		delete entity.rateLimitResetTimes[key];
	}
}

export function isRateLimitedForQuotaKey(entity: RateLimitedEntity, key: QuotaKey): boolean {
	const resetTime = entity.rateLimitResetTimes[key];
	return resetTime !== undefined && nowMs() < resetTime;
}

export function isRateLimitedForFamily(
	entity: RateLimitedEntity,
	family: ModelFamily,
	model?: string | null,
): boolean {
	clearExpiredRateLimits(entity);

	if (model) {
		const modelKey = getQuotaKey(family, model);
		if (isRateLimitedForQuotaKey(entity, modelKey)) {
			return true;
		}
	}

	const baseKey = getQuotaKey(family);
	return isRateLimitedForQuotaKey(entity, baseKey);
}

export function formatWaitTime(ms: number): string {
	if (Number.isNaN(ms) || ms === Number.POSITIVE_INFINITY) return "unknown";
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}
