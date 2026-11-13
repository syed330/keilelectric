/**
 * Ad spend by source channel (Google Ads, Meta Ads).
 * GoHighLevel's public API doesn't expose its Ads Reporting numbers, so spend is read the way GHL gets it:
 * from the Meta Marketing API and the Google Ads API (by the background sync, into ad_spend_daily),
 * or from spend entered by hand in Admin › Ad spend. Leads, bookings and sales match a channel by their GHL source.
 */
import type { Settings } from './settings.js';
import { lower, addDays, validYmd, daysBetween } from './util.js';
import { selectAll } from './db.js';
import type { Budget } from './ghl.js';

export const AD_CHANNELS: Record<'google' | 'meta', { label: string; color: string }> = {
  google: { label: 'Google Ads', color: '#3a7bd5' },
  meta: { label: 'Meta Ads', color: '#6c47c1' },
};
export type Channel = keyof typeof AD_CHANNELS;

/** Which channel a GHL lead source belongs to (keywords from Admin › Ad spend), or null. */
export function channelOf(source: unknown, S: Settings): Channel | null {
  const src = lower(source).trim();
  if (!src) return null;
  for (const ch of Object.keys(AD_CHANNELS) as Channel[]) {
    for (const w of String(S.ads.match[ch] || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean)) {
      const hit = w.length <= 3 ? new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)').test(src) : src.includes(w);
      if (hit) return ch;
    }
  }
  return null;
}
export function adsConfigured(S: Settings, ch: Channel): boolean {
  if (ch === 'meta') return !!S.ads.meta.accountId && !!S.ads.meta.token;
  const g = S.ads.google; return !!(g.customerId && g.developerToken && g.clientId && g.clientSecret && g.refreshToken);
}
export class AdsError extends Error {}

async function http(method: string, url: string, headers: Record<string, string> = {}, body?: string, budget?: Budget): Promise<[number, any]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), Math.max(5, Math.min(30, (budget?.left() ?? 25) + 5)) * 1000);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    let j: unknown = null; try { j = await res.json(); } catch { /* empty */ }
    return [res.status, j];
  } catch (err) { throw new AdsError('Couldn’t reach the ad platform: ' + ((err as Error).name === 'AbortError' ? 'timed out' : (err as Error).message)); }
  finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------- Meta Marketing API
export async function metaSpend(S: Settings, from: string, to: string, budget?: Budget): Promise<Record<string, number>> {
  const m = S.ads.meta;
  const acct = String(m.accountId).replace(/[^0-9a-z_]/gi, '').replace(/^act_/, '');
  const ver = String(m.version || '').trim();
  const base = (process.env.META_API_BASE || 'https://graph.facebook.com').replace(/\/+$/, '');
  let url: string | null = `${base}/${ver ? ver + '/' : ''}act_${encodeURIComponent(acct)}/insights?` + new URLSearchParams({
    fields: 'spend', level: 'account', time_increment: '1', limit: '500', time_range: JSON.stringify({ since: from, until: to }), access_token: m.token }).toString();
  const days: Record<string, number> = {};
  for (let i = 0; i < 30 && url && !budget?.out(); i++) {
    const [code, j] = await http('GET', url, {}, undefined, budget);
    if (code >= 400 || j?.error) {
      const er = j?.error ?? {}; const c = Number(er.code ?? 0);
      let msg = String(er.message ?? 'HTTP ' + code);
      if (c === 190) msg = 'the access token is invalid or expired — create a new one (Meta Business Settings › System users)';
      else if ([10, 200, 294].includes(c)) msg = 'the token isn’t allowed to read this ad account — give it the ads_read permission and access to the account';
      else if (c === 100) msg = `Meta doesn’t recognize that ad account ID (${msg})`;
      throw new AdsError('Meta Ads: ' + msg);
    }
    for (const row of j?.data ?? []) { const d = String(row.date_start ?? ''); if (validYmd(d)) days[d] = (days[d] ?? 0) + (Number(row.spend) || 0); }
    url = j?.paging?.next ?? null;
  }
  return days;
}

