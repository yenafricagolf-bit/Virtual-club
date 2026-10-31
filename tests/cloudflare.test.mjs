import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Miniflare } from 'miniflare';
import seed from '../data/menu.json' with { type: 'json' };
import { PDFDocument } from 'pdf-lib';
import { qrPdf } from '../shared/qr-pdf.mjs';

let mf, db, cookies;
const passwords = Object.fromEntries(['bar', 'reception', 'admin'].map(r => [r, randomBytes(24).toString('hex')]));
const origin = 'https://yengolf-test.example';
const key = () => randomBytes(16).toString('hex');
function initial() { return { bays: Array.from({ length: 6 }, (_, i) => ({ id: i + 1, active: false, session: null, name: '', phone: '', guests: 0, opened: null })), products: structuredClone(seed), orders: [], payments: [], sessions: [], audit: [], seq: 1 }; }

async function request(action, data, role, headers = {}) {
  const options = { method: data === undefined ? 'GET' : 'POST', headers: { ...headers } };
  if (role) options.headers.Cookie = cookies[role];
  if (data !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(data); }
  const response = await mf.dispatchFetch(`${origin}/api/${action}`, options);
  const result = response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : new Uint8Array(await response.arrayBuffer());
  return { response, status: response.status, result };
}
async function ok(action, data, role) { const r = await request(action, data, role); assert.equal(r.status, 200, JSON.stringify(r.result)); return r.result; }
async function open() { await ok('open', { bay: 1, name: 'Cloudflare Guest', phone: '+254700000000', guests: 4 }, 'reception'); return (await ok('state?bay=1')).bays[0].session; }
async function order(sid, role, idempotencyKey = key()) { return (await ok('orders', { bay: 1, session: sid, key: idempotencyKey, items: [{ product: 'heineken', option: 'heineken', qty: 2 }], note: '<script>no HTML</script>' }, role)).id; }
async function serve(id) { await ok('status', { id, status: 'preparing' }, 'bar'); await ok('status', { id, status: 'served' }, 'bar'); }

