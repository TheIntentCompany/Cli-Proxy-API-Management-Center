#!/usr/bin/python3 -I
"""Account actions for the codex-lb accounts that CLIProxyAPI reaches.

The panel shows Codex accounts held by codex-lb (see deploy/codex-lb-status). This relay
lets it run codex-lb's own actions on them, exactly as codex-lb's dashboard does:

  GET  /v1/accounts/<handle>/resets   banked resets: count and each one's expiry
  POST /v1/accounts/<handle>/refresh  codex-lb "probe": one request that refreshes usage
  POST /v1/accounts/<handle>/reset    spend one banked reset (body: {"redeem_request_id"})

codex-lb remains the only thing that holds or uses the account's token. This service
holds a codex-lb dashboard login (systemd credential "codex-lb-login": username on the
first line, password on the second), keeps the session cookie in memory, and calls
codex-lb's API on loopback.

Scope and safety:
- <handle> is the opaque id from the status service. An action runs only for an account
  that the status service currently lists (accounts assigned to cliproxy-* keys), so this
  relay cannot reach any other codex-lb account.
- Loopback peers only, loopback Host only, and no browser Origin. The panel reaches it
  through CLIProxyAPI's management api-call, which requires the management key.
- One action at a time; a reset needs a client-chosen redeem request id, which codex-lb
  uses to make retries idempotent.
- Upstream errors are reduced to codex-lb's error code and message; nothing else from
  codex-lb's responses is passed through.
"""

from __future__ import annotations

import hashlib
import http.cookiejar
import ipaddress
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST, PORT = "127.0.0.1", 8336
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}", "127.0.0.1", "localhost"}
CODEX_LB = "http://127.0.0.1:2455"
STATUS_URL = "http://127.0.0.1:8335/v1/accounts"
CREDENTIAL_NAME = "codex-lb-login"
UPSTREAM_TIMEOUT = 45
SOCKET_TIMEOUT_SECONDS = 5
HEADER_DEADLINE_SECONDS = 5.0
MAX_CONNECTIONS = 4
MAX_BODY_BYTES = 1024
ROUTE = re.compile(r"^/v1/accounts/([0-9a-f]{16})/(resets|refresh|reset)$")
REDEEM_ID = re.compile(r"^[A-Za-z0-9_-]{8,80}$")


class UpstreamError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _handle(account_id):
    return hashlib.sha256(str(account_id).encode()).hexdigest()[:16]


def _read_login():
    directory = os.environ.get("CREDENTIALS_DIRECTORY", "")
    path = os.path.join(directory, CREDENTIAL_NAME)
    with open(path, encoding="utf-8") as handle:
        lines = handle.read().splitlines()
    if len(lines) < 2 or not lines[1]:
        raise RuntimeError("codex-lb login credential must hold a username line and a password line")
    return lines[0].strip(), lines[1]


