import { Problem, requireThat, roles } from './domain.mjs';
export async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export function cookieToken(request) {
  return request.headers.get('Cookie')?.split(';').map(p => p.trim()).find(p => p.startsWith('vc_staff='))?.slice(9) || '';
}
export async function getRole(request, db) {
  const token = cookieToken(request);
  if (!token) return null;
  const row = await db.prepare('SELECT role FROM auth WHERE token = ? AND expires > ?').bind(await hash(token), Date.now()).first();
  return roles.includes(row?.role) ? row.role : null;
}
export async function login(request, env, data) {
  requireThat(roles.includes(data.role) && typeof data.password === 'string' && data.password.length <= 512, 'Invalid credentials.', 401);
  const configured = env[`VC_${data.role.toUpperCase()}_PASSWORD`];
  requireThat(typeof configured === 'string' && configured.length >= 16, 'Staff passwords are not configured. Ask the administrator to complete setup.', 503);
  const now = Date.now(), bucket = Math.floor(now / 300000);
  const ip = await hash((request.headers.get('CF-Connecting-IP') || 'local') + configured);
  const limit = await env.DB.batch([
    env.DB.prepare('DELETE FROM login_limits WHERE bucket < ?').bind(bucket - 1),
    env.DB.prepare('INSERT INTO login_limits(ip, bucket, attempts) VALUES(?, ?, 1) ON CONFLICT(ip, bucket) DO UPDATE SET attempts = attempts + 1 RETURNING attempts').bind(ip, bucket)
  ]);
  requireThat(limit[1].results[0].attempts <= 10, 'Too many login attempts. Try again in five minutes.', 429);
  const [expected, supplied] = await Promise.all([hash(configured), hash(data.password)]);
  let different = 0;
  for (let i = 0; i < expected.length; i++) different |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  requireThat(different === 0, 'Invalid credentials.', 401);
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth WHERE expires < ?').bind(now),
    env.DB.prepare('INSERT INTO auth(token, role, expires) VALUES(?, ?, ?)').bind(await hash(token), data.role, now + 28800000)
  ]);
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `vc_staff=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}`;
}
