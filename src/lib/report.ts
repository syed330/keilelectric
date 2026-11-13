/** Turns the report data into the scorecard: this period vs the previous one, per bucket, trend, booking %. */
import type { Period } from './period.js';
import type { Raw, Item, Ev } from './data.js';
import { e } from './util.js';

export interface Category { key: string; label: string; color: string; events: string[] }
export function categories(): Category[] {
  return [
    { key: 'marketing', label: 'Marketing', color: '#e3193b', events: ['lead', 'sql'] },
    { key: 'csr', label: 'CSR – Booking Rate', color: '#e8850c', events: ['booked'] },
    { key: 'sales', label: 'Sales', color: '#d4a017', events: ['sold'] },
    { key: 'permitting', label: 'Permitting', color: '#2e8b57', events: ['permitIn', 'permitFin'] },
    { key: 'production', label: 'Production', color: '#3a7bd5', events: ['completed'] },
    { key: 'cash', label: 'Cash', color: '#6c47c1', events: ['paid', 'invoiced'] },
    { key: 'payments', label: 'Payments', color: '#0f8a6c', events: ['paid', 'paidInv'] },
  ];
}
export const EVENT_DEFS: Record<string, { label: string; looksFor: string }> = {
  lead: { label: 'Leads', looksFor: 'contacts in the GHL sub-account (the token needs the View Contacts scope)' },
  sql: { label: 'Sales Qualified Leads', looksFor: 'contacts with a qualified tag (Admin › Display), or an opportunity past the first pipeline stage' },
  booked: { label: 'Jobs Booked', looksFor: 'a pipeline stage named like “Appointment Set” or “Booked”' },
  sold: { label: 'Sales Completed', looksFor: 'opportunities marked Won (the token needs the View Opportunities scope)' },
  permitIn: { label: 'Moved into permitting', looksFor: 'a pipeline stage named like “Permit Submitted”' },
  permitFin: { label: 'Permits Finalized', looksFor: 'a pipeline stage named like “Permit Approved” or “Final Inspection Passed”' },
  completed: { label: 'Jobs Completed', looksFor: 'a pipeline stage named like “Job Completed” or “Installed”' },
  paid: { label: 'Cash Collected', looksFor: 'Jobber payments (Admin › Jobber), GHL Payments transactions, paid GHL Invoices, or a pipeline stage named like “Paid” or “Payment received”' },
  paidInv: { label: 'Paid invoices', looksFor: 'Jobber invoices (Admin › Jobber) or GHL Invoices marked paid' },
  invoiced: { label: 'Invoiced', looksFor: 'GHL Invoices (add the View Invoices scope to the Private Integration) or Jobber invoices' },
};

export interface Summary { week: Item[]; prev: Item[]; sum: number; prevSum: number; byDay: number[]; byDayAmt: number[]; trend: (number | null)[]; trendAmt: (number | null)[] }
export interface EventX extends Summary { key: string; label: string; looksFor: string; found: boolean; how: string; hasAmount: boolean }
export interface Scorecard { P: Period; events: Record<string, EventX>; booking: { week: number | null; prev: number | null; byDay: (number | null)[] } | null; cats: Category[]; meta: Raw['meta'] }

