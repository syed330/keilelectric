/** The Daily Pipeline Scorecard page (port of index.php). */
import type { Settings } from '../lib/settings.js';
import type { Period } from '../lib/period.js';
import { periodToolbar } from '../lib/period.js';
import type { Item } from '../lib/data.js';
import { type Scorecard, type EventX, type Category, categoryMetrics, changeHtml } from '../lib/report.js';
import { channelOf, spendBetween, AD_CHANNELS, type SpendData, type Channel } from '../lib/ads.js';
import { e, money, num, pct } from '../lib/util.js';
import { lcfirstPeriod, whenText, ratioMoney, daysSince, moreList } from './common.js';

function kpiCard(label: string, ev: EventX, amount: boolean, sub: string, vs: string): string {
  if (!ev.found) return `<article class="kpi"><h3>${e(label)}</h3><div class="val">—</div><div class="sub">No data source yet</div><div class="chg">&nbsp;</div></article>`;
  const useAmt = amount && ev.hasAmount;
  const cur = useAmt ? ev.sum : ev.week.length, prev = useAmt ? ev.prevSum : ev.prev.length;
  return `<article class="kpi"><h3>${e(label)}</h3><div class="val">${useAmt ? money(cur) : num(cur)}</div><div class="sub">${e(sub)}</div><div>${changeHtml(cur, prev, vs)}</div></article>`;
}
function summaryHtml(cat: Category, R: Scorecard): string {
  const out: string[] = [];
  for (const x of categoryMetrics(cat, R)) {
    if (x.pct) {
      if (R.booking) out.push(`<span class="m"><small>Booking %</small><b>${pct(R.booking.week)}</b><span class="chg">${R.booking.prev !== null ? e(R.P.compareShort.charAt(0).toUpperCase() + R.P.compareShort.slice(1)) + ': ' + pct(R.booking.prev) : '&nbsp;'}</span></span>`);
      continue;
    }
    if (x.owed) {
      const ow = R.meta.outstanding; if (!ow.found) continue;
      out.push(`<span class="m"><small>Owed now</small><b>${money(ow.value)}</b><span class="chg">${num(ow.count)} unpaid invoice${ow.count === 1 ? '' : 's'}</span></span>`);
      continue;
    }
    if (x.now) {
      if (!R.events.permitIn.found) continue;
      const pn = R.meta.permitNow;
      out.push(`<span class="m"><small>In process now</small><b>${num(pn.count)}</b><span class="chg">${pn.value ? money(pn.value) + ' in invoices' : 'Jobs waiting on permits'}</span></span>`);
      continue;
    }
    const ev = x.ev as EventX;
    if (!ev.found || (x.label.endsWith('($)') && !x.amount)) continue;
    const cur = x.amount ? ev.sum : ev.week.length, prev = x.amount ? ev.prevSum : ev.prev.length;
    out.push(`<span class="m"><small>${e(x.label)}</small><b>${x.amount ? money(cur) : num(cur)}</b>${changeHtml(cur, prev, R.P.compareShort)}</span>`);
  }
  return out.length ? out.join('') : '<span class="nf">No data source yet</span>';
}

