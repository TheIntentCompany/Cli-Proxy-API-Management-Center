#!/usr/bin/python3 -I
"""Local usage history. Python 3.12 stdlib only; no network access on import.

Queue pops cannot be made atomic with SQLite. A crash between the HTTP pop and the
local commit can lose that batch. Once received, a batch stays in memory until its
transaction commits; no later pop occurs in that interval. No raw payload is spooled.
"""
from __future__ import annotations

import bisect
import hashlib
import http.client
import ipaddress
import json
import math
import os
import re
import shutil
import signal
import sqlite3
import sys
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

HOST, PORT = '127.0.0.1', 8337
ALLOWED_HOSTS = {f'127.0.0.1:{PORT}', f'localhost:{PORT}', '127.0.0.1', 'localhost'}
HEADER_DEADLINE_SECONDS = 5.0
SOCKET_TIMEOUT_SECONDS = 5
MAX_CONNECTIONS = 8
HOUR = 3_600_000
DAY = 24 * HOUR
DB_CAP = 1_000_000_000
FREE_FLOOR = 700_000_000
# Reserve for an incoming batch, indexes, rollups and a checkpoint before popping.
BATCH_RESERVE = 32_000_000
MAX_BODY = 16_000_000
# 16 bins: 15 finite upper edges, last bin is overflow. Percentiles use upper edges.
HIST_EDGES = tuple(round(100 * (6000 ** (i / 14))) for i in range(15))
TOKEN_FIELDS = ('input_uncached', 'cache_read', 'cache_write_5m', 'cache_write_1h',
                'output', 'reasoning')
SUM_FIELDS = ('requests', 'failed', *TOKEN_FIELDS, 'cost_usd', 'unpriced_requests',
              'latency_sum', 'latency_count', 'ttft_sum', 'ttft_count')
HIST_FIELDS = tuple(f'{prefix}{i}' for prefix in ('lh', 'th') for i in range(16))
ROLL_FIELDS = SUM_FIELDS + HIST_FIELDS
UNPRICED = {'<synthetic>', 'synthetic', 'opus', 'sonnet', 'haiku', 'fable'}


def now_ms():
    return time.time_ns() // 1_000_000


def timestamp_ns(value):
    """RFC3339 nanoseconds, or codex-lb naive UTC, without float rounding."""
    if not isinstance(value, str):
        raise ValueError('invalid timestamp')
    match = re.fullmatch(r'(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)?', value)
    if not match:
        raise ValueError('invalid timestamp')
    base, fraction, offset = match.groups()
    dt = datetime.fromisoformat(base + ('+00:00' if not offset or offset == 'Z' else offset))
    delta = dt.astimezone(timezone.utc) - datetime(1970, 1, 1, tzinfo=timezone.utc)
    return (delta.days * 86400 + delta.seconds) * 1_000_000_000 + int((fraction or '').ljust(9, '0'))


def number(value, default=0):
    try:
        n = float(value)
        return min(10**15, max(0, int(n))) if math.isfinite(n) else default
    except (TypeError, ValueError, OverflowError):
        return default


def metric(value):
    return None if value is None else number(value)


def clean(value, secrets=(), limit=2000):
    text = str(value or '')
    for secret in secrets:
        if secret:
            text = text.replace(str(secret), '[redacted]')
    text = re.sub(r'(?i)bearer\s+[^\s"\x27,}]+', 'Bearer [redacted]', text)
    return text[:limit]


def key_identity(raw):
    if not raw:
        return '', ''
    raw = str(raw)
    return hashlib.sha256(raw.encode()).hexdigest()[:16], (raw[:2] + '******' + raw[-2:] if len(raw) > 4 else '**********')


class Pricing:
    def __init__(self, document):
        self.source = document['source']
        self.models = {k.strip().lower(): v for k, v in document['models'].items()}
        candidates = {}
        for key, entry in self.models.items():
            if '/' not in key:
                continue
            prefix, bare = key.split('/', 1)[0], key.rsplit('/', 1)[-1]
            if bare in self.models:
                continue
            rank = int(prefix in {'anthropic', 'openai', 'xai', 'gemini'})
            held = candidates.get(bare)
            if held is None or rank > held[0]:
                candidates[bare] = (rank, entry)
            elif rank == held[0] and entry != held[1]:
                candidates[bare] = (rank, None)  # Ambiguous rates stay unpriced.
        self.models.update({k: v for k, (_, v) in candidates.items() if v is not None})

    @staticmethod
    def rates(entry, suffix='', base=None):
        inp = entry.get('input_cost_per_token' + suffix)
        out = entry.get('output_cost_per_token' + suffix, base[4] if base else None)
        if inp is None or out is None:
            return base
        def cache(name, index, fallback):
            if name + suffix in entry:
                return entry[name + suffix]
            return base[index] / base[0] * inp if base and base[0] > 0 else fallback
        write = cache('cache_creation_input_token_cost', 2, inp)
        return (inp, cache('cache_read_input_token_cost', 1, inp), write,
                cache('cache_creation_input_token_cost_above_1hr', 3, write), out)

    def cost(self, model, tokens):
        key = model.strip().lower().split('[', 1)[0]
        if key.rsplit('/', 1)[-1] in UNPRICED:
            return None
        entry = self.models.get(key)
        if entry is None:
            return None
        rates = self.rates(entry)
        prompt = sum(tokens[k] for k in TOKEN_FIELDS[:4])
        thresholds = sorted({int(m.group(1)) for k in entry
                             if (m := re.fullmatch(r'input_cost_per_token_above_(\d{1,7})k_tokens(?:_priority|_ultrafast)?', k))}, reverse=True)
        for threshold in thresholds:
            if prompt > threshold * 1000:
                rates = self.rates(entry, f'_above_{threshold}k_tokens', rates)
                break
        return sum(tokens[k] * r for k, r in zip(TOKEN_FIELDS[:5], rates))


