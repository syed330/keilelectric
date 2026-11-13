/**
 * Supabase database access through its REST API (PostgREST), with the server-side secret key.
 * Env: SUPABASE_URL (https://<project>.supabase.co) and SUPABASE_SERVICE_ROLE_KEY (service_role JWT or sb_secret_… key).
 */

export class DbError extends Error {
  constructor(message: string, public status = 500, public code = '') { super(message); }
}

function env(name: string): string { return (process.env[name] || '').trim(); }
export function dbConfigured(): boolean { return env('SUPABASE_URL') !== '' && env('SUPABASE_SERVICE_ROLE_KEY') !== ''; }

function base(): string {
  const url = env('SUPABASE_URL').replace(/\/+$/, '');
  if (!url) throw new DbError('SUPABASE_URL is not set. Add it in Netlify › Site configuration › Environment variables.', 500, 'config');
  return url + '/rest/v1';
}
function headers(extra: Record<string, string> = {}): Record<string, string> {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!key) throw new DbError('SUPABASE_SERVICE_ROLE_KEY is not set. Add it in Netlify › Site configuration › Environment variables.', 500, 'config');
  const h: Record<string, string> = { apikey: key, 'Content-Type': 'application/json', Accept: 'application/json', ...extra };
  if (key.split('.').length === 3) h.Authorization = 'Bearer ' + key; // legacy JWT keys; new sb_secret_ keys go in apikey only
  return h;
}

async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(base() + path, { method, headers: headers(extra), body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (err) {
    throw new DbError('Couldn’t reach Supabase: ' + (err as Error).message, 502, 'network');
  }
  if (!res.ok) {
    let msg = ''; let code = '';
    try { const j = await res.json() as { message?: string; code?: string; hint?: string }; msg = j.message || ''; code = j.code || ''; } catch { /* not JSON */ }
    if (code === '42P01' || /relation .* does not exist|Could not find the table/i.test(msg)) msg = 'The database tables are missing. Run supabase/schema.sql in Supabase › SQL Editor. (' + msg + ')';
    else if (res.status === 401 || res.status === 403) msg = 'Supabase refused the key. Check SUPABASE_SERVICE_ROLE_KEY (use the service_role / secret key, not the anon key). ' + msg;
    throw new DbError('Supabase ' + res.status + ': ' + msg, res.status, code);
  }
  return res;
}

/** One page of rows. `query` is a PostgREST query string, e.g. "select=*&added_at=gte.2026-01-01". */
export async function select<T = Record<string, unknown>>(table: string, query = 'select=*'): Promise<T[]> {
  const res = await call('GET', `/${table}?${query}`);
  return (await res.json()) as T[];
}
/** Every matching row, 1,000 at a time (Supabase's default page cap). `query` must include an order= for stable paging. */
export async function selectAll<T = Record<string, unknown>>(table: string, query: string, max = 200000): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < max; offset += 1000) {
    const rows = await select<T>(table, `${query}&limit=1000&offset=${offset}`);
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
/** Exact row count for a filter (no rows transferred). */
export async function count(table: string, filters = ''): Promise<number> {
  const res = await call('HEAD', `/${table}?select=*${filters ? '&' + filters : ''}`, undefined, { Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' });
  const cr = res.headers.get('content-range') || '';
  const n = Number(cr.split('/')[1]);
  return Number.isFinite(n) ? n : 0;
}
/** Insert or update rows by primary key (or `onConflict` columns), in batches. */
export async function upsert(table: string, rows: Record<string, unknown>[], onConflict?: string, batch = 500): Promise<number> {
  for (let i = 0; i < rows.length; i += batch) {
    await call('POST', `/${table}${onConflict ? '?on_conflict=' + onConflict : ''}`, rows.slice(i, i + batch), { Prefer: 'resolution=merge-duplicates,return=minimal' });
  }
  return rows.length;
}
export async function insert<T = Record<string, unknown>>(table: string, row: Record<string, unknown>): Promise<T> {
  const res = await call('POST', `/${table}`, row, { Prefer: 'return=representation' });
  return ((await res.json()) as T[])[0];
}
/** Update matching rows; returns the updated rows. */
export async function patch<T = Record<string, unknown>>(table: string, filters: string, body: Record<string, unknown>): Promise<T[]> {
  const res = await call('PATCH', `/${table}?${filters}`, body, { Prefer: 'return=representation' });
  return (await res.json()) as T[];
}
export async function remove(table: string, filters: string): Promise<void> {
  if (!filters) throw new DbError('Refusing to delete without a filter.');
  await call('DELETE', `/${table}?${filters}`, undefined, { Prefer: 'return=minimal' });
}
/** PostgREST value quoting for filters (e.g. ids that contain commas or dots). */
export function q(v: string): string { return encodeURIComponent(/[,.:()"\s]/.test(v) ? '"' + v.replace(/"/g, '\\"') + '"' : v); }
