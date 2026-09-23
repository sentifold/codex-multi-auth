import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountManager, AUTH_INVALIDATION_MARKER } from "../lib/accounts.js";
import type { AccountStorageV3 } from "../lib/storage.js";

const { queuedRefreshMock, saveAccountsMock, withAccountStorageTransactionMock } =
	vi.hoisted(() => ({
		queuedRefreshMock: vi.fn(),
		saveAccountsMock: vi.fn(),
		withAccountStorageTransactionMock: vi.fn(),
	}));

vi.mock("../lib/refresh-queue.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/refresh-queue.js")>();
	return { ...actual, queuedRefresh: queuedRefreshMock };
});

vi.mock("../lib/storage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/storage.js")>();
	return {
		...actual,
		saveAccounts: saveAccountsMock,
		withAccountStorageTransaction: withAccountStorageTransactionMock,
	};
});

vi.mock("../lib/codex-cli/writer.js", () => ({
	setCodexCliActiveSelection: vi.fn().mockResolvedValue(true),
}));

const {
	applyMonotonicAuthCooldown,
	DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
	ensureFreshAccessToken,
} = await import("../lib/runtime/rotation-token-refresh.js");

const NOW = Date.now();
const FAMILY = "gpt-5-codex" as const;
const SKEW_MS = 30_000;
const INVALIDATION_COOLDOWN_MS = 300_000;

function storageWith(
	expiresAt: number,
	accountOverrides: Partial<AccountStorageV3["accounts"][number]> = {},
): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { [FAMILY]: 0 },
		accounts: [
			{
				email: "account-1@example.com",
				accountId: "acc_1",
				refreshToken: "refresh-1",
				accessToken: "access-1",
				expiresAt,
				addedAt: NOW - 60_000,
				lastUsed: NOW - 60_000,
				enabled: true,
				...accountOverrides,
			},
		],
	};
}

const FRESH_EXPIRES = NOW + 3_600_000;
// Inside the refresh skew window: the proxy must refresh before using it.
const STALE_EXPIRES = NOW + 10_000;

const openManagers: AccountManager[] = [];

function managerWith(
	expiresAt: number,
	accountOverrides: Partial<AccountStorageV3["accounts"][number]> = {},
): AccountManager {
	const accountManager = new AccountManager(
		undefined,
		storageWith(expiresAt, accountOverrides),
	);
	openManagers.push(accountManager);
	return accountManager;
}

function refreshParams(accountManager: AccountManager) {
	const account = accountManager.getAccountByIndex(0);
	if (!account) throw new Error("fixture account missing");
	return {
		accountManager,
		account,
		family: FAMILY,
		model: null,
		now: NOW,
		tokenRefreshSkewMs: SKEW_MS,
		tokenInvalidationCooldownMs: INVALIDATION_COOLDOWN_MS,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	AccountManager.resetVolatileRuntimeState();
	saveAccountsMock.mockResolvedValue(undefined);
	withAccountStorageTransactionMock.mockImplementation(async (handler) =>
		handler(null, async () => undefined),
	);
});

afterEach(async () => {
	for (const accountManager of openManagers.splice(0, openManagers.length)) {
		await accountManager.flushPendingSave();
	}
});