def tokens_of(record):
    tokens = record.get('tokens') or {}
    if not isinstance(tokens, dict):
        raise ValueError('invalid tokens')
    breakdown = record.get('token_breakdown')
    if isinstance(breakdown, dict) and isinstance(breakdown.get('input'), dict) and isinstance(breakdown.get('output'), dict):
        inp, out = breakdown['input'], breakdown['output']
        uncached, read = number(inp.get('uncached_tokens')), number(inp.get('cache_read_tokens'))
        write = number(inp.get('cache_write_tokens'))
        output, reasoning = number(out.get('total_tokens')), number(out.get('reasoning_tokens'))
    else:
        uncached = number(tokens.get('input_tokens'))
        if str(record.get('provider', '')).lower() in {'codex', 'openai'}:
            read = number(tokens.get('cached_tokens', tokens.get('cache_read_tokens')))
            uncached = max(0, uncached - read)
        else:
            read = number(tokens.get('cache_read_tokens', tokens.get('cached_tokens')))
        write = number(tokens.get('cache_creation_tokens',
                       number(tokens.get('cache_creation_5m_tokens')) + number(tokens.get('cache_creation_1h_tokens'))))
        output, reasoning = number(tokens.get('output_tokens')), number(tokens.get('reasoning_tokens'))
    one_hour = min(write, number(tokens.get('cache_creation_1h_tokens')))
    return dict(zip(TOKEN_FIELDS, (uncached, read, write - one_hour, one_hour, output, reasoning)))


def normalize(record, routes, management_key=''):
    if isinstance(record, str):
        record = json.loads(record)
    if not isinstance(record, dict):
        raise ValueError('record is not an object')
    secrets = (record.get('api_key'), record.get('access_token_sha256'), management_key)
    ns = timestamp_ns(record.get('timestamp'))
    provider = clean(record.get('provider'), secrets, 100)
    auth = clean(record.get('auth_index'), secrets, 200)
    route = routes.get(auth)
    fail = record.get('fail') or {}
    if not isinstance(fail, dict):
        raise ValueError('invalid failure')
    failed = bool(record.get('failed'))
    key_id, masked = key_identity(record.get('api_key'))
    return {'ts': ns // 1_000_000, 'ts_ns': ns, 'source_origin': 'gateway',
            'provider': provider, 'model': clean(record.get('model'), secrets, 300),
            'alias': clean(record.get('alias'), secrets, 300), 'account_id': auth,
            'account_label': clean(route['label'] if route else record.get('source'), secrets, 300),
            'via': 'codex-lb' if route else '', 'key_id': key_id, 'key_masked': masked,
            'endpoint': clean(record.get('endpoint'), secrets, 300),
            'stream': int(bool(record.get('stream'))), **tokens_of(record),
            'latency_ms': metric(record.get('latency_ms')), 'ttft_ms': metric(record.get('ttft_ms')),
            'status_code': number(fail.get('status_code')) or (None if failed else 200),
            'failed': int(failed), 'error': clean(fail.get('body'), secrets) if failed else None,
            'request_id': clean(record.get('request_id'), secrets, 300),
            'user_agent': clean(record.get('user_agent'), secrets, 500)}


def empty_totals():
    return {k: 0 for k in ROLL_FIELDS}


def add_totals(target, source):
    for k in ROLL_FIELDS:
        target[k] += source[k]


def percentile(totals, prefix, quantile):
    count = sum(totals[f'{prefix}{i}'] for i in range(16))
    if not count:
        return None
    target, seen = count * quantile, 0
    for i in range(16):
        in_bin = totals[f'{prefix}{i}']
        if in_bin and seen + in_bin >= target:
            if i >= 15:
                return HIST_EDGES[14]  # Overflow is reported at 10 min.
            # Interpolate inside the bin on a log scale (the bins are log-spaced), so
            # two different distributions do not snap to the same bin edge.
            upper = HIST_EDGES[i]
            lower = HIST_EDGES[i - 1] if i > 0 else upper / (HIST_EDGES[1] / HIST_EDGES[0])
            fraction = min(1.0, max(0.0, (target - seen) / in_bin))
            return round(lower * (upper / lower) ** fraction)
        seen += in_bin


def public_totals(totals):
    return {**{k: totals[k] for k in ('requests', 'failed', 'input_uncached', 'cache_read',
                                     'output', 'reasoning', 'cost_usd', 'unpriced_requests')},
            'cache_write': totals['cache_write_5m'] + totals['cache_write_1h'],
            'latency_p50_ms': percentile(totals, 'lh', .5),
            'latency_p95_ms': percentile(totals, 'lh', .95),
            'ttft_p50_ms': percentile(totals, 'th', .5)}


