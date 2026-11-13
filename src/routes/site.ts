/** Public routes: / (scorecard), /pipelines (board), /export (CSV for Google Sheets), /admin/jobber/callback. */
import { DateTime } from 'luxon';
import { loadSettings, type Settings } from '../lib/settings.js';
import { startCtx, readForm, csrfOk, csrfField, signIn, verifyPassword, loginThrottle, html, redirect, text, flash, readCookies, type Ctx } from '../lib/http.js';
import { resolvePeriod, periodQuery, qs } from '../lib/period.js';
import { buildRaw, buildBoard, boardView } from '../lib/data.js';
import { scorecard } from '../lib/report.js';
import { spendDays, spendBetween, channelOf } from '../lib/ads.js';
import { jobberExchangeCode } from '../lib/jobber.js';
import { appLog } from '../lib/log.js';
import { e } from '../lib/util.js';
import { topbar, page, reportTitle, syncedText } from '../views/common.js';
import { scorecardBody, spendReport } from '../views/scorecard.js';
import { boardBody, STATUSES } from '../views/board.js';
import { triggerSync } from './admin.js';

const canView = (S: Settings, ctx: Ctx) => ctx.session.admin || !S.viewerHash || ctx.session.viewer;
function lockedForm(ctx: Ctx, error: string | null): string {
  return `<form class="box" method="post" style="max-width:420px;margin:40px auto;text-align:center">${csrfField(ctx)}<input type="hidden" name="do" value="login">`
    + '<h2 style="margin-bottom:6px">This report is password protected</h2><p class="meta" style="margin:0 0 16px">Enter the report password from your admin.</p>'
    + '<input type="password" name="password" class="field" style="width:100%;margin-bottom:10px" aria-label="Report password" autocomplete="current-password" required autofocus>'
    + (error ? `<div role="alert" style="color:var(--bad);font-size:13px;margin-bottom:8px">${e(error)}</div>` : '') + '<button class="btn primary" style="width:100%">View report</button></form>';
}
/** Report password form (POST do=login on / or /pipelines). */
async function viewerLogin(ctx: Ctx, S: Settings): Promise<Response | string> {
  const f = await readForm(ctx.req);
  if (f.do !== 'login') return redirect(ctx, ctx.url.pathname + ctx.url.search);
  if (!csrfOk(ctx, f)) return 'Your session expired. Please try again.';
  if (verifyPassword(f.password || '', S.adminHash)) { signIn(ctx, true); return redirect(ctx, ctx.url.pathname + ctx.url.search); }
  if (verifyPassword(f.password || '', S.viewerHash)) { signIn(ctx, false); return redirect(ctx, ctx.url.pathname + ctx.url.search); }
  await loginThrottle(); return 'That password isn’t right.';
}
function errorPage(ctx: Ctx, S: Settings, active: 'scorecard' | 'pipelines', msg: string): Response {
  return html(ctx, page(reportTitle(S), '', topbar(S, active, reportTitle(S), '') + `<main><div class="banner error">${msg}</div></main>`, ''), 500);
}

export async function handleScorecard(req: Request): Promise<Response> {
  const ctx = startCtx(req);
  const S = await loadSettings();
  let loginError: string | null = null;
  if (req.method === 'POST') { const r = await viewerLogin(ctx, S); if (r instanceof Response) return r; loginError = r; }
  const P = resolvePeriod(S, ctx.query);
  const title = reportTitle(S);
  const subtitle = (P.key === 'custom' ? 'Custom range' : P.label) + ' · ' + P.short;
  const scripts = '<script src="/assets/vendor/chartjs/chart.umd.min.js"></script><script src="/assets/js/report.js"></script><script src="/assets/js/period.js"></script>';
  if (!canView(S, ctx)) return html(ctx, page(title, '', topbar(S, 'scorecard', title, subtitle) + '<main>' + lockedForm(ctx, loginError) + '</main>', ''));
  if (!S.ghl.token || !S.ghl.locationId) return html(ctx, page(title, '', topbar(S, 'scorecard', title, subtitle) + '<main><div class="banner error">The GoHighLevel sub-account isn’t connected yet. An admin can connect it in <a href="/admin?page=connection">Admin › GHL connection</a>.</div></main>', ''));
  try {
    const R = scorecard(await buildRaw(S, P), P);
    let AD = null;
    try { const first = [P.prevFrom.slice(0, 10), (P.trend[0]?.start ?? P.from).slice(0, 10)].sort()[0]; AD = spendReport(S, R, P, await spendDays(S, first, P.to.slice(0, 10))); }
    catch (err) { await appLog('Ads: ' + (err as Error).message, '/'); }
    const refresh = P.isCurrent && Number(S.display.refreshSeconds) > 0 ? Math.max(30, Number(S.display.refreshSeconds)) : 0;
    const right = `<span class="meta">GoHighLevel · ${e(R.meta.location)}<br>${e(syncedText(S, R.meta.generatedAt, P.zone))}</span><a class="btn" href="/${e(qs(periodQuery(P)))}">Refresh</a>`;
    return html(ctx, page(title, refresh ? `<meta http-equiv="refresh" content="${refresh}">` : '', topbar(S, 'scorecard', title, subtitle) + '<main>' + scorecardBody(R, AD, right, !!ctx.query.custom) + '</main>', scripts));
  } catch (err) {
    await appLog('Scorecard: ' + (err as Error).message, '/');
    return errorPage(ctx, S, 'scorecard', 'Something went wrong while building the report' + (ctx.session.admin ? ': ' + e((err as Error).message) : '') + '. Details are in <a href="/admin?page=system">Admin › System check</a>.');
  }
}

