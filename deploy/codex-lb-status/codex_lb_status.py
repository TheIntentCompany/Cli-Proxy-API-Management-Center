#!/usr/bin/python3 -I
"""Read-only status of the codex-lb accounts that CLIProxyAPI reaches.

CLIProxyAPI forwards some Codex traffic to codex-lb through an API key whose name
starts with KEY_NAME_PREFIX. Those upstream accounts are not CLIProxyAPI auth files,
so the management panel cannot see them. This service answers one question for the
panel: for each such key, which accounts does it reach, and what are their status,
plan and latest usage windows?

Constraints this file keeps:
- It never writes. The database is opened with SQLite's read-only URI mode and
  `PRAGMA query_only`, statements run in autocommit, and each refresh has a hard
  deadline. The systemd unit also mounts the data directory read-only.
- It reads named columns only. Token columns of `accounts` and the key hash of
  `api_keys` are never selected, and `encryption.key` is never opened.
- It answers loopback peers that address it as a loopback host, and refuses browser
  requests (any Origin header), so a DNS-rebound page cannot read it. The panel reaches
  it through CLIProxyAPI's management `api-call`, which needs the management key.
- Load is bounded: answers (and failures) are cached, connections have deadlines, and
  at most MAX_CONNECTIONS are served at once; extra connections are closed at once.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import sqlite3
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DB_PATH = "/var/lib/intent-lb/codex/store.db"
HOST, PORT = "127.0.0.1", 8335
ROUTE = "/v1/accounts"
KEY_NAME_PREFIX = "cliproxy-"
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}", "127.0.0.1", "localhost"}

CACHE_SECONDS = 15
FAILURE_CACHE_SECONDS = 5
BUSY_TIMEOUT_MS = 2000
# One refresh, including retries, busy waits and queries, must finish within this.
# It stays well under the panel's 10-second api-call timeout.
REFRESH_DEADLINE_SECONDS = 4.0
OPEN_RETRY_SECONDS = 0.25
# Absolute limit on receiving a request line and headers, however slowly they trickle.
HEADER_DEADLINE_SECONDS = 5.0
SOCKET_TIMEOUT_SECONDS = 5
# Stays well below the unit's TasksMax so a flood cannot starve the service.
MAX_CONNECTIONS = 8

# codex-lb names usage windows "primary", "secondary" and (free plans) "monthly";
# legacy rows with a NULL window are primary, as in codex-lb's own repository code.
# The window's length decides what it is; length 0 means "not on this plan".
WINDOW_SLOTS = ("primary", "secondary", "monthly")
FIVE_HOUR_MAX_MINUTES = 5 * 60
WEEKLY_MAX_MINUTES = 7 * 24 * 60
MONTHLY_MAX_MINUTES = 31 * 24 * 60
# A window last recorded this long before the account's newest window is left over
# from an earlier plan or schedule; it is reported as stale rather than current.
STALE_AFTER_SECONDS = 24 * 60 * 60

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

# Matches idx_usage_window_account_latest (coalesce(window,'primary'), account_id,
# recorded_at DESC, id DESC): one index probe per window.
LATEST_WINDOW_SQL = """
SELECT used_percent, reset_at, window_minutes, recorded_at
FROM usage_history
WHERE coalesce("window", 'primary') = ? AND account_id = ?
ORDER BY recorded_at DESC, id DESC
LIMIT 1
"""


def _parse_time(value):
    """codex-lb stores naive UTC timestamps as text."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _iso(moment):
    return moment.isoformat().replace("+00:00", "Z") if moment else None


