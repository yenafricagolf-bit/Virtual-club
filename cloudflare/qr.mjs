import { requireThat } from './domain.mjs';

export function publicOrigin(request, env) {
  const value = env.VC_PUBLIC_URL || new URL(request.url).origin;
  let url;
  try { url = new URL(value); } catch { requireThat(false, 'A confirmed public HTTPS origin is required.', 409); }
  requireThat(url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash && !['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname), 'A confirmed public HTTPS origin is required before printing QR codes.', 409);
  return url.origin;
}
export function bayLinks(origin, bays) {
  return Object.fromEntries(bays.map(b => [b.id, `${origin}/bay/${b.id}`]));
}
