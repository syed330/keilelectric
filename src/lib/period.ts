/**
 * Reporting period: presets (Today … Last 90 days) or a custom date/time range.
 * All times are "yyyy-MM-dd HH:mm" strings in the report's time zone, so they compare as text.
 */
import { DateTime } from 'luxon';
import type { Settings } from './settings.js';
import { e, addDays, weekStart, validYmd, ymdObj, fmt } from './util.js';

export const PRESETS: Record<string, string> = {
  today: 'Today', yesterday: 'Yesterday', this_week: 'This week', last_week: 'Last week', last_7: 'Last 7 days', last_30: 'Last 30 days',
  this_month: 'This month', last_month: 'Last month', last_90: 'Last 90 days', custom: 'Custom range',
};
const F = 'yyyy-MM-dd HH:mm';
const L = { locale: 'en-US' } as const;

export interface Bucket { start: string; end: string; label: string; head: [string, string]; now: boolean; future: boolean }
export interface TrendP { start: string; end: string; label: string }
export interface Period {
  key: string; label: string; text: string; short: string; default: string; compareShort: string; compare: string; unit: 'hour' | 'day' | 'week';
  from: string; to: string; fromDT: DateTime; toDT: DateTime; prevFrom: string; prevTo: string; fetchFrom: DateTime; fetchTo: DateTime;
  buckets: Bucket[]; trend: TrendP[]; isCurrent: boolean; hasFuture: boolean; minutes: number; fullDays: boolean; byDays: boolean; nDays: number;
  now: string; today: string; zone: string;
}

export function zoneOf(S: Settings): string {
  const z = S.display.timezone || 'America/Los_Angeles';
  return DateTime.now().setZone(z).isValid ? z : 'America/Los_Angeles';
}
function at(ymdHm: string, zone: string): DateTime { return DateTime.fromFormat(ymdHm, F, { zone }); }
function parseLocal(v: string, zone: string, endOfDay: boolean): DateTime | null {
  let s = String(v || '').replace('T', ' ').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += endOfDay ? ' 23:59' : ' 00:00';
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) return null;
  const d = at(s, zone);
  return d.isValid && d.toFormat(F) === s ? d : null;
}
const lastOfMonth = (d: DateTime) => d.endOf('month').toFormat('yyyy-MM-dd');

