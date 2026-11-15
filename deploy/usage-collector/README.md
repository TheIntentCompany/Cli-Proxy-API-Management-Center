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
sudo install -d -m 0755 /opt/intent-seat-pacer-export
sudo install -m 0644 ../seat-pacer-export/seat_pacer_export.py /opt/intent-seat-pacer-export/
sudo install -m 0644 intent-usage-collector.service /etc/systemd/system/
sudo install -m 0644 ../seat-pacer-export/intent-seat-pacer-export.service ../seat-pacer-export/intent-seat-pacer-export.timer /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/intent-usage-collector.service /etc/systemd/system/intent-seat-pacer-export.service /etc/systemd/system/intent-seat-pacer-export.timer
sudo systemctl daemon-reload
sudo systemctl enable --now intent-seat-pacer-export.timer
sudo systemctl start intent-seat-pacer-export.service
sudo systemctl show intent-seat-pacer-export.service -p Result -p ExecMainStatus
sudo -u ubuntu test -r /var/lib/intent-seat-pacer/history.json
sudo systemctl enable intent-usage-collector.service
sudo systemctl restart intent-usage-collector.service
sudo systemctl status --no-pager intent-usage-collector.service intent-seat-pacer-export.timer
```

State lives in `/var/lib/intent-usage/usage.db`, with WAL and SHM sidecars. The service binds only `127.0.0.1:8337`. Use the gateway's authenticated management api-call proxy for the GET routes below. Any Origin header, a non-loopback Host or peer, duplicate Host headers and request bodies are rejected. There is no separate service credential on this loopback interface. Other local processes can read it.

For updated prices, download the source yourself, then regenerate the snapshot without contacting any endpoint from the builder.

```sh
python3 -I build_prices.py --input /tmp/litellm/prices.json --fetched-at 2026-11-14
```

The snapshot contains 227 first-party Anthropic, OpenAI, xAI and Gemini models with published input and output rates. Chat-capable Responses models, including Codex, are included. Costs are list-price estimates fixed at ingest. Reasoning is included in output. Unpriced requests have `cost_usd: null` individually and contribute zero to aggregate cost, with `unpriced_requests` tracking the missing prices. Replacing prices does not recalculate existing history.

## HTTP contract

GET only. JSON responses use epoch millisecond times. Usage routes have inclusive `from`, exclusive `to`, and missing ranges default to the last 24 hours. Single exact-match `provider`, `model`, `account` and `key` filters apply throughout usage responses. `account` is the gateway auth_index and `key` is the 16-character SHA-256 client-key handle. An empty key handle and mask mean the client key is unknown. Pool ranges and account keys follow the separate contract below.

Each file below is a complete, valid response from the synthetic fixture, including every field. They are examples of the API output, not JSON Schema documents.

- [`GET /v1/health`](examples/health.json) returns process health, last successful drain, all-time inserted count including backfill, raw coverage, first queue boundary, process start, storage usage and price provenance. `ok` means the local database is readable; check `last_drain_at` for collection freshness. It is null until the first successful drain, including an empty drain. `db_bytes` includes WAL and SHM.
- [`GET /v1/pool?from=1794614400000&to=1794614460000`](examples/pool.json) returns account quota snapshots and step-line history. Without either range parameter it omits `history` and never queries samples. Pool ranges include both endpoints and the last sample before `from` for each account/window. A missing `from` defaults to 90 days ago; a missing `to` defaults to now. Times are epoch milliseconds, including window resets, bank expiry and lock boundaries. `stale` means quota observation is absent or older than 15 minutes. Bank observations age independently. `error` is a fixed category or null. Health adds `last_quota_poll_at` (last completed polling tick that attempted a source) and cumulative `quota_errors` counts for `seat-pacer`, `gateway` and `codex-lb`; these survive restarts. A successful tick can contain source failures, so check account staleness and errors too.
- [`GET /v1/summary?from=1794614400000&to=1794618000000&bucket=hour&tz=UTC`](examples/summary.json) returns totals, filled series, arrays grouped by model/account/key/provider, coverage and price provenance. Every group includes the totals fields. Series `by_provider` is an object keyed by provider name; its `tokens` includes uncached input, cache reads/writes and output, with reasoning already inside output.
- [`GET /v1/requests?from=1794614400000&to=1794618000000&limit=50`](examples/requests.json) returns newest timestamp first, with id as the tie breaker. Pass `next_before` back as `before` to get the next page. The cursor is an existing raw row id and expires with retention. Default limit is 50, capped at 200. `status=ok|failed` and literal substring `q` are optional. Search covers model, account label, masked key, request id and stored error. Errors here are limited to 200 characters. `next_before` is null at the end.
- [`GET /v1/requests/1`](examples/request-detail.json) returns one item directly, including request_id, user_agent, priced and the full stored error, limited to 2000 characters. Missing or pruned rows return 404.

Errors use `{"error":"forbidden"}` (403), `{"error":"invalid parameters"}` (400), `{"error":"not found"}` (404), `{"error":"method not allowed"}` (405, Allow GET), or `{"error":"database unavailable"}` (503, Retry-After 5). HTTP parsing errors use `{"error":"invalid request"}` with their HTTP status.

## Accuracy and failure behavior

Quota polling has its own thread and SQLite writer connection. Network and file reads never hold the queue worker's lock or a write transaction. Import transactions contain at most 100 history samples; latest snapshots contain only allowlisted metadata and normalized windows. SQLite still serializes brief commits. A busy quota writer fails immediately and backs off. Imports and quota writes stop at the existing disk reserve. Existing databases gain additive tables on startup.

The collector reads the exported Seat Pacer file every two minutes. Original readings supply observation times, 0..1 utilization becomes percent without capping at 100, the year-one reset sentinel becomes null, and unfinished future locks supply `limited_until`. Cycle samples are imported within 90 days on first read, using persistent account/window cursors to import only newer samples afterward. A stale reading or missing file triggers a gateway-substituted Claude usage read at most every five minutes per account. Fresh gateway fallback readings do not suppress subsequent fallback reads while Seat Pacer stays stale.

Gateway auth files refresh every 15 minutes and identify enabled Claude/Codex accounts. Codex usage refreshes every four minutes; five-hour, weekly and monthly windows are mapped by duration within 20 percent. Only object-valued `id_token` claims are used for account id and plan; JWT strings are ignored. No auth file is opened, OAuth token requested or JWT decoded. All upstream reads go through management `api-call` using the literal `$TOKEN$` placeholder. The management credential is used only for loopback transport and redaction. Direct routes use `via: "gateway"`; pool keys are stable hashed account handles, unrelated to client API keys.

The read-only codex-lb status service on `127.0.0.1:8335` refreshes every two minutes. Accounts repeated under multiple keys appear once. Status-service generation time never refreshes quota observations; each window keeps its original sample time. Windows marked stale by that service are omitted. Banked resets refresh every 30 minutes per gateway account, filtering expired Claude grants and counting available, unexpired Codex credits. codex-lb supplies its cached count and observation time, with unknown expiry reported as null. The collector does not redeem resets. Removed/disabled Codex routes leave latest state after discovery but keep their history.

Failures back off independently by account and operation, starting at five minutes and doubling to one hour. Shared file/discovery/status reads also back off. Success resets that operation's backoff and clears its error; a successful bank read preserves a quota-read error. Global source failures appear on affected accounts. Backoff timers are process-local and restart with the service. History records usage/reset changes or a 30-minute heartbeat when the source observation advances. Retention removes quota samples after 90 days and can trim older history sooner under the shared size cap. Import cursors remain after pruning so old exported samples cannot refill deleted history.

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

Quota fixtures cover Seat Pacer locks, Fable, reset sentinels, import cursors and restarts, Codex duration mapping, codex-lb source timestamps, fallback scheduling, account/source backoff, bank expiry, sample deduplication/heartbeat, inclusive pool history with predecessors, no-history query cost, retention, disk gates, token/key redaction, queue progress during a slow quota call, shared management authentication limits and shutdown. Export tests mock ownership changes and verify atomic replacement, file/directory modes and preservation of the old copy after a failed export. Actual root:ubuntu ownership and systemd sandbox enforcement need Ubuntu validation.

Run `python3.12 -I test_usage_collector.py`. Tests cover token normalization, prices/context tiers, route mapping, read-only upstream access, nanosecond backfill exclusion, transactional rollback/cursors, rollups, filters, DST, pagination, actual file-size reclamation, retention, disk headroom, secret redaction, HTTP guards, connection limits and header/auth deadlines. HTTP is exercised in memory and gateway transport is mocked. Ubuntu/systemd behavior, production schema access and live gateway payloads require installation-time validation. No service was installed, no SSH was used and no live endpoint was called during implementation.
