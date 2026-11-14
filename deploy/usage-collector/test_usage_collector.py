#!/usr/bin/python3 -I
"""Synthetic tests. No sockets, live databases, credentials or endpoints are used."""
import importlib.util
import json
import sqlite3
import sys
import tempfile
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
            {}, [record()] * 500, [record()]]))
        lb = SimpleNamespace(resolve_routes=lambda doc: {}, backfill=lambda *args: 0)
        worker = u.Collector(self.store, lb, gateway)
        with patch.object(self.store, 'prune'), patch.object(self.store, 'can_pop', return_value=True):
            worker.once()
        self.assertEqual(self.store.health()['records_total'], 501)
        self.assertEqual(gateway.get.call_count, 3)
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
        for path in ['/v1/health', '/v1/summary?from='+str(BASE)+'&to='+str(BASE+u.HOUR),
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
        self.assertEqual(call('http://localhost:8337/v1/health')[0], 400)


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
