/** GoHighLevel API v2 client (LeadConnector). Used by the background sync and the admin connection tests. */
import type { Settings } from './settings.js';
import { sleep, toDateTime } from './util.js';
import type { DateTime } from 'luxon';

export const GHL_VERSION = '2021-07-28';
export function ghlBase(): string { return (process.env.GHL_API_BASE || 'https://services.leadconnectorhq.com').replace(/\/+$/, ''); }

export class GhlError extends Error { constructor(message: string, public status: number) { super(message); } }
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A deadline shared by one run (page request or sync), so long reads stop cleanly instead of timing out. */
export class Budget {
  private end: number;
  constructor(seconds: number) { this.end = Date.now() + seconds * 1000; }
  left(): number { return (this.end - Date.now()) / 1000; }
  out(): boolean { return this.left() <= 0; }
}

function ghlError(code: number, json: Json | null, path: string, netErr = ''): GhlError {
  if (code === 0) return new GhlError('Couldn’t reach GoHighLevel' + (netErr ? ': ' + netErr : '') + '.', 502);
  const m = json ? (Array.isArray(json.message) ? json.message.join(' ') : String(json.message ?? json.error ?? '')) : '';
  if (code === 401) return new GhlError('GoHighLevel rejected the token. Check the Private Integration token in Admin › GHL connection.', 401);
  if (code === 403) return new GhlError(`The token isn’t allowed to read ${path}. Add the missing scope to the Private Integration${m ? ` (${m})` : ''}.`, 403);
  if (code === 404) return new GhlError('GoHighLevel couldn’t find that' + (m ? ': ' + m : ' — check the Location ID') + '.', 404);
  if (code === 429) return new GhlError('GoHighLevel is rate-limiting requests. Try again in a minute.', 429);
  return new GhlError('GoHighLevel error ' + code + (m ? ': ' + m : ''), code);
}

export interface Req { method: 'GET' | 'POST'; path: string; query?: Record<string, string | number | undefined>; body?: unknown }

