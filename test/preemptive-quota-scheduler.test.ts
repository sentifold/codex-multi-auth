import { describe, expect, it } from "vitest";
import {
	PreemptiveQuotaScheduler,
	isObservedRateLimitDeferral,
	readQuotaSchedulerSnapshot,
} from "../lib/preemptive-quota-scheduler.js";

describe("preemptive quota scheduler", () => {
	it("reads quota snapshot from codex headers", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "99",
			"x-codex-primary-reset-after-seconds": "120",
			"x-codex-secondary-used-percent": "10",
		});

		const snapshot = readQuotaSchedulerSnapshot(headers, 200, 1_000);
		expect(snapshot).not.toBeNull();
		expect(snapshot?.status).toBe(200);
		expect(snapshot?.primary.usedPercent).toBe(99);
		expect(snapshot?.primary.resetAtMs).toBeGreaterThan(1_000);
	});

	it("uses provided now when parsing reset-after seconds", () => {
		const headers = new Headers({
			"x-codex-primary-reset-after-seconds": "120",
		});
		const snapshot = readQuotaSchedulerSnapshot(headers, 200, 5_000);
		expect(snapshot?.primary.resetAtMs).toBe(125_000);
	});

	it("returns null when quota headers are present but invalid", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "not-a-number",
			"x-codex-primary-reset-after-seconds": "oops",
			"x-codex-primary-reset-at": "not-a-date",
			"x-codex-secondary-reset-at": "still-not-a-date",
		});
		expect(readQuotaSchedulerSnapshot(headers, 200, 5_000)).toBeNull();
	});

	it("parses reset-at as epoch seconds, milliseconds, and HTTP date", () => {
		const secondsSnapshot = readQuotaSchedulerSnapshot(
			new Headers({
				"x-codex-primary-reset-at": "1700000000",
				"x-codex-secondary-reset-at": "1700000000000",
			}),
			200,
			0,
		);
		expect(secondsSnapshot?.primary.resetAtMs).toBe(1_700_000_000_000);
		expect(secondsSnapshot?.secondary.resetAtMs).toBe(1_700_000_000_000);

		const dateText = "Tue, 14 Nov 2023 22:13:20 GMT";
		const dateSnapshot = readQuotaSchedulerSnapshot(
			new Headers({
				"x-codex-primary-reset-at": dateText,
			}),
			200,
			0,
		);
		expect(dateSnapshot?.primary.resetAtMs).toBe(Date.parse(dateText));
	});

	it("defers requests for known 429 window", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		scheduler.markRateLimited("acc:model", 30_000, 1_000);

		const decision = scheduler.getDeferral("acc:model", 2_000);
		expect(decision.defer).toBe(true);
		expect(decision.reason).toBe("rate-limit");
		expect(decision.waitMs).toBeGreaterThan(0);
	});

	it("preserves the longest known rate-limit reset across overlapping updates", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		scheduler.markRateLimited("acc:model", 30_000, 1_000);
		scheduler.update("acc:model", {
			status: 429,
			primary: {},
			secondary: { resetAtMs: 31_000 },
			updatedAt: 1_000,
		});
		scheduler.markRateLimited("acc:model", 10_000, 5_000);

		const decision = scheduler.getDeferral("acc:model", 6_000);
		expect(decision.defer).toBe(true);
		expect(decision.reason).toBe("rate-limit");
		expect(decision.waitMs).toBe(25_000);
	});

	it("uses the longest active reset window for 429 deferrals", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		scheduler.update("acc:model", {
			status: 429,
			primary: { resetAtMs: 31_000 },
			secondary: { resetAtMs: 61_000 },
			updatedAt: 1_000,
		});

		const decision = scheduler.getDeferral("acc:model", 6_000);
		expect(decision.defer).toBe(true);
		expect(decision.reason).toBe("rate-limit");
		expect(decision.waitMs).toBe(55_000);
	});

	it("preserves secondary near-exhaustion state when marking a quota key rate-limited", () => {
		const scheduler = new PreemptiveQuotaScheduler({
			remainingPercentThresholdSecondary: 5,
		});
		scheduler.update("acc:model", {
			status: 200,
			primary: { usedPercent: 10, resetAtMs: 0 },
			secondary: { usedPercent: 97, resetAtMs: 61_000 },
			updatedAt: 1_000,
		});
		scheduler.markRateLimited("acc:model", 30_000, 1_000);
		const internalSnapshots = (
			scheduler as unknown as {
				snapshots: Map<string, { secondary: { usedPercent?: number; resetAtMs?: number } }>;
			}
		).snapshots;
		expect(internalSnapshots.get("acc:model")?.secondary.usedPercent).toBe(97);
		expect(internalSnapshots.get("acc:model")?.secondary.resetAtMs).toBe(61_000);
	});

	it("sanitizes non-finite retry-after values", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		scheduler.markRateLimited("acc:model", Number.NaN, 1_000);
		const nanDecision = scheduler.getDeferral("acc:model", 1_000);
		expect(nanDecision.defer).toBe(false);

		scheduler.markRateLimited("acc:model", Number.POSITIVE_INFINITY, 2_000);
		const infDecision = scheduler.getDeferral("acc:model", 2_000);
		expect(infDecision.defer).toBe(false);

		scheduler.markRateLimited("acc:model", -1234, 3_000);
		const negativeDecision = scheduler.getDeferral("acc:model", 3_000);
		expect(negativeDecision.defer).toBe(false);
	});

	it("defers when usage is near exhaustion and reset is pending", () => {
		const scheduler = new PreemptiveQuotaScheduler({
			usedPercentThreshold: 95,
		});
		scheduler.update("acc:model", {
			status: 200,
			primary: {
				usedPercent: 97,
				resetAtMs: 70_000,
			},
			secondary: {},
			updatedAt: 10_000,
		});

		const decision = scheduler.getDeferral("acc:model", 20_000);
		expect(decision.defer).toBe(true);
		expect(decision.reason).toBe("quota-near-exhaustion");
	});

	it("uses the longest near-exhausted reset window for quota deferrals", () => {
		const scheduler = new PreemptiveQuotaScheduler({
			remainingPercentThresholdPrimary: 5,
			remainingPercentThresholdSecondary: 5,
		});
		scheduler.update("acc:model", {
			status: 200,
			primary: { usedPercent: 96, resetAtMs: 70_000 },
			secondary: { usedPercent: 97, resetAtMs: 120_000 },
			updatedAt: 10_000,
		});

		const decision = scheduler.getDeferral("acc:model", 20_000);
		expect(decision.defer).toBe(true);
		expect(decision.reason).toBe("quota-near-exhaustion");
		expect(decision.waitMs).toBe(100_000);
	});

	it("uses a trusted future reset for an exhausted long quota window", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		const now = 1_000_000;
		const resetWaitMs = 72 * 60 * 60_000;
		scheduler.update("acc:model", {
			status: 200,
			primary: { usedPercent: 20, resetAtMs: now + 5 * 60 * 60_000 },
			secondary: { usedPercent: 100, resetAtMs: now + resetWaitMs },
			updatedAt: now,
		});

		const decision = scheduler.getDeferral("acc:model", now + 1_000);

		expect(decision).toEqual({
			defer: true,
			waitMs: resetWaitMs - 1_000,
			reason: "quota-near-exhaustion",
		});
	});

	it("caps trusted monthly-scale reset data at the seven-day safety ceiling", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		const now = 1_000_000;
		const sevenDaysMs = 7 * 24 * 60 * 60_000;
		scheduler.update("acc:model", {
			status: 200,
			primary: {},
			secondary: {
				usedPercent: 100,
				resetAtMs: now + 30 * 24 * 60 * 60_000,
			},
			updatedAt: now,
		});

		const decision = scheduler.getDeferral("acc:model", now + 1_000);

		expect(decision.waitMs).toBe(sevenDaysMs);
	});

	// An exhaustion claim with no trusted reset is unfalsifiable, so it is
	// trusted for one deferral cap measured from the snapshot that produced it
	// — a fixed deadline. Previously the cap was measured from `now`, which
	// re-armed the full wait on every poll: the account was never selected, so
	// no fresher snapshot could arrive to release it, and only a restart did.
	it.each([
		["missing", undefined],
		["invalid", Number.NaN],
	] as const)("caps %s reset data at a horizon fixed to the snapshot", (_label, resetAtMs) => {
		const maxDeferralMs = 30 * 60_000;
		const scheduler = new PreemptiveQuotaScheduler({ maxDeferralMs });
		const now = 1_000_000;
		scheduler.update("acc:model", {
			status: 200,
			primary: { usedPercent: 100, resetAtMs },
			secondary: {},
			updatedAt: now,
		});

		expect(scheduler.getDeferral("acc:model", now + 1_000)).toEqual({
			defer: true,
			waitMs: maxDeferralMs - 1_000,
			reason: "quota-near-exhaustion",
		});

		// The deadline does not slide: later polls report less time, not the
		// same cap again.
		expect(scheduler.getDeferral("acc:model", now + 20 * 60_000).waitMs).toBe(
			maxDeferralMs - 20 * 60_000,
		);
		expect(scheduler.getDeferral("acc:model", now + maxDeferralMs + 1).defer).toBe(false);
	});

	it("falls back to the configured cap for stale reset data", () => {
		const maxDeferralMs = 30 * 60_000;
		const scheduler = new PreemptiveQuotaScheduler({ maxDeferralMs });
		const now = 1_000_000;
		const sevenDaysMs = 7 * 24 * 60 * 60_000;
		scheduler.update("acc:model", {
			status: 200,
			primary: { usedPercent: 100, resetAtMs: now + 72 * 60 * 60_000 },
			secondary: {},
			updatedAt: now - sevenDaysMs - 1,
		});

		const decision = scheduler.getDeferral("acc:model", now + 1_000);

		expect(decision).toEqual({
			defer: true,
			waitMs: maxDeferralMs,
			reason: "quota-near-exhaustion",
		});
	});

	it("falls back to the configured cap for a future-dated snapshot", () => {
		const maxDeferralMs = 30 * 60_000;
		const scheduler = new PreemptiveQuotaScheduler({ maxDeferralMs });
		const now = 1_000_000;
		scheduler.update("acc:model", {
			status: 200,
			primary: { usedPercent: 100, resetAtMs: now + 60 * 60_000 },
			secondary: {},
			updatedAt: now + 1,
		});

		expect(scheduler.getDeferral("acc:model", now)).toEqual({
			defer: true,
			waitMs: maxDeferralMs,
			reason: "quota-near-exhaustion",
		});
	});

	it("does not re-defer an exhausted window after its reset has passed", () => {
		const scheduler = new PreemptiveQuotaScheduler({ maxDeferralMs: 30 * 60_000 });
		const now = 1_000_000;
		scheduler.update("acc:model", {
			status: 200,
			primary: { usedPercent: 100, resetAtMs: now - 1_000 },
			secondary: { usedPercent: 20, resetAtMs: now + 7 * 24 * 60 * 60_000 },
			updatedAt: now - 500,
		});

		expect(scheduler.getDeferral("acc:model", now)).toEqual({
			defer: false,
			waitMs: 0,
		});
	});

	it("prunes expired snapshots", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		scheduler.update("a", {
			status: 200,
			primary: { resetAtMs: 1_500 },
			secondary: {},
			updatedAt: 1_000,
		});
		scheduler.update("b", {
			status: 200,
			primary: { resetAtMs: 20_000 },
			secondary: {},
			updatedAt: 1_000,
		});

		const removed = scheduler.prune(2_000);
		expect(removed).toBe(1);
		expect(scheduler.getDeferral("a", 2_100).defer).toBe(false);
		expect(scheduler.getDeferral("b", 2_100).defer).toBe(false);
	});

	it("uses separate 5h/7d remaining thresholds", () => {
		const scheduler = new PreemptiveQuotaScheduler({
			remainingPercentThresholdPrimary: 10,
			remainingPercentThresholdSecondary: 2,
		});
		scheduler.update("acc:model", {
			status: 200,
			primary: { usedPercent: 91, resetAtMs: 65_000 },
			secondary: { usedPercent: 97, resetAtMs: 66_000 },
			updatedAt: 1_000,
		});

		const decision = scheduler.getDeferral("acc:model", 5_000);
		expect(decision.defer).toBe(true);
		expect(decision.reason).toBe("quota-near-exhaustion");
	});

	it("can disable preemptive deferral without clearing snapshots", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		scheduler.markRateLimited("acc:model", 30_000, 1_000);
		expect(scheduler.getDeferral("acc:model", 2_000).defer).toBe(true);

		scheduler.configure({ enabled: false });
		expect(scheduler.getDeferral("acc:model", 2_000).defer).toBe(false);

		scheduler.configure({ enabled: true });
		expect(scheduler.getDeferral("acc:model", 2_000).defer).toBe(true);
	});

	it("ignores empty keys for update/markRateLimited and falls back when updatedAt is falsy", () => {
		const now = Date.now();
		const scheduler = new PreemptiveQuotaScheduler();

		scheduler.update("", {
			status: 200,
			primary: { usedPercent: 99, resetAtMs: now + 60_000 },
			secondary: {},
			updatedAt: now,
		});
		scheduler.markRateLimited("", 30_000, now);
		expect(scheduler.getDeferral("", now + 1_000)).toEqual({
			defer: false,
			waitMs: 0,
		});

		scheduler.update("acc:model", {
			status: 429,
			primary: { usedPercent: 100, resetAtMs: now + 45_000 },
			secondary: {},
			updatedAt: 0,
		});
		const decision = scheduler.getDeferral("acc:model", now + 5_000);
		expect(decision.defer).toBe(true);
		expect(decision.reason).toBe("rate-limit");
	});

	it("prunes snapshots using the latest reset from primary or secondary windows", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		scheduler.update("keep", {
			status: 200,
			primary: { resetAtMs: 1_000 },
			secondary: { resetAtMs: 7_000 },
			updatedAt: 0,
		});
		scheduler.update("drop", {
			status: 200,
			primary: { resetAtMs: 1_000 },
			secondary: { resetAtMs: 1_500 },
			updatedAt: 0,
		});

		const removed = scheduler.prune(2_000);
		expect(removed).toBe(1);
		expect(scheduler.prune(8_000)).toBe(1);
	});
	it("H4: a transient 429 does not bench the account on a benign weekly window", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		const now = 1_000_000;
		const weekMs = 7 * 24 * 60 * 60 * 1000;
		// Healthy 200 snapshot: primary fine, weekly secondary resets ~7d out.
		scheduler.update("acc:model", {
			status: 200,
			primary: { usedPercent: 20, resetAtMs: now + 5 * 60_000 },
			secondary: { usedPercent: 30, resetAtMs: now + weekMs },
			updatedAt: now,
		});
		// Transient 60s 429.
		scheduler.markRateLimited("acc:model", 60_000, now);
		const decision = scheduler.getDeferral("acc:model", now + 1_000);
		expect(decision.defer).toBe(true);
		expect(decision.reason).toBe("rate-limit");
		// Must reflect the ~60s retry window, NOT the 7d weekly reset (which would
		// clamp to the 2h deferral cap). Allow the remaining ~59s.
		expect(decision.waitMs).toBeLessThanOrEqual(60_000);
		expect(decision.waitMs).toBeGreaterThan(50_000);
		// After the 429 window passes, the account is no longer rate-limit-deferred.
		const after = scheduler.getDeferral("acc:model", now + 61_000);
		expect(after.reason).not.toBe("rate-limit");
	});

	describe("advisory deferrals expire on a fixed probe horizon", () => {
		const HOUR = 60 * 60_000;

		it("releases a near-exhaustion deferral once the horizon lapses", () => {
			const scheduler = new PreemptiveQuotaScheduler({ maxDeferralMs: 15 * 60_000 });
			const now = 1_000_000;
			const weekMs = 7 * 24 * 60 * 60 * 1000;
			// Near its ceiling but NOT proven exhausted: still has quota left.
			scheduler.update("acc:model", {
				status: 200,
				primary: { usedPercent: 97, resetAtMs: now + weekMs },
				secondary: {},
				updatedAt: now,
			});

			const immediately = scheduler.getDeferral("acc:model", now + 1_000);
			expect(immediately.defer).toBe(true);
			expect(immediately.reason).toBe("quota-near-exhaustion");
			// Bounded by the horizon, not by the week-long window reset.
			expect(immediately.waitMs).toBeLessThanOrEqual(15 * 60_000);

			// The horizon is measured from the snapshot, so it is a fixed deadline
			// rather than one that slides forward on every poll.
			const later = scheduler.getDeferral("acc:model", now + 10 * 60_000);
			expect(later.waitMs).toBeLessThanOrEqual(5 * 60_000);

			const lapsed = scheduler.getDeferral("acc:model", now + 15 * 60_000 + 1);
			expect(lapsed.defer).toBe(false);
			expect(lapsed.waitMs).toBe(0);
		});

		it("keeps the full window when exhaustion is proven (issue #656)", () => {
			const scheduler = new PreemptiveQuotaScheduler({ maxDeferralMs: 15 * 60_000 });
			const now = 1_000_000;
			// 100% used with a known reset still ahead: evidence, not inference.
			scheduler.update("acc:model", {
				status: 200,
				primary: { usedPercent: 100, resetAtMs: now + 6 * HOUR },
				secondary: {},
				updatedAt: now,
			});

			const decision = scheduler.getDeferral("acc:model", now + 60_000);
			expect(decision.defer).toBe(true);
			expect(decision.reason).toBe("quota-near-exhaustion");
			// Not clamped to the 15m horizon — the proven window stands in full.
			expect(decision.waitMs).toBeGreaterThan(5 * HOUR);

			// Still deferred well past the horizon, because the claim is falsifiable
			// and has not yet expired.
			const afterHorizon = scheduler.getDeferral("acc:model", now + HOUR);
			expect(afterHorizon.defer).toBe(true);
		});

		it("bounds an exhaustion claim that carries no trusted reset", () => {
			const scheduler = new PreemptiveQuotaScheduler({ maxDeferralMs: 15 * 60_000 });
			const now = 1_000_000;
			// Claims 100% used but states no reset: unfalsifiable. Without a
			// horizon this defers forever, because the account is never selected
			// and so no fresher snapshot can ever arrive to release it.
			scheduler.update("acc:model", {
				status: 200,
				primary: { usedPercent: 100 },
				secondary: {},
				updatedAt: now,
			});

			expect(scheduler.getDeferral("acc:model", now + 1_000).defer).toBe(true);
			const lapsed = scheduler.getDeferral("acc:model", now + 15 * 60_000 + 1);
			expect(lapsed.defer).toBe(false);
		});

		it("never shortens a deferral produced by a real 429", () => {
			const scheduler = new PreemptiveQuotaScheduler({ maxDeferralMs: 15 * 60_000 });
			const now = 1_000_000;
			scheduler.markRateLimited("acc:model", 45 * 60_000, now);

			const decision = scheduler.getDeferral("acc:model", now + 60_000);
			expect(decision.reason).toBe("rate-limit");
			// The 429 branch keeps its own cap semantics; the advisory horizon
			// must not touch a server-stated window.
			expect(decision.waitMs).toBeGreaterThan(10 * 60_000);
		});
	});

	describe("isObservedRateLimitDeferral", () => {
		it("separates an observed 429 from a derived routing preference", () => {
			expect(isObservedRateLimitDeferral({ defer: true, waitMs: 1, reason: "rate-limit" })).toBe(
				true,
			);
			expect(
				isObservedRateLimitDeferral({
					defer: true,
					waitMs: 1,
					reason: "quota-near-exhaustion",
				}),
			).toBe(false);
			expect(isObservedRateLimitDeferral({ defer: false, waitMs: 0 })).toBe(false);
		});
	});
});