export function summarize(items: Item[], P: Period, trendOverride?: number[] | null, knownFrom?: string | null): Summary {
  const atOf = (x: Item) => x.at || (x.date + ' 12:00');
  const inR = (x: Item, a: string, b: string) => atOf(x) >= a && atOf(x) <= b;
  const sum = (a: Item[]) => a.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const cur = items.filter((x) => inR(x, P.from, P.to)).sort((a, b) => atOf(b).localeCompare(atOf(a)));
  const prev = items.filter((x) => inR(x, P.prevFrom, P.prevTo));
  const byDay: number[] = [], byDayAmt: number[] = [];
  for (const bk of P.buckets) { const on = cur.filter((x) => inR(x, bk.start, bk.end)); byDay.push(on.length); byDayAmt.push(sum(on)); }
  let trend: (number | null)[] = [], trendAmt: (number | null)[] = [];
  for (const t of P.trend) { const on = items.filter((x) => inR(x, t.start, t.end)); trend.push(on.length); trendAmt.push(sum(on)); }
  if (trendOverride && trendOverride.length === trend.length) trend = trendOverride.map((v) => Math.trunc(v));
  if (knownFrom) P.trend.forEach((t, i) => { if (t.start < knownFrom) { trend[i] = null; trendAmt[i] = null; } }); // not loaded: a gap, not a false 0
  return { week: cur, prev, sum: sum(cur), prevSum: sum(prev), byDay, byDayAmt, trend, trendAmt };
}

export function scorecard(raw: Raw, P: Period): Scorecard {
  const events: Record<string, EventX> = {};
  for (const [k, def] of Object.entries(EVENT_DEFS)) {
    const src: Ev = raw.events[k] ?? { found: false, items: [], how: '', hasAmount: false };
    events[k] = { key: k, ...def, found: !!src.found, how: src.how || '', hasAmount: !!src.hasAmount, ...summarize(src.items || [], P, src.trend, src.knownFrom) };
  }
  const L = events.lead, B = events.booked;
  let booking: Scorecard['booking'] = null;
  if (L.found && B.found) {
    booking = { week: L.week.length ? B.week.length / L.week.length * 100 : null, prev: L.prev.length ? B.prev.length / L.prev.length * 100 : null,
      byDay: P.buckets.map((_, i) => L.byDay[i] ? B.byDay[i] / L.byDay[i] * 100 : null) };
  }
  if (events.sql.found && L.found) {
    const q = new Set(events.sql.week.map((x) => x.cid || x.id || ''));
    for (const x of events.lead.week) x.qualified = q.has(x.cid || x.id || '');
  }
  return { P, events, booking, cats: categories(), meta: raw.meta };
}

/** "↑ 12% vs last week" style change line. */
export function changeHtml(cur: number | null, prev: number | null, vs = 'last week'): string {
  if (cur === null) return '';
  if (!prev) return cur ? `<span class="chg up">New vs ${e(vs)}</span>` : `<span class="chg">Same as ${e(vs)}</span>`;
  const p = (cur - prev) / prev * 100;
  if (Math.round(p) === 0) return `<span class="chg">Same as ${e(vs)}</span>`;
  return `<span class="chg ${p > 0 ? 'up' : 'down'}">${p > 0 ? '↑' : '↓'} ${Math.abs(Math.round(p))}% vs ${e(vs)}</span>`;
}

export interface Metric { ev?: EventX; label: string; amount?: boolean; pct?: boolean; now?: boolean; owed?: boolean }
export function categoryMetrics(cat: Category, R: Scorecard): Metric[] {
  const E = R.events;
  const m = (k: string, label?: string, amount = false): Metric => ({ ev: E[k], label: label ?? E[k].label, amount: amount && E[k].hasAmount });
  switch (cat.key) {
    case 'marketing': return [m('lead'), m('sql')];
    case 'csr': return [m('booked'), { pct: true, label: 'Booking %' }];
    case 'sales': return [m('sold', 'Sales Completed ($)', true), m('sold', 'Sales Completed')];
    case 'permitting': return [{ now: true, label: 'In process now' }, m('permitIn', 'Moved into permitting'), m('permitFin', 'Finalized')];
    case 'production': return [m('completed', 'Production ($)', true), m('completed', 'Jobs Completed')];
    case 'cash': return [m('paid', 'Cash Collected ($)', true), m('invoiced', 'Invoiced ($)', true), { owed: true, label: 'Owed now' }];
    case 'payments': return [m('paid', 'Payments received'), m('paidInv', 'Paid invoices'), m('paidInv', 'Paid invoices ($)', true)];
  }
  return [];
}
