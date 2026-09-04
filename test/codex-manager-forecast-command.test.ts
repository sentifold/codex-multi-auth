import { describe, expect, it, vi } from "vitest";
import {
	type ForecastCommandDeps,
	runForecastCommand,
} from "../lib/codex-manager/commands/forecast.js";
import { CodexUnavailableError } from "../lib/errors.js";
import { CODEX_UNAVAILABLE_PROBE_NOTE } from "../lib/quota-probe.js";
import {
	DEFAULT_PROBE_MODEL,
	getModelProfile,
	resolveNormalizedModel,
} from "../lib/request/helpers/model-map.js";
import type { AccountStorageV3 } from "../lib/storage.js";

function createStorage(): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: [
			{
				email: "forecast@example.com",
				refreshToken: "refresh-forecast",
				accessToken: "access-forecast",
				expiresAt: Date.now() + 60_000,
				addedAt: 1,
				lastUsed: 1,
				enabled: true,
			},
		],
	};
}

function createDeps(
	overrides: Partial<
		ForecastCommandDeps & {
			formatQuotaSnapshotLine: (snapshot: unknown) => string;
		}
	> = {},
): ForecastCommandDeps & {
	formatQuotaSnapshotLine: (snapshot: unknown) => string;
} {
	return {
		setStoragePath: vi.fn(),
		loadAccounts: vi.fn(async () => createStorage()),
		saveAccounts: vi.fn(async () => undefined),
		resolveActiveIndex: vi.fn(() => 0),
		loadQuotaCache: vi.fn(async () => ({ byAccountId: {}, byEmail: {} })),
		saveQuotaCache: vi.fn(async () => undefined),
		cloneQuotaCacheData: vi.fn((cache) => structuredClone(cache)),
		buildQuotaEmailFallbackState: vi.fn(() => new Map()),
		updateQuotaCacheForAccount: vi.fn(() => false),
		hasUsableAccessToken: vi.fn(() => true),
		queuedRefresh: vi.fn(async () => ({
			type: "success",
			access: "access-forecast",
			refresh: "refresh-forecast",
			expires: Date.now() + 60_000,
		})),
		fetchCodexQuotaSnapshot: vi.fn(async (input) => ({
			status: 200,
			model: input.model ?? DEFAULT_PROBE_MODEL,
			primary: {},
			secondary: {},
		})),
		normalizeFailureDetail: vi.fn((message) => message ?? "unknown"),
		formatAccountLabel: vi.fn(
			(_account, index) => `${index + 1}. forecast@example.com`,
		),
		extractAccountId: vi.fn(() => "account-id"),
		evaluateForecastAccounts: vi.fn(() => [
			{
				index: 0,
				label: "1. forecast@example.com",
				isCurrent: true,
				availability: "ready",
				riskScore: 0,
				riskLevel: "low",
				waitMs: 0,
				reasons: ["healthy"],
			},
		]),
		summarizeForecast: vi.fn(() => ({
			total: 1,
			ready: 1,
			delayed: 0,
			unavailable: 0,
			highRisk: 0,
		})),
		recommendForecastAccount: vi.fn(() => ({
			recommendedIndex: 0,
			reason: "lowest risk",
		})),
		stylePromptText: vi.fn((text) => text),
		formatResultSummary: vi.fn((segments) =>
			segments.map((segment) => segment.text).join(" | "),
		),
		styleQuotaSummary: vi.fn((summary) => summary),
		formatCompactQuotaSnapshot: vi.fn(() => "5h 75%"),
		availabilityTone: vi.fn(() => "success"),
		riskTone: vi.fn(() => "success"),
		formatWaitTime: vi.fn(() => "1m"),
		defaultDisplay: {
			showPerAccountRows: true,
			showQuotaDetails: true,
			showForecastReasons: true,
			showRecommendations: true,
			showLiveProbeNotes: true,
			menuAutoFetchLimits: true,
			menuSortEnabled: true,
			menuSortMode: "ready-first",
			menuSortPinCurrent: true,
			menuSortQuickSwitchVisibleRow: true,
		},
		formatQuotaSnapshotLine: vi.fn(() => "quota summary"),
		logInfo: vi.fn(),
		logError: vi.fn(),
		getNow: vi.fn(() => 1_000),
		...overrides,
	} as ForecastCommandDeps & {
		formatQuotaSnapshotLine: (snapshot: unknown) => string;
	};
}

