/** Formatting, escaping and date helpers shared by every page (port of the PHP bootstrap helpers). */
import { DateTime } from 'luxon';

export type Dict<T = unknown> = Record<string, T>;

/** HTML-escape anything. */
export function e(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c] as string));
}
const nf = (d: number) => new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
/** $1,234 (whole dollars; negative as -$1,234). */
export function money(v: unknown): string {
  if (v === null || v === undefined) return '—';
  const n = Number(v) || 0;
  return (n < 0 ? '-$' : '$') + nf(0).format(Math.abs(Math.round(n)));
}
export function num(v: unknown, d = 0): string { return v === null || v === undefined ? '—' : nf(d).format(Number(v) || 0); }
export function pct(v: unknown): string { return v === null || v === undefined ? '—' : nf(1).format(Number(v) || 0) + '%'; }
export function lower(s: unknown): string { return String(s ?? '').toLowerCase(); }
export function strIn(v: unknown, max = 200): string { return String(v ?? '').trim().slice(0, max); }
export function ucwords(s: string): string { return s.replace(/(^|\s)\S/g, (m) => m.toUpperCase()); }

// ---------------------------------------------------------------- calendar dates ("Y-m-d" strings)
export function validYmd(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  return DateTime.fromISO(v, { zone: 'utc' }).isValid;
}
export function ymdObj(ymd: string): DateTime { return DateTime.fromISO(ymd + 'T12:00:00', { zone: 'utc' }); }
export function addDays(ymd: string, n: number): string { return ymdObj(ymd).plus({ days: n }).toFormat('yyyy-MM-dd'); }
/** Monday (startsOn 1) or Sunday (0) on or before the date. */
export function weekStart(ymd: string, startsOn: number): string {
  const dow = ymdObj(ymd).weekday % 7; // luxon: Mon=1 … Sun=7 → Sun=0
  return addDays(ymd, -((dow - startsOn + 7) % 7));
}
export function daysBetween(a: string, b: string): number { return Math.round(ymdObj(b).diff(ymdObj(a), 'days').days); }

/** Any GHL / Jobber timestamp (ISO text, epoch seconds or milliseconds, numeric text) → DateTime or null. */
export function toDateTime(v: unknown): DateTime | null {
  if (v === null || v === undefined || v === '' || v === false || typeof v === 'object') return null;
  if (typeof v === 'number' || (typeof v === 'string' && /^\d{9,14}(\.\d+)?$/.test(v))) {
    let n = Number(v); if (n > 1e11) n /= 1000;
    const d = DateTime.fromSeconds(Math.floor(n), { zone: 'utc' }); return d.isValid ? d : null;
  }
  const s = String(v);
  let d = DateTime.fromISO(s, { setZone: true });
  if (!d.isValid) d = DateTime.fromSQL(s, { zone: 'utc' });
  if (!d.isValid) { const t = Date.parse(s); if (!Number.isNaN(t)) d = DateTime.fromMillis(t, { zone: 'utc' }); }
  return d.isValid ? d : null;
}
/** Timestamp → "Y-m-d H:i" in the report's time zone (these strings compare correctly as text). */
export function dtLocal(v: unknown, zone: string): string | null {
  const d = toDateTime(v); return d ? d.setZone(zone).toFormat('yyyy-MM-dd HH:mm') : null;
}
export function isoUtc(v: unknown): string | null { const d = toDateTime(v); return d ? d.toUTC().toISO() : null; }

/** PHP-style short formats used across the pages. */
export const fmt = {
  hm12: (d: DateTime) => d.toFormat('h:mm a', { locale: 'en-US' }),
  ga: (d: DateTime) => (d.toFormat('h', { locale: 'en-US' }).replace(/^0/, '') + d.toFormat('a', { locale: 'en-US' }).toLowerCase()),
};
export function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
