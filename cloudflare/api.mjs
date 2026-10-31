import { requireThat, Problem, snapshot, getBay } from './domain.mjs';
import { readClub, updateClub } from './store.mjs';
import { getRole, login, cookieToken, hash } from './auth.mjs';
import { publicOrigin, bayLinks } from './qr.mjs';

const headers = {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'self'"
};
const json = (value, status = 200, more = {}) => new Response(JSON.stringify(value), { status, headers: { ...headers, ...more } });

export async function handle(request, env) {
  try {
    const url = new URL(request.url), action = url.pathname.replace(/^\/api\//, '');
    requireThat(env.DB, 'D1 database binding is missing. Complete the Cloudflare setup.', 503);
    if (request.method === 'GET' && action === 'health') {
      const row = await env.DB.prepare('SELECT version FROM club WHERE id = 1').first();
      requireThat(row, 'Database migrations have not been applied.', 503);
      return json({ ok: true, backend: 'cloudflare-d1' });
    }
    const role = await getRole(request, env.DB);
    if (request.method === 'GET') {
      if (action === 'state') {
        const value = url.searchParams.get('bay');
        requireThat(value === null || /^\d+$/.test(value), 'Invalid bay.');
        const bid = value === null ? null : Number(value);
        const { state, version } = await readClub(env.DB);
        if (bid !== null && !role) getBay(state, bid);
        if (url.searchParams.get('since') === String(version) && url.searchParams.get('role') === (role || '')) return json({ unchanged: true, role, version, updates: 'poll', poll_interval: 5000 });
        return json(snapshot(state, role, bid, version));
      }
      if (action === 'qr-info') {
        requireThat(['reception', 'admin'].includes(role), 'Reception sign-in required.', role ? 403 : 401);
        const origin = publicOrigin(request, env), { state } = await readClub(env.DB);
        return json({ origin, bays: bayLinks(origin, state.bays) });
      }
      if (action === 'export') {
        requireThat(role === 'admin', 'Administrator permission required.', role ? 403 : 401);
        const { state, version } = await readClub(env.DB);
        return json({ exported_at: new Date().toISOString(), version, state }, 200, { 'Content-Disposition': 'attachment; filename="YENGolf-club-backup.json"' });
      }
      throw new Problem('Not found.', 404);
    }
    requireThat(request.method === 'POST', 'Method not allowed.', 405);
    const origin = request.headers.get('Origin');
    requireThat(!origin || origin === (env.VC_PUBLIC_URL || url.origin), 'Cross-origin request rejected.', 403);
    requireThat(request.headers.get('Content-Type')?.split(';')[0].trim() === 'application/json', 'JSON required.', 415);
    requireThat(Number(request.headers.get('Content-Length') || 0) <= 65536, 'Invalid request size.', 413);
    const reader = request.body?.getReader();
    requireThat(reader, 'JSON object required.');
    let count = 0; const chunks = [];
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      count += value.byteLength;
      if (count > 65536) { await reader.cancel(); throw new Problem('Invalid request size.', 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(count); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let data;
    try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Problem('Invalid JSON.'); }
    requireThat(data && typeof data === 'object' && !Array.isArray(data), 'JSON object required.');
    if (action === 'login') return json({ ok: true }, 200, { 'Set-Cookie': await login(request, env, data) });
    if (action === 'logout') {
      await env.DB.prepare('DELETE FROM auth WHERE token = ?').bind(await hash(cookieToken(request))).run();
      return json({ ok: true }, 200, { 'Set-Cookie': 'vc_staff=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    return json(await updateClub(env.DB, action, data, role));
  } catch (error) {
    if (error instanceof Problem) return json({ error: error.message }, error.status);
    // Never log requests, passwords or guest/payment details.
    console.error('YENGolf API internal failure:', error?.name || 'Error');
    return json({ error: 'The request could not be completed. Please retry or contact the administrator.' }, 500);
  }
}
