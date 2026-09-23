# codex-multi-auth reliability runtime patch

Applies a set of reliability changes to an **installed** `codex-multi-auth`
package. It edits the shipped `dist/lib/*.js` and `scripts/codex.js` in place;
it does not build or modify this repository.

## Why a patch and not a branch you install

The targets are build output (`dist/`), which does not exist in a source
checkout. Keeping the changes as a patch lets this repo stay a clean fork of
upstream — so the same fixes can be proposed upstream as ordinary pull requests
against the TypeScript sources — while the patch itself stays byte-identical to
what is running in production.

## What it changes

- **Per-task speed (r23).** Requests keep their selected Standard or Fast tier;
  omitted/null/`auto` means Standard and `fast` normalizes to `priority`.
  The routing hint is rebuilt from that same tier and exact model, then frozen
  across retries and failover. The retired machine file/environment override
  is ignored. Existing explicit `ultrafast` still passes through without changing
  its availability. Pool status `serviceTier` reports the Standard fallback,
  not any active task. Enable Codex's `features.fast_mode` independently from
  the user's default speed; configuration sync must preserve that preference.

- **Astra-aware quota diagnostics.** `gpt-6-astra` stays exact and probes use
  `low`, matching the [official reasoning range](https://developers.openai.com/api/docs/models/gpt-6-astra).
  An explicit forecast model disables fallback; unknown models or a mismatched
  probe response are rejected. JSON includes `requestedModel`, `probeModel`,
  and the actual per-account `liveQuota.model`, `primary`, and `secondary`
  windows so a UI never has to race against the shared quota cache. The default
  request model and the default generic probe model remain unchanged.

- **Client identity preserved.** The proxy no longer overwrites `originator`
  and `OpenAI-Beta` with the legacy `codex_cli_rs` / `responses=experimental`
  pair. Entitlement for newer model tiers is keyed to the client identity that
  made the request, so the rewrite made requests fail entitlement checks for
  models the account genuinely supports.
- **Exact model, never substituted.** An account that rejects the exact
  requested model is rotated away from; the model itself is never rewritten,
  and the wrapper's built-in fallback table is emptied.
- **Bounded hidden retries and failover.** Short `429`s, transport errors and
  retryable `5xx` get bounded same-account retries with backoff before the pool
  is spent, followed by whole-pool waits, all under a per-request deadline that
  stops immediately on client disconnect. Confirmed quota or billing
  exhaustion rotates without spending retries.
- **No leaked terminal 429.** A spent pool answers a retryable `503` carrying
  `Retry-After`, instead of a raw `429` that stops the Codex session.
- **Versioned affinity tombstones.** `forgetSession` participates in the same
  write-version protocol as `remember`, so a slower in-flight request cannot
  resurrect affinity to an account the router already abandoned.
- **Advisory quota deferrals bounded.** A near-exhaustion signal derived from
  quota headers is a routing preference, not an observed `429`: it is trusted
  for one deferral horizon measured from the snapshot that produced it, and is
  never persisted as a durable rate limit. A window proven exhausted (100% used
  with a known future reset) still keeps its full wait.
- **Mandatory account router.** If the runtime rotation proxy cannot start, the
  wrapper fails closed instead of silently continuing on a single account.
- **Local `/models`.** Model discovery is answered locally with an empty
  catalog, so official Codex keeps its bundled definitions without spending
  quota or selecting an account on a diagnostic poll.
- **Canonical session index for `exec`.** Non-interactive runs reuse the
  canonical Codex index instead of a fresh shadow home that forces a full
  transcript reindex before every prompt, and the redundant post-run repair
  scan is removed.
- **Pool status.** Adds authenticated, loopback-only
  `GET /managed/pool-status?model=<exact-model>` returning aggregate readiness
  counts. It never selects an account, attaches OAuth, contacts upstream, or
  mutates router state, and exposes no account identity.

## Exact-model quota limits (r22)

The source `AccountManager` and `payloads/codex-quota-scope.cjs` persist a limit
observed for a named model only under that exact model. Sol and Astra share the
`gpt-5.2` prompt family, but that is not evidence of a shared quota bucket. A Sol
429 must keep its full deadline without excluding an otherwise usable Astra
account. Explicit model-less limits retain their family-wide scope. The source
regression checks real account-manager selection and save/reload behavior for
quota, unknown, token, and concurrency reasons.

The patch deliberately preserves existing family-wide records. For a legacy
record contradicted by a **fresh successful exact-model live probe**, stop the
singleton, back up the machine-local account store with owner-only permissions,
remove only that verified stale record by account identity, and restart. Do not
clear other accounts, copy credentials between machines, or infer recovery from
an old cache entry. A successful normal Codex request is the recovery check.

The managed dotfiles installer vendors this payload into a new immutable runtime
before publication. Updating the pointer does not restart existing services.

## Requirements

The patch matches exact compiled layouts, so it is pinned:

```
codex-multi-auth@2.9.1
```

It refuses to run against any other version rather than patching on a
best-effort basis.

## Use

```bash
npm install -g --ignore-scripts codex-multi-auth@2.9.1
node tools/runtime-patch/apply.cjs
node tools/runtime-patch/apply.cjs --check   # verify, change nothing
```

Re-running is safe: every change carries a marker comment and is skipped if
already present.

An npm update will silently restore the unpatched package. To update
deliberately, install the new pinned version and re-run this patch.

## Safety properties

- **Fail-closed.** Any unexpected layout aborts before a single write. A
  partially recognised layout is treated as unsupported, never patched "as far
  as it goes".
- **Staged writes.** Generated files are syntax-checked in a temporary file and
  swapped in atomically; the session-affinity store is committed before the
  proxy, so an interruption can never leave new proxy calls against an old
  store.
- **Post-checked.** Every touched file is `node --check`ed, and the patch runs
  its own verification payloads before reporting success.
- **Idempotent.** Marker comments make re-application a no-op.

## Layout

- `apply.cjs` — resolves the installed package, enforces the version pin, runs
  the payloads, validates the result.
- `payloads/codex-runtime.cjs` — runtime proxy and session-affinity patch.
- `payloads/codex-wrapper.cjs` — `scripts/codex.js` patch.
- `payloads/codex-model-catalog.cjs` — staged Astra/forecast backport for 2.9.1;
  accepts an absolute package root and optional `--check`. Managed installers
  apply this to a new immutable release before publishing its pointer.
- `payloads/codex-quota-scope.cjs` — exact-model persisted quota limits, applied
  and verified by `apply.cjs`; also accepts an absolute staged package root.
- `payloads/check-*.cjs` — the verification payloads `--check` runs. Validation
  deliberately reuses these rather than a re-stated list of markers, because a
  hand-maintained copy drifts from what the patch actually writes.

## Live credential convergence (r24)

A resident router used to preserve a newer external OAuth rotation only in its
saved snapshot. Its live AccountManager continued to send the old access token,
producing repeating authentication cooldowns and pool 503s even with available
quota. After a successful routine persistence, the same live account objects now
adopt strictly newer persisted token material, matched by account identity.
The post-write expiry check protects newer concurrent refreshes. Failed writes
do not publish a new in-memory credential state.

This does not reload the pool or reset quota, pause, pin, cooldown, invalidation,
or request model/tier, except that since r28 a replaced credential's
invalidation and auth-failure cooldown go with it (below). An existing auth
cooldown expires normally (usually 30s). Explicit revocation still requires the
existing recovery/login path. This closes the stale-memory failure; it cannot
prevent real upstream outages or spent quota.

`payloads/codex-auth-convergence.cjs` ports the source fix to pinned npm 2.9.1.
Its byte-identical dotfiles copy is `.bin/lib/codex-auth-convergence.cjs`.
Source regressions live in `test/rotation-token-refresh.test.ts`; the offline
installed-package regression is `.bin/tests/test-codex-auth-convergence.sh` in
dotfiles. It runs an actual 401, external credential write, routine save, and a
successful second Astra/Fast request through the same running proxy.

### r28: a re-login releases the replaced credential's invalidation

On 2026-09-23 every request through a resident router got a 503 although the
invalidated account had signed in again the day before. Routine saves adopted
the new credential (r24) but wrote the old credential's explicit invalidation
back over the login, and the live account stayed skipped as `token-invalid`.

An explicit invalidation and an auth-failure cooldown belong to the credential
that earned them. When reconciliation takes a different refresh token with a
later expiry from disk, and that disk record is not itself invalidated, the
snapshot drops the invalidation, its error code and an `auth-failure` cooldown
before it is persisted. After the write succeeds, the live account drops the
same state and its consecutive auth-failure count. Refresh persistence
(`commitRefreshedAuth`) now reconciles the other accounts the same way, so a
refresh of one account can no longer revert a login written for another.

Kept: an invalidation of the same refresh token (even with a newer expiry), a
disk record that is itself invalidated, rate-limit/server/network cooldowns,
quota windows, disabled accounts, policy pauses and drains, pins and session
affinity. A marker already written back for the current refresh token looks
exactly like a real invalidation, so r28 keeps it; a new login (a new refresh
token) or the manual repair clears it.

The release happens when the resident manager saves, and a managed machine
router whose whole pool is unavailable makes no saves: its no-account branch
never reaches upstream's stale-state reload, so a re-login during a full outage
would wait for a restart. `AccountManager.adoptReplacementCredentials()` covers
that case. When an account is blocked for auth reasons (an explicit
invalidation or an active `auth-failure` cooldown) and the store holds its
replacement under the rule above, it runs the same reconciling save and
returns the released account indexes; otherwise it writes nothing. The runtime
proxy payload calls it in the managed no-account branch before the pool wait
or the 503: once per request, only while a candidate is skipped as
`token-invalid` or `cooling-down:auth-failure`, and at most once a second per
router, with concurrent requests sharing one pass. A released account is
selectable again in the same request. `payloads/check-proxy.cjs` requires that
call exactly once, first in that branch.

Both login writes clear the marker on disk: the CLI login
(`lib/codex-manager/account-pool-write.ts`) always did, and the plugin host
(`lib/runtime/account-pool.ts`) now does as well. The managed routers and the
CLI never load the plugin host, so the runtime payloads leave that file alone.

The payload upgrades an r24-patched `accounts.js` in place, byte-identical to
patching the unpatched file, and `--check` rejects an r24 file with an explicit
upgrade message. Any other layout is refused before a write. Required as a
module, it exports `render(source, layout)` (`base`, `r24`, `r28`) so tests can
derive each layout from a staged copy. The proxy adoption lives in
`payloads/codex-runtime.cjs` behind its own marker, so re-running the patch on
an older patched proxy adds only that block.


### r25: opt-in subscription final-week preference

The staged patch installs `subscription-priority.mjs` and hooks account selection.
Both routers read the same machine-local Router Limits `subscriptions.json` on
selection. Enable it with `"routingPolicy": { "mode": "final-week" }` at the top
level. Only manual `kind: "ends"` dates qualify; renewal/period-end dates do not.
Missing or malformed data leaves ordinary routing available.

Among eligible accounts, prefer the nearest cancellation date in the last weekly
window, falling back to seven calendar days when the reset is unknown. Date-only
billing evidence never hard-expires an account. Exact-model limits, disablement,
manual pins and retry exclusions remain authoritative. Operator numeric priority
in TeamClaude still wins. Existing sessions can move on their next request;
equal end dates preserve affinity. No request body, tier or retry code changes.
Codex weekly reset evidence must match the exact model and be at most 15 minutes
old; the preference never treats cached quota percentages as admission evidence.

The common behavioral test accepts two staged, patched package directories:
`node tools/runtime-patch/verify-subscription-priority.mjs /path/to/codex-multi-auth /path/to/teamclaude`.
Dotfiles `.bin/tests/test-subscription-priority.sh` stages read-only installed
fixtures, checks idempotency, and runs it with a private empty home.