export function resolvePeriod(S: Settings, query: Record<string, string | undefined>): Period {
  const q: Record<string, string | undefined> = { ...query };
  const zone = zoneOf(S);
  const startsOn = Number(S.display.weekStartsOn) === 0 ? 0 : 1;
  const now = DateTime.now().setZone(zone);
  const today = now.toFormat('yyyy-MM-dd');
  let def = String(S.display.defaultRange || 'last_week');
  if (!PRESETS[def] || def === 'custom') def = 'last_week';
  let key = q.range && PRESETS[q.range] ? q.range : def;
  for (const [f, dflt] of [['from', '00:00'], ['to', '23:59']] as const) {
    if (!q[f] && validYmd(q[f + '_date'])) { const t = q[f + '_time'] || ''; q[f] = q[f + '_date'] + 'T' + (/^\d{2}:\d{2}$/.test(t) ? t : dflt); }
  }
  if (!q.range && validYmd(q.week)) { key = 'custom'; const ws = weekStart(q.week, startsOn); q.from = ws; q.to = addDays(ws, 6); }

  const day = (f: string, t: string): [DateTime, DateTime] => [at(f + ' 00:00', zone), at(t + ' 23:59', zone)];
  const ws = weekStart(today, startsOn);
  const mStart = now.toFormat('yyyy-MM-01');
  let from: DateTime, to: DateTime;
  switch (key) {
    case 'today': [from, to] = day(today, today); break;
    case 'yesterday': { const y = addDays(today, -1); [from, to] = day(y, y); break; }
    case 'last_week': [from, to] = day(addDays(ws, -7), addDays(ws, -1)); break;
    case 'last_7': [from, to] = day(addDays(today, -6), today); break;
    case 'last_30': [from, to] = day(addDays(today, -29), today); break;
    case 'last_90': [from, to] = day(addDays(today, -89), today); break;
    case 'this_month': [from, to] = day(mStart, lastOfMonth(at(mStart + ' 00:00', zone))); break;
    case 'last_month': { const lm = at(mStart + ' 00:00', zone).minus({ months: 1 }); [from, to] = day(lm.toFormat('yyyy-MM-01'), lastOfMonth(lm)); break; }
    case 'custom': {
      const f = parseLocal(q.from || '', zone, false), t = parseLocal(q.to || '', zone, true);
      if (f && t) { [from, to] = [f, t]; } else { [from, to] = day(ws, addDays(ws, 6)); }
      if (to < from) [from, to] = [to, from];
      if (to.diff(from, 'days').days > 366) from = to.minus({ days: 366 });
      break;
    }
    default: [from, to] = day(ws, addDays(ws, 6));
  }
  const minutes = Math.floor((to.toMillis() - from.toMillis()) / 60000) + 1;
  // Whole-day periods are measured in calendar days, so daylight-saving changes don't shift them by an hour.
  const fullDays = from.toFormat('HH:mm') === '00:00' && to.toFormat('HH:mm') === '23:59';
  const nDays = Math.round(ymdObj(to.toFormat('yyyy-MM-dd')).diff(ymdObj(from.toFormat('yyyy-MM-dd')), 'days').days) + 1;
  // Part of a single day (e.g. 8:00 AM – 5:30 PM) steps and compares by whole days: the same hours the day before.
  const sameDayHours = !fullDays && from.toFormat('yyyy-MM-dd') === to.toFormat('yyyy-MM-dd');
  const byDays = fullDays || sameDayHours;
  const shift = (d: DateTime, k: number) => byDays ? d.plus({ days: k * nDays }) : d.plus({ minutes: k * minutes });
  let prevFrom = shift(from, -1), prevTo = shift(to, -1);
  if (key === 'this_month' || key === 'last_month') { const pm = from.minus({ months: 1 }); prevFrom = at(pm.toFormat('yyyy-MM-01') + ' 00:00', zone); prevTo = at(lastOfMonth(pm) + ' 23:59', zone); }

  // buckets for charts and the table: hours (≤ 2 days), days (≤ 62 days), else weeks
  const days = fullDays ? nDays : Math.ceil(minutes / 1440);
  const unit: Period['unit'] = (fullDays ? nDays <= 2 : minutes <= 2 * 1440) ? 'hour' : (days <= 62 ? 'day' : 'week');
  const buckets: Bucket[] = [];
  let cur = unit === 'week' ? at(weekStart(from.toFormat('yyyy-MM-dd'), startsOn) + ' 00:00', zone)
    : unit === 'hour' ? at(from.toFormat('yyyy-MM-dd HH') + ':00', zone) : at(from.toFormat('yyyy-MM-dd') + ' 00:00', zone);
  const step = (d: DateTime) => unit === 'hour' ? d.plus({ hours: 1 }) : unit === 'day' ? d.plus({ days: 1 }) : d.plus({ days: 7 });
  const multiDay = from.toFormat('yyyy-MM-dd') !== to.toFormat('yyyy-MM-dd');
  while (cur <= to && buckets.length < 200) {
    const next = step(cur);
    const s = cur > from ? cur : from; const eDt = next.minus({ minutes: 1 }); const en = eDt < to ? eDt : to;
    buckets.push({
      start: s.toFormat(F), end: en.toFormat(F),
      label: unit === 'hour' ? (multiDay ? cur.toFormat('ccc', L) + ' ' + fmt.ga(cur) : fmt.ga(cur)) : unit === 'day' ? cur.toFormat('ccc MM/dd', L) : 'Wk ' + cur.toFormat('LLL d', L),
      head: unit === 'hour' ? [multiDay ? cur.toFormat('ccc', L) : '', fmt.ga(cur)] : unit === 'day' ? [cur.toFormat('ccc', L), cur.toFormat('MM/dd')] : ['Week', cur.toFormat('LLL d', L)],
      now: now >= cur && now < next, future: cur > now,
    });
    cur = next;
  }
  // trend: the same-length periods leading up to this one
  const trendN = days <= 14 ? 8 : days <= 45 ? 6 : 4;
  const trend: TrendP[] = [];
  for (let i = trendN - 1; i >= 0; i--) {
    let ts: DateTime, te: DateTime, lab: string;
    if (key === 'this_month' || key === 'last_month') { const m = from.minus({ months: i }); ts = at(m.toFormat('yyyy-MM-01') + ' 00:00', zone); te = at(lastOfMonth(m) + ' 23:59', zone); lab = ts.toFormat('LLL yyyy', L); }
    else { ts = shift(from, -i); te = shift(to, -i); lab = days <= 1 ? ts.toFormat('ccc MM/dd', L) : ts.toFormat('LLL d', L); }
    trend.push({ start: ts.toFormat(F), end: te.toFormat(F), label: lab });
  }
  const t0 = at(trend[0].start, zone);
  const fetchFrom = t0 < prevFrom ? t0 : prevFrom;

  const isDefaultTimes = fullDays;
  const f1 = (d: DateTime) => isDefaultTimes ? d.toFormat('LLL d, yyyy', L) : d.toFormat('LLL d, yyyy', L) + ' ' + fmt.hm12(d);
  const text = from.toFormat('yyyy-MM-dd') === to.toFormat('yyyy-MM-dd') && isDefaultTimes ? from.toFormat('cccc, LLLL d, yyyy', L) : f1(from) + ' – ' + f1(to);
  const named: Record<string, string> = { today: 'yesterday', yesterday: 'the day before', this_week: 'last week', last_week: 'the week before', this_month: 'last month', last_month: 'the month before' };
  const hoursTxt = minutes >= 120 ? String(Math.round(minutes / 60 * 10) / 10) : '';
  const compare = named[key] ?? (sameDayHours ? 'the same hours the day before' : fullDays && nDays === 1 ? 'the day before' : fullDays && nDays === 7 ? 'the week before'
    : fullDays ? `prior ${nDays} days` : 'the previous ' + (minutes >= 120 ? hoursTxt + ' hours' : minutes + ' minutes'));
  // A custom range that is exactly a preset (e.g. after using ‹ ›) is shown and compared as that preset.
  if (key === 'custom' && !q._exact) {
    const fs = from.toFormat(F), tsx = to.toFormat(F);
    for (const k of Object.keys(PRESETS)) {
      if (k === 'custom') continue;
      const alt = resolvePeriod(S, { range: k, _exact: '1' });
      if (alt.from === fs && alt.to === tsx) return alt;
    }
  }
  const namedShort: Record<string, string> = { today: 'yesterday', yesterday: 'day before', this_week: 'last week', last_week: 'week before', this_month: 'last month', last_month: 'month before' };
  const compareShort = namedShort[key] ?? (sameDayHours || (fullDays && nDays === 1) ? 'day before' : fullDays && nDays === 7 ? 'week before'
    : fullDays ? `prior ${nDays} days` : 'prior ' + (minutes >= 120 ? hoursTxt + 'h' : minutes + ' min'));
  return {
    key, label: PRESETS[key], text, short: periodShort(from, to), default: def, compareShort, compare, unit,
    from: from.toFormat(F), to: to.toFormat(F), fromDT: from, toDT: to, prevFrom: prevFrom.toFormat(F), prevTo: prevTo.toFormat(F),
    fetchFrom, fetchTo: to, buckets, trend, isCurrent: to >= now, hasFuture: shift(from, 1) <= now, minutes, fullDays, byDays, nDays,
    now: now.toFormat(F), today, zone,
  };
}

