import { describe, expect, it, vi } from "vitest";
import { SessionAffinityStore } from "../lib/session-affinity.js";

describe("SessionAffinityStore", () => {
	it("returns remembered account while entry is fresh", () => {
		const store = new SessionAffinityStore({ ttlMs: 10_000 });
		store.remember("session-a", 2, 1_000);

		expect(store.getPreferredAccountIndex("session-a", 5_000)).toBe(2);
	});

	it("expires entries after ttl", () => {
		const store = new SessionAffinityStore({ ttlMs: 1_000 });
		store.remember("session-a", 1, 1_000);

		expect(store.getPreferredAccountIndex("session-a", 2_500)).toBeNull();
		expect(store.size()).toBe(0);
	});

	it("evicts oldest entry when max size is reached", () => {
		const store = new SessionAffinityStore({ ttlMs: 60_000, maxEntries: 2 });
		store.remember("s1", 0, 1_000);
		store.remember("s2", 1, 2_000);
		store.remember("s3", 2, 3_000);

		expect(store.getPreferredAccountIndex("s1", 3_100)).toBeNull();
		expect(store.getPreferredAccountIndex("s2", 3_100)).toBe(1);
		expect(store.getPreferredAccountIndex("s3", 3_100)).toBe(2);
	});

	it("forgets all sessions mapped to account", () => {
		const store = new SessionAffinityStore({ ttlMs: 60_000, maxEntries: 10 });
		store.remember("s1", 0);
		store.remember("s2", 1);
		store.remember("s3", 1);

		const removed = store.forgetAccount(1);
		expect(removed).toBe(2);
		expect(store.getPreferredAccountIndex("s2")).toBeNull();
		expect(store.getPreferredAccountIndex("s3")).toBeNull();
		expect(store.getPreferredAccountIndex("s1")).toBe(0);
	});

	it("reindexes sessions after account removal", () => {
		const store = new SessionAffinityStore({ ttlMs: 60_000, maxEntries: 10 });
		store.remember("s1", 0);
		store.remember("s2", 2);
		store.remember("s3", 3);

		const shifted = store.reindexAfterRemoval(1);
		expect(shifted).toBe(2);
		expect(store.getPreferredAccountIndex("s2")).toBe(1);
		expect(store.getPreferredAccountIndex("s3")).toBe(2);
	});
	it("rejects invalid session keys and invalid account indices", () => {
		const store = new SessionAffinityStore({ ttlMs: 10_000, maxEntries: 4 });
		store.remember("   ", 1, 1_000);
		store.remember("session-x", Number.NaN, 1_000);
		store.remember("session-y", -1, 1_000);

		expect(store.getPreferredAccountIndex("session-x", 2_000)).toBeNull();
		expect(store.getPreferredAccountIndex(null, 2_000)).toBeNull();
		expect(store.size()).toBe(0);
	});

	it("truncates oversized session keys and can retrieve by truncated form", () => {
		const store = new SessionAffinityStore({ ttlMs: 10_000, maxEntries: 8 });
		const longKey = `  ${"x".repeat(300)}  `;
		const truncated = "x".repeat(256);
		store.remember(longKey, 3, 1_000);

		expect(store.getPreferredAccountIndex(truncated, 2_000)).toBe(3);
	});

	it("does not evict when updating an existing key at capacity", () => {
		const store = new SessionAffinityStore({ ttlMs: 60_000, maxEntries: 2 });
		store.remember("s1", 0, 1_000);
		store.remember("s2", 1, 2_000);
		store.remember("s2", 2, 3_000);

		expect(store.getPreferredAccountIndex("s1", 3_500)).toBe(0);
		expect(store.getPreferredAccountIndex("s2", 3_500)).toBe(2);
		expect(store.size()).toBe(2);
	});

	it("forgets a specific session and no-ops on blank session key", () => {
		const store = new SessionAffinityStore({ ttlMs: 60_000, maxEntries: 10 });
		store.remember("s1", 0, 1_000);
		store.forgetSession("   ");
		store.forgetSession("s1");

		expect(store.getPreferredAccountIndex("s1", 2_000)).toBeNull();
		expect(store.size()).toBe(0);
	});

	it("returns zero for invalid forget/reindex requests", () => {
		const store = new SessionAffinityStore({ ttlMs: 60_000, maxEntries: 10 });
		store.remember("s1", 0, 1_000);

		expect(store.forgetAccount(Number.NaN)).toBe(0);
		expect(store.forgetAccount(-1)).toBe(0);
		expect(store.reindexAfterRemoval(Number.NaN)).toBe(0);
		expect(store.reindexAfterRemoval(-1)).toBe(0);
		expect(store.getPreferredAccountIndex("s1", 2_000)).toBe(0);
	});

	it("prunes expired sessions and keeps non-expired entries", () => {
		const store = new SessionAffinityStore({ ttlMs: 1_000, maxEntries: 10 });
		store.remember("s1", 0, 1_000);
		store.remember("s2", 1, 2_000);

		expect(store.prune(2_001)).toBe(1);
		expect(store.getPreferredAccountIndex("s1", 2_001)).toBeNull();
		expect(store.getPreferredAccountIndex("s2", 2_001)).toBe(1);
	});

	it("updates and retrieves the last response id for a live session", () => {
		const store = new SessionAffinityStore({ ttlMs: 10_000, maxEntries: 4 });
		store.remember("session-a", 1, 1_000);
		store.updateLastResponseId("session-a", "resp_123", 2_000);

		expect(store.getLastResponseId("session-a", 2_500)).toBe("resp_123");
		expect(store.getPreferredAccountIndex("session-a", 2_500)).toBe(1);
	});

	it("does not persist response ids for missing or expired sessions", () => {
		const store = new SessionAffinityStore({ ttlMs: 1_000, maxEntries: 4 });
		store.updateLastResponseId("missing", "resp_missing", 1_000);
		expect(store.getLastResponseId("missing", 1_500)).toBeNull();

		store.remember("session-a", 1, 1_000);
		store.updateLastResponseId("session-a", "resp_123", 2_500);
		expect(store.getLastResponseId("session-a", 2_500)).toBeNull();
		expect(store.size()).toBe(0);
	});

	it("preserves response id when account index is updated via remember()", () => {
		const store = new SessionAffinityStore({ ttlMs: 10_000, maxEntries: 4 });
		store.remember("session-a", 1, 1_000);
		store.updateLastResponseId("session-a", "resp_123", 2_000);
		store.remember("session-a", 2, 3_000);

		expect(store.getLastResponseId("session-a", 3_500)).toBe("resp_123");
		expect(store.getPreferredAccountIndex("session-a", 3_500)).toBe(2);
	});

	it("ignores stale response-id writes from older overlapping requests", () => {
		const store = new SessionAffinityStore({ ttlMs: 10_000, maxEntries: 4 });
		store.rememberWithVersion("session-a", 1, 1_000, 1);
		store.updateLastResponseId("session-a", "resp_first", 2_000, 1);
		store.rememberWithVersion("session-a", 2, 3_000, 2);
		store.updateLastResponseId("session-a", "resp_second", 4_000, 2);

		store.rememberWithVersion("session-a", 1, 5_000, 1);
		store.updateLastResponseId("session-a", "resp_stale", 5_000, 1);

		expect(store.getPreferredAccountIndex("session-a", 5_500)).toBe(2);
		expect(store.getLastResponseId("session-a", 5_500)).toBe("resp_second");
	});

	it("does not let an older request re-bind a session a newer request forgot", () => {
		const store = new SessionAffinityStore({ ttlMs: 60_000, maxEntries: 4 });
		store.rememberWithVersion("session-a", 0, 1_000, 1);
		// Request 3 found account 0 unusable and dropped the session.
		store.forgetSession("session-a", 1_500, 3);

		// Request 2 selected account 0 before that and finishes afterwards.
		store.rememberWithVersion("session-a", 0, 2_000, 2);
		store.updateLastResponseId("session-a", "resp_stale", 2_000, 2);
		expect(store.getPreferredAccountIndex("session-a", 2_500)).toBeNull();
		expect(store.getLastResponseId("session-a", 2_500)).toBeNull();

		// A newer request can bind the session again.
		store.rememberWithVersion("session-a", 1, 3_000, 4);
		expect(store.getPreferredAccountIndex("session-a", 3_500)).toBe(1);
	});

	it("does not let an older request's forget erase a newer request's binding", () => {
		const store = new SessionAffinityStore({ ttlMs: 60_000, maxEntries: 4 });
		store.rememberWithVersion("session-a", 1, 1_000, 3);
		store.forgetSession("session-a", 1_500, 2);

		expect(store.getPreferredAccountIndex("session-a", 2_000)).toBe(1);
	});

	it("keeps the failover binding when a request forgets and then rebinds", () => {
		const store = new SessionAffinityStore({ ttlMs: 60_000, maxEntries: 4 });
		store.rememberWithVersion("session-a", 0, 1_000, 1);
		// One request: the preferred account is unusable, then failover succeeds.
		store.forgetSession("session-a", 1_500, 2);
		store.rememberWithVersion("session-a", 1, 2_000, 2);

		expect(store.getPreferredAccountIndex("session-a", 2_500)).toBe(1);
	});

	it("orders an unversioned forget after every earlier write", () => {
		const store = new SessionAffinityStore({ ttlMs: 60_000, maxEntries: 4 });
		store.rememberWithVersion("session-a", 0, 1_000, 100);
		store.forgetSession("session-a");
		store.rememberWithVersion("session-a", 1, 2_000, 100);

		expect(store.getPreferredAccountIndex("session-a", 2_500)).toBeNull();
	});

	it("stops blocking stale writes once the forget is older than the ttl", () => {
		const store = new SessionAffinityStore({ ttlMs: 1_000, maxEntries: 4 });
		store.rememberWithVersion("session-a", 0, 1_000, 1);
		store.forgetSession("session-a", 1_000, 3);
		expect(store.size()).toBe(0);

		store.rememberWithVersion("session-a", 2, 2_001, 2);
		expect(store.getPreferredAccountIndex("session-a", 2_001)).toBe(2);
	});

	it("keeps at most maxEntries forgets, dropping the oldest first", () => {
		const store = new SessionAffinityStore({ ttlMs: 60_000, maxEntries: 2 });
		store.forgetSession("session-a", 1_000, 5);
		store.forgetSession("session-b", 1_000, 5);
		store.forgetSession("session-c", 1_000, 5);

		// The oldest forget was evicted, so a stale write binds again.
		store.rememberWithVersion("session-a", 0, 2_000, 1);
		expect(store.getPreferredAccountIndex("session-a", 2_500)).toBe(0);
		// The newer forgets still refuse it.
		store.rememberWithVersion("session-c", 0, 2_000, 1);
		expect(store.getPreferredAccountIndex("session-c", 2_500)).toBeNull();
	});

	it("does not let a request that started before clearAll re-bind any session", () => {
		const store = new SessionAffinityStore({ ttlMs: 60_000, maxEntries: 4 });
		store.rememberWithVersion("session-a", 0, 1_000, 5);
		store.clearAll();

		store.rememberWithVersion("session-a", 0, 2_000, 5);
		store.rememberWithVersion("session-b", 1, 2_000, 4);
		expect(store.getPreferredAccountIndex("session-a", 2_500)).toBeNull();
		expect(store.getPreferredAccountIndex("session-b", 2_500)).toBeNull();

		store.remember("session-a", 2, 3_000);
		expect(store.getPreferredAccountIndex("session-a", 3_500)).toBe(2);
	});

	it("orders clearAll after versions reserved before it, even on an empty store", () => {
		const store = new SessionAffinityStore({ ttlMs: 60_000, maxEntries: 4 });
		const inFlight = store.nextWriteVersion();
		store.clearAll();
		const next = store.nextWriteVersion();

		store.rememberWithVersion("session-a", 0, 1_000, inFlight);
		expect(store.getPreferredAccountIndex("session-a", 1_500)).toBeNull();
		store.rememberWithVersion("session-a", 1, 2_000, next);
		expect(store.getPreferredAccountIndex("session-a", 2_500)).toBe(1);
	});

	it("generates distinct default write versions for same-timestamp overlaps", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-06T00:00:00.000Z"));
		try {
			const store = new SessionAffinityStore({ ttlMs: 10_000, maxEntries: 4 });
			store.rememberWithVersion("session-a", 0, 1_000);
			store.rememberWithVersion("session-a", 1, 1_000);

			expect(store.getPreferredAccountIndex("session-a", 1_500)).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
