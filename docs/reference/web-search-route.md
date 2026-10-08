# Standalone web search through runtime rotation

The runtime proxy accepts POST `/alpha/search`, plus `/codex/alpha/search`, `/v1/alpha/search` and `/v1/codex/alpha/search`. Codex's standalone `web.run` tool calls this endpoint on the provider base URL. Codex 0.154 and later offers that tool instead of the hosted `web_search` Responses tool for Responses Lite models (the gpt-6.x and gpt-5.6 models in its catalog) and when `features.standalone_web_search` is enabled.

Search requests use the existing local bearer authentication, runtime policy, managed account selection, OAuth refresh and removal of local credentials. Bodies are forwarded unchanged to `/codex/alpha/search` under the configured upstream base (normally `https://chatgpt.com/backend-api`).

## Account selection and failures

- **Session affinity.** Codex sends no session header with a search. The body `id` is the Codex session id, which Codex also sends as the Responses `prompt_cache_key`, so the proxy uses it as the affinity key. A conversation's searches, and later `open`, `click` and `find` calls by `ref_id`, stay on the account that serves the conversation.
- **Rate limits.** Search uses the rate-limit family of the model named in the body, which is the conversation model. An explicit 429 rotates to another account and also cools that model's family on the account, as a Responses 429 does. This assumes the endpoint draws on the same Codex usage limit as the conversation. Image routes use a separate `codex` bucket instead.
- **5xx and transport failures** rotate the same way as Responses. A search has no side effects, so repeating it on another account is safe.
- **402 and 403** are passed through to Codex unchanged and do not disable the account or its workspace. A search refusal can be feature-level, for example a workspace with web search turned off, and still match the workspace-deactivation wording. A deactivated account is still detected on the conversation's next Responses request.
- **`api/` and `zdr/` models** are refused with `400 api_route_requires_responses` before any account is chosen, so a search from an API- or ZDR-routed session never goes out with ChatGPT OAuth credentials.
- **`speed/<tier>/<model>` slugs** are not rewritten for search. The proxy never advertises such slugs, so this only matters for a hand-typed model.

## Usage

The usage ledger records operation `search` with outcome, model and redacted account identity through the existing recorder. Search queries and results are not stored.

## Migration and rollback

No account migration, reauthentication or new configuration is required. Reverting the route change restores the previous route allowlist without changing account storage. Ledger rows with operation `search` read back as `unknown` on versions that do not know it. A running app router keeps its route table until it restarts, for example with `codex-multi-auth rotation reset-runtime`.