/** Query for the previous (-1) or next (+1) period of the same length. */
export function periodShift(P: Period, dir: number): Record<string, string> {
  const from = P.fromDT, to = P.toDT;
  const wholeMonth = from.toFormat('dd HH:mm') === '01 00:00' && to.toFormat('HH:mm') === '23:59' && to.day === to.daysInMonth && from.toFormat('yyyy-MM') === to.toFormat('yyyy-MM');
  if (P.key === 'this_month' || P.key === 'last_month' || (P.key === 'custom' && wholeMonth)) {
    const m = from.plus({ months: dir > 0 ? 1 : -1 });
    return { range: 'custom', from: m.toFormat('yyyy-MM-01') + 'T00:00', to: lastOfMonth(m) + 'T23:59' };
  }
  const mv = (d: DateTime) => P.byDays ? d.plus({ days: (dir > 0 ? 1 : -1) * P.nDays }) : d.plus({ minutes: (dir > 0 ? 1 : -1) * P.minutes });
  return { range: 'custom', from: mv(from).toFormat("yyyy-MM-dd'T'HH:mm"), to: mv(to).toFormat("yyyy-MM-dd'T'HH:mm") };
}
/** The query params that describe the current period (to keep it in links). */
export function periodQuery(P: Period): Record<string, string> {
  if (P.key === 'custom') return { range: 'custom', from: P.from.replace(' ', 'T'), to: P.to.replace(' ', 'T') };
  return P.key === P.default ? {} : { range: P.key };
}
/** Compact range text: "Nov 2 – Nov 8, 2026", "Fri, Nov 6, 2026", "Nov 6, 2026 · 8:00 AM – 5:30 PM". */
export function periodShort(from: DateTime, to: DateTime): string {
  const whole = from.toFormat('HH:mm') === '00:00' && to.toFormat('HH:mm') === '23:59';
  const sameDay = from.toFormat('yyyy-MM-dd') === to.toFormat('yyyy-MM-dd');
  const sameYear = from.year === to.year;
  if (whole) return sameDay ? from.toFormat('ccc, LLL d, yyyy', L) : sameYear ? from.toFormat('LLL d', L) + ' – ' + to.toFormat('LLL d, yyyy', L) : from.toFormat('LLL d, yyyy', L) + ' – ' + to.toFormat('LLL d, yyyy', L);
  if (sameDay) return from.toFormat('LLL d, yyyy', L) + ' · ' + fmt.hm12(from) + ' – ' + fmt.hm12(to);
  return from.toFormat('LLL d', L) + ', ' + fmt.hm12(from) + ' – ' + to.toFormat('LLL d', L) + ', ' + fmt.hm12(to) + (sameYear ? ', ' + to.year : '');
}
export function qs(params: Record<string, string | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') p.set(k, v);
  const s = p.toString(); return s ? '?' + s : '';
}

