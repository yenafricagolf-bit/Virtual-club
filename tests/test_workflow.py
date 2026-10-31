"""Real HTTP workflows against a temporary SQLite database."""
import concurrent.futures
import http.client
import json
import secrets
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from pathlib import Path
from http.server import ThreadingHTTPServer
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import Club, Handler, digest


class Workflow(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.club = Club(self.temp.name)
        self.password = secrets.token_urlsafe(20)
        for role in ['bar', 'reception', 'admin']:
            salt = secrets.token_hex(16)
            self.club.credentials[role] = {'salt': salt, 'hash': digest(self.password, salt)}
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.server.club = self.club
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.tokens = {}
        for role in ['bar', 'reception', 'admin']:
            _, _, headers = self.request('login', {'role': role, 'password': self.password})
            self.tokens[role] = headers['Set-Cookie'].split(';')[0]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.club.db.close()
        self.temp.cleanup()

    def request(self, action, data=None, role=None, origin=None):
        conn = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        headers = {}
        if role:
            headers['Cookie'] = self.tokens[role]
        if origin:
            headers['Origin'] = origin
        body = None
        if data is not None:
            body = json.dumps(data)
            headers['Content-Type'] = 'application/json'
        conn.request('POST' if data is not None else 'GET', '/api/' + action, body, headers)
        response = conn.getresponse()
        status, hdrs = response.status, dict(response.getheaders())
        result = json.loads(response.read())
        conn.close()
        return status, result, hdrs

    def ok(self, action, data=None, role=None):
        status, result, _ = self.request(action, data, role)
        self.assertEqual(status, 200, result)
        return result

    def open(self, bid=1):
        self.ok('open', {'bay': bid, 'name': 'Test Guest', 'phone': '+254700000000', 'guests': 4}, 'reception')
        return self.ok(f'state?bay={bid}')['bays'][0]['session']

    def order(self, sid, key=None, role=None):
        return self.ok('orders', {'bay': 1, 'session': sid, 'key': key or secrets.token_hex(16), 'items': [{'product': 'heineken', 'option': 'heineken', 'qty': 2}], 'note': '<script>test</script>', 'mixers': 'No ice'}, role)['id']

    def serve(self, oid):
        self.ok('status', {'id': oid, 'status': 'preparing'}, 'bar')
        self.ok('status', {'id': oid, 'status': 'served'}, 'bar')

    def test_complete_session_split_payment_receipt_and_reopen(self):
        sid = self.open()
        first = self.order(sid)
        self.assertEqual(first, 'VC001')
        self.serve(first)
        second = self.order(sid, role='bar')
        self.serve(second)
        pay = self.ok('payment', {'bay': 1, 'session': sid, 'payments': [{'method': 'M-Pesa', 'reference': 'TEST123', 'amount': 1250}, {'method': 'Cash', 'amount': 750}]}, 'reception')
        self.assertTrue(pay['id'].startswith('RC'))
        self.ok('close', {'bay': 1, 'session': sid}, 'reception')
        self.assertEqual(self.ok('state?bay=1')['orders'], [])
        new_sid = self.open()
        self.assertNotEqual(sid, new_sid)
        self.assertEqual(self.ok('state?bay=1')['orders'], [])
        staff = self.ok('state', role='reception')
        self.assertEqual(len(staff['orders']), 2)
        self.assertEqual(len(staff['payments']), 2)
        self.assertIsNotNone(staff['sessions'][0]['closed'])

    def test_staff_permissions_and_customer_privacy(self):
        sid = self.open()
        self.order(sid)
        self.assertEqual(self.request('open', {'bay': 2}, None)[0], 401)
        self.assertEqual(self.request('open', {'bay': 2}, 'bar')[0], 403)
        self.assertEqual(self.request('status', {'id': 'VC001', 'status': 'preparing'}, 'reception')[0], 403)
        customer = self.ok('state?bay=1')
        self.assertNotIn('name', customer['bays'][0])
        self.assertNotIn('phone', customer['bays'][0])
        self.assertNotIn('sessions', customer)
        self.assertEqual(self.ok('state')['orders'], [])
        self.assertNotIn('phone', self.ok('state', role='bar')['bays'][0])

    def test_unresolved_and_unpaid_orders_block_closure(self):
        sid = self.open()
        oid = self.order(sid)
        close = {'bay': 1, 'session': sid}
        payment = {**close, 'payments': [{'method': 'Cash', 'amount': 1000}]}
        self.assertEqual(self.request('close', close, 'reception')[0], 409)
        self.assertEqual(self.request('payment', payment, 'reception')[0], 409)
        self.serve(oid)
        self.assertEqual(self.request('close', close, 'reception')[0], 409)
        self.ok('payment', payment, 'reception')
        self.assertEqual(self.request('payment', payment, 'reception')[0], 409)

    def test_cancel_preserves_history_and_cannot_skip_transition(self):
        sid = self.open()
        oid = self.order(sid)
        self.assertEqual(self.request('status', {'id': oid, 'status': 'served'}, 'bar')[0], 409)
        self.assertEqual(self.request('status', {'id': oid, 'status': 'cancelled'}, 'bar')[0], 400)
        self.ok('status', {'id': oid, 'status': 'cancelled', 'reason': 'Duplicate order'}, 'bar')
        self.ok('close', {'bay': 1, 'session': sid}, 'reception')
        orders = self.ok('state', role='reception')['orders']
        self.assertEqual(orders[0]['reason'], 'Duplicate order')
        self.assertEqual(orders[0]['status'], 'cancelled')

    def test_order_idempotency_and_concurrent_numbering(self):
        sid = self.open()
        key = secrets.token_hex(16)
        self.assertEqual(self.order(sid, key), self.order(sid, key))
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            ids = list(pool.map(lambda _: self.order(sid), range(12)))
        self.assertEqual(len(set(ids)), 12)
        self.assertEqual(len(self.ok('state', role='bar')['orders']), 13)

    def test_inactive_stale_and_invalid_orders(self):
        payload = {'bay': 1, 'session': 'invalid', 'key': secrets.token_hex(16), 'items': []}
        self.assertEqual(self.request('orders', payload)[0], 409)
        sid = self.open()
        self.assertEqual(self.request('orders', payload)[0], 409)
        payload['session'] = sid
        self.assertEqual(self.request('orders', payload)[0], 400)
        for qty in [0, -1, 1.5, True, 100]:
            payload['items'] = [{'product': 'heineken', 'option': 'heineken', 'qty': qty}]
            self.assertEqual(self.request('orders', payload)[0], 400)

    def test_admin_price_change_and_availability(self):
        sid = self.open()
        old = self.order(sid)
        p = next(p for p in self.ok('state', role='admin')['products'] if p['id'] == 'heineken')
        p['options'][0]['price'] = 550
        self.assertEqual(self.request('product', p, 'reception')[0], 403)
        self.ok('product', p, 'admin')
        new = self.order(sid)
        orders = self.ok('state', role='bar')['orders']
        self.assertEqual(next(o for o in orders if o['id'] == old)['total'], 1000)
        self.assertEqual(next(o for o in orders if o['id'] == new)['total'], 1100)
        self.ok('product', {'id': 'heineken', 'available': False}, 'bar')
        payload = {'bay': 1, 'session': sid, 'key': secrets.token_hex(16), 'items': [{'product': 'heineken', 'option': 'heineken', 'qty': 1}]}
        self.assertEqual(self.request('orders', payload)[0], 409)

    def test_payment_validation_is_atomic(self):
        sid = self.open()
        self.serve(self.order(sid))
        for payments in [[{'method': 'Cash', 'amount': 999}], [{'method': 'M-Pesa', 'amount': 1000}], [{'method': 'Cash', 'amount': 500}, {'method': 'Fake', 'amount': 500}]]:
            self.assertEqual(self.request('payment', {'bay': 1, 'session': sid, 'payments': payments}, 'reception')[0], 400)
            self.assertEqual(self.ok('state', role='reception')['payments'], [])

    def test_database_survives_restart(self):
        sid = self.open()
        oid = self.order(sid)
        other = Club(self.temp.name)
        try:
            self.assertEqual(other.state['orders'][0]['id'], oid)
            self.assertEqual(other.state['bays'][0]['session'], sid)
        finally:
            other.db.close()

    def test_second_receipt_only_includes_new_orders(self):
        sid = self.open()
        first = self.order(sid)
        self.serve(first)
        payment = {'bay': 1, 'session': sid, 'payments': [{'method': 'Cash', 'amount': 1000}]}
        self.ok('payment', payment, 'reception')
        second = self.order(sid)
        self.serve(second)
        self.ok('payment', payment, 'reception')
        payments = self.ok('state', role='reception')['payments']
        self.assertEqual(payments[0]['order_ids'], [first])
        self.assertEqual(payments[1]['order_ids'], [second])

    def test_event_stream_and_origin_guard(self):
        conn = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        conn.request('GET', '/api/events')
        response = conn.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader('Content-Type'), 'text/event-stream')
        response.fp.readline()
        response.fp.readline()
        self.open()
        self.assertTrue(response.fp.readline().startswith(b'data: '))
        conn.close()
        self.assertEqual(self.request('open', {'bay': 2}, 'reception', 'https://evil.example')[0], 403)

    def test_supplied_menu_prices_and_missing_price(self):
        products = self.ok('state')['products']
        hendricks = next(p for p in products if p['id'] == 'hendricks')
        self.assertEqual(next(o for o in hendricks['options'] if o['label'] == 'Tot')['price'], 5000)
        self.assertIn('confirmation', hendricks['flag'])
        missing = next(p for p in products if p['id'] == 'glenlivet-founders-1l')
        self.assertFalse(missing['available'])
        self.assertEqual(missing['options'], [])
        self.assertEqual(len([p for p in products if p['id'] == 'jameson-black']), 1)

    def test_logout_and_invalid_login(self):
        self.assertEqual(self.request('login', {'role': 'admin', 'password': 'wrong'})[0], 401)
        self.ok('logout', {}, 'reception')
        self.assertEqual(self.request('open', {'bay': 1}, 'reception')[0], 401)

    def test_qr_routes_require_staff_and_use_confirmed_origin(self):
        self.assertEqual(self.request('qr-info')[0], 401)
        self.assertEqual(self.request('qr-info', role='bar')[0], 403)
        with patch.dict('os.environ', {'VC_PUBLIC_URL': '', 'RENDER_EXTERNAL_URL': ''}):
            self.assertEqual(self.request('qr-info', role='reception')[0], 409)
        with patch.dict('os.environ', {'RENDER_EXTERNAL_URL': 'https://assigned.onrender.com', 'VC_PUBLIC_URL': ''}):
            info = self.ok('qr-info', role='reception')
            self.assertEqual(info['bays']['1'], 'https://assigned.onrender.com/bay/1')
            conn = http.client.HTTPConnection(*self.server.server_address, timeout=5)
            conn.request('GET', '/api/qr-codes.pdf', headers={'Cookie': self.tokens['reception']})
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader('Content-Type'), 'application/pdf')
            self.assertTrue(response.read().startswith(b'%PDF-'))
            conn.close()

    def test_https_deployment_uses_secure_cookie_and_exact_origin(self):
        with patch.dict('os.environ', {'RENDER_EXTERNAL_URL': 'https://assigned.onrender.com', 'VC_PUBLIC_URL': ''}):
            status, _, headers = self.request('login', {'role': 'bar', 'password': self.password}, origin='https://assigned.onrender.com')
            self.assertEqual(status, 200)
            self.assertIn('; Secure', headers['Set-Cookie'])
            self.assertEqual(self.request('login', {'role': 'bar', 'password': self.password}, origin='https://evil.example')[0], 403)


if __name__ == '__main__':
    unittest.main()