describe("runForecastCommand", () => {
	it.each([[], ["--model", "gpt-6-astra"]])("uses the Astra family's active account (%j)", async (...modelArgs: string[]) => {
		const storage = createStorage();
		storage.accounts.push({ ...storage.accounts[0]!, email: "second@example.com" });
		storage.activeIndexByFamily = { codex: 0, "gpt-5.2": 1 };
		const deps = createDeps({
			loadAccounts: vi.fn(async () => storage),
			resolveActiveIndex: vi.fn((state, family) => state.activeIndexByFamily?.[family ?? "codex"] ?? state.activeIndex),
		});
		expect(await runForecastCommand(["--json", ...modelArgs], deps)).toBe(0);
		expect(deps.resolveActiveIndex).toHaveBeenCalledWith(storage, "gpt-5.2");
		const inputs = vi.mocked(deps.evaluateForecastAccounts).mock.calls[0]?.[0];
		expect(inputs?.map((input) => input.isCurrent)).toEqual([false, true]);
	});
	it.each([[], ["--model", "gpt-6-astra"]])("probes default or explicit Astra without fallback (%j)", async (...modelArgs: string[]) => {
		const deps = createDeps({
			fetchCodexQuotaSnapshot: vi.fn(async () => ({
				status: 200, model: "gpt-6-astra",
				primary: { usedPercent: 11, windowMinutes: 300 },
				secondary: { usedPercent: 22, windowMinutes: 10080 },
			})),
		});
		expect(await runForecastCommand(["--live", "--json", ...modelArgs], deps)).toBe(0);
		expect(deps.fetchCodexQuotaSnapshot).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-6-astra", fallbackModels: [] }));
		const report = JSON.parse(vi.mocked(deps.logInfo!).mock.calls[0][0]);
		expect(report).toMatchObject({ requestedModel: "gpt-6-astra", probeModel: "gpt-6-astra", probeErrors: [] });
		expect(report.accounts[0].liveQuota).toMatchObject({ model: "gpt-6-astra", primary: { usedPercent: 11 }, secondary: { usedPercent: 22 } });
	});

	it("refuses an unknown explicit model before probing or reading account state", async () => {
		const deps = createDeps();
		expect(await runForecastCommand(["--live", "--model", "gpt-7-missing"], deps)).toBe(1);
		expect(deps.fetchCodexQuotaSnapshot).not.toHaveBeenCalled();
		expect(deps.loadAccounts).not.toHaveBeenCalled();
		expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining("refusing model substitution"));
	});

	it.each([[], ["--model", "gpt-6-astra"]])("does not cache or report a successful probe of a different model (%j)", async (...modelArgs: string[]) => {
		const deps = createDeps({ fetchCodexQuotaSnapshot: vi.fn(async () => ({ status: 200, model: "gpt-5.5", primary: {}, secondary: {} })) });
		expect(await runForecastCommand(["--live", "--json", ...modelArgs], deps)).toBe(0);
		const report = JSON.parse(vi.mocked(deps.logInfo!).mock.calls[0][0]);
		expect(report.probeErrors[0]).toContain("Probe model mismatch");
		expect(report.accounts[0].liveQuota).toBeUndefined();
		expect(deps.updateQuotaCacheForAccount).not.toHaveBeenCalled();
	});
	it("prints usage for help", async () => {
		const deps = createDeps();
		const result = await runForecastCommand(["--help"], deps);
		expect(result).toBe(0);
		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining("codex-multi-auth forecast"),
		);
		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining(`(default: ${DEFAULT_PROBE_MODEL})`),
		);
	});

	it("rejects invalid options", async () => {
		const deps = createDeps();
		const result = await runForecastCommand(["--bogus"], deps);
		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith("Unknown option: --bogus");
	});

	it("rejects a flag-like value after --model instead of consuming it", async () => {
		// "--model --json" must NOT swallow --json as the model value.
		const deps = createDeps();
		const result = await runForecastCommand(["--model", "--json"], deps);
		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith("Missing value for --model");
	});

	it("rejects an empty flag-like --model= value", async () => {
		const deps = createDeps();
		const result = await runForecastCommand(["--model=--json"], deps);
		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith("Missing value for --model");
	});

	it("rejects a whitespace-only --model value", async () => {
		const deps = createDeps();
		const result = await runForecastCommand(["--model", "   "], deps);
		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith("Missing value for --model");
	});

	it("prints json output for populated storage", async () => {
		const deps = createDeps();
		const result = await runForecastCommand(["--json"], deps);
		expect(result).toBe(0);
		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining('"command": "forecast"'),
		);
	});

	it("threads the requested model's family and normalized id into forecast evaluation", async () => {
		const evaluateForecastAccounts = vi.fn((inputs) => {
			void inputs;
			return [
				{
					index: 0,
					label: "1. forecast@example.com",
					isCurrent: true,
					availability: "ready",
					riskScore: 0,
					riskLevel: "low",
					waitMs: 0,
					reasons: [],
				},
			] as const;
		});
		const deps = createDeps({ evaluateForecastAccounts });

		await expect(
			runForecastCommand(["--json", "--model", "gpt-5.6"], deps),
		).resolves.toBe(0);
		const explicit = evaluateForecastAccounts.mock.calls.at(-1)?.[0] as
			| Array<{ family?: string; model?: string | null }>
			| undefined;
		expect(explicit?.[0]?.family).toBe(getModelProfile("gpt-5.6").promptFamily);
		// The bare alias is driven in deliberately: resolveNormalizedModel maps
		// it to "gpt-5.6-sol", so a raw pass-through would fail here. Rate-limit
		// records are keyed by the model the proxy routes on, not the flag value.
		expect(resolveNormalizedModel("gpt-5.6")).not.toBe("gpt-5.6");
		expect(explicit?.[0]?.model).toBe(resolveNormalizedModel("gpt-5.6"));

		await expect(runForecastCommand(["--json"], deps)).resolves.toBe(0);
		const defaulted = evaluateForecastAccounts.mock.calls.at(-1)?.[0] as
			| Array<{ family?: string; model?: string | null }>
			| undefined;
		// Bare forecasts inspect the same bucket as default Astra requests.
		expect(getModelProfile(DEFAULT_PROBE_MODEL).promptFamily).not.toBe("codex");
		expect(defaulted?.[0]?.family).toBe(getModelProfile(DEFAULT_PROBE_MODEL).promptFamily);
		expect(defaulted?.[0]?.model).toBe(DEFAULT_PROBE_MODEL);
	});

	it("honors --no-runtime-overlay in json forecast output", async () => {
		const evaluateForecastAccounts = vi.fn((inputs) => {
			const overlay = inputs[0]?.runtimeOverlay as
				| { lastPoolExhaustionSkipReasons?: Record<string, string> }
				| null
				| undefined;
			const reason = overlay?.lastPoolExhaustionSkipReasons?.["0"];
			return [
				{
					index: 0,
					label: "1. forecast@example.com",
					isCurrent: true,
					availability: reason ? "unavailable" : "ready",
					riskScore: reason ? 90 : 0,
					riskLevel: reason ? "high" : "low",
					waitMs: 0,
					reasons: reason ? [`runtime skip: ${reason}`] : [],
					hardFailure: false,
					disabled: false,
				},
			] as const;
		});
		const deps = createDeps({
			evaluateForecastAccounts,
			summarizeForecast: vi.fn((results) => ({
				total: 1,
				ready: results.filter((result) => result.availability === "ready").length,
				delayed: 0,
				unavailable: results.filter(
					(result) => result.availability === "unavailable",
				).length,
				highRisk: results.filter((result) => result.riskLevel === "high").length,
			})),
			loadRuntimeObservabilitySnapshot: vi.fn(async () => ({
				lastPoolExhaustionSkipReasons: { "0": "circuit-open" },
			})),
		});

		await expect(runForecastCommand(["--json"], deps)).resolves.toBe(0);
		await expect(
			runForecastCommand(["--json", "--no-runtime-overlay"], deps),
		).resolves.toBe(0);

		const withOverlay = JSON.parse(
			(deps.logInfo as ReturnType<typeof vi.fn>).mock.calls.at(-2)?.[0] ?? "{}",
		) as {
			runtimeOverlay: boolean;
			accounts: Array<{ availability: string; reasons: string[] }>;
		};
		const withoutOverlay = JSON.parse(
			(deps.logInfo as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] ?? "{}",
		) as {
			runtimeOverlay: boolean;
			accounts: Array<{ availability: string; reasons: string[] }>;
		};
		expect(withOverlay.runtimeOverlay).toBe(true);
		expect(withOverlay.accounts[0]?.availability).toBe("unavailable");
		expect(withOverlay.accounts[0]?.reasons).toContain(
			"runtime skip: circuit-open",
		);
		expect(withoutOverlay.runtimeOverlay).toBe(false);
		expect(withoutOverlay.accounts[0]?.availability).toBe("ready");
		expect(withoutOverlay.accounts[0]?.reasons).toEqual([]);
	});

	it("persists refreshed probe tokens before forecasting live quota", async () => {
		const storage = createStorage();
		const concurrentStorage = createStorage();
		concurrentStorage.accounts[0] = {
			...concurrentStorage.accounts[0],
			currentWorkspaceIndex: 7,
		};
		const callLog: string[] = [];
		let persistedStorage: AccountStorageV3 | null = null;
		let loadCount = 0;
		const deps = createDeps({
			loadAccounts: vi.fn(async () => {
				loadCount += 1;
				return loadCount === 1
					? storage
					: structuredClone(concurrentStorage);
			}),
			saveAccounts: vi.fn(async (nextStorage) => {
				callLog.push(
					`save-${callLog.filter((entry) => entry.startsWith("save-")).length + 1}`,
				);
				if (callLog.length === 1) {
					throw Object.assign(new Error("EBUSY write in progress"), {
						code: "EBUSY",
					});
				}
				persistedStorage = structuredClone(nextStorage);
			}),
			hasUsableAccessToken: vi.fn(() => false),
			queuedRefresh: vi.fn(async () => ({
				type: "success",
				access: "access-forecast-updated",
				refresh: "refresh-forecast-updated",
				expires: 999_999,
				idToken: "id-token-forecast-updated",
			})),
			extractAccountId: vi.fn(() => "account-id-updated"),
			fetchCodexQuotaSnapshot: vi.fn(async (input) => {
				callLog.push("fetch");
				expect(persistedStorage?.accounts[0]?.refreshToken).toBe(
					"refresh-forecast-updated",
				);
				expect(persistedStorage?.accounts[0]?.accessToken).toBe(
					"access-forecast-updated",
				);
				expect(persistedStorage?.accounts[0]?.currentWorkspaceIndex).toBe(7);
				expect(input.accessToken).toBe(
					persistedStorage?.accounts[0]?.accessToken,
				);
				return {
					status: 200,
					model: "gpt-5-codex",
					primary: {},
					secondary: {},
				};
			}),
		});

		const result = await runForecastCommand(["--json", "--live"], deps);

		expect(result).toBe(0);
		expect(callLog).toEqual(["save-1", "save-2", "fetch"]);
		expect(deps.loadAccounts).toHaveBeenCalledTimes(2);
		expect(deps.saveAccounts).toHaveBeenCalledTimes(2);
		expect(deps.saveAccounts).toHaveBeenCalledWith(
			expect.objectContaining({
				accounts: [
					expect.objectContaining({
						refreshToken: "refresh-forecast-updated",
						accessToken: "access-forecast-updated",
						expiresAt: 999_999,
						accountId: "account-id-updated",
						accountIdSource: "token",
						currentWorkspaceIndex: 7,
					}),
				],
			}),
		);
		expect(deps.fetchCodexQuotaSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				accountId: "account-id-updated",
				accessToken: "access-forecast-updated",
			}),
		);
	});

	it("keeps concurrent json runs bound to their own quota formatter", async () => {
		let releaseSlowLoad: (() => void) | undefined;
		const slowLoad = new Promise<void>((resolve) => {
			releaseSlowLoad = resolve;
		});
		const slowDeps = createDeps({
			loadAccounts: vi.fn(async () => {
				await slowLoad;
				return createStorage();
			}),
			formatQuotaSnapshotLine: vi.fn(() => "slow quota"),
			fetchCodexQuotaSnapshot: vi.fn(async () => ({
				status: 200,
				model: DEFAULT_PROBE_MODEL,
				primary: {},
				secondary: {},
			})),
		});
		const fastDeps = createDeps({
			formatQuotaSnapshotLine: vi.fn(() => "fast quota"),
			fetchCodexQuotaSnapshot: vi.fn(async () => ({
				status: 200,
				model: DEFAULT_PROBE_MODEL,
				primary: {},
				secondary: {},
			})),
		});

		const slowRun = runForecastCommand(["--json", "--live"], slowDeps);
		const fastRun = runForecastCommand(["--json", "--live"], fastDeps);
		releaseSlowLoad?.();

		const [slowResult, fastResult] = await Promise.all([slowRun, fastRun]);

		expect(slowResult).toBe(0);
		expect(fastResult).toBe(0);
		expect(slowDeps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining('"summary": "slow quota"'),
		);
		expect(fastDeps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining('"summary": "fast quota"'),
		);
	});

	it("keeps muted separators between styled forecast row segments", async () => {
		const deps = createDeps({
			stylePromptText: vi.fn((text, tone) => `<${tone}>${text}</${tone}>`),
		});

		const result = await runForecastCommand([], deps);

		expect(result).toBe(0);
		expect(deps.logInfo).toHaveBeenCalledWith(
			'<accent>1.</accent> <accent>1. forecast@example.com [current]</accent> <muted>|</muted> <success>ready</success><muted> | </muted><success>low risk (0)</success>',
		);
	});

	it("includes the codex-unavailable note in json probeErrors without leaking raw detail", async () => {
		const deps = createDeps({
			fetchCodexQuotaSnapshot: vi.fn(async () => {
				throw new CodexUnavailableError(
					"The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
				);
			}),
		});

		const result = await runForecastCommand(["--json", "--live"], deps);

		expect(result).toBe(0);
		const jsonLine = (deps.logInfo as ReturnType<typeof vi.fn>).mock.calls
			.map((call) => String(call[0]))
			.find((line) => line.includes('"command": "forecast"'));
		expect(jsonLine).toBeDefined();
		const payload = JSON.parse(jsonLine as string) as { probeErrors?: string[] };
		expect(
			payload.probeErrors?.some(
				(e) =>
					e.includes(CODEX_UNAVAILABLE_PROBE_NOTE) &&
					e.includes("forecast@example.com"),
			),
		).toBe(true);
		expect(jsonLine).not.toContain("is not supported when using Codex");
	});
});