class Store:
    def __init__(self, path, pricing):
        self.path, self.pricing = Path(path), pricing
        self.lock = threading.RLock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None, timeout=2)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute('PRAGMA auto_vacuum=INCREMENTAL')
        self.conn.execute('PRAGMA journal_mode=WAL')
        self.conn.execute('PRAGMA synchronous=FULL')
        self.conn.execute('PRAGMA journal_size_limit=8388608')
        self.conn.execute('PRAGMA wal_autocheckpoint=256')
        self.conn.execute('PRAGMA cache_size=-8192')
        self.conn.execute('PRAGMA foreign_keys=ON')
        self.conn.executescript('''
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS models (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
        CREATE TABLE IF NOT EXISTS providers (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
        CREATE TABLE IF NOT EXISTS endpoints (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
        CREATE TABLE IF NOT EXISTS keys (id INTEGER PRIMARY KEY, key_id TEXT UNIQUE NOT NULL, key_masked TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY, auth_index TEXT NOT NULL,
          label TEXT NOT NULL, provider INTEGER NOT NULL, via TEXT NOT NULL,
          UNIQUE(auth_index,label,provider,via));
        CREATE TABLE IF NOT EXISTS requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source_origin TEXT NOT NULL,
          provider INTEGER NOT NULL, model INTEGER NOT NULL, account INTEGER NOT NULL,
          key INTEGER NOT NULL, endpoint INTEGER NOT NULL, alias TEXT NOT NULL, stream INTEGER NOT NULL,
          input_uncached INTEGER NOT NULL, cache_read INTEGER NOT NULL,
          cache_write_5m INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL,
          output INTEGER NOT NULL, reasoning INTEGER NOT NULL, cost_usd REAL, priced INTEGER NOT NULL,
          latency_ms INTEGER, ttft_ms INTEGER, status_code INTEGER, failed INTEGER NOT NULL,
          error TEXT, request_id TEXT NOT NULL, user_agent TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS requests_time ON requests(ts);
        CREATE INDEX IF NOT EXISTS requests_account_time ON requests(account,ts);
        CREATE INDEX IF NOT EXISTS requests_model_time ON requests(model,ts);
        CREATE INDEX IF NOT EXISTS requests_key_time ON requests(key,ts);
        ''')
        columns = ','.join(f'{k} {"REAL" if k == "cost_usd" else "INTEGER"} NOT NULL' for k in ROLL_FIELDS)
        self.conn.execute(f'''CREATE TABLE IF NOT EXISTS hourly (
          hour INTEGER NOT NULL, provider INTEGER NOT NULL, model INTEGER NOT NULL,
          account INTEGER NOT NULL, key INTEGER NOT NULL, outcome INTEGER NOT NULL,
          {columns}, PRIMARY KEY(hour,provider,model,account,key,outcome)) WITHOUT ROWID''')
        self.started = now_ms()
        self.last_drain_at, self.last_drain_count = None, 0

    def close(self):
        self.conn.close()

    def meta(self, key, default=None):
        row = self.conn.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()
        return row[0] if row else default

    def set_meta(self, key, value):
        self.conn.execute('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, str(value)))

    @contextmanager
    def transaction(self):
        with self.lock:
            self.conn.execute('BEGIN IMMEDIATE')
            try:
                yield
                self.conn.execute('COMMIT')
            except BaseException:
                self.conn.execute('ROLLBACK')
                raise

    def named_id(self, table, name):
        self.conn.execute(f'INSERT OR IGNORE INTO {table}(name) VALUES (?)', (name,))
        return self.conn.execute(f'SELECT id FROM {table} WHERE name=?', (name,)).fetchone()[0]

    def insert(self, row):
        provider = self.named_id('providers', row['provider'])
        model = self.named_id('models', row['model'])
        endpoint = self.named_id('endpoints', row['endpoint'])
        self.conn.execute('INSERT OR IGNORE INTO keys(key_id,key_masked) VALUES (?,?)', (row['key_id'], row['key_masked']))
        held = self.conn.execute('SELECT id,key_masked FROM keys WHERE key_id=?', (row['key_id'],)).fetchone()
        if held['key_masked'] != row['key_masked']:
            raise ValueError('ambiguous client key handle')
        key = held['id']
        identity = (row['account_id'], row['account_label'], provider, row['via'])
        self.conn.execute('INSERT OR IGNORE INTO accounts(auth_index,label,provider,via) VALUES (?,?,?,?)', identity)
        account = self.conn.execute('SELECT id FROM accounts WHERE auth_index=? AND label=? AND provider=? AND via=?', identity).fetchone()[0]
        cost = self.pricing.cost(row['model'], row)
        stored = {k: v for k, v in row.items() if k not in
                  {'ts_ns', 'account_id', 'account_label', 'via', 'key_id', 'key_masked'}}
        stored.update(provider=provider, model=model, endpoint=endpoint, account=account,
                      key=key, cost_usd=cost, priced=int(cost is not None))
        columns = ','.join(stored)
        self.conn.execute(f'INSERT INTO requests ({columns}) VALUES ({",".join("?" for _ in stored)})', tuple(stored.values()))
        totals = empty_totals()
        totals.update({k: row[k] for k in TOKEN_FIELDS})
        totals.update(requests=1, failed=row['failed'], cost_usd=cost or 0,
                      unpriced_requests=int(cost is None))
        for field, prefix in (('latency_ms', 'lh'), ('ttft_ms', 'th')):
            value = row[field]
            name = 'latency' if prefix == 'lh' else 'ttft'
            if value is not None:
                totals[name + '_sum'], totals[name + '_count'] = value, 1
                totals[f'{prefix}{bisect.bisect_left(HIST_EDGES, value)}'] = 1
        dims = (row['ts'] // HOUR * HOUR, provider, model, account, key, row['failed'])
        names = ','.join(ROLL_FIELDS)
        updates = ','.join(f'{k}={k}+excluded.{k}' for k in ROLL_FIELDS)
        self.conn.execute(f'INSERT INTO hourly (hour,provider,model,account,key,outcome,{names}) '
                          f'VALUES ({",".join("?" for _ in range(6 + len(ROLL_FIELDS)))}) '
                          f'ON CONFLICT(hour,provider,model,account,key,outcome) DO UPDATE SET {updates}', dims + tuple(totals.values()))
        self.set_meta('records_total', int(self.meta('records_total', '0')) + 1)

    def ingest(self, records, routes=None, management_key=''):
        rows = [normalize(r, routes or {}, management_key) for r in records]
        with self.transaction():
            if rows and self.meta('first_queue_ns') is None:
                instant = min(r['ts_ns'] for r in rows)
                self.set_meta('first_queue_ns', instant)
                self.set_meta('first_record_at', instant // 1_000_000)
            for row in rows:
                self.insert(row)
        self.last_drain_at, self.last_drain_count = now_ms(), len(rows)

    def db_bytes(self):
        return sum(p.stat().st_size for p in (self.path, Path(str(self.path) + '-wal'),
                                             Path(str(self.path) + '-shm')) if p.exists())

    def disk_free(self):
        return shutil.disk_usage(self.path.parent).free

    def prune(self, at=None, cap=DB_CAP, free_floor=FREE_FLOOR, reserve=0):
        """Rollups are permanent. Delete in bounded transactions, reclaim in-place."""
        at = now_ms() if at is None else at
        removed = 0
        with self.lock:
            cutoff = at - 90 * DAY
            while True:
                with self.transaction():
                    cursor = self.conn.execute('DELETE FROM requests WHERE id IN (SELECT id FROM requests WHERE ts<? LIMIT 2000)', (cutoff,))
                    count = cursor.rowcount
                removed += count
                if not count:
                    break
            self.reclaim()
            while self.db_bytes() + reserve > cap or self.disk_free() < free_floor + reserve:
                oldest = self.conn.execute('SELECT min(ts) FROM requests').fetchone()[0]
                if oldest is None:
                    break
                end = (oldest // DAY + 1) * DAY
                while True:
                    with self.transaction():
                        count = self.conn.execute('DELETE FROM requests WHERE id IN (SELECT id FROM requests WHERE ts<? LIMIT 2000)', (end,)).rowcount
                    removed += count
                    if not count:
                        break
                self.reclaim()
            return removed

    def reclaim(self):
        self.conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        # Incremental vacuum can free only one page per step on some SQLite builds.
        # Reclaim in bounded chunks rather than a full VACUUM requiring a second file.
        for step in range(4096):
            if self.conn.execute('PRAGMA freelist_count').fetchone()[0] == 0:
                break
            self.conn.execute('PRAGMA incremental_vacuum(256)').fetchall()
            if step % 8 == 7:
                self.conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        self.conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')

    def can_pop(self):
        return self.db_bytes() + BATCH_RESERVE < DB_CAP and self.disk_free() >= FREE_FLOOR + BATCH_RESERVE

    def coverage(self):
        return {'first_record_at': int(self.meta('first_record_at')) if self.meta('first_record_at') else None,
                'oldest_raw_at': self.conn.execute('SELECT min(ts) FROM requests').fetchone()[0]}

    def health(self):
        with self.read():
            return {'ok': True, 'last_drain_at': self.last_drain_at,
                    'last_drain_count': self.last_drain_count,
                    'records_total': int(self.meta('records_total', '0')), **self.coverage(),
                    'collector_started_at': self.started, 'db_bytes': self.db_bytes(),
                    'disk_free_bytes': self.disk_free(), 'price_source': self.pricing.source}

    @contextmanager
    def read(self):
        if not self.lock.acquire(timeout=.5):
            raise sqlite3.OperationalError('reader busy')
        deadline = time.monotonic() + 4
        self.conn.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
        try:
            yield
        finally:
            self.conn.set_progress_handler(None, 0)
            self.lock.release()

    @staticmethod
    def filters(params, alias):
        clauses, args = [], []
        for key, column in (('provider', 'p.name'), ('model', 'm.name'),
                            ('account', 'a.auth_index'), ('key', 'k.key_id')):
            if params.get(key):
                clauses.append(column + '=?')
                args.append(params[key])
        return clauses, args

    @staticmethod
    def joins(alias):
        return f'''JOIN models m ON m.id={alias}.model JOIN providers p ON p.id={alias}.provider
        JOIN accounts a ON a.id={alias}.account JOIN keys k ON k.id={alias}.key'''

    def summary(self, params):
        start, end = time_range(params)
        bucket = params.get('bucket', 'hour')
        if bucket not in {'hour', 'day'}:
            raise ValueError('invalid bucket')
        tz = ZoneInfo(params.get('tz', 'UTC'))
        # Rollups cannot resolve partial hours. Include UTC hours whose start lies in [from,to).
        if end - start > (366 * DAY if bucket == 'hour' else 10 * 366 * DAY):
            raise ValueError('range exceeds bucket limit')
        def bucket_at(ms):
            if bucket == 'hour':
                return ms // HOUR * HOUR
            dt = datetime.fromtimestamp(ms / 1000, tz)
            return int(datetime(dt.year, dt.month, dt.day, tzinfo=tz).timestamp() * 1000)
        with self.read():
            clauses, args = self.filters(params, 'h')
            clauses += ['h.hour>=?', 'h.hour<?']
            args += [start, end]
            sql = f'''SELECT h.*, p.name provider_name, m.name model_name, a.auth_index,
              a.label, a.via, k.key_id, k.key_masked FROM hourly h {self.joins('h')}
              WHERE {" AND ".join(clauses)} ORDER BY h.hour'''
            total, series, groups = empty_totals(), {}, {k: {} for k in ('model', 'account', 'key', 'provider')}
            # Iterate UTC hours for DST changes; calendar midnights are derived in tz.
            for hour in range(start // HOUR * HOUR, end, HOUR):
                series.setdefault(bucket_at(hour), {'totals': empty_totals(), 'providers': {}})
            deadline = time.monotonic() + 4
            for row in self.conn.execute(sql, args):
                if time.monotonic() >= deadline:
                    raise sqlite3.OperationalError('summary deadline')
                add_totals(total, row)
                entry = series.setdefault(bucket_at(row['hour']), {'totals': empty_totals(), 'providers': {}})
                add_totals(entry['totals'], row)
                add_totals(entry['providers'].setdefault(row['provider_name'], empty_totals()), row)
                identities = {'model': (row['model'], {'model': row['model_name']}),
                              'provider': (row['provider'], {'provider': row['provider_name']}),
                              'account': (row['account'], {'account_id': row['auth_index'], 'label': row['label'],
                                                         'provider': row['provider_name'], 'via': row['via']}),
                              'key': (row['key'], {'key_id': row['key_id'], 'key_masked': row['key_masked']})}
                for name, (identity, fields) in identities.items():
                    held = groups[name].setdefault(identity, {'fields': fields, 'totals': empty_totals()})
                    add_totals(held['totals'], row)
                if sum(len(group) for group in groups.values()) > 10_000:
                    raise ValueError('too many groups; narrow the range or filters')
            points = []
            for t, entry in sorted(series.items()):
                totals = public_totals(entry['totals'])
                points.append({'t': t, **{k: v for k, v in totals.items() if k not in
                                         {'unpriced_requests', 'latency_p50_ms', 'latency_p95_ms', 'ttft_p50_ms'}},
                               'by_provider': {name: {'requests': v['requests'],
                                                     'tokens': sum(v[k] for k in TOKEN_FIELDS[:5]),
                                                     'cost_usd': v['cost_usd']}
                                               for name, v in sorted(entry['providers'].items())}})
            result = {'totals': public_totals(total), 'series': points,
                      **{'by_' + name: [{**v['fields'], **public_totals(v['totals'])}
                                        for _, v in sorted(values.items())] for name, values in groups.items()},
                      'coverage': self.coverage(), 'price_source': self.pricing.source}
            return result

    def requests(self, params, detail_id=None):
        with self.read():
            clauses, args = self.filters(params, 'r')
            if detail_id is not None:
                clauses, args = ['r.id=?'], [detail_id]
                limit = 1
            else:
                start, end = time_range(params)
                clauses += ['r.ts>=?', 'r.ts<?']
                args += [start, end]
                status = params.get('status', '')
                if status not in {'', 'ok', 'failed'}:
                    raise ValueError('invalid status')
                if status:
                    clauses.append('r.failed=?')
                    args.append(int(status == 'failed'))
                if params.get('before'):
                    cursor = self.conn.execute('SELECT ts,id FROM requests WHERE id=?',
                                               (positive_int(params['before']),)).fetchone()
                    if cursor is None:
                        raise ValueError('cursor expired or unknown')
                    clauses.append('(r.ts,r.id)<(?,?)')
                    args.extend(cursor)
                if params.get('q'):
                    clauses.append("(m.name LIKE ? ESCAPE '\\' OR a.label LIKE ? ESCAPE '\\' OR k.key_masked LIKE ? ESCAPE '\\' OR r.request_id LIKE ? ESCAPE '\\' OR r.error LIKE ? ESCAPE '\\')")
                    query = '%' + params['q'][:300].replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
                    args.extend([query] * 5)
                limit = min(200, positive_int(params.get('limit', '50')))
            sql = f'''SELECT r.*, p.name provider_name, m.name model_name, a.auth_index,
            a.label, a.via, k.key_id, k.key_masked, e.name endpoint_name FROM requests r
            {self.joins('r')} JOIN endpoints e ON e.id=r.endpoint
            WHERE {" AND ".join(clauses)} ORDER BY r.ts DESC,r.id DESC LIMIT ?'''
            rows = self.conn.execute(sql, args + [limit + (detail_id is None)]).fetchall()
            items = []
            for row in rows[:limit]:
                item = {k: row[k] for k in ('id', 'ts', 'source_origin', 'alias', 'stream', *TOKEN_FIELDS,
                                          'cost_usd', 'latency_ms', 'ttft_ms', 'status_code', 'failed', 'error')}
                item.update(provider=row['provider_name'], model=row['model_name'],
                            account_id=row['auth_index'], account_label=row['label'], via=row['via'],
                            key_id=row['key_id'], key_masked=row['key_masked'], endpoint=row['endpoint_name'])
                item['stream'], item['failed'] = bool(item['stream']), bool(item['failed'])
                if detail_id is not None:
                    item.update(request_id=row['request_id'], user_agent=row['user_agent'], priced=bool(row['priced']))
                elif item['error'] is not None:
                    item['error'] = item['error'][:200]
                items.append(item)
            if detail_id is not None:
                return items[0] if items else None
            return {'items': items, 'next_before': items[-1]['id'] if len(rows) > limit else None}


def positive_int(value):
    result = int(value)
    if result <= 0:
        raise ValueError('expected positive integer')
    return result


def time_range(params):
    end = int(params.get('to', now_ms()))
    start = int(params.get('from', end - DAY))
    if start < 0 or end <= start or end > 253402214400000:
        raise ValueError('invalid time range')
    return start, end


class LBReader:
    """Copied persistent mode=ro/query_only pattern from codex_lb_status.py.

    No immutable=1: the live store is WAL. Autocommit leaves no read transaction
    pinned between calls. An open connection keeps codex-lb's WAL sidecars alive.
    """
    def __init__(self, path):
        self.path, self.conn, self.inode = Path(path), None, None

    def close(self):
        if self.conn is not None:
            self.conn.close()
        self.conn, self.inode = None, None

    @contextmanager
    def connection(self):
        inode = self.path.stat().st_ino
        if self.conn is not None and inode != self.inode:
            self.close()
        if self.conn is None:
            conn = sqlite3.connect(f'file:{quote(str(self.path), safe="/")}?mode=ro', uri=True,
                                   timeout=2, isolation_level=None)
            conn.row_factory = sqlite3.Row
            conn.execute('PRAGMA query_only=ON')
            conn.execute('PRAGMA cache_size=-2048')
            self.conn, self.inode = conn, inode
        deadline = time.monotonic() + 4
        self.conn.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
        try:
            yield self.conn
        except sqlite3.Error:
            self.close()
            raise
        finally:
            if self.conn is not None:
                self.conn.set_progress_handler(None, 0)

    def resolve_routes(self, document):
        entries = document if isinstance(document, list) else document.get('codex-api-key', [])
        result = {}
        with self.connection() as conn:
            keys = conn.execute('SELECT id,key_prefix FROM api_keys WHERE key_prefix IS NOT NULL').fetchall()
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                try:
                    url = urlsplit(entry.get('base-url', ''))
                    is_lb = url.hostname in {'127.0.0.1', 'localhost'} and url.port == 2455
                except ValueError:
                    continue
                if not is_lb or not entry.get('auth-index'):
                    continue
                raw = entry.get('api-key', '')
                matches = [k['id'] for k in keys if k['key_prefix'] and raw.startswith(k['key_prefix'])]
                # A common prefix or duplicate prefix must not select a random account.
                key_id = matches[0] if len(matches) == 1 else None
                label = ''
                if key_id is not None:
                    latest = conn.execute('''SELECT a.email FROM request_logs r
                        LEFT JOIN accounts a ON a.id=r.account_id WHERE r.api_key_id=?
                        ORDER BY r.requested_at DESC,r.id DESC LIMIT 1''', (key_id,)).fetchone()
                    label = latest[0] or '' if latest else ''
                auth = clean(entry['auth-index'], (raw,), 200)
                result[auth] = {'label': clean(label, (raw,), 300), 'lb_key_id': key_id}
        return result

    def backfill(self, store, routes, limit=500):
        cutoff = store.meta('first_queue_ns')
        if cutoff is None or store.meta('backfill_done') == '1':
            return 0
        cursor = int(store.meta('backfill_id', '0'))
        with self.connection() as conn:
            key_ids = [row[0] for row in conn.execute(
                "SELECT id FROM api_keys WHERE name LIKE 'cliproxy-%'").fetchall()]
            if not key_ids:
                return 0
            marks = ','.join('?' * len(key_ids))
            # Filter by api_key_id first (indexed): a scan over every log row by id
            # would read most of codex-lb's multi-gigabyte table on each cycle.
            rows = conn.execute(f'''SELECT r.id,r.requested_at,r.account_id,r.api_key_id,
                r.input_tokens,r.cached_input_tokens,r.output_tokens,r.reasoning_tokens,
                r.latency_ms,r.latency_first_token_ms,r.status,r.error_message,
                r.upstream_status_code,r.model,a.email FROM request_logs r
                LEFT JOIN accounts a ON a.id=r.account_id
                WHERE r.api_key_id IN ({marks}) AND r.id>?
                ORDER BY r.id LIMIT ?''', (*key_ids, cursor, limit)).fetchall()
        if not rows:
            with store.transaction():
                store.set_meta('backfill_done', '1')
            return 0
        imported = 0
        reached_cutoff = False
        with store.transaction():
            for row in rows:
                ns = timestamp_ns(row['requested_at'])
                # Rows from the queue's first record on are already stored from the
                # gateway; once one appears, history before it is complete.
                reached_cutoff = reached_cutoff or ns >= int(cutoff)
                if ns < int(cutoff):
                    route_ids = [auth for auth, route in routes.items() if route['lb_key_id'] == row['api_key_id']]
                    auth = route_ids[0] if len(route_ids) == 1 else 'codex-lb:' + str(row['account_id'] or 'unknown')
                    # codex-lb logs know the upstream routing key, not the gateway's
                    # client key. Preserve that missing attribution as the empty key.
                    record = normalize({'timestamp': row['requested_at'], 'provider': 'codex',
                                        'model': row['model'], 'auth_index': auth, 'source': row['email'],
                                        'tokens': {'input_tokens': row['input_tokens'],
                                                   'cached_tokens': row['cached_input_tokens'],
                                                   'output_tokens': row['output_tokens'],
                                                   'reasoning_tokens': row['reasoning_tokens']},
                                        'latency_ms': row['latency_ms'], 'ttft_ms': row['latency_first_token_ms'],
                                        'failed': row['status'] != 'success',
                                        'fail': {'status_code': row['upstream_status_code'],
                                                 'body': row['error_message']}}, {})
                    record['source_origin'], record['via'] = 'codex-lb', 'codex-lb'
                    store.insert(record)
                    imported += 1
                # Advancing over excluded rows is atomic with the imported rows.
                store.set_meta('backfill_id', row['id'])
            if reached_cutoff:
                store.set_meta('backfill_done', '1')
        return imported


class AuthFailure(Exception):
    pass


class Gateway:
    """Direct HTTP to a fixed loopback address. No redirects, proxies or URL inputs."""
    def __init__(self, credential_path):
        self.credential_path = Path(credential_path)
        self.key = ''
        self.failures = 0
        self.retry_at = 0.0

    def get(self, path):
        key = self.credential_path.read_text().strip()
        if not key or '\n' in key or '\r' in key:
            raise ValueError('invalid credential')
        if key != self.key:
            self.key, self.failures, self.retry_at = key, 0, 0
        # Four failures are enough to identify a bad credential. Refuse a fifth
        # consecutive attempt until the credential changes or the process restarts.
        if time.monotonic() < self.retry_at or self.failures >= 4:
            raise AuthFailure()
        conn = http.client.HTTPConnection('127.0.0.1', 8317, timeout=5)
        try:
            conn.request('GET', path, headers={'Authorization': 'Bearer ' + key, 'Accept': 'application/json'})
            response = conn.getresponse()
            if response.status in {401, 403}:
                self.failures += 1
                self.retry_at = time.monotonic() + 60
                raise AuthFailure()
            if response.status != 200:
                raise OSError('gateway unavailable')
            self.failures = 0
            # Bound both size and elapsed time. read1 yields after a socket read;
            # read(n) may let a trickling peer keep the call alive indefinitely.
            deadline, chunks, size = time.monotonic() + 10, [], 0
            while True:
                if time.monotonic() >= deadline:
                    raise TimeoutError('gateway response deadline')
                if conn.sock is not None:
                    conn.sock.settimeout(min(5, max(.001, deadline - time.monotonic())))
                chunk = response.read1(min(65536, MAX_BODY + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > MAX_BODY:
                    raise ValueError('gateway batch too large')
            return json.loads(b''.join(chunks))
        finally:
            conn.close()


class Collector:
    def __init__(self, store, lb, gateway):
        self.store, self.lb, self.gateway = store, lb, gateway
        self.stop = threading.Event()
        self.pending = None
        with store.lock:
            self.routes = json.loads(store.meta('routes', '{}'))
        self.next_routes, self.next_prune = 0.0, 0.0

    def once(self):
        # A pending batch has priority over all network and maintenance activity.
        if self.pending is not None:
            self.store.ingest(self.pending, self.routes, self.gateway.key)
            self.pending = None
        if time.monotonic() >= self.next_prune:
            self.store.prune(reserve=BATCH_RESERVE)
            self.next_prune = time.monotonic() + 86400
        # Fetch routing before the first queue pop, but an unavailable source DB
        # must not prevent queue collection. Retry independently on the next cycle.
        if time.monotonic() >= self.next_routes:
            try:
                document = self.gateway.get('/v0/management/codex-api-key')
                routes = self.lb.resolve_routes(document)
                with self.store.transaction():
                    self.store.set_meta('routes', json.dumps(routes, separators=(',', ':')))
                self.routes = routes
                self.next_routes = time.monotonic() + 300
            except AuthFailure:
                raise
            except (OSError, ValueError, sqlite3.Error, http.client.HTTPException):
                self.next_routes = time.monotonic() + 5
                sys.stderr.write('route refresh unavailable\n')
                raise OSError('route refresh unavailable') from None
        while not self.stop.is_set():
            with self.store.lock:
                if not self.store.can_pop():
                    self.store.prune(reserve=BATCH_RESERVE)
                if not self.store.can_pop():
                    raise OSError('storage reserve unavailable')
            batch = self.gateway.get('/v0/management/usage-queue?count=500')
            if not isinstance(batch, list):
                raise ValueError('queue response is not an array')
            self.pending = batch
            self.store.ingest(batch, self.routes, self.gateway.key)
            self.pending = None
            if len(batch) < 500:
                break
        if self.store.can_pop() and time.monotonic() >= getattr(self, 'next_backfill', 0):
            try:
                self.lb.backfill(self.store, self.routes)
            except (OSError, ValueError, sqlite3.Error) as error:
                # Back off so a failing read never hammers codex-lb's database.
                self.next_backfill = time.monotonic() + 60
                sys.stderr.write(f'backfill unavailable: {type(error).__name__}\n')

    def run(self):
        while not self.stop.is_set() or self.pending is not None:
            delay = 3
            try:
                if self.stop.is_set():
                    self.store.ingest(self.pending, self.routes, self.gateway.key)
                    self.pending = None
                else:
                    self.once()
            except AuthFailure:
                delay = 60
                sys.stderr.write('management authentication unavailable\n')
            except (OSError, ValueError, TypeError, sqlite3.Error, http.client.HTTPException):
                delay = 5
                # Never log exception strings: they can contain raw response data.
                sys.stderr.write('collection unavailable; retrying\n')
            if self.stop.is_set() and self.pending is not None:
                time.sleep(.5)
            else:
                self.stop.wait(delay)
        self.lb.close()


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
    server_version = "intent-usage-collector"
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
        if (not self._allowed() or len(self.headers.get_all('Host', [])) != 1
                or self.headers.get('Transfer-Encoding') is not None
                or self.headers.get('Content-Length') not in (None, '0')):
            self._send(403, b'{"error":"forbidden"}')
            return
        try:
            url = urlsplit(self.path)
            if url.scheme or url.netloc:
                raise ValueError('absolute request target')
            values = parse_qs(url.query, keep_blank_values=True, max_num_fields=24)
            if any(len(v) != 1 for v in values.values()):
                raise ValueError('duplicate parameters')
            params = {k: v[0] for k, v in values.items()}
            if url.path == '/v1/health':
                result = self.server.store.health()
            elif url.path == '/v1/summary':
                result = self.server.store.summary(params)
            elif url.path == '/v1/requests':
                result = self.server.store.requests(params)
            elif re.fullmatch(r'/v1/requests/[0-9]+', url.path):
                result = self.server.store.requests({}, int(url.path.rsplit('/', 1)[-1]))
                if result is None:
                    self._send(404, b'{"error":"not found"}')
                    return
            else:
                self._send(404, b'{"error":"not found"}')
                return
            self._send(200, json.dumps(result, separators=(',', ':'), allow_nan=False).encode())
        except (ValueError, ZoneInfoNotFoundError, OverflowError):
            self._send(400, b'{"error":"invalid parameters"}')
        except (sqlite3.Error, OSError):
            self._send(503, b'{"error":"database unavailable"}', {'Retry-After': '5'})

    def _method_not_allowed(self):
        self._send(405, b'{"error":"method not allowed"}', {'Allow': 'GET'})

    do_HEAD = do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_TRACE = _method_not_allowed

    def send_error(self, code, message=None, explain=None):
        self._send(code, json.dumps({'error': 'invalid request'}).encode())

    def log_message(self, fmt, *args):
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
    state = Path(os.environ.get('STATE_DIRECTORY', '/var/lib/intent-usage'))
    credential = Path(os.environ['CREDENTIALS_DIRECTORY']) / 'management-key'
    with Path(__file__).with_name('prices.json').open() as source:
        pricing = Pricing(json.load(source))
    store = Store(state / 'usage.db', pricing)
    collector = Collector(store, LBReader('/var/lib/intent-lb/codex/store.db'), Gateway(credential))
    server = Server((HOST, PORT), Handler)
    server.store = store
    # serve_forever runs on main; shutdown must be invoked from another thread.
    def shutdown(signum, frame):
        collector.stop.set()
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    worker = threading.Thread(target=collector.run, name='collector', daemon=True)
    worker.start()
    try:
        server.serve_forever(poll_interval=.5)
    finally:
        collector.stop.set()
        server.server_close()
        worker.join(timeout=15)
        # A pending in-memory batch must finish or remain alive until systemd's
        # stop timeout. Closing its connection underneath it would lose the batch.
        if worker.is_alive():
            worker.join()
        store.close()


if __name__ == '__main__':
    main()