export async function handleBoard(req: Request): Promise<Response> {
  const ctx = startCtx(req);
  const S = await loadSettings();
  let loginError: string | null = null;
  if (req.method === 'POST') { const r = await viewerLogin(ctx, S); if (r instanceof Response) return r; loginError = r; }
  const PER = resolvePeriod(S, ctx.query);
  const title = (S.display.region ? S.display.region + ' – ' : '') + 'Pipeline Board';
  const subtitle = (PER.key === 'custom' ? 'Custom range' : PER.label) + ' · ' + PER.short;
  const scripts = '<script src="/assets/vendor/chartjs/chart.umd.min.js"></script><script src="/assets/js/board.js"></script><script src="/assets/js/period.js"></script>';
  const shell = (main: string, refresh = 0) => page(title, refresh ? `<meta http-equiv="refresh" content="${refresh}">` : '', topbar(S, 'pipelines', title, subtitle) + '<main>' + main + '</main>', scripts);
  if (!canView(S, ctx)) return html(ctx, shell(lockedForm(ctx, loginError)));
  if (!S.ghl.token || !S.ghl.locationId) return html(ctx, shell('<div class="banner error">The GoHighLevel sub-account isn’t connected yet. An admin can connect it in <a href="/admin?page=connection">Admin › GHL connection</a>.</div>'));
  try {
    const B = await buildBoard(S, PER.zone);
    const status = STATUSES[ctx.query.status ?? ''] ? ctx.query.status : 'open';
    if (!B.pipelines.length) return html(ctx, shell(`<div class="banner">${B.synced ? 'This GoHighLevel sub-account has no pipelines with opportunities yet. Create one in GHL under Opportunities › Pipelines and it appears here after the next sync.' : 'The first sync from GoHighLevel hasn’t finished yet. An admin can start it in Admin › Overview › Sync now.'}</div>`));
    let Pp = B.pipelines.find((p) => p.id === ctx.query.p);
    if (!Pp) Pp = B.pipelines.reduce((a, b) => (b.opps.length > a.opps.length ? b : a)); // default: the busiest pipeline
    const V = boardView(Pp, PER, status);
    const refresh = PER.isCurrent && Number(S.display.refreshSeconds) > 0 ? Math.max(30, Number(S.display.refreshSeconds)) : 0;
    const right = `<span class="meta">GoHighLevel · ${e(B.location)}<br>${e(syncedText(S, B.generatedAt, PER.zone))}</span><a class="btn" href="${e('/pipelines' + qs({ p: Pp.id, status: status === 'open' ? null : status, ...periodQuery(PER) }))}">Refresh</a>`;
    return html(ctx, shell(boardBody(B.pipelines, Pp, V, PER, status, right, !!ctx.query.custom, []), refresh));
  } catch (err) {
    await appLog('Board: ' + (err as Error).message, '/pipelines');
    return errorPage(ctx, S, 'pipelines', 'Something went wrong while building the board' + (ctx.session.admin ? ': ' + e((err as Error).message) : '') + '. Details are in <a href="/admin?page=system">Admin › System check</a>.');
  }
}

