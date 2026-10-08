import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeWithRetry } from "./helpers/remove-with-retry.js";
import { AccountManager } from "../lib/accounts.js";
import {
	setStoragePathDirect,
	type AccountStorageV3,
} from "../lib/storage.js";

// Stress audit H3: a routine saveToDisk() by one process must not clobber a
// single-use refresh token that a SECOND process rotated to disk meanwhile.
describe("H3 - cross-process token clobber protection", () => {
	const tmpDirs: string[] = [];
	const managers: AccountManager[] = [];

	function makeStoragePath(): string {
		const dir = mkdtempSync(join(tmpdir(), "h3-clobber-"));
		tmpDirs.push(dir);
		return join(dir, "openai-codex-accounts.json");
	}

	beforeEach(() => {
		setStoragePathDirect(null);
	});

	afterEach(async () => {
		for (const m of managers.splice(0, managers.length)) {
			await m.flushPendingSave();
		}
		setStoragePathDirect(null);
		for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
			try {
				await removeWithRetry(dir, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		}
	});

	function seedPool(now: number): { storagePath: string; proc1: AccountManager } {
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					accountId: "acc-a",
					email: "a@example.com",
					refreshToken: "RT_A1",
					accessToken: "AT_A1",
					expiresAt: now + 60_000,
					addedAt: now,
					lastUsed: now,
				},
				{
					accountId: "acc-b",
					email: "b@example.com",
					refreshToken: "RT_B1",
					accessToken: "AT_B1",
					expiresAt: now + 60_000,
					addedAt: now,
					lastUsed: now,
				},
			],
		};
		const storagePath = makeStoragePath();
		writeFileSync(storagePath, JSON.stringify(storage), "utf8");
		setStoragePathDirect(storagePath);

		const proc1 = new AccountManager(undefined, storage);
		managers.push(proc1);
		return { storagePath, proc1 };
	}

	function readDisk(storagePath: string): AccountStorageV3 {
		return JSON.parse(readFileSync(storagePath, "utf8")) as AccountStorageV3;
	}

	// proc2 (simulated): rewrites the shared store.
	function editDisk(
		storagePath: string,
		edit: (storage: AccountStorageV3) => void,
	): void {
		const storage = readDisk(storagePath);
		edit(storage);
		writeFileSync(storagePath, JSON.stringify(storage), "utf8");
	}

	// proc2 (simulated): rotates B's token and writes a NEWER copy to disk.
	function rotateBOnDisk(storagePath: string, now: number): void {
		editDisk(storagePath, (rotated) => {
			const diskB = rotated.accounts[1]!;
			diskB.refreshToken = "RT_B2";
			diskB.accessToken = "AT_B2";
			diskB.expiresAt = now + 3_600_000;
		});
	}

	it("preserves a refresh token another process rotated to disk during a routine save", async () => {
		const now = Date.now();
		const { storagePath, proc1 } = seedPool(now);
		rotateBOnDisk(storagePath, now);

		// proc1 fires a routine save (touched only A in memory).
		await proc1.saveToDisk();

		const after = JSON.parse(
			readFileSync(storagePath, "utf8"),
		) as AccountStorageV3;
		const afterB = after.accounts.find((a) => a.accountId === "acc-b");
		expect(afterB?.refreshToken).toBe("RT_B2");
		expect(afterB?.accessToken).toBe("AT_B2");
	});

	it("serves the rotated token from the live pool after that routine save", async () => {
		const now = Date.now();
		const { storagePath, proc1 } = seedPool(now);
		const liveB = proc1.getAccountByIndex(1);
		if (!liveB) throw new Error("fixture account missing");
		proc1.markRateLimited(liveB, 120_000, "codex");
		const rateLimitResetTimes = structuredClone(liveB.rateLimitResetTimes);
		rotateBOnDisk(storagePath, now);

		await proc1.saveToDisk();

		// Without this, proc1 keeps presenting AT_B1 and its next refresh of B
		// spends RT_B1, which proc2 already rotated away.
		expect(proc1.getAccountByIndex(1)).toBe(liveB);
		expect(liveB).toMatchObject({
			refreshToken: "RT_B2",
			access: "AT_B2",
			expires: now + 3_600_000,
		});
		expect(liveB.rateLimitResetTimes).toEqual(rateLimitResetTimes);
		expect(proc1.getAccountByIndex(0)).toMatchObject({
			refreshToken: "RT_A1",
			access: "AT_A1",
		});
	});

	it("adopts another account's rotated token when committing its own refresh", async () => {
		const now = Date.now();
		const { storagePath, proc1 } = seedPool(now);
		const liveA = proc1.getAccountByIndex(0);
		if (!liveA) throw new Error("fixture account missing");
		rotateBOnDisk(storagePath, now);

		await proc1.commitRefreshedAuth(liveA, {
			type: "oauth",
			access: "AT_A2",
			refresh: "RT_A2",
			expires: now + 7_200_000,
		});

		expect(proc1.getAccountByIndex(0)).toMatchObject({
			refreshToken: "RT_A2",
			access: "AT_A2",
		});
		expect(proc1.getAccountByIndex(1)).toMatchObject({
			refreshToken: "RT_B2",
			access: "AT_B2",
		});
	});

	it("adopts a rotation for the same record after the other process also changed its email", async () => {
		const now = Date.now();
		const { storagePath, proc1 } = seedPool(now);
		// Any save by a current process stamps the record ids on disk.
		await proc1.saveToDisk();
		const liveB = proc1.getAccountByIndex(1);
		if (!liveB) throw new Error("fixture account missing");
		// proc2 refreshed B and stored the email read from the new token, so B
		// no longer has the identity proc1 knows it by.
		editDisk(storagePath, (disk) => {
			Object.assign(disk.accounts[1]!, {
				email: "b.renamed@example.com",
				refreshToken: "RT_B2",
				accessToken: "AT_B2",
				expiresAt: now + 3_600_000,
			});
		});

		await proc1.saveToDisk();

		expect(liveB).toMatchObject({
			refreshToken: "RT_B2",
			access: "AT_B2",
			expires: now + 3_600_000,
		});

		// A further rotation by proc2 must merge on the next save, not conflict.
		editDisk(storagePath, (disk) => {
			Object.assign(disk.accounts[1]!, {
				refreshToken: "RT_B3",
				accessToken: "AT_B3",
				expiresAt: now + 7_200_000,
			});
		});

		await proc1.saveToDisk();

		expect(liveB).toMatchObject({ refreshToken: "RT_B3", access: "AT_B3" });
		expect(readDisk(storagePath).accounts[1]).toMatchObject({
			recordId: liveB.recordId,
			email: "b.renamed@example.com",
			refreshToken: "RT_B3",
		});
	});

	it.each([
		["after proc1 has saved once", true],
		["before proc1's first save", false],
	])(
		"does not give a removed record the token of the account logged in again in its place (%s)",
		async (_when, savedOnce) => {
			const now = Date.now();
			const { storagePath, proc1 } = seedPool(now);
			if (savedOnce) await proc1.saveToDisk();
			const liveB = proc1.getAccountByIndex(1);
			if (!liveB) throw new Error("fixture account missing");
			// proc2 removed B and logged the same account in again as a new record.
			editDisk(storagePath, (disk) => {
				disk.accounts = [
					disk.accounts[0]!,
					{
						recordId: "record-b-relogin",
						accountId: "acc-b",
						email: "b@example.com",
						refreshToken: "RT_B9",
						accessToken: "AT_B9",
						expiresAt: now + 3_600_000,
						addedAt: now + 1,
						lastUsed: now + 1,
					},
				];
			});

			await proc1.saveToDisk();

			// The stale record keeps its own token chain; spending RT_B9 here would
			// leave the new record with a used refresh token on disk.
			expect(liveB).toMatchObject({ refreshToken: "RT_B1", access: "AT_B1" });
			expect(
				readDisk(storagePath).accounts.find(
					(row) => row.recordId === "record-b-relogin",
				),
			).toMatchObject({ refreshToken: "RT_B9", accessToken: "AT_B9" });
		},
	);
});