// ---------------------------------------------------------------- Google Ads API
const tokenCache = new Map<string, { token: string; exp: number }>();
async function googleAccessToken(S: Settings, budget?: Budget): Promise<string> {
  const g = S.ads.google; const key = g.clientId + '|' + g.refreshToken;
  const c = tokenCache.get(key); if (c && c.exp > Date.now() + 60000) return c.token;
  const [code, j] = await http('POST', process.env.GOOGLE_OAUTH_URL || 'https://oauth2.googleapis.com/token', { 'Content-Type': 'application/x-www-form-urlencoded' },
    new URLSearchParams({ client_id: g.clientId, client_secret: g.clientSecret, refresh_token: g.refreshToken, grant_type: 'refresh_token' }).toString(), budget);
  if (code >= 400 || !j?.access_token) {
    const why = String(j?.error_description ?? j?.error ?? 'HTTP ' + code);
    throw new AdsError('Google Ads: sign-in failed — ' + (why === 'invalid_grant' || /expired/i.test(why) ? 'the refresh token is expired or revoked; create a new one' : why) + '.');
  }
  tokenCache.set(key, { token: j.access_token, exp: Date.now() + Number(j.expires_in ?? 3600) * 1000 });
  return j.access_token;
}
/** Google retires API versions about once a year: try the pinned one, else the one found last time, then newest-to-oldest. */
function googleVersions(S: Settings): string[] {
  const pin = String(S.ads.google.version || '').trim();
  if (pin) return [pin];
  return [...new Set([S.ads.googleVersionFound, 'v26', 'v25', 'v24', 'v23', 'v22', 'v21', 'v20'].filter(Boolean) as string[])];
}
/** Daily spend, and the API version that answered (to remember). */
export async function googleSpend(S: Settings, from: string, to: string, budget?: Budget): Promise<{ days: Record<string, number>; version: string }> {
  const g = S.ads.google;
  const cid = g.customerId.replace(/\D/g, ''), login = String(g.loginCustomerId || '').replace(/\D/g, '');
  const token = await googleAccessToken(S, budget);
  const headers: Record<string, string> = { Authorization: 'Bearer ' + token, 'developer-token': g.developerToken, 'Content-Type': 'application/json' };
  if (login) headers['login-customer-id'] = login;
  const body = JSON.stringify({ query: `SELECT segments.date, metrics.cost_micros FROM customer WHERE segments.date BETWEEN '${from}' AND '${to}'` });
  const base = (process.env.GOOGLE_ADS_BASE || 'https://googleads.googleapis.com').replace(/\/+$/, '');
  let last = '';
  for (const v of googleVersions(S)) {
    if (budget?.out()) break;
    const [code, j] = await http('POST', `${base}/${v}/customers/${cid}/googleAds:searchStream`, headers, body, budget);
    if (code === 404) { last = `API version ${v} not available`; continue; }
    if (code >= 400) {
      const er = (Array.isArray(j) ? j[0]?.error : j?.error) ?? {};
      let msg = String(er.message ?? 'HTTP ' + code); const detail = JSON.stringify(er.details ?? []);
      if (detail.includes('DEVELOPER_TOKEN_NOT_APPROVED')) msg = 'the developer token only has test access — apply for Basic access in the Google Ads API Center';
      else if (detail.includes('USER_PERMISSION_DENIED') || code === 403) msg = `the signed-in Google user can’t read customer ${cid}` + (login ? '' : ' — if it’s managed by an MCC, enter the MCC ID as the login customer ID');
      else if (detail.includes('CUSTOMER_NOT_FOUND')) msg = `customer ID ${cid} wasn’t found`;
      throw new AdsError('Google Ads: ' + msg + '.');
    }
    const days: Record<string, number> = {};
    for (const batch of (Array.isArray(j) ? j : [j])) for (const r of batch?.results ?? []) {
      const d = String(r?.segments?.date ?? '');
      if (validYmd(d)) days[d] = (days[d] ?? 0) + (Number(r?.metrics?.costMicros ?? r?.metrics?.cost_micros ?? 0) / 1e6);
    }
    return { days, version: v };
  }
  throw new AdsError(`Google Ads: no supported API version answered (${last}). Set the API version in Admin › Ad spend.`);
}

// ---------------------------------------------------------------- manual entries & stored spend
/** Manual entries are spread evenly over their days, so a monthly amount shows correctly in any week or day. */
export function manualSpend(S: Settings, ch: Channel, from: string, to: string): Record<string, number> {
  const days: Record<string, number> = {};
  for (const m of S.ads.manual) {
    if (m.channel !== ch || !validYmd(m.from) || !validYmd(m.to)) continue;
    const n = daysBetween(m.from, m.to) + 1; if (n <= 0) continue;
    const per = Number(m.amount) / n;
    for (let d = m.from; d <= m.to; d = addDays(d, 1)) if (d >= from && d <= to) days[d] = (days[d] ?? 0) + per;
  }
  return days;
}
export interface SpendData { channels: Record<Channel, { label: string; color: string; source: string | null; days: Record<string, number> }>; warnings: string[] }
/** Daily spend per channel for [from, to] (yyyy-MM-dd): the synced API numbers when connected, else manual entries. */
export async function spendDays(S: Settings, from: string, to: string): Promise<SpendData> {
  const rows = await selectAll<{ channel: string; day: string; amount: number; source: string }>('ad_spend_daily', `select=channel,day,amount,source&day=gte.${from}&day=lte.${to}&order=day.asc`);
  const out = { channels: {} as SpendData['channels'], warnings: [] as string[] };
  for (const ch of Object.keys(AD_CHANNELS) as Channel[]) {
    const api = rows.filter((r) => r.channel === ch);
    const row = { ...AD_CHANNELS[ch], source: null as string | null, days: {} as Record<string, number> };
    if (adsConfigured(S, ch) && api.length) {
      for (const r of api) row.days[String(r.day).slice(0, 10)] = Number(r.amount) || 0;
      row.source = api[api.length - 1].source || (ch === 'meta' ? 'Meta Marketing API' : 'Google Ads API');
    } else {
      const manual = manualSpend(S, ch, from, to);
      if (Object.keys(manual).length) { row.days = manual; row.source = 'manual entries (Admin › Ad spend)'; }
      else if (adsConfigured(S, ch)) out.warnings.push(`${AD_CHANNELS[ch].label} is connected but hasn’t been synced yet.`);
    }
    out.channels[ch] = row;
  }
  return out;
}
/** Sum of daily spend over [from, to] (the date part of "yyyy-MM-dd HH:mm" strings is used). */
export function spendBetween(days: Record<string, number>, from: string, to: string): number {
  const f = from.slice(0, 10), t = to.slice(0, 10); let s = 0;
  for (const [d, v] of Object.entries(days)) if (d >= f && d <= t) s += v;
  return s;
}