/** /admin/jobber/callback — Jobber sends the admin back here after “Connect to Jobber”. */
export async function handleJobberCallback(req: Request): Promise<Response> {
  const ctx = startCtx(req);
  if (!ctx.session.admin) return redirect(ctx, '/admin');
  const state = ctx.query.state || '';
  ctx.setCookies.push(`kjs=; Path=/admin; Max-Age=0; HttpOnly; SameSite=Lax`);
  if (ctx.query.error) { flash(ctx, 'Jobber connection was cancelled: ' + (ctx.query.error_description || ctx.query.error).slice(0, 200), 'danger'); return redirect(ctx, '/admin?page=jobber'); }
  const expected = readCookies(req).kjs || '';
  if (!state || state !== expected) { flash(ctx, 'That Jobber sign-in link expired. Click “Connect to Jobber” again.', 'danger'); return redirect(ctx, '/admin?page=jobber'); }
  try {
    const S = await jobberExchangeCode(ctx.url.origin, ctx.query.code || '');
    await triggerSync(ctx.url.origin, 'jobber connected');
    flash(ctx, `Connected to Jobber${S.jobber.account ? ' (' + S.jobber.account + ')' : ''}. A sync has started to copy payments and invoices.`);
  } catch (err) { await appLog('Jobber connect: ' + (err as Error).message); flash(ctx, (err as Error).message, 'danger'); }
  return redirect(ctx, '/admin?page=jobber');
}

