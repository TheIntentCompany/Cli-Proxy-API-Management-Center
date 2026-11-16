#!/usr/bin/python3 -I
"""Synthetic tests. No sockets, live databases, credentials or endpoints are used."""
import importlib.util
import json
import sqlite3
import sys
import tempfile
import threading
import hashlib
from datetime import datetime, timezone
import unittest
from email.message import Message
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('usage_collector', ROOT / 'usage_collector.py')
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)
spec = importlib.util.spec_from_file_location('build_prices', ROOT / 'build_prices.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)

RAW = 'sk-synthetic-client-only-12345'
TOKEN_HASH = 'access-token-hash-synthetic-do-not-store'
BASE = u.timestamp_ns('2026-11-14T00:00:00Z') // 1_000_000
RATES = {'input_cost_per_token': .000001, 'output_cost_per_token': .000004,
         'cache_read_input_token_cost': .0000001, 'cache_creation_input_token_cost': .000002,
         'cache_creation_input_token_cost_above_1hr': .000003}
DOCUMENT = {'source': {'name': 'fixture', 'url': 'https://example.invalid/prices', 'fetched_at': '2026-11-14'},
            'models': {'anthropic/test-claude': RATES, 'openai/test-codex': RATES}}


def record(**overrides):
    result = {'timestamp': '2026-11-14T00:00:00.123456789Z', 'latency_ms': 250,
              'ttft_ms': 75, 'provider': 'claude', 'model': 'test-claude', 'source': 'person@example.invalid',
              'auth_index': '0123456789abcdef', 'api_key': RAW, 'access_token_sha256': TOKEN_HASH,
              'endpoint': 'POST /v1/messages', 'stream': True, 'request_id': 'req-fixture',
              'user_agent': 'fixture', 'tokens': {'input_tokens': 100, 'output_tokens': 30,
                  'reasoning_tokens': 10, 'cache_read_tokens': 20, 'cache_creation_tokens': 12,
                  'cache_creation_5m_tokens': 4, 'cache_creation_1h_tokens': 5}, 'failed': False}
    result.update(overrides)
    return result


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.store = u.Store(self.path / 'usage.db', u.Pricing(DOCUMENT))
        self.addCleanup(self.store.close)

    def params(self, **values):
        return {'from': str(BASE), 'to': str(BASE + 3 * u.HOUR), **values}

    def fake_lb(self):
        path = self.path / 'lb.db'
        conn = sqlite3.connect(path)
        conn.executescript('''PRAGMA journal_mode=WAL;
          CREATE TABLE api_keys(id INTEGER PRIMARY KEY,name TEXT,key_prefix TEXT);
          CREATE TABLE accounts(id INTEGER PRIMARY KEY,email TEXT);
          CREATE TABLE request_logs(id INTEGER PRIMARY KEY,requested_at TEXT,account_id INTEGER,
            api_key_id INTEGER,input_tokens INTEGER,cached_input_tokens INTEGER,output_tokens INTEGER,
            reasoning_tokens INTEGER,latency_ms INTEGER,latency_first_token_ms INTEGER,status TEXT,
            error_message TEXT,upstream_status_code INTEGER,model TEXT);
          INSERT INTO api_keys VALUES(1,'cliproxy-fixture','upstream-prefix-');
          INSERT INTO api_keys VALUES(2,'other','different-prefix-');
          INSERT INTO accounts VALUES(1,'lb@example.invalid');
        ''')
        self.addCleanup(conn.close)
        def add(ident, ts, key=1, status='success'):
            conn.execute('INSERT INTO request_logs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                         (ident, ts, 1, key, 100, 20, 30, 10, 300, 50, status, 'fixture-error',
                          200 if status == 'success' else 503, 'test-codex'))
            conn.commit()
        reader = u.LBReader(path)
        self.addCleanup(reader.close)
        return reader, conn, add

    def test_codex_lb_limit_history_backfill(self):
        reader, conn, _ = self.fake_lb()
        conn.executescript('''
          CREATE TABLE api_key_accounts(api_key_id INTEGER, account_id INTEGER);
          CREATE TABLE usage_history(id INTEGER PRIMARY KEY, account_id INTEGER, recorded_at TEXT,
            "window" TEXT, used_percent REAL, reset_at INTEGER, window_minutes INTEGER);
          INSERT INTO api_key_accounts VALUES(1,1);
          INSERT INTO usage_history VALUES(1,1,'2026-11-14 00:00:00.000001',NULL,10,1795000000,10080);
          INSERT INTO usage_history VALUES(2,1,'2026-11-14 00:05:00.000001',NULL,10,1795000000,10080);
          INSERT INTO usage_history VALUES(3,1,'2026-11-14 01:00:00.000001',NULL,25,1795000000,10080);
          INSERT INTO usage_history VALUES(4,1,'2026-11-14 01:00:00.000001','secondary',0,NULL,0);
        ''')
        conn.commit()
        since = int(datetime(2026, 11, 13, tzinfo=timezone.utc).timestamp() * 1000)
        history = reader.limit_history(since)
        handle = hashlib.sha256(b'1').hexdigest()[:16]
        # Repeated readings collapse to change points; a zero-minute window is kept but unmapped.
        self.assertEqual([(p[1], p[2]) for p in history[handle]], [(10080, 10), (10080, 25), (0, 0)])
        poller = u.QuotaPoller(self.store, None, threading.Event(), lb=reader)
        poller.writer = u.QuotaWriter(self.store)
        poller.read_lb_history(since + 10 * u.DAY)
        poller.read_lb_history(since + 10 * u.DAY)
        key = u.quota_account('codex', handle, via='codex-lb')['key']
        rows = self.store.conn.execute(
            'SELECT kind, used_percent, resets_at FROM quota_samples WHERE key=? ORDER BY ts', (key,)).fetchall()
        self.assertEqual([tuple(row) for row in rows], [('weekly', 10.0, 1795000000000), ('weekly', 25.0, 1795000000000)])

    def test_tokens_pricing_and_secrets(self):
        failed = record(failed=True, fail={'status_code': 429, 'body': RAW + TOKEN_HASH + 'x' * 2500},
                        user_agent=RAW, request_id=TOKEN_HASH)
        codex = record(provider='codex', model='test-codex',
                       tokens={'input_tokens': 100, 'cached_tokens': 40, 'output_tokens': 20,
                               'reasoning_tokens': 8})
        self.store.ingest([record(), json.dumps(codex), failed])
        rows = self.store.requests(self.params(limit='200'))['items']
        self.assertEqual(rows[2]['input_uncached'], 100)
        self.assertEqual(rows[2]['cache_write_5m'], 7)
        self.assertEqual(rows[2]['cache_write_1h'], 5)
        self.assertEqual(rows[1]['input_uncached'], 60)
        self.assertEqual(rows[1]['cache_read'], 40)
        self.assertAlmostEqual(rows[2]['cost_usd'], 100e-6 + 20e-7 + 7*2e-6 + 5*3e-6 + 30*4e-6)
        self.assertEqual(len(rows[0]['error']), 200)
        detail = self.store.requests({}, rows[0]['id'])
        self.assertEqual(len(detail['error']), 2000)
        self.assertNotIn(RAW, json.dumps(detail))
        self.assertNotIn(TOKEN_HASH, json.dumps(detail))
        self.assertEqual(detail['request_id'], '[redacted]')
        self.assertEqual(detail['user_agent'], '[redacted]')
        self.store.conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        for path in self.path.glob('usage.db*'):
            payload = path.read_bytes()
            self.assertNotIn(RAW.encode(), payload)
            self.assertNotIn(TOKEN_HASH.encode(), payload)
        for response in (self.store.health(), self.store.summary(self.params()),
                         self.store.requests(self.params()), detail):
            self.assertNotIn(RAW, json.dumps(response))
            self.assertNotIn(TOKEN_HASH, json.dumps(response))

    def test_breakdown_precedence_clamping_and_output(self):
        value = record(tokens={'cache_creation_5m_tokens': 2, 'cache_creation_1h_tokens': 8},
                       token_breakdown={'input': {'uncached_tokens': 11, 'cache_read_tokens': 12,
                                                   'cache_write_tokens': 10},
                                        'output': {'total_tokens': 14, 'reasoning_tokens': 9}})
        row = u.normalize(value, {})
        self.assertEqual(tuple(row[k] for k in u.TOKEN_FIELDS), (11, 12, 2, 8, 14, 9))
        self.assertAlmostEqual(u.Pricing(DOCUMENT).cost('test-claude', row),
                               11e-6 + 12e-7 + 2*2e-6 + 8*3e-6 + 14*4e-6)
        value['token_breakdown']['input']['cache_write_tokens'] = 3
        self.assertEqual(u.tokens_of(value)['cache_write_1h'], 3)
        self.assertEqual(u.tokens_of(record(provider='openai', tokens={'input_tokens': 1, 'cached_tokens': 5}))['input_uncached'], 0)

    def test_summary_filters_empty_buckets_and_histograms(self):
        self.store.ingest([record(), record(provider='codex', model='test-codex', auth_index='route2',
                                            api_key='sk-other-fixture', timestamp='2026-11-14T01:01:00Z',
                                            failed=True, fail={'status_code': 500})])
        result = self.store.summary(self.params())
        self.assertEqual(result['totals']['requests'], 2)
        self.assertEqual(result['totals']['failed'], 1)
        self.assertEqual(len(result['series']), 3)
        self.assertEqual(result['series'][2]['requests'], 0)
        # Percentiles interpolate inside the log-spaced bins, so expect a band.
        self.assertGreaterEqual(result['totals']['latency_p50_ms'], 200)
        self.assertTrue(50 <= result['totals']['ttft_p50_ms'] <= 100)
        self.assertEqual(result['series'][0]['by_provider']['claude']['tokens'], 162)
        for params in ({'provider': 'codex'}, {'account': 'route2'}, {'model': 'test-codex'},
                       {'key': u.key_identity('sk-other-fixture')[0]}):
            filtered = self.store.summary(self.params(**params))
            self.assertEqual(filtered['totals']['requests'], 1)
            self.assertEqual(len(filtered['by_model']), 1)
            self.assertEqual(len(filtered['by_account']), 1)
            self.assertEqual(len(filtered['by_key']), 1)
            self.assertEqual(len(filtered['by_provider']), 1)
            self.assertEqual(sum(x['requests'] for x in filtered['series']), 1)
        self.store.conn.execute('DELETE FROM requests')
        self.assertEqual(self.store.summary(self.params())['totals']['requests'], 2)

    def test_day_buckets_dst_and_nonintegral_offset(self):
        self.store.ingest([record(timestamp='2026-11-01T07:00:00Z'),
                           record(timestamp='2026-11-02T07:59:00Z')])
        start = u.timestamp_ns('2026-11-01T07:00:00Z') // 1_000_000
        result = self.store.summary({'from': str(start), 'to': str(start + 25*u.HOUR),
                                     'bucket': 'day', 'tz': 'America/Los_Angeles'})
        self.assertEqual(len(result['series']), 1)
        self.assertEqual(result['series'][0]['requests'], 2)
        result = self.store.summary(self.params(bucket='day', tz='Asia/Kathmandu'))
        self.assertEqual(result['series'][0]['t'], BASE - (5*60 + 45)*60_000)

    def test_pagination_search_detail_and_status(self):
        self.store.ingest([record(request_id='find-me', alias='alias'), record(failed=True, fail={'body': 'oops'})])
        first = self.store.requests(self.params(limit='1'))
        second = self.store.requests(self.params(limit='1', before=str(first['next_before'])))
        self.assertGreater(first['items'][0]['id'], second['items'][0]['id'])
        self.assertIsNone(second['next_before'])
        self.assertEqual(len(self.store.requests(self.params(q='find-me'))['items']), 1)
        self.assertEqual(len(self.store.requests(self.params(status='failed'))['items']), 1)
        self.assertEqual(len(self.store.requests(self.params(q='oops'))['items']), 1)
        self.assertEqual(self.store.requests(self.params(q='%'))['items'], [])
        self.assertEqual(self.store.requests({}, second['items'][0]['id'])['alias'], 'alias')
        self.assertIsNone(self.store.requests({}, 999))
        with self.assertRaises(ValueError):
            self.store.requests(self.params(status='bad'))

    def test_retention_cap_and_free_floor_keep_rollups(self):
        self.store.ingest([record(timestamp='2026-01-01T00:00:00Z'), record()])
        self.assertEqual(self.store.prune(at=BASE, cap=10**10, free_floor=0), 1)
        self.assertEqual(self.store.conn.execute('SELECT sum(requests) FROM hourly').fetchone()[0], 2)
        with patch.object(self.store, 'db_bytes', side_effect=[200, 50]), patch.object(self.store, 'disk_free', return_value=1000):
            self.assertEqual(self.store.prune(at=BASE, cap=100, free_floor=0), 1)
        self.assertEqual(self.store.conn.execute('SELECT count(*) FROM requests').fetchone()[0], 0)
        self.store.ingest([record()])
        with patch.object(self.store, 'db_bytes', return_value=0), patch.object(self.store, 'disk_free', side_effect=[1, 1000]):
            self.assertEqual(self.store.prune(at=BASE, cap=10**9, free_floor=700), 1)
        self.assertEqual(self.store.conn.execute('PRAGMA auto_vacuum').fetchone()[0], 2)

    def test_route_mapping_backfill_nanosecond_boundary_cursor(self):
        reader, conn, add = self.fake_lb()
        add(1, '2026-11-14T00:00:00.123456788Z')
        add(2, '2026-11-14T00:00:00.123456789Z')
        add(3, '2026-11-14T00:00:00.123456790Z')
        add(4, '2026-01-01T00:00:00Z', key=2)
        routes = reader.resolve_routes({'codex-api-key': [
            {'base-url': 'http://localhost:2455/v1', 'api-key': 'upstream-prefix-fixture', 'auth-index': 'route-lb'},
            {'base-url': 'http://localhost:2456/v1', 'api-key': 'upstream-prefix-fixture', 'auth-index': 'not-lb'}]})
        self.assertEqual(set(routes), {'route-lb'})
        self.assertEqual(routes['route-lb']['label'], 'lb@example.invalid')
        self.assertEqual(reader.backfill(self.store, routes), 0)
        self.store.ingest([record(auth_index='route-lb')], routes)
        self.assertEqual(reader.backfill(self.store, routes, limit=1), 1)
        self.assertEqual(reader.backfill(self.store, routes, limit=1), 0)
        self.assertEqual(reader.backfill(self.store, routes, limit=1), 0)
        self.assertEqual(reader.backfill(self.store, routes), 0)
        # The first row at or past the queue's first record ends the backfill.
        self.assertEqual(self.store.meta('backfill_id'), '2')
        self.assertEqual(self.store.meta('backfill_done'), '1')
        rows = self.store.requests(self.params())['items']
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['source_origin'], 'codex-lb')
        self.assertEqual(rows[0]['account_id'], 'route-lb')
        self.assertEqual(rows[0]['input_uncached'], 80)
        self.assertEqual(rows[0]['key_id'], '')
        self.assertEqual(rows[1]['via'], 'codex-lb')
        original = reader.conn
        with reader.connection() as ro:
            self.assertIs(ro, original)
            self.assertEqual(ro.execute('PRAGMA query_only').fetchone()[0], 1)
            with self.assertRaises(sqlite3.OperationalError):
                ro.execute('DELETE FROM api_keys')
        # Transaction rollback must leave both rollups and cursor unchanged.
        with self.store.transaction():
            self.store.set_meta('backfill_done', '0')
        add(5, '2026-11-13T00:00:00Z', status='error')
        with patch.object(self.store, 'insert', side_effect=sqlite3.OperationalError()):
            with self.assertRaises(sqlite3.OperationalError):
                reader.backfill(self.store, routes)
        self.assertEqual(self.store.meta('backfill_id'), '2')
        self.assertEqual(reader.backfill(self.store, routes), 1)

    def test_real_size_cap_reclaims_raw_pages(self):
        rows = [record(timestamp=f'2026-11-{day:02d}T00:00:00Z', failed=True,
                       fail={'body': 'fixture-padding-' * 200}, request_id=str(i))
                for day in (12, 13, 14) for i in range(100)]
        self.store.ingest(rows)
        self.store.reclaim()
        original_bytes = self.store.db_bytes()
        cap = original_bytes - 100_000
        removed = self.store.prune(at=BASE, cap=cap, free_floor=0)
        self.assertGreaterEqual(removed, 100)
        self.assertLessEqual(self.store.db_bytes(), cap)
        self.assertEqual(self.store.conn.execute('SELECT sum(requests) FROM hourly').fetchone()[0], 300)

    def test_pagination_orders_out_of_order_arrivals_by_time(self):
        self.store.ingest([record(timestamp='2026-11-14T02:00:00Z'),
                           record(timestamp='2026-11-14T00:00:00Z'),
                           record(timestamp='2026-11-14T01:00:00Z')])
        first = self.store.requests(self.params(limit='1'))
        second = self.store.requests(self.params(limit='1', before=str(first['next_before'])))
        third = self.store.requests(self.params(limit='1', before=str(second['next_before'])))
        self.assertEqual([x['items'][0]['id'] for x in (first, second, third)], [1, 3, 2])

    def test_transaction_rolls_back_and_cutoff_survives_restart(self):
        with patch.object(self.store, 'insert', side_effect=sqlite3.OperationalError()):
            with self.assertRaises(sqlite3.OperationalError):
                self.store.ingest([record()])
        self.assertIsNone(self.store.meta('first_queue_ns'))
        self.store.ingest([record()])
        cutoff = self.store.meta('first_queue_ns')
        self.store.ingest([record(timestamp='2026-01-01T00:00:00Z')])
        self.assertEqual(self.store.meta('first_queue_ns'), cutoff)
        reopened = u.Store(self.store.path, self.store.pricing)
        self.addCleanup(reopened.close)
        self.assertEqual(reopened.meta('first_queue_ns'), cutoff)
        self.assertEqual(reopened.health()['records_total'], 2)

    def test_collector_full_batches_and_pending_retry(self):
        gateway = SimpleNamespace(key='fixture-management', get=unittest.mock.Mock(side_effect=[
            [record()] * 500, [record()]]))
        lb = SimpleNamespace(resolve_routes=lambda doc: {}, backfill=lambda *args: 0)
        worker = u.Collector(self.store, lb, gateway)
        with patch.object(self.store, 'prune'), patch.object(self.store, 'can_pop', return_value=True), patch.object(u.threading.Thread, 'start'):
            worker.once()
        self.assertEqual(self.store.health()['records_total'], 501)
        self.assertEqual(gateway.get.call_count, 2)
        gateway.get = unittest.mock.Mock(return_value=[record()])
        worker.next_routes = float('inf')
        with patch.object(self.store, 'can_pop', return_value=True), patch.object(self.store, 'ingest', side_effect=sqlite3.OperationalError()):
            with self.assertRaises(sqlite3.OperationalError):
                worker.once()
        self.assertIsNotNone(worker.pending)
        gateway.get.reset_mock()
        with patch.object(self.store, 'can_pop', return_value=False), patch.object(self.store, 'prune'):
            with self.assertRaises(OSError):
                worker.once()
        gateway.get.assert_not_called()
        self.assertIsNone(worker.pending)
        self.assertEqual(self.store.health()['records_total'], 502)

    def test_slow_route_refresh_does_not_block_queue(self):
        import threading
        entered, release = threading.Event(), threading.Event()
        def slow(path):
            entered.set()
            release.wait(2)
            raise TimeoutError('synthetic response must never be logged')
        gateway = SimpleNamespace(key='fixture', credential_path='fixture', get=lambda path: [record()])
        lb = SimpleNamespace(resolve_routes=lambda doc: {}, backfill=lambda *args: 0, close=lambda: None)
        worker = u.Collector(self.store, lb, gateway)
        with patch.object(u.Gateway, 'get', side_effect=slow), patch.object(self.store, 'prune'):
            worker.once()
            self.assertTrue(entered.wait(1))
            worker.once()
            self.assertEqual(self.store.health()['records_total'], 2)
            release.set()
            worker.maintenance.join(2)

    def test_read_snapshot_does_not_hold_ingestion_lock(self):
        import threading
        self.store.ingest([record()])
        finished = threading.Event()
        with self.store.read():
            self.assertEqual(self.store.conn.execute('select count(*) from requests').fetchone()[0], 1)
            def write():
                self.store.ingest([record()])
                finished.set()
            thread = threading.Thread(target=write)
            thread.start()
            self.assertTrue(finished.wait(1))
            self.assertEqual(self.store.conn.execute('select count(*) from requests').fetchone()[0], 1)
        thread.join()
        self.assertEqual(self.store.health()['records_total'], 2)

    def test_summary_cache_coalesces_and_expires(self):
        self.store.ingest([record()])
        with patch.object(self.store, '_summary', wraps=self.store._summary) as calculate:
            first = self.store.summary(self.params())
            self.store.summary(self.params())
            self.assertEqual(calculate.call_count, 1)
            with patch.object(u.time, 'monotonic', return_value=u.time.monotonic() + 11):
                self.store.summary(self.params())
            self.assertEqual(calculate.call_count, 2)
            self.assertEqual(first['totals']['requests'], 1)

    def test_http_contract_host_origin_methods_and_parameters(self):
        self.store.ingest([record()])
        def call(path, host='127.0.0.1:8337', origin=None, method='GET', peer='127.0.0.1'):
            handler = object.__new__(u.Handler)
            handler.path, handler.command = path, method
            handler.client_address = (peer, 1)
            handler.headers = Message()
            handler.headers['Host'] = host
            if origin is not None:
                handler.headers['Origin'] = origin
            handler.server = SimpleNamespace(store=self.store)
            result = []
            handler._send = lambda status, body, extra=None: result.append((status, json.loads(body)))
            getattr(handler, 'do_' + method)()
            return result[0]
        for path in ['/v1/health', '/v1/pool', '/v1/pool?from='+str(BASE)+'&to='+str(BASE+u.HOUR),
                     '/v1/summary?from='+str(BASE)+'&to='+str(BASE+u.HOUR),
                     '/v1/requests?from='+str(BASE)+'&to='+str(BASE+u.HOUR), '/v1/requests/1']:
            self.assertEqual(call(path)[0], 200)
        self.assertEqual(call('/v1/health', host='attacker.invalid')[0], 403)
        self.assertEqual(call('/v1/health', origin='null')[0], 403)
        self.assertEqual(call('/v1/health', peer='192.0.2.1')[0], 403)
        self.assertEqual(call('/v1/health', method='POST')[0], 405)
        self.assertEqual(call('/v1/requests/999')[0], 404)
        self.assertEqual(call('/v1/summary?bucket=week')[0], 400)
        self.assertEqual(call('/v1/summary?tz=MadeUp/Zone')[0], 400)
        self.assertEqual(call('/v1/requests?limit=0')[0], 400)
        self.assertEqual(call('/v1/requests?limit=1&limit=2')[0], 400)
        self.assertEqual(call('/v1/pool?from=2&to=1')[0], 400)
        self.assertEqual(call('http://localhost:8337/v1/health')[0], 400)


