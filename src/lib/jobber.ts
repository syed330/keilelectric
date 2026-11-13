/**
 * Jobber (payments and invoices) — Jobber GraphQL API with OAuth 2.0.
 * Access tokens last about an hour; refresh tokens rotate (each works once), so every new pair is saved with the
 * settings version check — if two requests refresh at the same moment, the loser picks up the winner's tokens.
 */
import { loadSettings, saveSettings, SettingsConflict, type Settings } from './settings.js';
import { sleep } from './util.js';
import type { Budget } from './ghl.js';

export class JobberError extends Error {}
export function jobberBase(): string { return (process.env.JOBBER_API_BASE || 'https://api.getjobber.com').replace(/\/+$/, ''); }
export function jobberConnected(S: Settings): boolean { return !!S.jobber.refreshToken && !!S.jobber.clientId; }
/** The callback URL to register in the Jobber app: <site>/admin/jobber/callback */
export function jobberCallbackUrl(origin: string): string { return origin.replace(/\/+$/, '') + '/admin/jobber/callback'; }
export function jobberAuthorizeUrl(S: Settings, origin: string, state: string): string {
  return jobberBase() + '/api/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: S.jobber.clientId, redirect_uri: jobberCallbackUrl(origin), state }).toString();
}

function expiry(j: { expires_in?: number; access_token?: string }): number {
  if (j.expires_in) return Math.floor(Date.now() / 1000) + Number(j.expires_in);
  const parts = String(j.access_token || '').split('.');
  if (parts.length === 3) { try { const p = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); if (p.exp) return Number(p.exp); } catch { /* not a JWT */ } }
  return Math.floor(Date.now() / 1000) + 3300;
}
async function tokenRequest(form: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  let res: Response;
  try {
    res = await fetch(jobberBase() + '/api/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(form).toString() });
  } catch (err) { throw new JobberError('Couldn’t reach Jobber: ' + (err as Error).message); }
  let j: any = {}; try { j = await res.json(); } catch { /* empty */ } // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!res.ok || !j.access_token) {
    const why = String(j.error_description ?? j.message ?? j.error ?? 'HTTP ' + res.status);
    throw new JobberError('Jobber sign-in failed: ' + (why === 'invalid_grant' ? 'the authorization expired or was revoked — click “Connect to Jobber” again' : why) + '.');
  }
  return j;
}

/** Trade the one-time code from the callback for tokens, and save them. */
export async function jobberExchangeCode(origin: string, code: string): Promise<Settings> {
  let S = await loadSettings();
  const j = await tokenRequest({ client_id: S.jobber.clientId, client_secret: S.jobber.clientSecret, grant_type: 'authorization_code', code, redirect_uri: jobberCallbackUrl(origin) });
  S.jobber.accessToken = j.access_token; S.jobber.refreshToken = String(j.refresh_token || ''); S.jobber.expiresAt = expiry(j); S.jobber.connectedAt = new Date().toISOString();
  S = await saveSettings(S);
  try { const a = await jobberGraphql(S, 'query { account { id name } }'); S.jobber.account = String(a.account?.name ?? ''); S = await saveSettings(S); } catch { /* the name is cosmetic */ }
  return S;
}

/** A valid access token; refreshes it when it is about to expire. Mutates S.jobber (and S._version) with the saved tokens. */
async function accessToken(S: Settings): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (S.jobber.accessToken && S.jobber.expiresAt > now + 90) return S.jobber.accessToken;
  for (let attempt = 0; attempt < 3; attempt++) {
    const fresh = await loadSettings();                       // someone may have refreshed already
    if (fresh.jobber.accessToken && fresh.jobber.expiresAt > now + 90) { S.jobber = fresh.jobber; S._version = fresh._version; return S.jobber.accessToken; }
    let j;
    try { j = await tokenRequest({ client_id: fresh.jobber.clientId, client_secret: fresh.jobber.clientSecret, grant_type: 'refresh_token', refresh_token: fresh.jobber.refreshToken }); }
    catch (err) {
      const again = await loadSettings();                    // lost a race: the winner rotated the token — use theirs
      if (again.jobber.refreshToken !== fresh.jobber.refreshToken) { S.jobber = again.jobber; S._version = again._version; if (again.jobber.expiresAt > now + 90) return again.jobber.accessToken; continue; }
      throw err;
    }
    fresh.jobber.accessToken = j.access_token;
    if (j.refresh_token) fresh.jobber.refreshToken = j.refresh_token;
    fresh.jobber.expiresAt = expiry(j);
    try { await saveSettings(fresh); S.jobber = fresh.jobber; S._version = fresh._version; return S.jobber.accessToken; }
    catch (err) { if (!(err instanceof SettingsConflict)) throw err; /* retry with the latest */ }
  }
  throw new JobberError('Couldn’t refresh the Jobber connection. Click “Connect to Jobber” again in Admin › Jobber.');
}