// ---------------------------------------------------------------- CSV export for Google Sheets
const csvCell = (v: unknown) => { const s = String(v ?? ''); return /[",\n\r]|^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function csvFail(code: number, msg: string): Response { return text('error\n' + csvCell(msg) + '\n', code, 'text/csv; charset=utf-8', { 'X-Robots-Tag': 'noindex' }); }

export async function handleExport(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const S = await loadSettings();
  const key = S.export.key;
  if (!key) return csvFail(403, 'The Google Sheets export is turned off. Turn it on in Admin › Google Sheets.');
  const given = url.searchParams.get('key') || '';
  if (given.length !== key.length || !(await import('node:crypto')).timingSafeEqual(Buffer.from(given), Buffer.from(key))) { await loginThrottle(); return csvFail(403, 'This export link is not valid. Copy the current link from Admin › Google Sheets.'); }
  if (!S.ghl.token || !S.ghl.locationId) return csvFail(409, 'GoHighLevel is not connected yet (Admin › GHL connection).');
  const view = url.searchParams.get('view') === 'months' ? 'months' : 'summary';
  const zone = S.display.timezone || 'America/Los_Angeles';
  const now = DateTime.now().setZone(zone); const nowStr = now.toFormat('yyyy-MM-dd HH:mm');
  const periods: { label: string; from: string; to: string }[] = [];
  if (view === 'summary') {
    for (const [k, label] of [['last_week', 'Last week'], ['this_week', 'This week'], ['this_month', 'This month'], ['last_month', 'Last month'], ['last_30', 'Last 30 days'], ['last_90', 'Last 90 days']]) {
      const p = resolvePeriod(S, { range: k, _exact: '1' }); periods.push({ label, from: p.from, to: p.to });
    }
  } else {
    const m = now.startOf('month');
    for (let i = 11; i >= 0; i--) { const s = m.minus({ months: i }); periods.push({ label: s.toFormat('LLL yyyy', { locale: 'en-US' }), from: s.toFormat('yyyy-MM-dd HH:mm'), to: s.endOf('month').toFormat('yyyy-MM-dd') + ' 23:59' }); }
  }
  for (const p of periods) if (p.to > nowStr) p.to = nowStr; // “This month” = month to date
  const winFrom = periods.map((p) => p.from).sort()[0], winTo = periods.map((p) => p.to).sort().slice(-1)[0];
  try {
    const P = resolvePeriod(S, { range: 'custom', from: winFrom.replace(' ', 'T'), to: winTo.replace(' ', 'T'), _exact: '1' });
    const raw = await buildRaw(S, P, { lite: true });
    const sp = await spendDays(S, winFrom.slice(0, 10), winTo.slice(0, 10));
    const E = raw.events;
    const inP = (x: { at?: string }, p: { from: string; to: string }) => !!x.at && x.at >= p.from && x.at <= p.to;
    const cnt = (ev: string, p: typeof periods[0]) => (E[ev]?.items ?? []).filter((x) => inP(x, p)).length;
    const sum = (ev: string, p: typeof periods[0]) => Math.round((E[ev]?.items ?? []).filter((x) => inP(x, p)).reduce((s, x) => s + (Number(x.amount) || 0), 0) * 100) / 100;
    const byCh = (ev: string, p: typeof periods[0], ch: 'google' | 'meta' | null, money = false) => {
      const items = (E[ev]?.items ?? []).filter((x) => inP(x, p) && channelOf(x.src ?? x.detail ?? '', S) === ch);
      return money ? Math.round(items.reduce((s, x) => s + (Number(x.amount) || 0), 0) * 100) / 100 : items.length;
    };
    const spend = (ch: 'google' | 'meta', p: typeof periods[0]) => Math.round(spendBetween(sp.channels[ch]?.days ?? {}, p.from, p.to) * 100) / 100;
    const pn = raw.meta.permitNow, ow = raw.meta.outstanding;
    type Row = [string, string, (p: typeof periods[0]) => unknown];
    const rows: Row[] = [
      ['period_from', 'Period start', (p) => p.from], ['period_to', 'Period end', (p) => p.to],
      ['days', 'Days in period', (p) => Math.round((DateTime.fromFormat(p.to, 'yyyy-MM-dd HH:mm', { zone }).toMillis() - DateTime.fromFormat(p.from, 'yyyy-MM-dd HH:mm', { zone }).toMillis() + 60000) / 864000) / 100],
      ['leads', 'Leads', (p) => cnt('lead', p)], ['sql', 'Sales Qualified Leads', (p) => cnt('sql', p)], ['booked', 'Jobs Booked', (p) => cnt('booked', p)],
      ['sales_count', 'Sales Completed (count)', (p) => cnt('sold', p)], ['sales_value', 'Sales Completed ($)', (p) => sum('sold', p)],
      ['permits_now', 'Permits in process now (jobs)', () => pn.count], ['permits_now_value', 'Permits in process now ($)', () => Math.round(pn.value * 100) / 100],
      ['permits_moved_in', 'Moved into permitting', (p) => cnt('permitIn', p)], ['permits_finalized', 'Permits Finalized', (p) => cnt('permitFin', p)],
      ['jobs_completed', 'Jobs Completed', (p) => cnt('completed', p)], ['production_value', 'Production ($)', (p) => sum('completed', p)],
      ['cash_collected', 'Cash Collected ($)', (p) => sum('paid', p)], ['payments', 'Payments (count)', (p) => cnt('paid', p)], ['invoiced', 'Invoiced ($)', (p) => sum('invoiced', p)],
      ['paid_invoices_count', 'Paid invoices (count)', (p) => cnt('paidInv', p)], ['paid_invoices_value', 'Paid invoices ($)', (p) => sum('paidInv', p)],
      ['owed_now', 'Owed now – unpaid invoice balances ($)', () => Math.round(ow.value * 100) / 100], ['owed_now_count', 'Owed now – unpaid invoices (count)', () => ow.count],
      ['payments_source', 'Payments source', () => E.paid?.how ?? ''],
      ['spend_google', 'Ad spend – Google Ads ($)', (p) => spend('google', p)], ['spend_meta', 'Ad spend – Meta Ads ($)', (p) => spend('meta', p)],
      ['spend_total', 'Ad spend – total ($)', (p) => Math.round((spend('google', p) + spend('meta', p)) * 100) / 100],
    ];
    for (const [ck, label, ch] of [['google', 'Google Ads', 'google'], ['meta', 'Meta Ads', 'meta'], ['other', 'Other sources', null]] as const) {
      rows.push([`leads_${ck}`, `Leads – ${label}`, (p) => byCh('lead', p, ch)], [`booked_${ck}`, `Jobs Booked – ${label}`, (p) => byCh('booked', p, ch)],
        [`customers_${ck}`, `New customers (won) – ${label}`, (p) => byCh('sold', p, ch)], [`revenue_${ck}`, `Sales ($) – ${label}`, (p) => byCh('sold', p, ch, true)]);
    }
    rows.push(['spend_source_google', 'Google Ads spend source', () => sp.channels.google?.source ?? 'not connected'], ['spend_source_meta', 'Meta Ads spend source', () => sp.channels.meta?.source ?? 'not connected'],
      ['generated_at', 'Updated', () => raw.meta.generatedAt ? DateTime.fromISO(raw.meta.generatedAt).setZone(zone).toFormat('yyyy-MM-dd HH:mm') : 'not synced yet']);
    let out = ['key', 'metric', ...periods.map((p) => p.label)].map(csvCell).join(',') + '\n';
    for (const [k, label, fn] of rows) out += [k, label].map(csvCell).join(',') + ',' + periods.map((p) => { const v = fn(p); return typeof v === 'number' ? String(v) : csvCell(v); }).join(',') + '\n';
    return text(out, 200, 'text/csv; charset=utf-8', { 'X-Robots-Tag': 'noindex' });
  } catch (err) {
    await appLog('Export: ' + (err as Error).message, '/export');
    return csvFail(502, 'Couldn’t build the export: ' + (err as Error).message);
  }
}