/** One request, retrying rate limits. */
export async function ghl(S: Settings, r: Req, budget?: Budget): Promise<Json> {
  const qs = r.query ? '?' + new URLSearchParams(Object.entries(r.query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString() : '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(5, Math.min(30, (budget?.left() ?? 25) + 5)) * 1000);
    let res: Response;
    try {
      res = await fetch(ghlBase() + r.path + qs, {
        method: r.method, signal: ctrl.signal,
        headers: { Authorization: 'Bearer ' + S.ghl.token, Version: GHL_VERSION, Accept: 'application/json', ...(r.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: r.body !== undefined ? JSON.stringify(r.body) : undefined,
      });
    } catch (err) {
      clearTimeout(timer);
      throw ghlError(0, null, r.path, (err as Error).name === 'AbortError' ? 'timed out' : (err as Error).message);
    }
    clearTimeout(timer);
    if (res.status === 429 && attempt < 2 && (budget?.left() ?? 99) > 4) { await sleep(2000 * (attempt + 1)); continue; }
    let json: Json | null = null;
    try { json = await res.json() as Json; } catch { json = null; }
    if (res.ok) return json ?? {};
    throw ghlError(res.status, json, r.path);
  }
  throw new GhlError('GoHighLevel didn’t respond.', 502);
}

/** Several requests at once, a few at a time (GHL allows ~100 requests / 10 s per location). Errors are returned, not thrown. */
export async function ghlMulti(S: Settings, reqs: Req[], budget?: Budget, concurrency = 5): Promise<(Json | GhlError)[]> {
  const out: (Json | GhlError)[] = new Array(reqs.length);
  let i = 0;
  async function worker() {
    while (i < reqs.length) {
      const k = i++;
      if (budget?.out()) { out[k] = new GhlError('Stopped to stay within the time limit.', 504); continue; }
      try { out[k] = await ghl(S, reqs[k], budget); } catch (err) { out[k] = err instanceof GhlError ? err : new GhlError((err as Error).message, 500); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, reqs.length) }, worker));
  return out;
}

export interface Stage { id: string; name: string; position: number }
export interface Pipeline { id: string; name: string; stages: Stage[] }
export async function fetchPipelines(S: Settings, budget?: Budget): Promise<Pipeline[]> {
  const r = await ghl(S, { method: 'GET', path: '/opportunities/pipelines', query: { locationId: S.ghl.locationId } }, budget);
  return (r.pipelines ?? []).map((p: Json) => {
    const stages: Stage[] = (p.stages ?? []).map((st: Json, i: number) => ({ id: String(st.id), name: String(st.name ?? ''), position: Number(st.position ?? i) }));
    stages.sort((a, b) => a.position - b.position);
    return { id: String(p.id), name: String(p.name ?? 'Pipeline'), stages };
  });
}
export async function fetchLocationName(S: Settings, budget?: Budget): Promise<string> {
  const r = await ghl(S, { method: 'GET', path: '/locations/' + encodeURIComponent(S.ghl.locationId) }, budget);
  return String(r.location?.name ?? r.name ?? '');
}

export function contactsSearchBody(loc: string, from: DateTime, to: DateTime, page: number, limit: number) {
  return { locationId: loc, page, pageLimit: limit,
    filters: [{ field: 'dateAdded', operator: 'range', value: { gte: from.toISO({ suppressMilliseconds: true }), lte: to.toISO({ suppressMilliseconds: true }) } }],
    sort: [{ field: 'dateAdded', direction: 'desc' }] };
}

/** Contacts added in [from, to]. Search Contacts (pages in parallel); falls back to the older list endpoint. */
export async function fetchContacts(S: Settings, from: DateTime, to: DateTime, warnings: string[], budget?: Budget): Promise<Json[]> {
  const loc = S.ghl.locationId; const MAXP = 100;
  try {
    const r = await ghl(S, { method: 'POST', path: '/contacts/search', body: contactsSearchBody(loc, from, to, 1, 100) }, budget);
    const all: Json[] = [...(r.contacts ?? [])];
    const total = Number(r.total ?? 0);
    if (all.length >= 100 && total > 100) {
      const pages = Math.min(MAXP, Math.ceil(total / 100));
      const reqs: Req[] = [];
      for (let p = 2; p <= pages; p++) reqs.push({ method: 'POST', path: '/contacts/search', body: contactsSearchBody(loc, from, to, p, 100) });
      let missed = 0;
      for (const res of await ghlMulti(S, reqs, budget)) {
        if (res instanceof GhlError) { if (res.status === 401) throw res; missed++; continue; }
        all.push(...(res.contacts ?? []));
      }
      if (missed) warnings.push(`Contacts ${from.toFormat('LLL yyyy')}: ${missed} of ${pages} pages couldn’t be read; the next sync will try again.`);
      if (total > MAXP * 100) warnings.push(`Contacts ${from.toFormat('LLL yyyy')}: more than ${MAXP * 100} in one month; only the newest were read.`);
    }
    return all;
  } catch (err) {
    if (err instanceof GhlError && [401, 403, 429, 502, 504].includes(err.status)) throw err;
  }
  // Fallback: GET /contacts/ (newest first), stop when older than `from`.
  const all: Json[] = []; const q: Record<string, string | number | undefined> = { locationId: loc, limit: 100 };
  for (let page = 0; page < 100 && !budget?.out(); page++) {
    const r = await ghl(S, { method: 'GET', path: '/contacts/', query: q }, budget);
    const batch: Json[] = r.contacts ?? [];
    for (const c of batch) {
      const added = toDateTime(c.dateAdded);
      if (added && added < from) return all;
      if (!added || added <= to) all.push(c);
    }
    const meta = r.meta ?? {};
    if (batch.length < 100 || !meta.startAfterId) return all;
    q.startAfterId = meta.startAfterId; q.startAfter = meta.startAfter;
  }
  return all;
}

/** Every opportunity. GHL allows page OR startAfter/startAfterId — never both (that combination is a 400). */
export async function fetchOpportunities(S: Settings, warnings: string[], budget?: Budget): Promise<Json[]> {
  const base = { location_id: S.ghl.locationId, limit: 100, status: 'all' };
  const r = await ghl(S, { method: 'GET', path: '/opportunities/search', query: { ...base, page: 1 } }, budget);
  const first: Json[] = r.opportunities ?? [];
  let meta: Json = r.meta ?? {};
  const total: number | null = meta.total !== undefined ? Number(meta.total) : null;
  const all: Json[] = []; const seen = new Set<string>();
  const add = (batch: Json[]) => { let n = 0; for (const o of batch) { const id = String(o.id ?? ''); if (id && seen.has(id)) continue; if (id) seen.add(id); all.push(o); n++; } return n; };
  add(first);
  if (first.length < 100 || (total !== null && total <= 100)) return all;
  if (total !== null) {
    const pages = Math.min(300, Math.ceil(total / 100));
    const reqs: Req[] = [];
    for (let p = 2; p <= pages; p++) reqs.push({ method: 'GET', path: '/opportunities/search', query: { ...base, page: p } });
    let missed = 0, dupes = true;
    for (const res of await ghlMulti(S, reqs, budget)) {
      if (res instanceof GhlError) { if (res.status === 401) throw res; missed++; continue; }
      if (add(res.opportunities ?? []) > 0) dupes = false;
    }
    if (!dupes || all.length >= total) {
      if (missed) warnings.push(`Opportunities: ${missed} of ${pages} pages couldn’t be read; the next sync will try again.`);
      return all;
    }
    // page numbers ignored by the API (every page identical) → cursor paging
  }
  const q: Record<string, string | number | undefined> = { ...base };
  for (let i = 0; i < 300 && !budget?.out(); i++) {
    const nextId = String(meta.startAfterId ?? ''); const nextAt = meta.startAfter;
    if (!nextId || nextAt === undefined || nextAt === null || nextAt === '' || q.startAfterId === nextId) return all;
    q.startAfterId = nextId; q.startAfter = nextAt;
    const rr = await ghl(S, { method: 'GET', path: '/opportunities/search', query: q }, budget);
    const batch: Json[] = rr.opportunities ?? []; meta = rr.meta ?? {};
    if (add(batch) === 0 || batch.length < 100 || (total !== null && all.length >= total)) return all;
  }
  return all;
}

async function offsetPaged(S: Settings, path: string, query: Record<string, string>, listKeys: string[], totalKey: string, budget?: Budget, maxPages = 100): Promise<Json[]> {
  const all: Json[] = [];
  for (let i = 0, offset = 0; i < maxPages && !budget?.out(); i++, offset += 100) {
    const r = await ghl(S, { method: 'GET', path, query: { ...query, limit: 100, offset } }, budget);
    let batch: Json[] = [];
    for (const k of listKeys) if (Array.isArray(r[k])) { batch = r[k]; break; }
    all.push(...batch);
    if (batch.length < 100 || (r[totalKey] !== undefined && all.length >= Number(r[totalKey]))) break;
  }
  return all;
}
export function fetchTransactions(S: Settings, fromYmd: string, toYmd: string, budget?: Budget) {
  return offsetPaged(S, '/payments/transactions', { altId: S.ghl.locationId, altType: 'location', startAt: fromYmd, endAt: toYmd }, ['data', 'transactions'], 'totalCount', budget);
}
export function fetchInvoices(S: Settings, fromYmd: string, toYmd: string, budget?: Budget) {
  return offsetPaged(S, '/invoices/', { altId: S.ghl.locationId, altType: 'location', startAt: fromYmd, endAt: toYmd }, ['invoices', 'data'], 'total', budget);
}

/** Contact display name from any GHL contact shape. */
export function contactName(c: Json): string {
  let n = String(c.contactName ?? c.name ?? '').trim();
  if (!n) n = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim();
  if (!n) n = String(c.companyName ?? '').trim();
  if (!n) n = String(c.email ?? '').trim();
  if (!n) n = String(c.phone ?? '').trim();
  if (!n) return 'Unnamed contact';
  return /[A-Z]/.test(n) ? n : n.replace(/(^|\s)\S/g, (m) => m.toUpperCase());
}