export async function jobberGraphql(S: Settings, query: string, variables: Record<string, unknown> = {}, budget?: Budget): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let attempt = 0; attempt < 4; attempt++) {
    const tok = await accessToken(S);
    let res: Response;
    try {
      res = await fetch(jobberBase() + '/api/graphql', { method: 'POST', body: JSON.stringify({ query, variables }),
        headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', Accept: 'application/json', 'X-JOBBER-GRAPHQL-VERSION': S.jobber.version || '2025-01-20' } });
    } catch (err) { throw new JobberError('Couldn’t reach Jobber: ' + (err as Error).message); }
    if (res.status === 401) { S.jobber.expiresAt = 0; if (attempt === 0) continue; throw new JobberError('Jobber rejected the connection. Click “Connect to Jobber” again in Admin › Jobber.'); }
    let j: any = {}; try { j = await res.json(); } catch { /* empty */ } // eslint-disable-line @typescript-eslint/no-explicit-any
    const errs: { message?: string; extensions?: { code?: string } }[] = j.errors ?? [];
    const throttled = res.status === 429 || errs.some((x) => x.extensions?.code === 'THROTTLED');
    if (throttled && attempt < 3 && (budget?.left() ?? 99) > 6) { await sleep(2000 + 2000 * attempt); continue; } // Jobber limits by query cost
    if (!res.ok && !errs.length) throw new JobberError('Jobber API error ' + res.status + '.');
    if (errs.length) throw new JobberError('Jobber: ' + [...new Set(errs.map((x) => x.message || 'error'))].join('; '));
    return j.data ?? {};
  }
  throw new JobberError('Jobber is rate-limiting requests. Try again in a minute.');
}

/** All nodes of a connection field. Tries the date filter first; if this API version doesn't accept it, reads unfiltered. */
async function paged(S: Settings, field: string, nodeFields: string, filter: Record<string, unknown> | null, filterType: string, budget?: Budget, max = 5000): Promise<any[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  let withFilter = filter !== null; const all: any[] = []; let after: string | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  while (all.length < max && !budget?.out()) {
    const decl: string[] = [], args = ['first: 50'];
    if (after) { decl.push('$after: String'); args.push('after: $after'); }
    if (withFilter) { decl.push('$filter: ' + filterType); args.push('filter: $filter'); }
    const q = `query${decl.length ? '(' + decl.join(', ') + ')' : ''} { ${field}(${args.join(', ')}) { nodes { ${nodeFields} } pageInfo { hasNextPage endCursor } } }`;
    const vars: Record<string, unknown> = {}; if (after) vars.after = after; if (withFilter) vars.filter = filter;
    let d;
    try { d = await jobberGraphql(S, q, vars, budget); }
    catch (err) {
      if (withFilter && !all.length && /filter|argument|doesn.?t accept|isn.?t a defined|not defined|unknown/i.test((err as Error).message)) { withFilter = false; continue; }
      throw err;
    }
    const conn = d[field] ?? {};
    all.push(...(conn.nodes ?? []));
    if (!conn.pageInfo?.hasNextPage || !conn.pageInfo?.endCursor) break;
    after = conn.pageInfo.endCursor;
  }
  return all;
}
export async function jobberPayments(S: Settings, from: string, to: string, budget?: Budget) {
  const rows = await paged(S, 'paymentRecords', 'id amount entryDate paymentType client { name } invoice { id invoiceNumber }',
    { entryDate: { after: from + 'T00:00:00Z', before: to + 'T23:59:59Z' } }, 'PaymentRecordFilterAttributes', budget);
  return rows.filter((r) => { const d = String(r.entryDate ?? '').slice(0, 10); return d >= from && d <= to; });
}
export async function jobberInvoices(S: Settings, from: string, to: string, budget?: Budget) {
  const rows = await paged(S, 'invoices', 'id invoiceNumber invoiceStatus issuedDate dueDate amounts { total invoiceBalance } client { name }',
    { issuedDate: { after: from + 'T00:00:00Z', before: to + 'T23:59:59Z' } }, 'InvoiceFilterAttributes', budget);
  return rows.filter((r) => { const d = String(r.issuedDate ?? '').slice(0, 10); return d === '' || (d >= from && d <= to); });
}