/** The period bar: preset buttons, ‹ current range ›, and a Custom panel with date + time fields (works without JavaScript). */
export function periodToolbar(P: Period, action: string, keep: Record<string, string | null | undefined>, right: string, customFlag: boolean): string {
  const url = (q: Record<string, string>) => action + qs({ ...keep, ...q });
  const customOpen = P.key === 'custom' || customFlag;
  let pills = '';
  for (const [k, l] of Object.entries(PRESETS)) {
    if (k === 'custom') continue;
    const href = url(k === P.default ? {} : { range: k });
    pills += `<a class="pill${k === P.key ? ' is-active' : ''}" href="${e(href)}"${k === P.key ? ' aria-current="true"' : ''}>${e(l)}</a>`;
  }
  pills += `<a class="pill pill-custom${P.key === 'custom' ? ' is-active' : ''}" href="${e(url({ ...periodQuery(P), custom: '1' }))}" data-custom-toggle aria-expanded="${customOpen ? 'true' : 'false'}" aria-controls="period-custom"${P.key === 'custom' ? ' aria-current="true"' : ''}><span class="ico-cal" aria-hidden="true"></span>Custom</a>`;
  const prev = url(periodShift(P, -1)), next = url(periodShift(P, 1));
  const cmp = P.compare ? 'Compared with ' + P.compare : '';
  let hidden = '';
  for (const [k, v] of Object.entries(keep)) if (v) hidden += `<input type="hidden" name="${e(k)}" value="${e(v)}">`;
  const f = P.fromDT, t = P.toDT;
  return '<section class="periodbar" aria-label="Reporting period">'
    + `<div class="pb-presets" role="group" aria-label="Quick periods">${pills}</div>`
    + '<div class="pb-row"><div class="pb-current">'
    + `<a class="pb-arrow" href="${e(prev)}" aria-label="Previous period" title="Previous period">‹</a>`
    + `<div class="pb-range"><span class="pb-cal"><span class="ico-cal ico-cal-lg" aria-hidden="true"></span></span><span><strong>${e(P.short)}</strong>`
    + `<small>${e(P.key === 'custom' ? 'Custom range' : P.label)}${cmp ? ' · ' + e(cmp) : ''}</small></span></div>`
    + (P.hasFuture ? `<a class="pb-arrow" href="${e(next)}" aria-label="Next period" title="Next period">›</a>` : '<span class="pb-arrow is-disabled" aria-disabled="true" title="This is the latest period">›</span>')
    + '</div>' + (right ? `<div class="pb-right">${right}</div>` : '') + '</div>'
    + `<form class="pb-custom" id="period-custom" method="get" action="${e(action)}"${customOpen ? '' : ' hidden'}>${hidden}<input type="hidden" name="range" value="custom">`
    + `<fieldset><legend>From</legend><div class="pb-dt"><input type="date" name="from_date" value="${e(f.toFormat('yyyy-MM-dd'))}" max="${e(P.today)}" required aria-label="Start date">`
    + `<input type="time" name="from_time" value="${e(f.toFormat('HH:mm'))}" step="60" aria-label="Start time"></div></fieldset>`
    + '<span class="pb-sep" aria-hidden="true">→</span>'
    + `<fieldset><legend>To</legend><div class="pb-dt"><input type="date" name="to_date" value="${e(t.toFormat('yyyy-MM-dd'))}" required aria-label="End date">`
    + `<input type="time" name="to_time" value="${e(t.toFormat('HH:mm'))}" step="60" aria-label="End time"></div></fieldset>`
    + `<div class="pb-actions"><button class="pb-apply" type="submit">Apply</button>${P.key === 'custom' ? '' : `<a class="pb-cancel" href="${e(url(periodQuery(P)))}" data-custom-cancel>Cancel</a>`}</div>`
    + `<p class="pb-hint">Times are in ${e(P.zone)}. Leave the times as 12:00 AM and 11:59 PM for whole days.</p></form></section>`;
}