class CodexLb:
    """A logged-in codex-lb dashboard client. Callers hold LOCK."""

    def __init__(self):
        self._jar = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self._jar), urllib.request.ProxyHandler({})
        )
        self._logged_in = False

    def _send(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(CODEX_LB + path, data=data, method=method)
        request.add_header("Accept", "application/json")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with self._opener.open(request, timeout=UPSTREAM_TIMEOUT) as response:
                raw = response.read(1_000_000)
                return response.status, json.loads(raw) if raw.strip() else None
        except urllib.error.HTTPError as error:
            raw = error.read(64_000)
            try:
                payload = json.loads(raw)
            except ValueError:
                payload = None
            detail = payload.get("error") if isinstance(payload, dict) else None
            if not isinstance(detail, dict):
                detail = payload if isinstance(payload, dict) else {}
            raise UpstreamError(
                error.code,
                str(detail.get("code") or f"http_{error.code}"),
                str(detail.get("message") or "codex-lb refused the request"),
            ) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise UpstreamError(502, "codex_lb_unreachable", "codex-lb did not answer") from None

    def _login(self):
        username, password = _read_login()
        self._jar.clear()
        self._send(
            "POST",
            "/api/dashboard-auth/password/login",
            {"username": username or None, "password": password},
        )
        self._logged_in = True

    def call(self, method, path, body=None):
        if not self._logged_in:
            self._login()
        try:
            return self._send(method, path, body)
        except UpstreamError as error:
            if error.status != 401:
                raise
            # Session expired or was revoked: log in again once.
            self._login()
            return self._send(method, path, body)


LOCK = threading.Lock()
CLIENT = CodexLb()


def _listed_account_ids():
    """Raw codex-lb ids of accounts the status service lists, keyed by their handle."""
    request = urllib.request.Request(STATUS_URL, headers={"Accept": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=10) as response:
        status = json.loads(response.read(1_000_000))
    handles = {account["id"] for key in status.get("keys", []) for account in key.get("accounts", [])}
    # The status service only exposes handles; resolve them against codex-lb's own list.
    _, accounts = CLIENT.call("GET", "/api/accounts")
    rows = accounts.get("accounts", []) if isinstance(accounts, dict) else accounts or []
    resolved = {}
    ambiguous = set()
    for row in rows:
        account_id = row.get("accountId") or row.get("id")
        if not account_id or _handle(account_id) not in handles:
            continue
        handle = _handle(account_id)
        if resolved.get(handle, account_id) != account_id:
            ambiguous.add(handle)
        resolved[handle] = account_id
    # Two accounts sharing a 64-bit handle could send an action to the unlisted one; refuse both.
    for handle in ambiguous:
        resolved.pop(handle, None)
    return resolved


def _resets(account_id):
    quoted = urllib.request.quote(account_id, safe="")
    _, counts = CLIENT.call("GET", f"/api/accounts/{quoted}/usage-reset-credits")
    try:
        _, snapshot = CLIENT.call("GET", f"/api/accounts/{quoted}/rate-limit-reset-credits")
    except UpstreamError:
        snapshot = None
    credits = (snapshot or {}).get("credits") or []
    counts = (counts or {}).get("rateLimitResetCredits") or {}
    return {
        "available": int(counts.get("availableCount") or 0),
        "unusable": int(counts.get("unusableCount") or 0),
        "credits": [
            {
                "title": credit.get("title"),
                "status": credit.get("status"),
                "expires_at": credit.get("expiresAt"),
                "granted_at": credit.get("grantedAt"),
            }
            for credit in credits
            if isinstance(credit, dict)
        ],
    }


def _refresh(account_id):
    quoted = urllib.request.quote(account_id, safe="")
    _, result = CLIENT.call("POST", f"/api/accounts/{quoted}/probe", {})
    result = result or {}
    return {
        "status": result.get("status"),
        "probe_status_code": result.get("probeStatusCode"),
        "account_status": result.get("accountStatusAfter"),
        "primary_used_percent": result.get("primaryUsedPercentAfter"),
        "secondary_used_percent": result.get("secondaryUsedPercentAfter"),
    }


def _reset(account_id, redeem_request_id):
    quoted = urllib.request.quote(account_id, safe="")
    _, result = CLIENT.call(
        "POST",
        f"/api/accounts/{quoted}/usage-reset-credits/consume",
        {"redeemRequestId": redeem_request_id},
    )
    result = result or {}
    return {
        "status": result.get("status"),
        "code": result.get("code"),
        "windows_reset": result.get("windowsReset"),
        "account_status": result.get("accountStatusAfter"),
        "primary_used_percent": result.get("primaryUsedPercentAfter"),
    }


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

    def read(self, size):
        """Read exactly `size` body bytes (or fewer at EOF) within the same deadline."""
        while len(self._buffer) < size:
            remaining = self._deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("request deadline passed")
            self._sock.settimeout(min(remaining, SOCKET_TIMEOUT_SECONDS))
            chunk = self._sock.recv(4096)
            if not chunk:
                break
            self._buffer += chunk
        data, self._buffer = self._buffer[:size], self._buffer[size:]
        return data

    def close(self):
        self._buffer = b""


class Handler(BaseHTTPRequestHandler):
    server_version = "codex-lb-actions"
    sys_version = ""
    timeout = SOCKET_TIMEOUT_SECONDS
    protocol_version = "HTTP/1.0"

    def setup(self):
        super().setup()
        # Socket inactivity alone lets a client trickle header bytes forever.
        self._deadline = time.monotonic() + HEADER_DEADLINE_SECONDS
        self.rfile.close()
        self.rfile = _DeadlineReader(self.connection, self._deadline)

    def _send(self, status, payload):
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.connection.settimeout(SOCKET_TIMEOUT_SECONDS)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _allowed(self):
        try:
            if not ipaddress.ip_address(self.client_address[0]).is_loopback:
                return False
        except ValueError:
            return False
        if time.monotonic() > self._deadline:
            return False
        host = (self.headers.get("Host") or "").strip().lower()
        return host in ALLOWED_HOSTS and self.headers.get("Origin") is None

    def _route(self, method):
        if not self._allowed():
            self._send(403, {"error": {"code": "forbidden", "message": "Forbidden"}})
            return
        match = ROUTE.match(self.path.split("?", 1)[0])
        if not match:
            self._send(404, {"error": {"code": "not_found", "message": "Not found"}})
            return
        handle, action = match.groups()
        if (action == "resets") != (method == "GET"):
            self._send(405, {"error": {"code": "method_not_allowed", "message": "Method not allowed"}})
            return
        body = {}
        if method == "POST":
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY_BYTES:
                self._send(413, {"error": {"code": "too_large", "message": "Body too large"}})
                return
            raw = self.rfile.read(length) if length else b""
            try:
                body = json.loads(raw) if raw.strip() else {}
            except ValueError:
                body = None
            if not isinstance(body, dict):
                self._send(400, {"error": {"code": "bad_body", "message": "Body must be a JSON object"}})
                return
        if action == "reset":
            redeem = body.get("redeem_request_id")
            if not isinstance(redeem, str) or not REDEEM_ID.match(redeem):
                self._send(400, {"error": {"code": "redeem_request_id_required", "message": "A redeem request id is required"}})
                return
        if not LOCK.acquire(timeout=1):
            self._send(409, {"error": {"code": "busy", "message": "Another codex-lb action is running"}})
            return
        try:
            account_id = _listed_account_ids().get(handle)
            if account_id is None:
                self._send(404, {"error": {"code": "account_not_listed", "message": "Account is not reachable from this gateway"}})
                return
            if action == "resets":
                result = _resets(account_id)
            elif action == "refresh":
                result = _refresh(account_id)
            else:
                result = _reset(account_id, body["redeem_request_id"])
            sys.stderr.write(f"{action} ok {handle}\n")
            self._send(200, result)
        except UpstreamError as error:
            sys.stderr.write(f"{action} failed {handle} {error.code}\n")
            status = error.status if 400 <= error.status < 600 else 502
            self._send(status, {"error": {"code": error.code, "message": error.message}})
        except Exception as error:  # noqa: BLE001 - one line, no traceback
            sys.stderr.write(f"{action} error {handle} {type(error).__name__}\n")
            self._send(500, {"error": {"code": "relay_error", "message": "The relay could not complete the action"}})
        finally:
            LOCK.release()

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def log_message(self, fmt, *args):
        return


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8

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
        sys.stderr.write("request failed: %s\n" % sys.exc_info()[0].__name__)


def main():
    Server((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
