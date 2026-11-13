#!/usr/bin/python3 -I
"""Read-only status of the codex-lb accounts that CLIProxyAPI reaches.

CLIProxyAPI forwards some Codex traffic to codex-lb through an API key whose name
starts with KEY_NAME_PREFIX. Those upstream accounts are not CLIProxyAPI auth files,
so the management panel cannot see them. This service answers one question for the
panel: for each such key, which accounts does it reach, and what are their status,
plan and latest usage windows?

Constraints this file keeps:
- It never writes. The database is opened with SQLite's read-only URI mode and
  `PRAGMA query_only`, and the systemd unit mounts the data directory read-only.
- It reads named columns only. Token columns of `accounts` and the key hash of
  `api_keys` are never selected.
- It listens on loopback only and refuses non-loopback peers.
- Answers are cached for CACHE_SECONDS so panel polling cannot load the database.

The panel reaches it through CLIProxyAPI's management `api-call` endpoint, which is
itself protected by the management key.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import sqlite3
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DB_PATH = "/var/lib/intent-lb/codex/store.db"
LISTEN = ("127.0.0.1", 8335)
ROUTE = "/v1/accounts"
KEY_NAME_PREFIX = "cliproxy-"
CACHE_SECONDS = 15
BUSY_TIMEOUT_MS = 2000

# Windows are named "primary" and "secondary" in codex-lb; their length decides
# whether they are the 5-hour or the weekly limit. Length 0 means "not on this plan".
FIVE_HOUR_MAX_MINUTES = 5 * 60
WEEKLY_MAX_MINUTES = 7 * 24 * 60

KEYS_SQL = """
SELECT id, name, key_prefix, is_active, account_assignment_scope_enabled
FROM api_keys
WHERE substr(name, 1, ?) = ?
ORDER BY name
"""

ACCOUNTS_SQL = """
SELECT a.id, a.email, a.alias, a.plan_type, a.status, a.deactivation_reason, a.reset_at
FROM api_key_accounts AS ka
JOIN accounts AS a ON a.id = ka.account_id
WHERE ka.api_key_id = ?
ORDER BY a.email
"""

# Served by idx_usage_window_raw_account_time_covering: one index probe per window.
LATEST_WINDOW_SQL = """
SELECT used_percent, reset_at, window_minutes, recorded_at
FROM usage_history
WHERE account_id = ? AND "window" = ?
ORDER BY recorded_at DESC
LIMIT 1
"""


def _iso(value):
    """codex-lb stores naive UTC timestamps as text; return ISO 8601 with Z, or None."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _epoch(value):
    """Reset instants are epoch seconds in codex-lb; keep positive numbers only."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return int(number) if number > 0 else None


def _window(row):
    if row is None:
        return None
    used, reset_at, minutes, recorded_at = row
    try:
        minutes = int(minutes or 0)
    except (TypeError, ValueError):
        minutes = 0
    if minutes <= 0:
        return None
    if minutes <= FIVE_HOUR_MAX_MINUTES:
        kind = "five_hour"
    elif minutes <= WEEKLY_MAX_MINUTES:
        kind = "weekly"
    else:
        kind = "other"
    try:
        used = max(0.0, min(100.0, float(used)))
    except (TypeError, ValueError):
        used = None
    return {
        "kind": kind,
        "used_percent": used,
        "reset_at": _epoch(reset_at),
        "window_minutes": minutes,
        "recorded_at": _iso(recorded_at),
    }


def read_status():
    uri = f"file:{DB_PATH}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=BUSY_TIMEOUT_MS / 1000, isolation_level=None)
    try:
        conn.execute("PRAGMA query_only = ON")
        conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
        keys = []
        for key_id, name, prefix, active, scoped in conn.execute(
            KEYS_SQL, (len(KEY_NAME_PREFIX), KEY_NAME_PREFIX)
        ).fetchall():
            accounts = []
            # An unscoped key can reach every account; listing them all would be
            # misleading, so only explicitly assigned accounts are reported.
            if scoped:
                for account_id, email, alias, plan, status, reason, reset_at in conn.execute(
                    ACCOUNTS_SQL, (key_id,)
                ).fetchall():
                    windows = [
                        w
                        for w in (
                            _window(conn.execute(LATEST_WINDOW_SQL, (account_id, slot)).fetchone())
                            for slot in ("primary", "secondary")
                        )
                        if w is not None
                    ]
                    accounts.append(
                        {
                            # A stable handle for the panel; the raw codex-lb id is not exposed.
                            "id": hashlib.sha256(str(account_id).encode()).hexdigest()[:16],
                            "email": email or None,
                            "alias": alias or None,
                            "plan_type": plan or None,
                            "status": status or None,
                            "status_reason": reason or None,
                            "blocked_until": _epoch(reset_at),
                            "windows": windows,
                        }
                    )
            keys.append(
                {
                    "name": name,
                    "key_prefix": prefix or None,
                    "active": bool(active),
                    "scoped": bool(scoped),
                    "accounts": accounts,
                }
            )
        return {
            "source": "codex-lb",
            "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "keys": keys,
        }
    finally:
        conn.close()


class _Cache:
    def __init__(self):
        self._lock = threading.Lock()
        self._body = None
        self._at = 0.0

    def get(self):
        with self._lock:
            now = time.monotonic()
            if self._body is None or now - self._at >= CACHE_SECONDS:
                self._body = json.dumps(read_status(), separators=(",", ":")).encode()
                self._at = now
            return self._body


CACHE = _Cache()


class Handler(BaseHTTPRequestHandler):
    server_version = "codex-lb-status"
    sys_version = ""

    def _send(self, status, body, content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _peer_is_loopback(self):
        try:
            return ipaddress.ip_address(self.client_address[0]).is_loopback
        except ValueError:
            return False

    def do_GET(self):
        if not self._peer_is_loopback():
            self._send(403, b'{"error":"forbidden"}')
            return
        if self.path.split("?", 1)[0] != ROUTE:
            self._send(404, b'{"error":"not found"}')
            return
        try:
            body = CACHE.get()
        except sqlite3.Error as error:
            # The message names the SQLite condition only; it carries no row data.
            self._send(503, json.dumps({"error": "database unavailable", "detail": str(error)}).encode())
            return
        self._send(200, body)

    def do_HEAD(self):
        self.do_GET()

    def log_message(self, fmt, *args):
        # One line per request without query strings or headers.
        sys.stderr.write("%s %s\n" % (self.command, self.path.split("?", 1)[0]))


def main():
    server = ThreadingHTTPServer(LISTEN, Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