describe("ensureFreshAccessToken", () => {
	it("uses a fresh token as-is without touching the refresh queue", async () => {
		const accountManager = managerWith(FRESH_EXPIRES);

		const result = await ensureFreshAccessToken(refreshParams(accountManager));

		expect(result).toMatchObject({ ok: true, accessToken: "access-1" });
		expect(queuedRefreshMock).not.toHaveBeenCalled();
	});

	it("refreshes a stale token and commits the rotated credentials", async () => {
		const accountManager = managerWith(STALE_EXPIRES);
		queuedRefreshMock.mockResolvedValue({
			type: "success",
			access: "access-new",
			refresh: "refresh-new",
			expires: NOW + 7_200_000,
		});

		const result = await ensureFreshAccessToken(refreshParams(accountManager));

		expect(queuedRefreshMock).toHaveBeenCalledExactlyOnceWith("refresh-1");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.accessToken).toBe("access-new");
			expect(result.account.access).toBe("access-new");
		}
		// The in-memory pool now carries the rotated credentials.
		expect(accountManager.getAccountByIndex(0)).toMatchObject({
			access: "access-new",
			refreshToken: "refresh-new",
		});
	});

	it("falls back to the refresh result's token when the commit cannot resolve the account", async () => {
		const accountManager = managerWith(STALE_EXPIRES);
		const original = accountManager.getAccountByIndex(0);
		if (!original) throw new Error("fixture account missing");
		queuedRefreshMock.mockResolvedValue({
			type: "success",
			access: "access-new",
			refresh: "refresh-new",
			expires: NOW + 7_200_000,
		});
		// The account vanished from storage between refresh and persist: the
		// commit reports null and the caller must use the freshly refreshed
		// token, never the stale one on the original account object.
		vi.spyOn(accountManager, "commitRefreshedAuth").mockResolvedValue(null);

		const result = await ensureFreshAccessToken(refreshParams(accountManager));

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.accessToken).toBe("access-new");
			expect(result.account).toBe(original);
		}
	});

	it("deduplicates concurrent commits for the same refreshed account", async () => {
		const accountManager = managerWith(STALE_EXPIRES);
		const commit = vi.spyOn(accountManager, "commitRefreshedAuth");
		queuedRefreshMock.mockResolvedValue({
			type: "success",
			access: "access-new",
			refresh: "refresh-new",
			expires: NOW + 7_200_000,
		});
		// Hold the first commit open so the second caller arrives while it is
		// still in flight — that is the window the dedup queue exists for.
		let releaseCommit!: () => void;
		const commitGate = new Promise<void>((resolve) => {
			releaseCommit = resolve;
		});
		withAccountStorageTransactionMock.mockImplementation(async (handler) => {
			await commitGate;
			return handler(null, async () => undefined);
		});
		const params = refreshParams(accountManager);

		const firstPending = ensureFreshAccessToken(params);
		const secondPending = ensureFreshAccessToken({ ...params });
		await new Promise<void>((resolve) => setImmediate(resolve));
		releaseCommit();
		const [first, second] = await Promise.all([firstPending, secondPending]);

		// Both callers share the single in-flight commit and the same token.
		expect(commit).toHaveBeenCalledTimes(1);
		expect(first).toMatchObject({ ok: true, accessToken: "access-new" });
		expect(second).toMatchObject({ ok: true, accessToken: "access-new" });
	});

	it("applies the short cooldown on a non-retryable auth failure", async () => {
		const accountManager = managerWith(STALE_EXPIRES);
		queuedRefreshMock.mockResolvedValue({
			type: "failed",
			reason: "http_error",
			statusCode: 401,
			message: "token expired",
		});

		const result = await ensureFreshAccessToken(refreshParams(accountManager));

		expect(result).toMatchObject({
			ok: false,
			retryable: false,
			invalidated: false,
		});
		const coolingDownUntil =
			accountManager.getAccountByIndex(0)?.coolingDownUntil ?? 0;
		expect(coolingDownUntil).toBeGreaterThan(NOW);
		expect(coolingDownUntil).toBeLessThanOrEqual(
			Date.now() + DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
		);
	});

	it("marks transient refresh failures retryable", async () => {
		const accountManager = managerWith(STALE_EXPIRES);
		queuedRefreshMock.mockResolvedValue({
			type: "failed",
			reason: "network_error",
			message: "fetch failed",
		});

		const result = await ensureFreshAccessToken(refreshParams(accountManager));

		expect(result).toMatchObject({ ok: false, retryable: true });
	});

	it("applies the long cooldown and signals invalidation on a revoked token", async () => {
		const accountManager = managerWith(STALE_EXPIRES);
		queuedRefreshMock.mockResolvedValue({
			type: "failed",
			reason: "http_error",
			statusCode: 401,
			message: "OAuth token has been invalidated",
		});

		const result = await ensureFreshAccessToken(refreshParams(accountManager));

		expect(result).toMatchObject({ ok: false, invalidated: true });
		const coolingDownUntil =
			accountManager.getAccountByIndex(0)?.coolingDownUntil ?? 0;
		// The invalidation cooldown is the long one, far beyond the 30s default.
		expect(coolingDownUntil).toBeGreaterThan(
			NOW + INVALIDATION_COOLDOWN_MS - 10_000,
		);
		expect(accountManager.getAccountByIndex(0)).toMatchObject({
			authInvalidatedAt: expect.any(Number),
			authInvalidationErrorCode: "token_invalidated",
		});
		expect(
			accountManager.isAccountAvailableForFamily(0, FAMILY, "gpt-5-codex"),
		).toBe(false);
	});

	it("persists the invalidation marker until a successful refresh clears it", async () => {
		let persisted: AccountStorageV3 | undefined;
		withAccountStorageTransactionMock.mockImplementation(async (handler) =>
			handler(null, async (nextStorage: AccountStorageV3) => {
				persisted = structuredClone(nextStorage);
			}),
		);
		const accountManager = managerWith(STALE_EXPIRES);
		queuedRefreshMock.mockResolvedValue({
			type: "failed",
			reason: "http_error",
			statusCode: 401,
			message: "OAuth token has been invalidated",
		});

		await ensureFreshAccessToken(refreshParams(accountManager));
		await accountManager.flushPendingSave();

		expect(persisted?.accounts[0]).toMatchObject({
			authInvalidatedAt: expect.any(Number),
			authInvalidationErrorCode: "token_invalidated",
		});

		queuedRefreshMock.mockResolvedValue({
			type: "success",
			access: "access-recovered",
			refresh: "refresh-recovered",
			expires: NOW + 7_200_000,
		});
		const refreshed = await ensureFreshAccessToken(refreshParams(accountManager));

		expect(refreshed).toMatchObject({ ok: true, accessToken: "access-recovered" });
		expect(accountManager.getAccountByIndex(0)?.authInvalidatedAt).toBeUndefined();
		expect(
			accountManager.getAccountByIndex(0)?.authInvalidationErrorCode,
		).toBeUndefined();
	});

	it("never lets a later generic failure truncate an invalidation cooldown", async () => {
		const accountManager = managerWith(STALE_EXPIRES);
		const account = accountManager.getAccountByIndex(0);
		if (!account) throw new Error("fixture account missing");
		accountManager.markAccountCoolingDown(
			account,
			INVALIDATION_COOLDOWN_MS,
			"auth-failure",
		);
		const longDeadline =
			accountManager.getAccountByIndex(0)?.coolingDownUntil ?? 0;
		queuedRefreshMock.mockResolvedValue({
			type: "failed",
			reason: "http_error",
			statusCode: 401,
			message: "token expired",
		});

		await ensureFreshAccessToken(refreshParams(accountManager));

		// Monotonic guard: the 30s generic cooldown must not shorten the
		// 5-minute invalidation cooldown set by a concurrent request.
		expect(accountManager.getAccountByIndex(0)?.coolingDownUntil).toBe(
			longDeadline,
		);
	});

	it("cools down and stays retryable when the commit itself fails", async () => {
		const accountManager = managerWith(STALE_EXPIRES);
		queuedRefreshMock.mockResolvedValue({
			type: "success",
			access: "access-new",
			refresh: "refresh-new",
			expires: NOW + 7_200_000,
		});
		// Once: the post-test debounced-save flush must still see the working
		// transaction implementation from beforeEach.
		withAccountStorageTransactionMock.mockRejectedValueOnce(
			Object.assign(new Error("locked"), { code: "EBUSY" }),
		);

		const result = await ensureFreshAccessToken(refreshParams(accountManager));

		expect(result).toMatchObject({ ok: false, retryable: true });
		expect(
			accountManager.getAccountByIndex(0)?.coolingDownUntil ?? 0,
		).toBeGreaterThan(NOW);
	});
});

