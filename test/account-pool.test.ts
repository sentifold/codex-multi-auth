import { describe, expect, it, vi } from "vitest";
import { persistAccountPoolResults } from "../lib/runtime/account-pool.js";
import type { AccountStorageV3 } from "../lib/storage.js";

describe("account pool helper", () => {
	it("persists new account results into storage transaction", async () => {
		const persist = vi.fn(async () => undefined);

		await persistAccountPoolResults({
			results: [
				{
					type: "success",
					access: "access-token",
					refresh: "refresh-token",
					expires: 123,
					accountIdOverride: "acct_1",
					accountIdSource: "manual",
					accountLabel: "Primary",
					workspaces: [
						{ id: "acct_1", name: "Primary", enabled: true, isDefault: true },
					],
				},
			],
			replaceAll: false,
			modelFamilies: ["codex"],
			withAccountStorageTransaction: async (handler) => handler(null, persist),
			findMatchingAccountIndex: () => undefined,
			extractAccountId: () => undefined,
			extractAccountEmail: () => "user@example.com",
			sanitizeEmail: (email) => email,
		});

		expect(persist).toHaveBeenCalledWith({
			version: 3,
			accounts: [
				{
					accountId: "acct_1",
					accountIdSource: "manual",
					accountLabel: "Primary",
					email: "user@example.com",
					refreshToken: "refresh-token",
					accessToken: "access-token",
					expiresAt: 123,
					addedAt: expect.any(Number),
					lastUsed: expect.any(Number),
					workspaces: [
						{ id: "acct_1", name: "Primary", enabled: true, isDefault: true },
					],
					currentWorkspaceIndex: 0,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		});
	});

	// The plugin host's login write for an account that signs in again.
	async function signInAgain(
		fields: Partial<AccountStorageV3["accounts"][number]>,
	): Promise<AccountStorageV3["accounts"][number] | undefined> {
		const persist = vi.fn(async (_storage: AccountStorageV3) => undefined);
		const stored: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					accountId: "acct_1",
					email: "user@example.com",
					refreshToken: "refresh-old",
					accessToken: "access-old",
					expiresAt: 100,
					addedAt: 1,
					lastUsed: 1,
					rateLimitResetTimes: { codex: 999 },
					...fields,
				},
			],
		};

		await persistAccountPoolResults({
			results: [
				{
					type: "success",
					access: "access-new",
					refresh: "refresh-new",
					expires: 200,
					accountIdOverride: "acct_1",
					accountIdSource: "manual",
				},
			],
			replaceAll: false,
			modelFamilies: ["codex"],
			withAccountStorageTransaction: async (handler) => handler(stored, persist),
			findMatchingAccountIndex: () => 0,
			extractAccountId: () => undefined,
			extractAccountEmail: () => "user@example.com",
			sanitizeEmail: (email) => email,
		});

		return persist.mock.calls[0]?.[0].accounts[0];
	}

	it("clears the replaced credential's invalidation and auth backoff when an account signs in again", async () => {
		const saved = await signInAgain({
			authInvalidatedAt: 50,
			authInvalidationErrorCode: "token_invalidated",
			coolingDownUntil: 400,
			cooldownReason: "auth-failure",
		});

		expect(saved).toMatchObject({
			refreshToken: "refresh-new",
			accessToken: "access-new",
			expiresAt: 200,
			rateLimitResetTimes: { codex: 999 },
		});
		expect(saved?.authInvalidatedAt).toBeUndefined();
		expect(saved?.authInvalidationErrorCode).toBeUndefined();
		expect(saved?.coolingDownUntil).toBeUndefined();
		expect(saved?.cooldownReason).toBeUndefined();
	});

	it("keeps a rate-limit cooldown when an account signs in again", async () => {
		const saved = await signInAgain({
			coolingDownUntil: 400,
			cooldownReason: "rate-limit",
		});

		expect(saved).toMatchObject({
			refreshToken: "refresh-new",
			coolingDownUntil: 400,
			cooldownReason: "rate-limit",
		});
	});
});
