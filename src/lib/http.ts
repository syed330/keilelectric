/**
 * Requests, responses and sign-in for Netlify Functions: signed-cookie sessions (HMAC with SESSION_SECRET),
 * CSRF tokens, scrypt password hashes, flash messages, form parsing and security headers.
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { sleep } from './util.js';

export interface Session { sid: string; admin: boolean; viewer: boolean; exp: number }
export interface Ctx { req: Request; url: URL; query: Record<string, string>; session: Session; flashes: [string, string][]; setCookies: string[] }

function secret(): string {
  const s = (process.env.SESSION_SECRET || '').trim();
  if (s.length < 16) throw new ConfigError('SESSION_SECRET is missing or too short. Add a long random value in Netlify › Environment variables.');
  return s;
}
export class ConfigError extends Error {}
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const sign = (data: string) => createHmac('sha256', secret()).update(data).digest('base64url');
function safeEq(a: string, b: string): boolean { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }

export function readCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get('cookie') || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
function cookie(name: string, value: string, maxAge: number, secure: boolean): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
const isHttps = (url: URL) => url.protocol === 'https:';

export function startCtx(req: Request): Ctx {
  const url = new URL(req.url);
  const c = readCookies(req);
  let session: Session = { sid: '', admin: false, viewer: false, exp: 0 };
  const raw = c.ks || '';
  const dot = raw.lastIndexOf('.');
  if (dot > 0) {
    const data = raw.slice(0, dot), sig = raw.slice(dot + 1);
    if (safeEq(sign(data), sig)) { try { const s = JSON.parse(Buffer.from(data, 'base64url').toString()); if (s.exp > Date.now() / 1000) session = s; } catch { /* bad cookie */ } }
  }
  const setCookies: string[] = [];
  if (!session.sid) { session = { sid: b64u(randomBytes(18)), admin: false, viewer: false, exp: Math.floor(Date.now() / 1000) + 30 * 86400 }; setCookies.push(sessionCookie(session, url)); }
  let flashes: [string, string][] = [];
  if (c.kf) { try { const d = c.kf.slice(0, c.kf.lastIndexOf('.')); if (safeEq(sign('f' + d), c.kf.slice(c.kf.lastIndexOf('.') + 1))) flashes = JSON.parse(Buffer.from(d, 'base64url').toString()); } catch { /* ignore */ }
    setCookies.push(cookie('kf', '', 0, isHttps(url))); }
  const query: Record<string, string> = {}; url.searchParams.forEach((v, k) => { query[k] = v; });
  return { req, url, query, session, flashes, setCookies };
}
function sessionCookie(s: Session, url: URL): string { const data = b64u(JSON.stringify(s)); return cookie('ks', data + '.' + sign(data), Math.max(0, s.exp - Math.floor(Date.now() / 1000)), isHttps(url)); }
/** Signs the visitor in (new session id, so an old cookie can't be reused). */
export function signIn(ctx: Ctx, admin: boolean): void {
  ctx.session = { sid: b64u(randomBytes(18)), admin, viewer: true, exp: Math.floor(Date.now() / 1000) + (admin ? 12 * 3600 : 30 * 86400) };
  ctx.setCookies.push(sessionCookie(ctx.session, ctx.url));
}
export function signOut(ctx: Ctx): void { ctx.session = { sid: b64u(randomBytes(18)), admin: false, viewer: false, exp: Math.floor(Date.now() / 1000) + 30 * 86400 }; ctx.setCookies.push(sessionCookie(ctx.session, ctx.url)); }
export function flash(ctx: Ctx, msg: string, kind = 'success'): void {
  const list = [[kind, msg]]; const data = b64u(JSON.stringify(list));
  ctx.setCookies.push(cookie('kf', data + '.' + sign('f' + data), 120, isHttps(ctx.url)));
}

/** A small value carried to the next page view (test results, a typed field) in a signed, short-lived cookie. No secrets. */
export function stash(ctx: Ctx, key: string, value: unknown): void {
  const data = b64u(JSON.stringify(value));
  ctx.setCookies.push(cookie('kx_' + key, data + '.' + sign('x' + key + data), 120, isHttps(ctx.url)));
}
export function unstash<T>(ctx: Ctx, key: string): T | null {
  const raw = readCookies(ctx.req)['kx_' + key]; if (!raw) return null;
  ctx.setCookies.push(cookie('kx_' + key, '', 0, isHttps(ctx.url)));
  const i = raw.lastIndexOf('.'); const data = raw.slice(0, i);
  if (!safeEq(sign('x' + key + data), raw.slice(i + 1))) return null;
  try { return JSON.parse(Buffer.from(data, 'base64url').toString()) as T; } catch { return null; }
}

// ---------------------------------------------------------------- CSRF
export function csrfToken(ctx: Ctx): string { return sign('csrf:' + ctx.session.sid).slice(0, 43); }
export function csrfField(ctx: Ctx): string { return `<input type="hidden" name="csrf" value="${csrfToken(ctx)}">`; }
export function csrfOk(ctx: Ctx, form: Record<string, string>): boolean {
  // also refuse cross-site posts outright
  const origin = ctx.req.headers.get('origin');
  if (origin && origin !== 'null' && new URL(origin).host !== ctx.url.host) return false;
  return typeof form.csrf === 'string' && safeEq(form.csrf, csrfToken(ctx));
}

// ---------------------------------------------------------------- passwords (scrypt)
export function hashPassword(pw: string): string {
  const salt = randomBytes(16); const h = scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64')}$${h.toString('base64')}`;
}
export function verifyPassword(pw: string, stored: string | null): boolean {
  if (!stored) return false;
  const [kind, n, salt, hash] = stored.split('$');
  if (kind !== 'scrypt') return false;
  const h = scryptSync(pw, Buffer.from(salt, 'base64'), 32, { N: Number(n), r: 8, p: 1 });
  return timingSafeEqual(h, Buffer.from(hash, 'base64'));
}
export async function loginThrottle() { await sleep(800); }
export function randomKey(bytes = 20): string { return randomBytes(bytes).toString('hex'); }

// ---------------------------------------------------------------- forms and responses
/** Parses an urlencoded form; "match[google]=x" becomes key "match[google]". */
export async function readForm(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get('content-type') || '';
  if (!ct.includes('application/x-www-form-urlencoded')) return {};
  const text = (await req.text()).slice(0, 200000);
  const out: Record<string, string> = {};
  new URLSearchParams(text).forEach((v, k) => { out[k] = v; });
  return out;
}
const SECURITY: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
export function html(ctx: Ctx | null, body: string, status = 200, extra: Record<string, string> = {}): Response {
  const h = new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY, ...extra });
  for (const c of ctx?.setCookies ?? []) h.append('Set-Cookie', c);
  return new Response(body, { status, headers: h });
}
export function redirect(ctx: Ctx | null, location: string, status = 303): Response {
  const h = new Headers({ Location: location, 'Cache-Control': 'no-store', ...SECURITY });
  for (const c of ctx?.setCookies ?? []) h.append('Set-Cookie', c);
  return new Response(null, { status, headers: h });
}
export function text(body: string, status = 200, type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY, ...extra } });
}