def _epoch(value):
    """Reset instants are epoch seconds in codex-lb; keep positive numbers only."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return int(number) if number > 0 else None


def _kind(minutes):
    if minutes <= FIVE_HOUR_MAX_MINUTES:
        return "five_hour"
    if minutes <= WEEKLY_MAX_MINUTES:
        return "weekly"
    if minutes <= MONTHLY_MAX_MINUTES:
        return "monthly"
    return "other"


def _windows(conn, account_id):
    rows = [conn.execute(LATEST_WINDOW_SQL, (slot, account_id)).fetchone() for slot in WINDOW_SLOTS]
    rows = [row for row in rows if row is not None]
    # Staleness is judged against the newest observation of any slot, including rows
    # whose duration is unknown, so a fresh unknown row still ages out an old window.
    newest = max((t for t in (_parse_time(row[3]) for row in rows) if t), default=None)
    found = []
    for used, reset_at, minutes, recorded_at in rows:
        try:
            minutes = int(minutes or 0)
        except (TypeError, ValueError):
            minutes = 0
        if minutes <= 0:
            continue
        try:
            used = max(0.0, min(100.0, float(used)))
        except (TypeError, ValueError):
            used = None
        found.append(
            {
                "kind": _kind(minutes),
                "used_percent": used,
                "reset_at": _epoch(reset_at),
                "window_minutes": minutes,
                "recorded_at": _parse_time(recorded_at),
            }
        )
    for window in found:
        moment = window["recorded_at"]
        window["stale"] = bool(
            newest and (moment is None or (newest - moment).total_seconds() > STALE_AFTER_SECONDS)
        )
        window["recorded_at"] = _iso(moment)
    return found


# One read-only connection, used only under the cache lock. codex-lb closes its own
# connections when idle, and SQLite then deletes store.db-wal and store.db-shm; on the
# read-only mount this reader cannot recreate them, so a fresh connection fails until
# codex-lb reconnects (measured absent 40% of the time). An open reader keeps codex-lb
# from being the last connection, so the sidecars stay. Reads are short autocommit
# statements, so no read transaction is held between refreshes and checkpoints proceed.
_conn = None
_conn_inode = None


def _close():
    global _conn, _conn_inode
    if _conn is not None:
        try:
            _conn.close()
        except sqlite3.Error:
            pass
    _conn, _conn_inode = None, None


def _connection(busy_ms):
    global _conn, _conn_inode
    inode = os.stat(DB_PATH).st_ino
    if _conn is not None and inode != _conn_inode:
        _close()  # The database file was replaced; read the new one.
    if _conn is None:
        conn = sqlite3.connect(
            f"file:{DB_PATH}?mode=ro",
            uri=True,
            timeout=busy_ms / 1000,
            isolation_level=None,
            check_same_thread=False,  # Handler threads take turns under the cache lock.
        )
        try:
            conn.execute("PRAGMA query_only = ON")
        except sqlite3.Error:
            conn.close()
            raise
        _conn, _conn_inode = conn, inode
    _conn.execute(f"PRAGMA busy_timeout = {busy_ms}")
    return _conn


def read_status():
    """Read within REFRESH_DEADLINE_SECONDS, reconnecting and retrying while the
    database cannot be opened. Callers hold the cache lock."""
    deadline = time.monotonic() + REFRESH_DEADLINE_SECONDS
    attempt = 0
    while True:
        try:
            return _read_once(deadline)
        except sqlite3.OperationalError as error:
            attempt += 1
            pause = OPEN_RETRY_SECONDS * attempt
            if "unable to open" not in str(error) or time.monotonic() + pause >= deadline:
                raise
            time.sleep(pause)


def _read_once(deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise sqlite3.OperationalError("refresh deadline passed")
    busy_ms = max(1, int(min(BUSY_TIMEOUT_MS, remaining * 1000)))
    try:
        conn = _connection(busy_ms)
    except OSError as error:
        raise sqlite3.OperationalError("unable to open database file") from error
    try:
        # Abort any statement still running past the deadline (non-zero interrupts).
        conn.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
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
                            "windows": _windows(conn, account_id),
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
            "generated_at": _iso(datetime.now(timezone.utc)),
            "keys": keys,
        }
    except sqlite3.Error:
        _close()  # Start clean next time.
        raise
    finally:
        if _conn is not None:
            _conn.set_progress_handler(None, 0)


class _Cache:
    """One refresh at a time; successes live CACHE_SECONDS, failures FAILURE_CACHE_SECONDS."""

    def __init__(self):
        self._lock = threading.Lock()
        self._status = 0
        self._body = b""
        self._until = 0.0

    def get(self):
        with self._lock:
            now = time.monotonic()
            if now >= self._until:
                try:
                    self._body = json.dumps(read_status(), separators=(",", ":")).encode()
                    self._status = 200
                    ttl = CACHE_SECONDS
                except sqlite3.Error:
                    # No row data and no paths: the panel only needs to know it failed.
                    self._body = b'{"error":"database unavailable"}'
                    self._status = 503
                    ttl = FAILURE_CACHE_SECONDS
                # Counted from completion, so a slow refresh still protects its waiters.
                self._until = time.monotonic() + ttl
            return self._status, self._body


CACHE = _Cache()


class _DeadlineReader:
    """Line reader over the socket that enforces an absolute header deadline.

    Python's buffered readline keeps receiving inside one line, so a client sending a
    byte every few seconds could hold a connection for as long as its line lasts. This
    reader receives itself and checks the deadline before every receive. Only request
    lines and headers are read; GET and HEAD carry no body.
    """

    def __init__(self, sock, deadline):
        self._sock = sock
        self._deadline = deadline
        self._buffer = b""

    def readline(self, limit=-1):
        while b"\n" not in self._buffer and (limit < 0 or len(self._buffer) < limit):
            remaining = self._deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("request header deadline passed")
            # Idle clients hit the inactivity limit; trickling ones hit the deadline.
            self._sock.settimeout(min(remaining, SOCKET_TIMEOUT_SECONDS))
            chunk = self._sock.recv(4096)
            if not chunk:
                break
            self._buffer += chunk
        newline = self._buffer.find(b"\n")
        end = newline + 1 if newline >= 0 else len(self._buffer)
        if limit >= 0:
            end = min(end, limit)
        line, self._buffer = self._buffer[:end], self._buffer[end:]
        return line

    def close(self):
        self._buffer = b""


class Handler(BaseHTTPRequestHandler):
    server_version = "codex-lb-status"
    sys_version = ""
    # Applied to the socket by StreamRequestHandler: slow or idle clients are dropped.
    timeout = SOCKET_TIMEOUT_SECONDS
    protocol_version = "HTTP/1.0"

    def setup(self):
        super().setup()
        # Socket inactivity alone lets a client trickle header bytes forever.
        self.rfile.close()
        self.rfile = _DeadlineReader(self.connection, time.monotonic() + HEADER_DEADLINE_SECONDS)

    def _send(self, status, body, extra=None):
        # The header deadline may have left a very short socket timeout; writing gets
        # the normal inactivity limit again.
        self.connection.settimeout(SOCKET_TIMEOUT_SECONDS)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _allowed(self):
        try:
            if not ipaddress.ip_address(self.client_address[0]).is_loopback:
                return False
        except ValueError:
            return False
        host = (self.headers.get("Host") or "").strip().lower()
        # Browsers always send Origin on cross-origin fetches; the api-call proxy never does.
        return host in ALLOWED_HOSTS and self.headers.get("Origin") is None

    def do_GET(self):
        if not self._allowed():
            self._send(403, b'{"error":"forbidden"}')
            return
        if self.path.split("?", 1)[0] != ROUTE:
            self._send(404, b'{"error":"not found"}')
            return
        status, body = CACHE.get()
        extra = {"Retry-After": str(FAILURE_CACHE_SECONDS)} if status == 503 else None
        self._send(status, body, extra)

    def do_HEAD(self):
        self.do_GET()

    def log_message(self, fmt, *args):
        # No per-request logging: a loopback flood must not become a journal flood.
        return


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._slots = threading.BoundedSemaphore(MAX_CONNECTIONS)

    def process_request(self, request, client_address):
        if not self._slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()

    def handle_error(self, request, client_address):
        # One line, no traceback: paths and library internals stay out of the journal.
        sys.stderr.write("request failed: %s\n" % sys.exc_info()[0].__name__)


def main():
    Server((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
