# Usage collector

Python 3.12 stdlib service for CLIProxyAPI 8.0.67. All tests use synthetic records and local fixture databases. No endpoint is contacted by importing the modules, building prices or running tests.

## Install on Ubuntu

Run these commands from this directory on the installation host. Starting the unit begins destructive queue reads. The existing management key stays in its credential source file.

```sh
python3 -I test_usage_collector.py
sudo -u ubuntu test -r /var/lib/intent-lb/codex/store.db
sudo test -s /var/lib/cliproxy/secrets/management-key
sudo install -d -m 0755 /opt/intent-usage-collector
sudo install -m 0644 usage_collector.py prices.json /opt/intent-usage-collector/
sudo install -m 0644 intent-usage-collector.service /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/intent-usage-collector.service
sudo systemctl daemon-reload
sudo systemctl enable --now intent-usage-collector.service
sudo systemctl status --no-pager intent-usage-collector.service
```

State lives in `/var/lib/intent-usage/usage.db`, with WAL and SHM sidecars. The service binds only `127.0.0.1:8337`. Use the gateway's authenticated management api-call proxy for the GET routes below. Any Origin header, a non-loopback Host or peer, duplicate Host headers and request bodies are rejected. There is no separate service credential on this loopback interface. Other local processes can read it.

For updated prices, download the source yourself, then regenerate the snapshot without contacting any endpoint from the builder.

```sh
python3 -I build_prices.py --input /tmp/litellm/prices.json --fetched-at 2026-11-14
```

The snapshot contains 227 first-party Anthropic, OpenAI, xAI and Gemini models with published input and output rates. Chat-capable Responses models, including Codex, are included. Costs are list-price estimates fixed at ingest. Reasoning is included in output. Unpriced requests have `cost_usd: null` individually and contribute zero to aggregate cost, with `unpriced_requests` tracking the missing prices. Replacing prices does not recalculate existing history.

## HTTP contract

GET only. JSON responses, epoch millisecond times, inclusive `from`, exclusive `to`. Missing ranges default to the last 24 hours. Single exact-match `provider`, `model`, `account` and `key` filters apply throughout a response. `account` is the gateway auth_index and `key` is the 16-character SHA-256 handle. An empty key handle and mask mean the client key is unknown.

Each file below is a complete, valid response from the synthetic fixture, including every field. They are examples of the API output, not JSON Schema documents.

- [`GET /v1/health`](examples/health.json) returns process health, last successful drain, all-time inserted count including backfill, raw coverage, first queue boundary, process start, storage usage and price provenance. `ok` means the local database is readable; check `last_drain_at` for collection freshness. It is null until the first successful drain, including an empty drain. `db_bytes` includes WAL and SHM.
- [`GET /v1/summary?from=1794614400000&to=1794618000000&bucket=hour&tz=UTC`](examples/summary.json) returns totals, filled series, arrays grouped by model/account/key/provider, coverage and price provenance. Every group includes the totals fields. Series `by_provider` is an object keyed by provider name; its `tokens` includes uncached input, cache reads/writes and output, with reasoning already inside output.
- [`GET /v1/requests?from=1794614400000&to=1794618000000&limit=50`](examples/requests.json) returns newest timestamp first, with id as the tie breaker. Pass `next_before` back as `before` to get the next page. The cursor is an existing raw row id and expires with retention. Default limit is 50, capped at 200. `status=ok|failed` and literal substring `q` are optional. Search covers model, account label, masked key, request id and stored error. Errors here are limited to 200 characters. `next_before` is null at the end.
- [`GET /v1/requests/1`](examples/request-detail.json) returns one item directly, including request_id, user_agent, priced and the full stored error, limited to 2000 characters. Missing or pruned rows return 404.

Errors use `{"error":"forbidden"}` (403), `{"error":"invalid parameters"}` (400), `{"error":"not found"}` (404), `{"error":"method not allowed"}` (405, Allow GET), or `{"error":"database unavailable"}` (503, Retry-After 5). HTTP parsing errors use `{"error":"invalid request"}` with their HTTP status.

## Accuracy and failure behavior