describe("applyMonotonicAuthCooldown", () => {
	it("extends an absent cooldown but never shortens an existing one", () => {
		const accountManager = managerWith(FRESH_EXPIRES);
		const account = accountManager.getAccountByIndex(0);
		if (!account) throw new Error("fixture account missing");

		applyMonotonicAuthCooldown(accountManager, account, 60_000);
		const firstDeadline =
			accountManager.getAccountByIndex(0)?.coolingDownUntil ?? 0;
		expect(firstDeadline).toBeGreaterThan(NOW);

		applyMonotonicAuthCooldown(accountManager, account, 1_000);
		expect(accountManager.getAccountByIndex(0)?.coolingDownUntil).toBe(
			firstDeadline,
		);

		applyMonotonicAuthCooldown(accountManager, account, 600_000);
		expect(
			accountManager.getAccountByIndex(0)?.coolingDownUntil ?? 0,
		).toBeGreaterThan(firstDeadline);
	});
});


describe("external credential rotation in a long-lived manager", () => {
	function externallyRotatedStorage() {
		return storageWith(NOW + 7_200_000, {
			accessToken: "access-external",
			refreshToken: "refresh-external",
		});
	}

	it("uses disk-rotated auth after a routine 401 save without replacing the manager", async () => {
		const manager = managerWith(FRESH_EXPIRES);
		const account = refreshParams(manager).account;
		applyMonotonicAuthCooldown(manager, account, DEFAULT_AUTH_FAILURE_COOLDOWN_MS);
		const cooldown = account.coolingDownUntil;
		const disk = externallyRotatedStorage();
		const persist = vi.fn().mockResolvedValue(undefined);
		withAccountStorageTransactionMock.mockImplementation(async (handler) => handler(disk, persist));

		manager.saveToDiskDebounced();
		await manager.flushPendingSave();

		expect(manager.getAccountByIndex(0)).toBe(account);
		expect(account.refreshToken).toBe("refresh-external");
		// The 401 backoff was earned by the replaced token, not the new one.
		expect(cooldown).toBeGreaterThan(NOW);
		expect(account.coolingDownUntil).toBeUndefined();
		expect(account.cooldownReason).toBeUndefined();
		const result = await ensureFreshAccessToken({ ...refreshParams(manager), model: "gpt-6-astra" });
		expect(result).toMatchObject({ ok: true, accessToken: "access-external" });
		expect(queuedRefreshMock).not.toHaveBeenCalled();
		const persisted = persist.mock.calls[0]?.[0].accounts[0];
		expect(persisted?.accessToken).toBe("access-external");
		expect(persisted?.coolingDownUntil).toBeUndefined();
		expect(persisted?.cooldownReason).toBeUndefined();
	});

	it("keeps disabled accounts, real quota and routing state while releasing the replaced credential's invalidation", async () => {
		const manager = managerWith(FRESH_EXPIRES, { enabled: false });
		const account = refreshParams(manager).account;
		manager.markRateLimited(account, 120_000, FAMILY, "gpt-6-astra");
		manager.markAuthInvalidated(account);
		const { authInvalidatedAt, authInvalidationErrorCode, ...before } = structuredClone(account);
		expect(authInvalidatedAt).toBeGreaterThan(0);
		expect(authInvalidationErrorCode).toBe("token_invalidated");
		withAccountStorageTransactionMock.mockImplementation(async (handler) => handler(externallyRotatedStorage(), async () => undefined));
		await manager.saveToDisk();
		expect(account).toEqual({
			...before,
			access: "access-external",
			refreshToken: "refresh-external",
			expires: NOW + 7_200_000,
			consecutiveAuthFailures: 0,
		});
		expect(manager.getAccountRuntimeSkipReason(0, FAMILY, "gpt-6-astra")).toBe("disabled");
	});

	it("does not publish new live auth when persistence fails", async () => {
		const manager = managerWith(FRESH_EXPIRES);
		const account = refreshParams(manager).account;
		withAccountStorageTransactionMock.mockImplementation(async (handler) => handler(externallyRotatedStorage(), async () => { throw new Error("disk full"); }));
		await expect(manager.saveToDisk()).rejects.toThrow("disk full");
		expect(account.access).toBe("access-1");
	});

	it("does not overwrite a newer concurrent refresh while a save is pending", async () => {
		const manager = managerWith(FRESH_EXPIRES);
		const account = refreshParams(manager).account;
		withAccountStorageTransactionMock.mockImplementation(async (handler) => handler(externallyRotatedStorage(), async () => {
			manager.updateFromAuth(account, { type: "oauth", access: "access-latest", refresh: "refresh-latest", expires: NOW + 10_800_000 });
		}));
		await manager.saveToDisk();
		expect(account.access).toBe("access-latest");
		expect(account.refreshToken).toBe("refresh-latest");
	});

	it.each([0, -60_000])("does not replace auth with equal or older disk expiry (%s)", async (offset) => {
		const manager = managerWith(FRESH_EXPIRES);
		const disk = externallyRotatedStorage();
		disk.accounts[0]!.expiresAt = FRESH_EXPIRES + offset;
		withAccountStorageTransactionMock.mockImplementation(async (handler) => handler(disk, async () => undefined));
		await manager.saveToDisk();
		expect(refreshParams(manager).account.access).toBe("access-1");
	});

	it("matches identity instead of reordered account indices", async () => {
		const manager = managerWith(FRESH_EXPIRES);
		const disk = externallyRotatedStorage();
		disk.accounts.unshift({ ...disk.accounts[0]!, accountId: "other", email: "other@example.com", accessToken: "access-other", refreshToken: "refresh-other", expiresAt: NOW + 10_800_000 });
		withAccountStorageTransactionMock.mockImplementation(async (handler) => handler(disk, async () => undefined));
		await manager.saveToDisk();
		expect(refreshParams(manager).account.access).toBe("access-external");
	});
});