before(async () => {
  mf = new Miniflare({ scriptPath: '.runtime/cloudflare-build/index.js', modules: true, compatibilityDate: '2025-04-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], bindings: Object.fromEntries(Object.entries(passwords).map(([k,v]) => [`VC_${k.toUpperCase()}_PASSWORD`,v])) });
  db = await mf.getD1Database('DB');
  await db.exec("CREATE TABLE club(id INTEGER PRIMARY KEY, payload TEXT NOT NULL, version INTEGER NOT NULL);\nCREATE TABLE auth(token TEXT PRIMARY KEY, role TEXT, expires INTEGER);\nCREATE TABLE login_limits(ip TEXT, bucket INTEGER, attempts INTEGER, PRIMARY KEY(ip,bucket));");
});
after(async () => { await mf?.dispose(); });
beforeEach(async () => {
  await db.batch([db.prepare('DELETE FROM auth'),db.prepare('DELETE FROM login_limits'),db.prepare('DELETE FROM club'),db.prepare('INSERT INTO club VALUES(1,?,1)').bind(JSON.stringify(initial()))]);
  cookies = {};
  for (const role of ['bar','reception','admin']) {
    const r = await request('login', { role, password: passwords[role] });
    assert.equal(r.status,200,JSON.stringify(r.result));
    cookies[role] = r.response.headers.get('Set-Cookie').split(';')[0];
    assert.match(r.response.headers.get('Set-Cookie'), /; Secure/);
  }
});

test('D1 health and initial menu preserve supplied prices', async () => {
  assert.equal((await ok('health')).backend,'cloudflare-d1');
  const s=await ok('state?bay=1');
  assert.equal(s.bays[0].active,false); assert.equal(s.updates,'poll');
  const h=s.products.find(p=>p.id==='hendricks');
  assert.equal(h.options.find(o=>o.label==='Tot').price,5000); assert.match(h.flag,/confirmation/);
  const missing=s.products.find(p=>p.id==='glenlivet-founders-1l'); assert.equal(missing.available,false); assert.equal(missing.options.length,0);
});
test('complete multi-station workflow, split payment, receipt and session isolation', async () => {
  const sid=await open();const a=await order(sid);assert.equal(a,'VC001');await serve(a);
  const b=await order(sid,'reception');await serve(b);
  const pay=await ok('payment',{bay:1,session:sid,payments:[{method:'M-Pesa',reference:'TEST123',amount:1250},{method:'Cash',amount:750}]},'reception');
  assert.match(pay.id,/^RC/);
  const staff=await ok('state',undefined,'reception');assert.equal(staff.payments.length,2);assert.deepEqual(staff.payments[0].order_ids,[a,b]);
  await ok('close',{bay:1,session:sid},'reception'); assert.deepEqual((await ok('state?bay=1')).orders,[]);
  assert.notEqual(await open(),sid);assert.deepEqual((await ok('state?bay=1')).orders,[]);
  assert.equal((await ok('state',undefined,'reception')).orders.length,2);
});
test('permissions, logout and private customer data', async () => {
  const sid=await open();await order(sid);
  assert.equal((await request('open',{bay:2})).status,401);
  assert.equal((await request('open',{bay:2},'bar')).status,403);
  assert.equal((await request('status',{id:'VC001',status:'preparing'},'reception')).status,403);
  const guest=await ok('state?bay=1');assert.equal('phone' in guest.bays[0],false);assert.equal('name' in guest.bays[0],false);assert.equal('sessions' in guest,false);
  assert.equal('phone' in (await ok('state',undefined,'bar')).bays[0],false);
  assert.deepEqual((await ok('state')).orders,[]);
  await ok('logout',{},'reception');assert.equal((await request('open',{bay:2},'reception')).status,401);
});
test('active orders and unpaid balances block closing and settlement', async () => {
  const sid=await open(),id=await order(sid), body={bay:1,session:sid};
  assert.equal((await request('close',body,'reception')).status,409);
  assert.equal((await request('payment',{...body,payments:[{method:'Cash',amount:1000}]},'reception')).status,409);
  await serve(id);assert.equal((await request('close',body,'reception')).status,409);
  await ok('payment',{...body,payments:[{method:'Cash',amount:1000}]},'reception');
  assert.equal((await request('payment',{...body,payments:[{method:'Cash',amount:1000}]},'reception')).status,409);
});
test('cancellation preserves the audit and cannot skip states', async () => {
  const sid=await open(),id=await order(sid);
  assert.equal((await request('status',{id,status:'served'},'bar')).status,409);
  assert.equal((await request('status',{id,status:'cancelled'},'bar')).status,400);
  await ok('status',{id,status:'cancelled',reason:'Duplicate order'},'bar');
  await ok('close',{bay:1,session:sid},'reception');
  const s=await ok('state',undefined,'admin');assert.equal(s.orders[0].reason,'Duplicate order');assert.ok(s.audit.some(a=>a.action==='status'));
});
test('concurrent customer orders are not lost and have unique readable numbers', async () => {
  const sid=await open(), idem=key(); assert.equal(await order(sid,null,idem),await order(sid,null,idem));
  const ids=await Promise.all(Array.from({length:10},()=>order(sid)));
  assert.equal(new Set(ids).size,10); assert.equal((await ok('state',undefined,'bar')).orders.length,11);
});
test('concurrent settlements record the money exactly once', async () => {
  const sid=await open();await serve(await order(sid));
  const data={bay:1,session:sid,payments:[{method:'Cash',amount:1000}]};
  const outcomes=await Promise.all([request('payment',data,'reception'),request('payment',data,'reception')]);
  assert.deepEqual(outcomes.map(r=>r.status).sort(),[200,409]);
  assert.equal((await ok('state',undefined,'reception')).payments.length,1);
});
test('stale sessions, unavailable products and invalid quantities are rejected', async () => {
  const body={bay:1,session:'stale',key:key(),items:[{product:'heineken',option:'heineken',qty:1}]};
  assert.equal((await request('orders',body)).status,409);const sid=await open();assert.equal((await request('orders',body)).status,409);
  body.session=sid;
  for(const qty of [0,-1,1.5,true,100]) {body.items[0].qty=qty;assert.equal((await request('orders',body)).status,400);}
  await ok('product',{id:'heineken',available:false},'bar');body.items[0].qty=1;assert.equal((await request('orders',body)).status,409);
});
test('admin menu prices are shared and historical order prices remain fixed', async () => {
  const sid=await open(),first=await order(sid);
  const p=(await ok('state',undefined,'admin')).products.find(p=>p.id==='heineken');p.options[0].price=550;
  assert.equal((await request('product',p,'reception')).status,403);await ok('product',p,'admin');const second=await order(sid);
  const orders=(await ok('state',undefined,'bar')).orders;assert.equal(orders.find(o=>o.id===first).total,1000);assert.equal(orders.find(o=>o.id===second).total,1100);
});
test('invalid split payments and missing M-Pesa references do not partially persist', async () => {
  const sid=await open();await serve(await order(sid));
  for(const payments of [[{method:'Cash',amount:999}],[{method:'M-Pesa',amount:1000}],[{method:'Cash',amount:500},{method:'Fake',amount:500}]]) {
    assert.equal((await request('payment',{bay:1,session:sid,payments},'reception')).status,400);
    assert.deepEqual((await ok('state',undefined,'reception')).payments,[]);
  }
});
test('successive receipts contain only their newly settled orders', async () => {
  const sid=await open(),a=await order(sid);await serve(a);
  const payment={bay:1,session:sid,payments:[{method:'Cash',amount:1000}]};await ok('payment',payment,'reception');
  const b=await order(sid);await serve(b);await ok('payment',payment,'reception');
  const ps=(await ok('state',undefined,'reception')).payments;assert.deepEqual(ps[0].order_ids,[a]);assert.deepEqual(ps[1].order_ids,[b]);
});
test('conditional polling changes after mutations and after staff authentication', async () => {
  const before=await ok('state?bay=1');
  assert.equal((await ok(`state?bay=1&since=${before.version}&role=`)).unchanged,true);
  assert.equal((await ok(`state?bay=1&since=${before.version}&role=`,undefined,'reception')).unchanged,undefined);
  await open();const next=await ok(`state?bay=1&since=${before.version}&role=`);assert.equal(next.bays[0].active,true);assert.ok(next.version>before.version);
});
test('QR PDF has six actual HTTPS bay URLs and requires a staff session', async () => {
  assert.equal((await request('qr-info')).status,401);assert.equal((await request('qr-info',undefined,'bar')).status,403);
  const info=await ok('qr-info',undefined,'reception');assert.equal(info.bays['6'],origin+'/bay/6');
  const pdf=await qrPdf(info.origin,Object.keys(info.bays).map(id=>({id:Number(id)})));
  const parsed=await PDFDocument.load(pdf);assert.equal(parsed.getPageCount(),1);
  writeFileSync('/tmp/yengolf-cloudflare-qr-test.pdf',pdf);
});
test('admin export is complete and denied to customers and other roles', async () => {
  await open();assert.equal((await request('export')).status,401);assert.equal((await request('export',undefined,'reception')).status,403);
  const backup=await ok('export',undefined,'admin');assert.equal(backup.state.bays[0].name,'Cloudflare Guest');assert.equal(backup.state.products.length,seed.length);
});
test('wrong passwords, login rate limit, oversized requests and cross-origin writes fail', async () => {
  assert.equal((await request('login',{role:'admin',password:passwords.admin},null,{Origin:'https://evil.example'})).status,403);
  for(let i=0;i<9;i++) assert.equal((await request('login',{role:'bar',password:'wrong'})).status,401);
  assert.equal((await request('login',{role:'bar',password:'wrong'})).status,429);
  assert.equal((await request('open',{bay:1,name:'x'.repeat(70000)},'reception')).status,413);
});