Hourly rollups are permanent. A summary includes UTC hours whose start is in `[from,to)`. Align boundaries to full UTC hours for exact totals. Partial hours cannot be split once raw records expire. Day buckets use the supplied IANA timezone and calendar midnight, including 23/25-hour DST days. Zones with a midnight that falls inside a UTC hour assign that entire hour to the local date at the hour's start. This can move up to one hour of usage across a local day boundary. Exact sub-hour local-day splits would require finer rollups.

Histograms use 16 fixed logarithmic bins with upper edges from 100 ms to 600,000 ms and a final overflow bin. Both latency and TTFT percentiles are bucket estimates. Values below 100 ms report 100 ms; overflow reports 600,000 ms. Raw latencies remain available for 90 days. Hour summaries allow up to 366 days, day summaries up to ten years, and grouping is limited to 10,000 combined dictionary groups to bound memory. Narrow the filters if a request exceeds these bounds. SQLite reads have a four-second statement deadline and a half-second lock wait.

The first nonempty queue batch stores its earliest timestamp at nanosecond precision as an immutable backfill boundary. `first_record_at` reports that boundary in milliseconds even after backfill imports earlier history. `oldest_raw_at` can therefore be earlier. Backfill scans matching `cliproxy-%` rows in id order, 500 per drain cycle, saving the cursor in the same transaction as inserts and rollups. Rows at or after the boundary are skipped permanently. Older rows inserted later are imported if their id exceeds the cursor. Existing upstream rows are assumed immutable.

Route snapshots persist only auth indexes, resolved labels and upstream database key ids. Prefix ambiguity leaves the label unresolved. A failed route refresh pauses that cycle before popping queue data, then retries after five seconds. Labels describe the route's latest observed upstream account at refresh time; the gateway record does not identify the exact account codex-lb chose for that request. Backfill uses the historical log's account email, maps to the gateway auth_index when exactly one route matches, and otherwise uses `codex-lb:<account-id>`. Its client-key identity stays empty because upstream logs cannot identify the gateway client key. An empty `via` means a direct gateway route.

The upstream database is opened with `mode=ro` and `query_only`, using one persistent autocommit connection and named columns. The unit mounts its directory read-only. Schema assumptions are exercised against the fixture; the actual 9 GB database was not inspected.

A received batch remains in memory and blocks further queue pops until committed. Invalid records also hold that batch for retry rather than silently discarding it. A process crash, oversized/malformed queue response or connection loss between the destructive HTTP pop and the local commit can lose that batch. The upstream API has no acknowledgement protocol to close this gap. SIGTERM retries a pending batch until successful or systemd's stop timeout. The service logs only fixed messages and exception class names.

Authentication failures wait 60 seconds and share one counter between both management endpoints. After four consecutive failures, further attempts stop before the fifth failure can ban localhost. Replace the source management key and restart the unit to reload systemd's credential copy. Other failures retry after five seconds.

Daily retention removes raw rows older than 90 days. Size pressure removes whole oldest UTC raw days earlier. The cap includes the database and sidecars, uses decimal 1 GB / 700 MB limits, and reserves another 32 MB before any queue pop or backfill batch. Incremental vacuum and WAL checkpoints reclaim space without a second database file. Rollups and dictionaries remain. If those alone consume the budget, or another process consumes the remaining disk space, collection pauses; indefinite rollups and a hard size cap cannot both be guaranteed for unlimited unique dimensions. There is no guarantee against other processes filling the disk during a pop.

Raw client keys and access-token hashes are never bound to SQLite. All retained queue text fields redact those values and the management credential before truncation. Response headers, client IPs and forwarded IPs are discarded. Synthetic tests inspect database and WAL bytes and every response type for credential leakage.

## Verification

Run `python3.12 -I test_usage_collector.py`. Tests cover token normalization, prices/context tiers, route mapping, read-only upstream access, nanosecond backfill exclusion, transactional rollback/cursors, rollups, filters, DST, pagination, actual file-size reclamation, retention, disk headroom, secret redaction, HTTP guards, connection limits and header/auth deadlines. HTTP is exercised in memory and gateway transport is mocked. Ubuntu/systemd behavior, production schema access and live gateway payloads require installation-time validation. No service was installed, no SSH was used and no live endpoint was called during implementation.