class QuotaTests(unittest.TestCase):
    setUp = Fixture.setUp

    def writer(self):
        writer = u.QuotaWriter(self.store)
        self.addCleanup(writer.close)
        return writer

    def account(self, provider='claude'):
        return u.quota_account(provider, provider + '-fixture.json', label='seat@example.invalid',
                               file_name=provider + '-fixture.json', auth_index='fixture-index')

    def poller(self, entries=()):
        import threading
        gateway = SimpleNamespace(key='fixture-management', get=unittest.mock.Mock(
            return_value={'files': list(entries)}), request=unittest.mock.Mock())
        poller = u.QuotaPoller(self.store, gateway, threading.Event(), self.path / 'seats.json')
        poller.writer = self.writer()
        return poller

    def seat_document(self, at=BASE):
        name = 'claude-27cd370d-seat@example.invalid.json'
        reading = {'observed_at': '2026-11-14T00:00:00Z', 'source': 'usage-endpoint',
            'windows': [{'kind': 'five_hour', 'utilization': 1.1, 'duration': 18_000_000_000_000,
                         'resets_at': '2026-11-14T05:00:00Z'},
                        {'kind': 'seven_day', 'utilization': .5, 'resets_at': '0001-01-01T00:00:00Z'},
                        {'kind': 'weekly_scoped', 'scope': 'Fable', 'utilization': .25,
                         'resets_at': '2026-11-21T00:00:00Z'}]}
        seats = [{'kind': 'five_hour', 'cycles': [{'resets_at': '2026-11-14T05:00:00Z',
            'samples': [[(at - 10000) / 1000, .1], [(at - 5000) / 1000, .2]]}],
            'locks': [{'from': at / 1000 - 60, 'to': at / 1000 + 600},
                      {'from': at / 1000 - 60, 'to': at / 1000 + 900, 'end': 'served'},
                      {'from': at / 1000 - 60, 'to': at / 1000 - 1},
                      {'from': at / 1000 - 60, 'to': at / 1000 + 1200, 'end': 'reset'}]}]
        return {'version': 1, 'readings': {name: reading}, 'seats': {name: seats}}

    def test_seat_windows_fable_sentinel_locks_and_labels(self):
        doc = self.seat_document()
        name = next(iter(doc['readings']))
        observed, windows, limited = u.seat_reading(doc['readings'][name], doc['seats'][name], BASE)
        self.assertEqual(observed, BASE)
        self.assertEqual([w['kind'] for w in windows], ['five_hour', 'weekly', 'fable'])
        self.assertAlmostEqual(windows[0]['used_percent'], 110)
        self.assertEqual(windows[0]['window_minutes'], 300)
        self.assertIsNone(windows[1]['resets_at'])
        self.assertEqual(limited, BASE + 600000)
        self.assertEqual(u.seat_label(name), 'seat@example.invalid')
        self.assertEqual(u.seat_label('claude-tc_584a69b4fc2e39a1.json'), 'claude-tc_584a69b4fc2e39a1')
        fallback = u.claude_windows({'five_hour': {'utilization': 103, 'resets_at': None},
            'seven_day': {'utilization': 12}, 'limits': [{'kind': 'weekly_scoped',
            'scope': {'model': {'display_name': 'Fable'}}, 'percent': 42}]})
        self.assertEqual([w['used_percent'] for w in fallback], [103, 12, 42])

    def test_history_import_idempotent_newer_cursor_and_restart(self):
        writer = self.writer()
        doc = self.seat_document()
        seats = next(iter(doc['seats'].values()))
        writer.import_seats('seat', seats, BASE)
        writer.import_seats('seat', seats, BASE)
        self.assertEqual(writer.conn.execute('SELECT count(*) FROM quota_samples').fetchone()[0], 2)
        seats[0]['cycles'][0]['samples'].extend([[(BASE - 15000) / 1000, .05], [BASE / 1000, .3]])
        writer.import_seats('seat', seats, BASE)
        self.assertEqual(writer.conn.execute('SELECT count(*) FROM quota_samples').fetchone()[0], 3)
        reopened = self.writer()
        reopened.import_seats('seat', seats, BASE)
        self.assertEqual(reopened.conn.execute('SELECT count(*) FROM quota_samples').fetchone()[0], 3)
        # A newer gateway point must not suppress Seat Pacer's older source history.
        writer.conn.execute('INSERT INTO quota_samples VALUES (?,?,?,?,?)', ('seat', 'weekly', BASE, 50, None))
        writer.import_seats('seat', [{'kind': 'seven_day', 'cycles': [{'samples': [[BASE/1000 - 5, .1]]}]}], BASE)
        self.assertEqual(writer.conn.execute("SELECT count(*) FROM quota_samples WHERE kind='weekly'").fetchone()[0], 2)

    def test_sample_dedup_reset_change_and_heartbeat(self):
        writer = self.writer()
        with writer.transaction():
            for ts, used, reset in [(BASE, 10, None), (BASE+60000, 10, None),
                    (BASE+1800000, 10, None), (BASE+1800001, 11, None),
                    (BASE+1800002, 11, BASE+u.DAY), (BASE-1, 12, None)]:
                writer.sample('seat', 'five_hour', ts, used, reset)
        rows = writer.conn.execute('SELECT ts FROM quota_samples ORDER BY ts').fetchall()
        self.assertEqual([r[0] for r in rows], [BASE, BASE+1800000, BASE+1800001, BASE+1800002])

    def test_codex_mapping_by_length_relative_reset_and_unknown_length(self):
        windows = u.codex_windows({'rate_limit': {
            'primary_window': {'limit_window_seconds': 604800, 'used_percent': 22, 'reset_at': BASE/1000+99},
            'secondary_window': {'limit_window_seconds': 18000, 'used_percent': 101, 'reset_after_seconds': 88}}}, BASE)
        self.assertEqual([w['kind'] for w in windows], ['weekly', 'five_hour'])
        self.assertEqual(windows[1]['resets_at'], BASE+88000)
        windows = u.codex_windows({'rate_limit': {'primary_window': {
            'limit_window_seconds': 2592000, 'used_percent': 3}}}, BASE)
        self.assertEqual(windows[0]['kind'], 'monthly')
        with self.assertRaises(ValueError):
            u.codex_windows({'rate_limit': {'primary_window': {
                'limit_window_seconds': 60, 'used_percent': 3}}}, BASE)

    def test_lb_mapping_deduplicates_accounts_preserves_source_times(self):
        account = {'id': 'hashed-account', 'email': 'lb@example.invalid', 'plan_type': 'pro',
            'status': 'limited', 'blocked_until': BASE/1000+30, 'reset_credits_available': 2,
            'details_recorded_at': '2026-11-13T23:00:00Z', 'windows': [
                {'kind': 'five_hour', 'used_percent': 90, 'reset_at': BASE/1000+60,
                 'window_minutes': 300, 'recorded_at': '2026-11-13T23:55:00Z'},
                {'kind': 'monthly', 'used_percent': 20, 'window_minutes': 43200,
                 'recorded_at': '2026-11-13T23:56:00Z'},
                {'kind': 'weekly', 'used_percent': 10, 'stale': True}]}
        values = u.lb_accounts({'keys': [{'key_prefix': RAW, 'accounts': [account]}, {'accounts': [account]}]}, BASE)
        self.assertEqual(len(values), 1)
        value = values[0]
        self.assertEqual(value['via'], 'codex-lb')
        self.assertEqual(value['observed_at'], BASE-300000)
        self.assertEqual(value['limited_until'], BASE+30000)
        self.assertEqual(value['banked_resets']['observed_at'], BASE-u.HOUR)
        self.assertEqual([w['kind'] for w in value['windows']], ['five_hour', 'monthly'])
        with patch.object(u, 'now_ms', return_value=BASE):
            self.writer().save(value)
        rows = self.store.conn.execute('SELECT kind,ts FROM quota_samples ORDER BY ts').fetchall()
        self.assertEqual([r['ts'] for r in rows], [BASE-300000, BASE-240000])
        self.assertNotIn('_sample_times', json.dumps(self.store.pool({})))
        self.assertNotIn(RAW, json.dumps(value))

    def test_banked_resets_exclude_expired_and_unavailable(self):
        claude = u.banked_resets('claude', {'cedar_ember': {'grants': [
            {'resets_total': 3, 'resets_left': 2, 'ends_at': '2026-11-15T00:00:00Z'},
            {'resets_total': 3, 'resets_left': 3, 'ends_at': '2026-11-13T00:00:00Z'},
            {'resets_total': 1, 'resets_left': 0, 'ends_at': '2026-11-14T01:00:00Z'}]}}, BASE)
        self.assertEqual(claude, {'available': 2, 'next_expires_at': BASE+u.DAY, 'observed_at': BASE})
        codex = u.banked_resets('codex', {'credits': [
            {'status': 'available', 'expires_at': '2026-11-15T00:00:00Z'},
            {'status': 'available', 'expires_at': BASE/1000+60},
            {'status': 'consumed', 'expires_at': BASE/1000+20},
            {'status': 'available', 'expires_at': BASE/1000-1}]}, BASE)
        self.assertEqual(codex['available'], 2)
        self.assertEqual(codex['next_expires_at'], BASE+60000)
        with self.assertRaises(KeyError):
            u.banked_resets('codex', {}, BASE)

    def test_fallback_uses_seat_freshness_not_last_gateway_read(self):
        name = next(iter(self.seat_document()['readings']))
        poller = self.poller([{'provider': 'claude', 'name': name, 'auth_index': 'index'}])
        poller.seat_path.write_text(json.dumps(self.seat_document()))
        poller.gateway.request.return_value = {'status_code': 200, 'body': json.dumps({
            'five_hour': {'utilization': 10}, 'cedar_ember': {'grants': []}})}
        with patch.object(u, 'now_ms', return_value=BASE), patch.object(u.time, 'monotonic', return_value=100), patch.object(u, 'loopback_json', return_value={'keys': []}):
            poller.tick()
        # Fresh Seat Pacer requires only the independent bank request.
        self.assertEqual(poller.gateway.request.call_count, 1)
        self.assertIn('cedar_ember', poller.gateway.request.call_args.args[2]['url'])
        poller.gateway.request.reset_mock()
        with patch.object(u, 'now_ms', return_value=BASE+16*60000), patch.object(u.time, 'monotonic', return_value=1060), patch.object(u, 'loopback_json', return_value={'keys': []}):
            poller.tick()
        self.assertEqual(poller.gateway.request.call_count, 1)
        self.assertEqual(poller.gateway.request.call_args.args[2]['url'], u.CLAUDE_URL)
        with patch.object(u, 'now_ms', return_value=BASE+17*60000), patch.object(u.time, 'monotonic', return_value=1120):
            poller.tick()
        self.assertEqual(poller.gateway.request.call_count, 1)
        with patch.object(u, 'now_ms', return_value=BASE+21*60000), patch.object(u.time, 'monotonic', return_value=1360), patch.object(u, 'loopback_json', return_value={'keys': []}):
            poller.tick()
        self.assertEqual(poller.gateway.request.call_count, 2)

    def test_missing_file_falls_back_and_error_is_category_only(self):
        poller = self.poller([{'provider': 'claude', 'name': 'claude-fixture.json', 'auth_index': 'index'}])
        poller.gateway.request.return_value = {'status_code': 200, 'body': json.dumps({
            'five_hour': {'utilization': 5}, 'cedar_ember': {'grants': []}})}
        with patch.object(u, 'now_ms', return_value=BASE), patch.object(u.time, 'monotonic', return_value=1), patch.object(u, 'loopback_json', return_value={'keys': []}), patch.object(u.sys, 'stderr'):
            poller.tick()
        self.assertEqual(poller.gateway.request.call_count, 2)
        result = self.store.pool({})
        self.assertEqual(result['accounts'][0]['source'], 'gateway')
        self.assertEqual(result['accounts'][0]['error'], 'io')
        self.assertEqual(self.store.health()['quota_errors']['seat-pacer'], 1)

    def test_codex_usage_discovery_and_bank_intervals(self):
        poller = self.poller([{'provider': 'codex', 'name': 'codex.json', 'auth_index': 'index'}])
        def response(method, path, payload):
            body = {'credits': []} if payload['url'].endswith('reset-credits') else {
                'rate_limit': {'primary_window': {'limit_window_seconds': 18000, 'used_percent': 5}}}
            return {'status_code': 200, 'body': json.dumps(body)}
        poller.gateway.request.side_effect = response
        with patch.object(poller, 'read_seats'), patch.object(poller, 'read_lb'):
            for clock, expected_calls, expected_discoveries in ((0, 2, 1), (239, 2, 1),
                    (240, 3, 1), (900, 4, 2), (1799, 5, 2), (1800, 6, 3)):
                with patch.object(u.time, 'monotonic', return_value=clock), patch.object(u, 'now_ms', return_value=BASE+clock*1000):
                    poller.tick()
                self.assertEqual(poller.gateway.request.call_count, expected_calls)
                self.assertEqual(poller.gateway.get.call_count, expected_discoveries)

    def test_bad_seat_and_lb_account_do_not_stop_other_accounts(self):
        poller = self.poller()
        document = self.seat_document()
        broken = json.loads(json.dumps(next(iter(document['readings'].values()))))
        broken['windows'][0]['utilization'] = RAW
        document['readings']['claude-bad.json'] = broken
        poller.seat_path.write_text(json.dumps(document))
        with patch.object(u.sys, 'stderr'), patch.object(u, 'now_ms', return_value=BASE):
            poller.read_seats(BASE, u.time.monotonic())
        accounts = self.store.pool({})['accounts']
        self.assertEqual(sorted(a['error'] or '' for a in accounts), ['', 'invalid_data'])
        bad, good = {'id': 'bad', 'windows': [{'kind': 'five_hour', 'used_percent': RAW}]}, {
            'id': 'good', 'windows': [{'kind': 'five_hour', 'used_percent': 4,
                'recorded_at': '2026-11-14T00:00:00Z', 'window_minutes': 300}]}
        with patch.object(u, 'loopback_json', return_value={'keys': [{'accounts': [bad, good]}]}), patch.object(u.sys, 'stderr'), patch.object(u, 'now_ms', return_value=BASE):
            poller.read_lb(BASE)
        lb = [a for a in self.store.pool({})['accounts'] if a['via']=='codex-lb']
        self.assertEqual(len(lb), 2)
        self.assertEqual(sorted(a['error'] or '' for a in lb), ['', 'invalid_data'])
        self.assertEqual(self.store.health()['quota_errors']['codex-lb'], 1)

    def test_shutdown_does_not_start_bank_after_slow_usage(self):
        poller = self.poller([{'provider': 'codex', 'name': 'codex.json', 'auth_index': 'index'}])
        def usage(account):
            poller.stop.set()
        with patch.object(poller, 'read_seats'), patch.object(poller, 'read_lb'), patch.object(poller, 'gateway_read', side_effect=usage) as read:
            poller.tick()
        self.assertEqual(read.call_count, 1)

    def test_backoff_is_per_account_operation_and_caps_at_hour(self):
        poller = self.poller()
        action = unittest.mock.Mock(side_effect=ValueError(RAW))
        clock = 10
        for delay in (300, 600, 1200, 2400, 3600, 3600):
            with patch.object(u.time, 'monotonic', return_value=clock), patch.object(u.sys, 'stderr'):
                poller.attempt('one', 'usage', 'gateway', 240, clock, action)
            self.assertEqual(poller.schedule['one', 'usage'][0], clock+delay)
            self.assertFalse(poller.due('one', 'usage', clock+delay-1))
            self.assertTrue(poller.due('two', 'usage', clock))
            self.assertTrue(poller.due('one', 'bank', clock))
            clock += delay
        with patch.object(u.time, 'monotonic', return_value=clock):
            poller.attempt('one', 'usage', 'gateway', 240, clock, lambda: None)
        self.assertEqual(poller.schedule['one', 'usage'], (clock+240, 0))
        self.assertEqual(self.store.health()['quota_errors']['gateway'], 6)
        self.assertNotIn(RAW, json.dumps(self.store.health()))

    def test_auth_metadata_proxy_headers_and_no_secrets_in_storage(self):
        jwt = 'eyJfixture.payload.signature'
        poller = self.poller([{'provider': 'codex', 'name': 'codex-fixture.json', 'auth_index': 'index',
            'email': RAW, 'api_key': RAW, 'access_token': 'opaque-oauth-token-fixture',
            'id_token': {'chatgpt_plan_type': 'pro', 'chatgpt_account_id': 'account-id'}},
            {'provider': 'codex', 'name': 'disabled.json', 'auth_index': 'disabled', 'disabled': True},
            {'provider': 'other', 'name': 'other.json', 'auth_index': 'other'}])
        poller.discover()
        self.assertEqual(len(poller.active), 1)
        account = next(iter(poller.accounts.values()))
        poller.gateway.request.return_value = {'status_code': 200, 'body': json.dumps({'rate_limit': {
            'primary_window': {'limit_window_seconds': 18000, 'used_percent': 3}}})}
        poller.gateway_read(account)
        request = poller.gateway.request.call_args.args[2]
        self.assertEqual(request['header']['Authorization'], 'Bearer $TOKEN$')
        self.assertEqual(request['header']['Chatgpt-Account-Id'], 'account-id')
        self.assertEqual(request['url'], u.CODEX_URL+'usage')
        poller.gateway.request.return_value = {'status_code': 200, 'body': '{"credits":[]}'}
        poller.gateway_read(account, True)
        headers = poller.gateway.request.call_args.args[2]['header']
        self.assertEqual(headers['OpenAI-Beta'], 'codex-1')
        self.assertEqual(headers['Originator'], 'Codex Desktop')
        ignored = u.auth_accounts({'files': [{'provider': 'codex', 'name': 'jwt.json', 'auth_index': 'jwt', 'id_token': jwt}]})
        self.assertIsNone(ignored[0][1])
        serialized = json.dumps(self.store.pool({'from': str(BASE), 'to': str(u.now_ms())}))
        data = b''.join(path.read_bytes() for path in self.path.glob('usage.db*'))
        for secret in (RAW, jwt, 'opaque-oauth-token-fixture', 'fixture-management', '$TOKEN$'):
            self.assertNotIn(secret, serialized)
            self.assertNotIn(secret.encode(), data)
        self.assertEqual(self.store.pool({})['accounts'][0]['plan'], 'pro')

    def test_pool_shape_inclusive_range_predecessor_stale_and_no_history_scan(self):
        account = self.account()
        account.update(observed_at=BASE, windows=[u.quota_window('five_hour', 1, None)])
        writer = self.writer()
        with patch.object(u, 'now_ms', return_value=BASE):
            writer.save(account)
        with writer.transaction():
            for ts in (BASE+10, BASE+20, BASE+30):
                writer.sample(account['key'], 'five_hour', ts, ts-BASE, None)
        with patch.object(u, 'now_ms', return_value=BASE+900001):
            latest = self.store.pool({})
        self.assertNotIn('history', latest)
        self.assertTrue(latest['accounts'][0]['stale'])
        self.assertEqual(set(latest['accounts'][0]), {'key', 'provider', 'label', 'plan', 'via', 'auth_index',
            'file_name', 'source', 'observed_at', 'stale', 'error', 'windows', 'banked_resets', 'limited_until'})
        result = self.store.pool({'from': str(BASE+15), 'to': str(BASE+20)})
        self.assertEqual([point[0] for point in result['history'][0]['points']], [BASE+10, BASE+20])
        empty = self.store.pool({'from': str(BASE-2), 'to': str(BASE-1)})
        self.assertEqual(empty['history'], [])
        with self.assertRaises(ValueError):
            self.store.pool({'from': '2', 'to': '1'})
        statements = []
        original = self.store.read
        from contextlib import contextmanager
        @contextmanager
        def traced():
            with original():
                self.store.conn.set_trace_callback(statements.append)
                yield
        with patch.object(self.store, 'read', traced):
            self.store.pool({})
        self.assertFalse(any('quota_samples' in statement for statement in statements))

    def test_banked_read_does_not_refresh_windows_or_clear_usage_error(self):
        poller = self.poller()
        account = self.account('codex')
        account['observed_at'] = BASE
        poller.remember(account)
        poller.writer.outcome(account['key'], 'usage', 'gateway', TimeoutError(RAW))
        poller.gateway.request.return_value = {'status_code': 200, 'body': '{"credits":[]}'}
        with patch.object(u, 'now_ms', return_value=BASE+u.HOUR):
            poller.gateway_read(account, True)
            result = self.store.pool({})['accounts'][0]
        self.assertTrue(result['stale'])
        self.assertEqual(result['observed_at'], BASE)
        self.assertEqual(result['banked_resets']['observed_at'], BASE+u.HOUR)
        self.assertEqual(result['error'], 'timeout')

    def test_quota_retention_cap_and_nonblocking_busy_writer(self):
        writer = self.writer()
        with writer.transaction():
            writer.sample('seat', 'weekly', BASE-91*u.DAY, 1, None)
            writer.sample('seat', 'weekly', BASE, 2, None)
        self.assertEqual(self.store.prune(at=BASE, cap=10**10, free_floor=0), 1)
        with self.store.transaction():
            with self.assertRaises(sqlite3.OperationalError):
                writer.save(self.account())
        self.store.ingest([record()])
        with patch.object(self.store, 'db_bytes', side_effect=[200, 50]), patch.object(self.store, 'disk_free', return_value=1000):
            self.assertEqual(self.store.prune(at=BASE, cap=100, free_floor=0), 2)
        self.assertEqual(writer.conn.execute('SELECT count(*) FROM quota_samples').fetchone()[0], 0)
        with patch.object(self.store, 'can_pop', return_value=False):
            with self.assertRaises(OSError):
                writer.save(self.account())

    def test_slow_quota_call_does_not_block_queue_drain(self):
        import threading
        entered, release = threading.Event(), threading.Event()
        poller = self.poller()
        account = self.account('codex')
        poller.remember(account)
        def slow(*args):
            entered.set()
            release.wait(2)
            return {'status_code': 200, 'body': json.dumps({'rate_limit': {'primary_window': {
                'limit_window_seconds': 18000, 'used_percent': 10}}})}
        poller.gateway.request.side_effect = slow
        failures = []
        def run():
            poller.writer = u.QuotaWriter(self.store)
            try:
                poller.gateway_read(account)
            except Exception as error:
                failures.append(error)
            finally:
                poller.writer.close()
        thread = threading.Thread(target=run)
        thread.start()
        self.assertTrue(entered.wait(1))
        self.store.ingest([record()])
        self.assertEqual(self.store.health()['records_total'], 1)
        release.set()
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(self.store.pool({})['accounts'][0]['windows'][0]['used_percent'], 10)


