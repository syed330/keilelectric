/** App settings: one Supabase row (app_settings.id = 1), JSON with a version number for safe concurrent saves. */
import { select, patch, insert, DbError } from './db.js';

export interface ManualSpend { id: string; channel: string; from: string; to: string; amount: number; note: string }
export interface Settings {
  adminHash: string | null;
  viewerHash: string | null;
  ghl: { locationId: string; token: string; locationName: string; connectedAt: string | null };
  display: { company: string; region: string; title: string; weekStartsOn: number; timezone: string; refreshSeconds: number; defaultRange: string };
  sources: { qualifiedTags: string; useTransactions: boolean; syncMinutes: number };
  export: { key: string };
  jobber: { clientId: string; clientSecret: string; accessToken: string; refreshToken: string; expiresAt: number; account: string; version: string; connectedAt: string | null };
  ads: {
    meta: { accountId: string; token: string; version: string };
    google: { customerId: string; loginCustomerId: string; developerToken: string; clientId: string; clientSecret: string; refreshToken: string; version: string };
    manual: ManualSpend[];
    match: { google: string; meta: string };
    googleVersionFound?: string;
    pending?: { meta?: Record<string, string>; google?: Record<string, string> }; // values from a failed connection test (server-side only)
  };
  _version?: number;
}

export function defaults(): Settings {
  return {
    adminHash: null, viewerHash: null,
    ghl: { locationId: '', token: '', locationName: '', connectedAt: null },
    display: { company: 'Keil Electric', region: 'San Diego', title: 'Daily Pipeline Scorecard', weekStartsOn: 1, timezone: 'America/Los_Angeles', refreshSeconds: 120, defaultRange: 'last_week' },
    sources: { qualifiedTags: 'qualified, sql', useTransactions: true, syncMinutes: 15 },
    export: { key: '' },
    jobber: { clientId: '', clientSecret: '', accessToken: '', refreshToken: '', expiresAt: 0, account: '', version: '2025-01-20', connectedAt: null },
    ads: {
      meta: { accountId: '', token: '', version: '' },
      google: { customerId: '', loginCustomerId: '', developerToken: '', clientId: '', clientSecret: '', refreshToken: '', version: '' },
      manual: [],
      match: { google: 'google, adwords, ppc, lsa, local services, gclid', meta: 'facebook, meta, instagram, fb, ig' },
    },
  };
}

function isObj(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
/** Deep-merge saved values over the defaults (objects merge; arrays and scalars replace). */
export function merge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(out[k]) && isObj(v) ? merge(out[k], v) : v;
  return out as T;
}

export async function loadSettings(): Promise<Settings> {
  const rows = await select<{ data: unknown; version: number }>('app_settings', 'select=data,version&id=eq.1');
  if (!rows.length) {
    try { await insert('app_settings', { id: 1, data: {} }); } catch { /* created concurrently */ }
    return { ...defaults(), _version: 1 };
  }
  const s = merge(defaults(), rows[0].data);
  s._version = rows[0].version;
  return s;
}

export class SettingsConflict extends Error {}
/** Saves only if nobody else saved since we loaded (version check); throws SettingsConflict otherwise. */
export async function saveSettings(S: Settings): Promise<Settings> {
  const { _version, ...data } = S;
  const v = _version ?? 1;
  const rows = await patch<{ version: number }>('app_settings', `id=eq.1&version=eq.${v}`, { data, version: v + 1, updated_at: new Date().toISOString() });
  if (!rows.length) throw new SettingsConflict('Settings were changed by another request. Please try again.');
  S._version = v + 1;
  return S;
}
/** Load → change → save, retrying if another request saved in between. */
export async function updateSettings(fn: (S: Settings) => void | Promise<void>, tries = 4): Promise<Settings> {
  for (let i = 0; i < tries; i++) {
    const S = await loadSettings();
    await fn(S);
    try { return await saveSettings(S); } catch (err) { if (!(err instanceof SettingsConflict) || i === tries - 1) throw err; }
  }
  throw new DbError('Couldn’t save settings.');
}