// ---------------------------------------------------------------- ad spend
export interface SpendRow { label: string; color: string; source: string | null; days: Record<string, number>; spend: number; spendPrev: number; leads: Item[]; booked: number; sold: number; sales: number; buckets: number[]; trend: number[] }
export interface SpendReport { rows: Record<Channel, SpendRow>; total: { spend: number; spendPrev: number; leads: number; booked: number; sold: number; sales: number }; other: Item[]; warnings: string[]; connected: boolean }
export function spendReport(S: Settings, R: Scorecard, P: Period, sp: SpendData): SpendReport {
  const E = R.events;
  const by = (items: Item[], ch: Channel | null) => items.filter((x) => channelOf(x.src ?? x.detail ?? '', S) === ch);
  const toNow = P.to < P.now ? P.to : P.now; // spend to date, never future days
  const rows = {} as Record<Channel, SpendRow>;
  for (const ch of Object.keys(AD_CHANNELS) as Channel[]) {
    const c = sp.channels[ch];
    const sold = by(E.sold.week, ch);
    rows[ch] = { ...c, spend: spendBetween(c.days, P.from, toNow), spendPrev: spendBetween(c.days, P.prevFrom, P.prevTo), leads: by(E.lead.week, ch),
      booked: by(E.booked.week, ch).length, sold: sold.length, sales: sold.reduce((s, x) => s + (Number(x.amount) || 0), 0),
      buckets: P.buckets.map((b) => b.future ? 0 : Math.round(spendBetween(c.days, b.start, b.end < toNow ? b.end : toNow) * 100) / 100),
      trend: P.trend.map((t) => Math.round(spendBetween(c.days, t.start, t.end) * 100) / 100) };
  }
  const list = Object.values(rows);
  const total = { spend: list.reduce((s, r) => s + r.spend, 0), spendPrev: list.reduce((s, r) => s + r.spendPrev, 0), leads: list.reduce((s, r) => s + r.leads.length, 0),
    booked: list.reduce((s, r) => s + r.booked, 0), sold: list.reduce((s, r) => s + r.sold, 0), sales: list.reduce((s, r) => s + r.sales, 0) };
  return { rows, total, other: by(E.lead.week, null), warnings: sp.warnings, connected: list.some((r) => r.source !== null) };
}
function spendSummary(AD: SpendReport, P: Period): string {
  if (!AD.connected) return `<span class="m"><small>Paid-ad leads</small><b>${num(AD.total.leads)}</b><span class="chg">Spend not connected yet</span></span>`;
  const t = AD.total;
  return `<span class="m"><small>Ad spend</small><b>${money(t.spend)}</b>${changeHtml(t.spend, t.spendPrev, P.compareShort)}</span>`
    + `<span class="m"><small>Cost per lead</small><b>${ratioMoney(t.spend, t.leads)}</b><span class="chg">${num(t.leads)} paid-ad leads</span></span>`
    + `<span class="m"><small>Return on ad spend</small><b>${t.spend > 0 ? (t.sales / t.spend).toFixed(1) + '×' : '—'}</b><span class="chg">${money(t.sales)} in sales</span></span>`;
}
function spendBody(AD: SpendReport, R: Scorecard): string {
  const P = R.P; const t = AD.total;
  let h = '';
  if (AD.warnings.length) h += `<div class="notfound" style="grid-column:1/-1">${AD.warnings.map(e).join('<br>')}</div>`;
  if (!AD.connected) h += '<div class="notfound" style="grid-column:1/-1"><b>Ad spend isn’t connected yet.</b><p>GoHighLevel’s API doesn’t include the numbers from its Ads Reporting page, so the report reads spend straight from Google Ads and Meta Ads — the same place GHL gets it — or from amounts you enter. An admin can set this up in <a href="/admin?page=ads">Admin › Ad spend</a>. Leads per channel below already come from GHL.</p></div>';
  const tr = (label: string, color: string, spend: number | null, leads: number, booked: number, sold: number, sales: number, bold = false) =>
    `<tr${bold ? ' class="tot-row"' : ''}><td>${color ? `<i class="dot" style="background:${e(color)}"></i>` : ''}${e(label)}</td><td>${spend === null ? '—' : money(spend)}</td><td>${num(leads)}</td><td>${spend === null ? '—' : ratioMoney(spend, leads)}</td>`
    + `<td>${num(booked)}</td><td>${spend === null ? '—' : ratioMoney(spend, booked)}</td><td>${money(sales)}${sold ? ` <small>(${sold})</small>` : ''}</td><td>${spend ? (sales / spend).toFixed(1) + '×' : '—'}</td></tr>`;
  let table = '<div class="spend-scroll"><table class="spendtable"><thead><tr><th>Channel</th><th>Spend</th><th>Leads</th><th>Cost / lead</th><th>Booked</th><th>Cost / booking</th><th>Sales</th><th>Return</th></tr></thead><tbody>';
  for (const r of Object.values(AD.rows)) table += tr(r.label, r.color, r.source === null ? null : r.spend, r.leads.length, r.booked, r.sold, r.sales);
  table += tr('All paid ads', '', AD.connected ? t.spend : null, t.leads, t.booked, t.sold, t.sales, true);
  table += `<tr class="muted-row"><td><i class="dot" style="background:#b9bec5"></i>Other sources</td><td>—</td><td>${num(AD.other.length)}</td><td colspan="5">organic, referral, website and other GHL sources</td></tr></tbody></table></div>`;
  const chart = { color: '#00a3b4', amount: true, stacked: true, days: P.buckets.map((b) => b.label), weeks: P.trend.map((x) => x.label),
    series: Object.values(AD.rows).filter((r) => r.source !== null).map((r) => ({ label: r.label, color: r.color, day: r.buckets, trend: r.trend })) };
  const json = e(JSON.stringify(chart));
  const charts = AD.connected && P.unit !== 'hour'
    ? `<h4>Spend by ${e(P.unit)}</h4><div class="chart-wrap"><canvas data-chart="day" data-cfg="${json}" role="img" aria-label="Ad spend by ${e(P.unit)}"></canvas></div>`
      + `<h4 style="margin-top:20px">Spend, last ${P.trend.length} periods</h4><div class="chart-wrap short"><canvas data-chart="trend" data-cfg="${json}" role="img" aria-label="Ad spend trend"></canvas></div>` : '';
  let lists = '';
  for (const r of Object.values(AD.rows)) {
    const n = r.leads.length;
    lists += `<h4><i class="dot" style="background:${e(r.color)}"></i>Leads from ${e(r.label)} <small>${n} in ${e(lcfirstPeriod(P))}${r.source !== null && n ? ' · ' + ratioMoney(r.spend, n) + ' each' : ''}</small></h4>`;
    lists += n ? `<ul class="clist">${r.leads.slice(0, 8).map((x) => `<li><div><span class="nm">${e(x.name)}</span>${x.src ? `<span class="sub">${e(x.src)}</span>` : ''}</div><div class="when">${e(whenText(x))}</div></li>`).join('')}</ul>`
      + (n > 8 ? `<p class="meta" style="margin:6px 0 0">+ ${n - 8} more</p>` : '') : `<ul class="clist"><li class="empty-li">None in ${e(lcfirstPeriod(P))}</li></ul>`;
  }
  const src = Object.values(AD.rows).map((r) => `<b>${e(r.label)}</b> — ${r.source ? 'spend from ' + e(r.source) : 'spend not connected'}`);
  return h + `<div class="charts-col">${table}${charts ? `<div style="margin-top:20px">${charts}</div>` : ''}</div><div class="contacts">${lists}</div>`
    + `<p class="source">${src.join('; ')}. Leads, bookings and sales are matched to a channel by their GHL source (keywords in Admin › Ad spend).</p>`;
}