class ExportTests(unittest.TestCase):
    def test_atomic_export_permissions_and_failed_copy_preserves_previous(self):
        spec = importlib.util.spec_from_file_location('seat_export', ROOT.parent / 'seat-pacer-export/seat_pacer_export.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory(dir=ROOT) as temp:
            source, target = Path(temp)/'source.json', Path(temp)/'history.json'
            source.write_text('{"version":1}')
            target.write_text('previous')
            with patch.object(module.grp, 'getgrnam', return_value=SimpleNamespace(gr_gid=1234)), patch.object(module.os, 'fchown') as chown, patch.object(module.os, 'replace', wraps=module.os.replace) as rename:
                module.export(source, target)
                self.assertEqual(target.read_text(), '{"version":1}')
                self.assertEqual(target.stat().st_mode & 0o777, 0o640)
                self.assertEqual(target.parent.stat().st_mode & 0o777, 0o750)
                self.assertEqual(chown.call_count, 2)
                rename.assert_called_once()
                with patch.object(module.shutil, 'copyfileobj', side_effect=OSError(RAW)):
                    with self.assertRaises(OSError):
                        module.export(source, target)
                self.assertEqual(target.read_text(), '{"version":1}')
                self.assertEqual(list(Path(temp).glob('.history-*')), [])


class PricingTests(unittest.TestCase):
    def test_tiers_fallback_aliases_and_unpriced(self):
        entry = {**RATES, 'input_cost_per_token_above_1k_tokens': .000002}
        pricing = u.Pricing({'source': DOCUMENT['source'], 'models': {'anthropic/tier': entry,
                            'openai/no-cache': {'input_cost_per_token': .1, 'output_cost_per_token': .2}}})
        tokens = dict(zip(u.TOKEN_FIELDS, (1000, 0, 0, 0, 10, 10)))
        self.assertAlmostEqual(pricing.cost('TIER[1m]', tokens), .00104)
        tokens['input_uncached'] = 1001
        self.assertAlmostEqual(pricing.cost('tier', tokens), .002042)
        tokens = dict(zip(u.TOKEN_FIELDS, (10, 20, 30, 40, 50, 50)))
        self.assertEqual(pricing.cost('no-cache', tokens), 20)
        for model in ['opus', 'openai/fable', '<synthetic>', 'unknown', 'synthetic']:
            self.assertIsNone(pricing.cost(model, tokens))
        self.assertIsNone(u.Pricing({'source': {}, 'models': {'openai/ambiguous': RATES,
                         'anthropic/ambiguous': {**RATES, 'output_cost_per_token': 1}}}).cost('ambiguous', tokens))

    def test_cache_context_tiers_scale_base_ratios_and_one_hour_fallback(self):
        entry = {**RATES, 'input_cost_per_token_above_1k_tokens': .000002}
        pricing = u.Pricing({'source': {}, 'models': {'tier': entry}})
        tokens = dict(zip(u.TOKEN_FIELDS, (900, 80, 20, 10, 20, 15)))
        expected = 900*2e-6 + 80*2e-7 + 20*4e-6 + 10*6e-6 + 20*4e-6
        self.assertAlmostEqual(pricing.cost('tier', tokens), expected)
        entry = {k: v for k, v in RATES.items() if k != 'cache_creation_input_token_cost_above_1hr'}
        pricing = u.Pricing({'source': {}, 'models': {'fallback': entry}})
        tokens = dict(zip(u.TOKEN_FIELDS, (0, 0, 1, 1, 0, 0)))
        self.assertAlmostEqual(pricing.cost('fallback', tokens), 4e-6)

    def test_build_snapshot_filtering_reproducibility(self):
        source = {'openai/kept': {**RATES, 'litellm_provider': 'openai', 'mode': 'responses'},
                  'azure/rejected': {**RATES, 'litellm_provider': 'openai', 'mode': 'chat'},
                  'image': {**RATES, 'litellm_provider': 'openai', 'mode': 'image_generation'}}
        doc = build.build(source, '2026-11-14')
        self.assertEqual(set(doc['models']), {'openai/kept'})
        actual = json.loads((ROOT / 'prices.json').read_text())
        self.assertEqual(actual['source']['fetched_at'], '2026-11-14')
        self.assertGreater(len(actual['models']), 100)
        self.assertIsNotNone(u.Pricing(actual).cost('claude-sonnet-4-5', {k: 1 for k in u.TOKEN_FIELDS}))


class TransportTests(unittest.TestCase):
    def test_management_auth_guard_is_shared_across_workers(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as temp:
            credential = Path(temp)/'key'
            credential.write_text('fixture-management')
            drain = u.Gateway(credential)
            quota = u.Gateway(credential, drain.auth)
            conn = unittest.mock.Mock()
            conn.getresponse.return_value = SimpleNamespace(status=401)
            with patch.object(u.http.client, 'HTTPConnection', return_value=conn) as connect:
                for worker in (drain, quota, drain, quota):
                    worker.retry_at = 0
                    with self.assertRaises(u.AuthFailure):
                        worker.get('/fixture')
                drain.retry_at = 0
                with self.assertRaises(u.AuthFailure):
                    drain.get('/fixture')
                self.assertEqual(connect.call_count, 4)
            self.assertEqual(drain.auth.in_flight, 0)

    def test_absolute_http_deadline_interrupts_closed_connection_response(self):
        sock = unittest.mock.Mock()
        conn = SimpleNamespace(sock=sock)
        timer = unittest.mock.Mock()
        with patch.object(u.threading, 'Timer', return_value=timer) as create:
            with self.assertRaises(TimeoutError):
                with u.absolute_http_deadline(conn) as watch:
                    watch(conn.sock)
                    # HTTPConnection hands ownership to an HTTP/1.0 response.
                    conn.sock = None
                    create.call_args.args[1]()
            self.assertEqual(create.call_args.args[0], 50)
            sock.shutdown.assert_called_once_with(u.socket.SHUT_RDWR)
            timer.cancel.assert_called_once()

    def test_header_absolute_deadline_and_trickling(self):
        sock = unittest.mock.Mock()
        sock.recv.side_effect = [b'G', b'E', b'T']
        reader = u._DeadlineReader(sock, 5)
        with patch.object(u.time, 'monotonic', side_effect=[1, 2, 6]):
            with self.assertRaises(TimeoutError):
                reader.readline()
        self.assertEqual(sock.recv.call_count, 2)

    def test_connection_cap_without_socket(self):
        server = object.__new__(u.Server)
        server._slots = unittest.mock.Mock()
        server._slots.acquire.return_value = False
        server.shutdown_request = unittest.mock.Mock()
        server.process_request('fixture', ('127.0.0.1', 1))
        server.shutdown_request.assert_called_once_with('fixture')

    def test_auth_backoff_and_no_fifth_attempt(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as temp:
            credential = Path(temp) / 'management-key'
            credential.write_text('fixture-management')
            gateway = u.Gateway(credential)
            response = SimpleNamespace(status=401)
            conn = unittest.mock.Mock()
            conn.getresponse.return_value = response
            with patch.object(u.http.client, 'HTTPConnection', return_value=conn) as connect:
                for i in range(4):
                    gateway.retry_at = 0
                    with self.assertRaises(u.AuthFailure):
                        gateway.get('/fixture')
                gateway.retry_at = 0
                with self.assertRaises(u.AuthFailure):
                    gateway.get('/fixture')
                self.assertEqual(connect.call_count, 4)
                credential.write_text('rotated-fixture-management')
                with self.assertRaises(u.AuthFailure):
                    gateway.get('/fixture')
                self.assertEqual(connect.call_count, 5)


if __name__ == '__main__':
    unittest.main(verbosity=2)
