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