// ---------------------------------------------------------------- lists
function paymentMethodsTable(R: Scorecard): string {
  const by: Record<string, { n: number; v: number }> = {};
  for (const x of R.events.paid.week) { const m = (x.method || '').trim() || 'Other'; (by[m] ??= { n: 0, v: 0 }); by[m].n++; by[m].v += Number(x.amount) || 0; }
  const rows = Object.entries(by).sort((a, b) => b[1].v - a[1].v);
  const tot = rows.reduce((s, [, r]) => s + r.v, 0);
  let h = `<h4>By payment method <small>${e(lcfirstPeriod(R.P))}</small></h4>`;
  if (!rows.length) return h + `<ul class="clist"><li class="empty-li">No payments in ${e(lcfirstPeriod(R.P))}</li></ul>`;
  h += '<div class="spend-scroll"><table class="spendtable" style="margin-bottom:6px"><thead><tr><th>Method</th><th>Payments</th><th>Amount</th><th>Share</th></tr></thead><tbody>';
  for (const [m, r] of rows) h += `<tr><td>${e(m)}</td><td>${num(r.n)}</td><td>${money(r.v)}</td><td>${tot > 0 ? Math.round(r.v / tot * 100) + '%' : '—'}</td></tr>`;
  const n = R.events.paid.week.length;
  return h + `<tr class="tot-row"><td>All payments</td><td>${num(n)}</td><td>${money(tot)}</td><td>avg ${money(n ? tot / n : 0)}</td></tr></tbody></table></div>`;
}
function owedList(R: Scorecard): string {
  const ow = R.meta.outstanding, today = R.P.today;
  const row = (x: Item) => {
    const late = x.due && x.due < today ? daysSince(x.due, today) : 0;
    return `<li><div><span class="nm">${e(x.name)}</span>${late ? `<span class="tag lost">${late}d overdue</span>` : ''}<span class="sub">${e(x.detail ?? '')}</span></div>`
      + `<div class="when"><span class="amt">${money(x.amount)}</span>${x.due ? 'due ' + e(new Date(x.due + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })) : ''}</div></li>`;
  };
  const n = ow.items.length;
  const h = `<h4>Owed now <small>${n} invoice${n === 1 ? '' : 's'} · ${money(ow.value)}</small></h4>`;
  if (!n) return h + '<ul class="clist"><li class="empty-li">Nothing is owed right now</li></ul>';
  return h + moreList(ow.items, 10, row, 310);
}
function permitsNowList(R: Scorecard): string {
  const pn = R.meta.permitNow;
  const items = [...pn.items].sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  const row = (x: Item) => {
    const days = x.date ? daysSince(x.date, R.P.today) : null;
    return `<li><div><span class="nm">${e(x.name)}</span>${x.detail ? `<span class="sub">${e(x.detail)}</span>` : ''}</div>`
      + `<div class="when">${x.amount ? `<span class="amt">${money(x.amount)}</span>` : ''}${days !== null ? (days === 0 ? 'since today' : `waiting ${days} day${days === 1 ? '' : 's'}`) : ''}</div></li>`;
  };
  const n = items.length;
  const h = `<h4>In permitting now <small>${n} job${n === 1 ? '' : 's'}${pn.value ? ' · ' + money(pn.value) : ''}</small></h4>`;
  if (!n) return h + '<ul class="clist"><li class="empty-li">No jobs are waiting on permits right now</li></ul>';
  return h + moreList(items, 10, row, 1000);
}
function contactList(ev: EventX, R: Scorecard, label?: string): string {
  const row = (x: Item) => {
    const sub = (x.detail || '').trim();
    return `<li><div><span class="nm">${e(x.name)}</span>${x.qualified ? '<span class="tag">SQL</span>' : ''}${sub ? `<span class="sub">${e(sub)}</span>` : ''}</div>`
      + `<div class="when">${ev.hasAmount && x.amount ? `<span class="amt">${money(x.amount)}</span>` : ''}${e(whenText(x))}</div></li>`;
  };
  const n = ev.week.length;
  const h = `<h4>${e(label ?? ev.label)} <small>${n} in ${e(lcfirstPeriod(R.P))}</small></h4>`;
  if (!n) return h + `<ul class="clist"><li class="empty-li">None in ${e(lcfirstPeriod(R.P))}</li></ul>`;
  return h + moreList(ev.week, 10, row, 1000);
}

