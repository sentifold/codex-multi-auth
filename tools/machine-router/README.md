# Machine-wide Codex account router

Runs the patched runtime rotation proxy as **one long-lived process per Mac**,
bound to `127.0.0.1:17892`, instead of letting every `codex` invocation start
its own short-lived proxy.

## Why one process

The per-invocation proxy is fine for a single interactive session. It stops
being fine the moment several agents run at once — which is the normal case
when an orchestrator launches parallel workers.

Each proxy keeps its own view of cooldowns, rate-limit windows, account leases
and session affinity, and none of them can see the others. So they select the
same "best" account simultaneously, discover its 429 independently, and each
pay the same rotation cost. The account pool is a shared resource being
scheduled by processes that cannot coordinate.

The singleton makes that state machine-wide: cooldowns, request budgets and
account leases are owned once. Sessions also keep a stable provider URL, so a
router replacement is a service operation rather than something that strands
open sessions on a dead port.

## Requirements

- `codex-multi-auth@2.9.1` installed globally **and patched** with
  `tools/runtime-patch/apply.cjs`. The daemon imports
  `dist/lib/runtime-rotation-proxy.js` from that install and requires the
  `managedMachineRouter` option the patch adds; an unpatched package will not
  start.
- Node 20+ (the version that runs the installed package is fine).

## Setup

1. Point `AGENT_CODEX_ROUTER_MODULE_PATH` at the patched proxy module:

   ```bash
   echo "$(npm root -g)/codex-multi-auth/dist/lib/runtime-rotation-proxy.js"
   ```

2. Copy `com.example.codex-account-router.plist` into
   `~/Library/LaunchAgents/`, rename the label to something you own, and fix
   the two paths in it (the daemon script and the module path above).

3. Load it:

   ```bash
   launchctl bootstrap gui/$UID ~/Library/LaunchAgents/<your-label>.plist
   launchctl print gui/$UID/<your-label> | head
   ```

4. Confirm the listener and the client key:

   ```bash
   nc -z 127.0.0.1 17892 && echo "router up"
   ls -l ~/.codex/multi-auth/machine-router-client-key   # must be 0600
   ```

The daemon creates that client key on first start if it is absent, and refuses
to run if it is not an owner-only regular file. Every client — including the
`codex` wrapper — must present it, so the loopback listener is not open to any
local process that happens to find the port.

## Pointing `codex` at it

The patched wrapper reads two variables and, when they are set, uses the
existing router instead of starting its own:

```bash
export CODEX_MULTI_AUTH_SHARED_PROXY_URL="http://127.0.0.1:17892"
export CODEX_MULTI_AUTH_SHARED_PROXY_CLIENT_KEY="$(cat ~/.codex/multi-auth/machine-router-client-key)"
```

The URL must be loopback; anything else is refused. If either variable is set
and the pair is invalid, the wrapper fails closed rather than silently falling
back to a private proxy.

## Optional: service tier

`~/.config/agent-router/codex-service-tier` selects the wire service tier for
the whole machine. It must be an owner-only (`0600`) regular file containing
exactly `default`, `fast`, or `ultrafast`. An absent file means `default`. The
path is deliberately not overridable by an environment variable: an
env-selectable path let a preflight validate one file while the daemon read
another, which crash-looped the service with no listener on the port.

## Optional: advisory quota horizon

`CODEX_AUTH_PREEMPTIVE_QUOTA_MAX_DEFERRAL_MS` bounds how long a *derived*
quota signal may bench an account before it is re-probed. The sample plist sets
`900000` (15 minutes) against the package default of two hours. A genuine 429
is never shortened by this value — it only limits how long an unproven
near-exhaustion signal is trusted.

## Replacing the router

Moving the installed package or re-running the patch does not restart a
resident process. Replace it deliberately, between active turns:

```bash
launchctl kickstart -k gui/$UID/<your-label>
```

Open sessions keep a valid provider URL and pick up the replacement on their
next request. An in-flight stream may fail during replacement, which is why
this is a scheduled operation rather than something to do mid-turn.
