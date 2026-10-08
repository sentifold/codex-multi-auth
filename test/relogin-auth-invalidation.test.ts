import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { persistAccountPool } from "../lib/codex-manager/login-oauth.js";
import { persistAccountPoolResults } from "../lib/runtime/account-pool.js";
import {
	findMatchingAccountIndex,
	loadAccounts,
	setStoragePathDirect,
	withAccountStorageTransaction,
} from "../lib/storage.js";

// A re-login replaces a credential that was invalidated upstream. Both login
// writes go through the real account storage here, so the record a restarted
// process loads is exactly what the login left on disk.

const tmpDirs: string[] = [];

afterEach(() => {
	setStoragePathDirect(null);
	for (const dir of tmpDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function seedInvalidatedAccount(now: number): void {
	const dir = mkdtempSync(join(tmpdir(), "relogin-invalidation-"));
	tmpDirs.push(dir);
	const path = join(dir, "openai-codex-accounts.json");
	writeFileSync(
		path,
		JSON.stringify({
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					accountId: "acct_1",
					accountIdSource: "manual",
					email: "user@example.com",
					refreshToken: "refresh-old",
					accessToken: "access-old",
					expiresAt: now + 3_600_000,
					addedAt: now - 60_000,
					lastUsed: now - 60_000,
					authInvalidatedAt: now - 30_000,
					authInvalidationErrorCode: "token_invalidated",
					coolingDownUntil: now + 300_000,
					cooldownReason: "auth-failure",
				},
			],
		}),
		"utf8",
	);
	setStoragePathDirect(path);
}

function loginResult(now: number) {
	return {
		type: "success" as const,
		access: "access-new",
		refresh: "refresh-new",
		expires: now + 3_600_000,
		accountIdOverride: "acct_1",
		accountIdSource: "manual" as const,
	};
}

async function skipReasonAfterReload(): Promise<string | null> {
	const stored = await loadAccounts();
	expect(stored?.accounts[0]?.refreshToken).toBe("refresh-new");
	return new AccountManager(undefined, stored).getAccountRuntimeSkipReason(
		0,
		"codex",
	);
}

describe("re-login of an invalidated account", () => {
	it("leaves the account selectable after a plugin-host login", async () => {
		const now = Date.now();
		seedInvalidatedAccount(now);

		await persistAccountPoolResults({
			results: [loginResult(now)],
			modelFamilies: ["codex"],
			withAccountStorageTransaction,
			findMatchingAccountIndex,
			extractAccountId: () => undefined,
			extractAccountEmail: () => "user@example.com",
			sanitizeEmail: (email) => email,
		});

		expect(await skipReasonAfterReload()).toBeNull();
	});

	it("leaves the account selectable after a CLI login", async () => {
		const now = Date.now();
		seedInvalidatedAccount(now);

		await persistAccountPool([loginResult(now)], false);

		expect(await skipReasonAfterReload()).toBeNull();
	});
});