describe("re-login while an explicit invalidation is resident", () => {
	// 2026-09-23: a resident router kept a token_invalidated marker for an
	// account that had signed in again the day before. Routine saves adopted
	// the new credential but wrote the old marker back, so every request 503ed.
	const INVALIDATED_AT = NOW - 3 * 86_400_000;
	const RELOGIN_EXPIRES = NOW + 7_200_000;
	const MODEL = "gpt-6-astra";

	function invalidatedManager() {
		const manager = managerWith(FRESH_EXPIRES);
		const account = refreshParams(manager).account;
		manager.markAuthInvalidated(account, "token_invalidated", INVALIDATED_AT);
		applyMonotonicAuthCooldown(manager, account, INVALIDATION_COOLDOWN_MS);
		manager.incrementAuthFailures(account);
		manager.incrementAuthFailures(account);
		return { manager, account };
	}

	// What a login writes: a new refresh token for the same identity with the
	// invalidation cleared. It leaves the old cooldown fields in place.
	function reloginStorage(
		overrides: Partial<AccountStorageV3["accounts"][number]> = {},
	): AccountStorageV3 {
		return storageWith(RELOGIN_EXPIRES, {
			accessToken: "access-relogin",
			refreshToken: "refresh-relogin",
			coolingDownUntil: NOW + INVALIDATION_COOLDOWN_MS,
			cooldownReason: "auth-failure",
			...overrides,
		});
	}

	function statefulDisk(initial: AccountStorageV3) {
		const disk = { current: structuredClone(initial) };
		withAccountStorageTransactionMock.mockImplementation(async (handler) =>
			handler(structuredClone(disk.current), async (storage: AccountStorageV3) => {
				disk.current = structuredClone(storage);
			}),
		);
		return disk;
	}

	it("routes the same live account again and never writes the old marker back", async () => {
		const { manager, account } = invalidatedManager();
		expect(manager.getAccountRuntimeSkipReason(0, FAMILY, MODEL)).toBe(AUTH_INVALIDATION_MARKER);
		const disk = statefulDisk(reloginStorage());

		await manager.saveToDisk();

		const persisted = disk.current.accounts[0];
		expect(persisted).toMatchObject({ refreshToken: "refresh-relogin", accessToken: "access-relogin" });
		for (const field of ["authInvalidatedAt", "authInvalidationErrorCode", "coolingDownUntil", "cooldownReason"] as const) {
			expect(persisted?.[field]).toBeUndefined();
		}
		expect(manager.getAccountByIndex(0)).toBe(account);
		expect(account).toMatchObject({
			refreshToken: "refresh-relogin",
			access: "access-relogin",
			expires: RELOGIN_EXPIRES,
			consecutiveAuthFailures: 0,
		});
		expect(manager.isAccountAuthInvalidated(account)).toBe(false);
		expect(account.authInvalidationErrorCode).toBeUndefined();
		expect(account.coolingDownUntil).toBeUndefined();
		expect(manager.getAccountRuntimeSkipReason(0, FAMILY, MODEL)).toBeNull();
		expect(manager.getCurrentOrNextForFamily(FAMILY, MODEL)).toBe(account);
		const result = await ensureFreshAccessToken({ ...refreshParams(manager), model: MODEL });
		expect(result).toMatchObject({ ok: true, accessToken: "access-relogin" });
		expect(queuedRefreshMock).not.toHaveBeenCalled();

		await manager.saveToDisk();
		expect(disk.current.accounts[0]?.authInvalidatedAt).toBeUndefined();
	});

	it("keeps an invalidation of the same refresh token even with a newer expiry", async () => {
		const { manager, account } = invalidatedManager();
		const disk = statefulDisk(storageWith(RELOGIN_EXPIRES, { accessToken: "access-topped-up" }));

		await manager.saveToDisk();

		expect(account).toMatchObject({
			refreshToken: "refresh-1",
			access: "access-topped-up",
			authInvalidatedAt: INVALIDATED_AT,
			cooldownReason: "auth-failure",
			consecutiveAuthFailures: 2,
		});
		expect(manager.getAccountRuntimeSkipReason(0, FAMILY, MODEL)).toBe(AUTH_INVALIDATION_MARKER);
		expect(disk.current.accounts[0]).toMatchObject({
			authInvalidatedAt: INVALIDATED_AT,
			authInvalidationErrorCode: "token_invalidated",
			cooldownReason: "auth-failure",
		});
	});

	it("keeps the invalidation when the new disk credential is itself marked invalid", async () => {
		const { manager, account } = invalidatedManager();
		const disk = statefulDisk(
			reloginStorage({ authInvalidatedAt: NOW - 1_000, authInvalidationErrorCode: "token_revoked" }),
		);

		await manager.saveToDisk();

		expect(account).toMatchObject({
			refreshToken: "refresh-relogin",
			authInvalidatedAt: INVALIDATED_AT,
			cooldownReason: "auth-failure",
			consecutiveAuthFailures: 2,
		});
		expect(manager.getAccountRuntimeSkipReason(0, FAMILY, MODEL)).toBe(AUTH_INVALIDATION_MARKER);
		// Nothing is released: the persisted record keeps its marker and backoff.
		expect(disk.current.accounts[0]).toMatchObject({
			authInvalidatedAt: INVALIDATED_AT,
			authInvalidationErrorCode: "token_invalidated",
			cooldownReason: "auth-failure",
		});
	});

	it("keeps rate-limit cooldowns and exact-model quota windows", async () => {
		const manager = managerWith(FRESH_EXPIRES);
		const account = refreshParams(manager).account;
		manager.markAuthInvalidated(account, "token_invalidated", INVALIDATED_AT);
		manager.markRateLimited(account, 6 * 86_400_000, FAMILY, MODEL);
		manager.markAccountCoolingDown(account, 120_000, "rate-limit");
		const quota = structuredClone(account.rateLimitResetTimes);
		const cooldownUntil = account.coolingDownUntil;
		const disk = statefulDisk(reloginStorage());

		await manager.saveToDisk();

		expect(manager.isAccountAuthInvalidated(account)).toBe(false);
		const kept = { coolingDownUntil: cooldownUntil, cooldownReason: "rate-limit", rateLimitResetTimes: quota };
		expect(account).toMatchObject({ refreshToken: "refresh-relogin", ...kept });
		expect(disk.current.accounts[0]).toMatchObject(kept);
		expect(manager.getAccountRuntimeSkipReason(0, FAMILY, MODEL)).toBe("rate-limited");
	});

	it("releases nothing when persistence fails", async () => {
		const { manager, account } = invalidatedManager();
		withAccountStorageTransactionMock.mockImplementation(async (handler) =>
			handler(reloginStorage(), async () => {
				throw new Error("disk full");
			}),
		);

		await expect(manager.saveToDisk()).rejects.toThrow("disk full");

		expect(account).toMatchObject({
			refreshToken: "refresh-1",
			authInvalidatedAt: INVALIDATED_AT,
			cooldownReason: "auth-failure",
			consecutiveAuthFailures: 2,
		});
	});

	it("also releases a marker the old credential earns while the write is in flight", async () => {
		const manager = managerWith(FRESH_EXPIRES);
		const account = refreshParams(manager).account;
		withAccountStorageTransactionMock.mockImplementation(async (handler) =>
			handler(reloginStorage(), async () => {
				// A request still holding the old token learns it was invalidated.
				manager.markAuthInvalidated(account);
				applyMonotonicAuthCooldown(manager, account, INVALIDATION_COOLDOWN_MS);
			}),
		);

		await manager.saveToDisk();

		expect(account.refreshToken).toBe("refresh-relogin");
		expect(manager.getAccountRuntimeSkipReason(0, FAMILY, MODEL)).toBeNull();
	});

	it("keeps a marker the same credential earns while the write is in flight", async () => {
		const manager = managerWith(FRESH_EXPIRES);
		const account = refreshParams(manager).account;
		// Disk holds the same refresh token with a later expiry and no marker.
		withAccountStorageTransactionMock.mockImplementation(async (handler) =>
			handler(storageWith(RELOGIN_EXPIRES, { accessToken: "access-topped-up" }), async () => {
				manager.markAuthInvalidated(account, "token_invalidated", NOW);
				applyMonotonicAuthCooldown(manager, account, INVALIDATION_COOLDOWN_MS);
			}),
		);

		await manager.saveToDisk();

		expect(account).toMatchObject({
			refreshToken: "refresh-1",
			access: "access-topped-up",
			authInvalidatedAt: NOW,
			authInvalidationErrorCode: "token_invalidated",
			cooldownReason: "auth-failure",
		});
		expect(manager.getAccountRuntimeSkipReason(0, FAMILY, MODEL)).toBe(AUTH_INVALIDATION_MARKER);
	});

	it("does not let another account's refresh revert the re-login on disk", async () => {
		const stored = storageWith(FRESH_EXPIRES);
		const second = {
			...stored.accounts[0]!,
			accountId: "acc_2",
			email: "account-2@example.com",
			refreshToken: "refresh-2",
			accessToken: "access-2",
			expiresAt: STALE_EXPIRES,
		};
		stored.accounts.push(second);
		const manager = new AccountManager(undefined, stored);
		openManagers.push(manager);
		const invalidated = manager.getAccountByIndex(0)!;
		manager.markAuthInvalidated(invalidated, "token_invalidated", INVALIDATED_AT);
		const relogin = reloginStorage();
		relogin.accounts.push(structuredClone(second));
		const disk = statefulDisk(relogin);
		queuedRefreshMock.mockResolvedValue({
			type: "success",
			access: "access-2-new",
			refresh: "refresh-2-new",
			expires: NOW + 7_200_000,
		});

		const result = await ensureFreshAccessToken({
			...refreshParams(manager),
			account: manager.getAccountByIndex(1)!,
			model: MODEL,
		});

		expect(result).toMatchObject({ ok: true, accessToken: "access-2-new" });
		expect(disk.current.accounts[0]).toMatchObject({ refreshToken: "refresh-relogin", accessToken: "access-relogin" });
		expect(disk.current.accounts[0]?.authInvalidatedAt).toBeUndefined();
		expect(disk.current.accounts[1]).toMatchObject({ refreshToken: "refresh-2-new", accessToken: "access-2-new" });
		expect(invalidated.refreshToken).toBe("refresh-relogin");
		expect(manager.getAccountRuntimeSkipReason(0, FAMILY, MODEL)).toBeNull();
	});

	// A managed router whose whole pool is unavailable makes no routine saves,
	// so it asks for a waiting replacement directly before refusing a request.
	describe("adoptReplacementCredentials", () => {
		function countingDisk(initial: AccountStorageV3) {
			const disk = { current: structuredClone(initial), writes: 0 };
			withAccountStorageTransactionMock.mockImplementation(async (handler) =>
				handler(structuredClone(disk.current), async (storage: AccountStorageV3) => {
					disk.writes += 1;
					disk.current = structuredClone(storage);
				}),
			);
			return disk;
		}

		it("adopts a waiting re-login without a routine save", async () => {
			const { manager, account } = invalidatedManager();
			const disk = countingDisk(reloginStorage());

			await expect(manager.adoptReplacementCredentials()).resolves.toEqual([0]);

			expect(disk.writes).toBe(1);
			expect(manager.getAccountByIndex(0)).toBe(account);
			expect(account).toMatchObject({
				refreshToken: "refresh-relogin",
				access: "access-relogin",
				expires: RELOGIN_EXPIRES,
				consecutiveAuthFailures: 0,
			});
			expect(account.authInvalidatedAt).toBeUndefined();
			expect(account.cooldownReason).toBeUndefined();
			expect(manager.getAccountRuntimeSkipReason(0, FAMILY, MODEL)).toBeNull();
			const persisted = disk.current.accounts[0];
			for (const field of ["authInvalidatedAt", "authInvalidationErrorCode", "coolingDownUntil", "cooldownReason"] as const) {
				expect(persisted?.[field]).toBeUndefined();
			}
			// Nothing is left to adopt, so a second call neither loads nor writes.
			await expect(manager.adoptReplacementCredentials()).resolves.toEqual([]);
			expect(withAccountStorageTransactionMock).toHaveBeenCalledTimes(1);
			expect(disk.writes).toBe(1);
		});

		it("releases an auth-failure cooldown that has no explicit invalidation", async () => {
			const manager = managerWith(FRESH_EXPIRES);
			const account = refreshParams(manager).account;
			applyMonotonicAuthCooldown(manager, account, DEFAULT_AUTH_FAILURE_COOLDOWN_MS);
			expect(manager.getAccountRuntimeSkipReason(0, FAMILY, MODEL)).toBe("cooling-down:auth-failure");
			const disk = countingDisk(reloginStorage({ coolingDownUntil: undefined, cooldownReason: undefined }));

			await expect(manager.adoptReplacementCredentials()).resolves.toEqual([0]);

			expect(disk.writes).toBe(1);
			expect(account.refreshToken).toBe("refresh-relogin");
			expect(manager.getAccountRuntimeSkipReason(0, FAMILY, MODEL)).toBeNull();
		});

		it.each([
			["the same refresh token", storageWith(RELOGIN_EXPIRES, { accessToken: "access-topped-up" })],
			["a different token that does not expire later", storageWith(FRESH_EXPIRES - 1_000, {
				accessToken: "access-relogin",
				refreshToken: "refresh-relogin",
			})],
			["a disk record that is itself invalidated", storageWith(RELOGIN_EXPIRES, {
				accessToken: "access-relogin",
				refreshToken: "refresh-relogin",
				authInvalidatedAt: NOW - 1_000,
				authInvalidationErrorCode: "token_revoked",
			})],
		])("writes and releases nothing for %s", async (_label, stored) => {
			const { manager, account } = invalidatedManager();
			const before = structuredClone(account);
			const disk = countingDisk(stored);

			await expect(manager.adoptReplacementCredentials()).resolves.toEqual([]);

			expect(withAccountStorageTransactionMock).toHaveBeenCalledTimes(1);
			expect(disk.writes).toBe(0);
			expect(account).toEqual(before);
			expect(manager.getAccountRuntimeSkipReason(0, FAMILY, MODEL)).toBe(AUTH_INVALIDATION_MARKER);
		});

		it("writes nothing when another process added an account to the store", async () => {
			const { manager, account } = invalidatedManager();
			const stored = reloginStorage();
			stored.accounts.push({
				...stored.accounts[0]!,
				accountId: "acc_added",
				email: "added@example.com",
				refreshToken: "refresh-added",
				accessToken: "access-added",
			});
			const disk = countingDisk(stored);

			await expect(manager.adoptReplacementCredentials()).resolves.toEqual([]);

			// A write rebuilt from the live pool would drop the added account.
			expect(disk.writes).toBe(0);
			expect(disk.current.accounts.map((entry) => entry.accountId)).toEqual(["acc_1", "acc_added"]);
			expect(manager.getAccountRuntimeSkipReason(0, FAMILY, MODEL)).toBe(AUTH_INVALIDATION_MARKER);
			expect(account.refreshToken).toBe("refresh-1");
		});

		it("writes nothing when another process removed an account from the store", async () => {
			const stored = storageWith(FRESH_EXPIRES);
			stored.accounts.push({
				...stored.accounts[0]!,
				accountId: "acc_removed",
				email: "removed@example.com",
				refreshToken: "refresh-removed",
				accessToken: "access-removed",
			});
			const manager = new AccountManager(undefined, stored);
			openManagers.push(manager);
			manager.markAuthInvalidated(manager.getAccountByIndex(0)!, "token_invalidated", INVALIDATED_AT);
			const disk = countingDisk(reloginStorage());

			await expect(manager.adoptReplacementCredentials()).resolves.toEqual([]);

			// A write rebuilt from the live pool would bring the removed account back.
			expect(disk.writes).toBe(0);
			expect(manager.getAccountRuntimeSkipReason(0, FAMILY, MODEL)).toBe(AUTH_INVALIDATION_MARKER);
		});

		it("does not open the store while no account is blocked for auth reasons", async () => {
			const manager = managerWith(FRESH_EXPIRES);
			const account = refreshParams(manager).account;
			// A newer credential is waiting, but rate limits are account state.
			manager.markAccountCoolingDown(account, 120_000, "rate-limit");
			manager.markRateLimited(account, 86_400_000, FAMILY, MODEL);
			const disk = countingDisk(reloginStorage({ coolingDownUntil: undefined, cooldownReason: undefined }));

			await expect(manager.adoptReplacementCredentials()).resolves.toEqual([]);

			expect(withAccountStorageTransactionMock).not.toHaveBeenCalled();
			expect(disk.writes).toBe(0);
			expect(account.refreshToken).toBe("refresh-1");
			expect(account.cooldownReason).toBe("rate-limit");
		});

		it("releases nothing when the write fails", async () => {
			const { manager, account } = invalidatedManager();
			const before = structuredClone(account);
			withAccountStorageTransactionMock.mockImplementation(async (handler) =>
				handler(reloginStorage(), async () => {
					throw new Error("disk full");
				}),
			);

			await expect(manager.adoptReplacementCredentials()).rejects.toThrow("disk full");

			expect(account).toEqual(before);
			expect(manager.getAccountRuntimeSkipReason(0, FAMILY, MODEL)).toBe(AUTH_INVALIDATION_MARKER);
		});
	});
});