function categoryBody(cat: Category, R: Scorecard): string {
  const E = R.events;
  const evs = cat.events.map((k) => E[k]);
  const found = evs.filter((x) => x.found);
  if (!found.length) {
    let h = `<div class="notfound"><b>${e(cat.label)} has no data source yet.</b>`;
    for (const x of evs) h += `<p>${e(x.label)}: the report uses ${e(x.looksFor)}.</p>`;
    return h + '<p>Categories are detected automatically from your GHL pipeline stages. See what was found in <a href="/admin?page=pipelines">Admin › Detected pipelines</a>.</p></div>';
  }
  const P = R.P;
  let th = '<th></th>';
  for (const bk of P.buckets) th += `<th class="${bk.now ? 'today' : ''}">${e(bk.head[0])}${bk.head[0] !== '' ? '<br>' : ''}${e(bk.head[1])}</th>`;
  let rows = '';
  for (const x of categoryMetrics(cat, R)) {
    if (x.now || x.owed) continue; // right-now figures have no per-day row
    if (x.pct) {
      if (!R.booking) continue;
      rows += '<tr class="pct"><td>Booking %</td>' + R.booking.byDay.map((v, i) => `<td class="${P.buckets[i].now ? 'today' : ''}">${P.buckets[i].future ? '' : pct(v)}</td>`).join('') + `<td class="tot">${pct(R.booking.week)}</td></tr>`;
      continue;
    }
    const ev = x.ev as EventX;
    if (!ev.found || (x.label.endsWith('($)') && !x.amount)) continue;
    const arr = x.amount ? ev.byDayAmt : ev.byDay;
    rows += `<tr><td>${e(x.label)}</td>` + arr.map((v, i) => { const bk = P.buckets[i]; return `<td class="${bk.now ? 'today' : ''}">${bk.future ? '' : (x.amount ? money(v) : String(v))}</td>`; }).join('')
      + `<td class="tot">${x.amount ? money(ev.sum) : ev.week.length}</td></tr>`;
  }
  const table = `<div class="daytable-wrap"><table class="daytable"><thead><tr>${th}<th>Total</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  const main = found[0];
  const amount = main.hasAmount && ['sales', 'production', 'cash'].includes(cat.key);
  const series = ['marketing', 'permitting'].includes(cat.key) ? found : [main];
  const chart = { color: cat.color, amount, days: P.buckets.map((b) => b.label), weeks: P.trend.map((t) => t.label),
    series: series.map((x) => ({ label: x.label + (amount ? ' ($)' : ''), day: amount ? x.byDayAmt : x.byDay, trend: amount ? x.trendAmt : x.trend })) };
  const json = e(JSON.stringify(chart));
  let lists = '';
  if (cat.key === 'permitting' && E.permitIn.found) lists += permitsNowList(R);
  if (cat.key === 'payments' && E.paid.found) lists += paymentMethodsTable(R);
  for (const x of found) { if (cat.key === 'marketing' && x.key === 'sql' && E.lead.found) continue; lists += contactList(x, R, cat.key === 'payments' && x.key === 'paid' ? 'Payments received' : undefined); }
  if (cat.key === 'cash' && R.meta.outstanding.found) lists += owedList(R);
  const src: string[] = found.map((x) => `<b>${e(x.label)}</b> — ${e(x.how)}${x.hasAmount && ['sold', 'completed', 'permitIn', 'permitFin'].includes(x.key) ? ', amounts from the opportunity value' : ''}`);
  for (const x of evs) if (!x.found) src.push(`<b>${e(x.label)}</b> has no source yet — uses ${e(x.looksFor)}`);
  const trendTitle = `Last ${P.trend.length} ` + (P.key === 'this_month' || P.key === 'last_month' ? 'months' : 'periods of this length');
  return `<div class="charts-col"><h4>${e(P.key === 'custom' ? 'Selected period' : P.label)} by ${P.unit}</h4><div class="chart-wrap"><canvas data-chart="day" data-cfg="${json}" role="img" aria-label="${e(cat.label)} by ${P.unit}"></canvas></div>`
    + table + `<h4 style="margin-top:20px">${e(trendTitle)}</h4><div class="chart-wrap short"><canvas data-chart="trend" data-cfg="${json}" role="img" aria-label="${e(cat.label)} trend"></canvas></div></div>`
    + `<div class="contacts">${lists}</div><p class="source">Data sources: ${src.join('; ')}.</p>`;
}

/** Everything below the header: period bar, KPI cards and the category accordions. */
export function scorecardBody(R: Scorecard, AD: SpendReport | null, right: string, customFlag: boolean): string {
  const P = R.P, E = R.events;
  const wk = P.key === 'custom' ? 'Selected period' : P.label, vs = P.compareShort;
  const pn = R.meta.permitNow;
  let h = '';
  if (R.meta.warnings.length) h += `<div class="banner error">${R.meta.warnings.map(e).join('<br>')}</div>`;
  h += periodToolbar(P, '/', {}, right, customFlag);
  h += '<section class="kpis">' + kpiCard('Leads', E.lead, false, wk, vs) + kpiCard('Jobs Booked', E.booked, false, wk, vs) + kpiCard('Sales ($)', E.sold, true, wk, vs)
    + (E.permitIn.found ? `<article class="kpi"><h3>Permitting (In Process)</h3><div class="val">${num(pn.count)}</div><div class="sub">Jobs · right now</div><div><span class="chg">${pn.value ? money(pn.value) + ' in invoices' : '— in invoices'}</span></div></article>` : kpiCard('Permitting (In Process)', E.permitIn, false, 'Jobs', vs))
    + kpiCard('Production ($)', E.completed, true, wk, vs) + kpiCard('Cash Collected ($)', E.paid, true, wk, vs) + '</section>';
  h += '<div class="acc-tools"><button class="linkbtn" type="button" data-acc="open">Open all</button><button class="linkbtn" type="button" data-acc="close">Close all</button></div>';
  R.cats.forEach((cat, i) => {
    h += `<details class="acc" data-cat="${e(cat.key)}" style="--c:${e(cat.color)}"${i === 0 ? ' open' : ''}><summary><span class="label">${e(cat.label)}</span><span class="sum">${summaryHtml(cat, R)}</span><span class="chev"></span></summary><div class="acc-body">${categoryBody(cat, R)}</div></details>`;
    if (cat.key === 'marketing' && AD) h += `<details class="acc" data-cat="spend" style="--c:#00a3b4"><summary><span class="label">Ad Spend</span><span class="sum">${spendSummary(AD, P)}</span><span class="chev"></span></summary><div class="acc-body">${spendBody(AD, R)}</div></details>`;
  });
  return h;
}
