/** /admin — sign-in, settings forms and admin pages. POST actions always redirect (POST → 303 → GET). */
import { loadSettings, saveSettings, updateSettings, defaults, type Settings } from '../lib/settings.js';
import { startCtx, readForm, csrfOk, csrfField, signIn, signOut, flash, stash, unstash, hashPassword, verifyPassword, loginThrottle, randomKey, html, redirect, type Ctx } from '../lib/http.js';
import { ghl, GhlError, fetchPipelines, Budget, contactsSearchBody } from '../lib/ghl.js';
import { resolvePeriod, PRESETS } from '../lib/period.js';
import { buildRaw, loadStructure, type Structure } from '../lib/data.js';
import { scorecard, type Scorecard } from '../lib/report.js';
import { metaSpend, googleSpend, AdsError, AD_CHANNELS, type Channel } from '../lib/ads.js';
import { jobberAuthorizeUrl, jobberGraphql, jobberPayments, jobberInvoices, JobberError } from '../lib/jobber.js';
import { recentSyncs } from '../lib/sync.js';
import { appLog, recentErrors, clearLog } from '../lib/log.js';
import { count, select, dbConfigured } from '../lib/db.js';
import { strIn, money, addDays, validYmd, ymdObj } from '../lib/util.js';
import { PAGES, gatePage, adminFrame, overviewPage, connectionPage, pipelinesPage, displayPage, adsPage, jobberPage, sheetsPage, accessPage, systemPage, type SystemInfo } from '../views/admin.js';
import { DateTime } from 'luxon';

class UserError extends Error {}

/** Starts a background sync (Netlify background function, up to 15 min). Returns false if it couldn't be started. */
export async function triggerSync(origin: string, trigger: string, full = false): Promise<boolean> {
  try {
    const res = await fetch(origin + '/.netlify/functions/sync-background', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-sync-secret': process.env.SYNC_SECRET || '' }, body: JSON.stringify({ trigger, full }) });
    return res.status === 202 || res.ok;
  } catch (err) { await appLog('Couldn’t start a sync: ' + (err as Error).message, trigger); return false; }
}


export async function handleAdmin(req: Request): Promise<Response> {
  const ctx = startCtx(req);
  let S = await loadSettings();
  const page = PAGES[ctx.query.page ?? ''] ? ctx.query.page : 'overview';
  const here = '/admin?page=' + page;
  const origin = ctx.url.origin;
  let gateError: string | null = null;

  if (req.method === 'POST') {
    const f = await readForm(req);
    const doIt = f.do || '';
    if (!csrfOk(ctx, f)) { flash(ctx, 'Your session expired. Please try again.', 'danger'); return redirect(ctx, here); }
    try {
      if (doIt === 'setup') {
        if (S.adminHash) return redirect(ctx, '/admin');
        const pw = f.password || '';
        if (pw.length < 8) gateError = 'Use at least 8 characters.';
        else if (pw !== (f.password2 || '')) gateError = 'The two passwords don’t match.';
        else { S = await updateSettings((x) => { if (!x.adminHash) x.adminHash = hashPassword(pw); }); signIn(ctx, true); flash(ctx, 'Admin password created. Next, connect your GoHighLevel sub-account.'); return redirect(ctx, '/admin?page=connection'); }
      } else if (doIt === 'login') {
        const pw = f.password || '';
        if (verifyPassword(pw, S.adminHash)) { signIn(ctx, true); return redirect(ctx, here); }
        await loginThrottle();
        gateError = verifyPassword(pw, S.viewerHash) ? 'That’s the report password. Use the admin password here.' : 'That password isn’t right.';
      } else if (!ctx.session.admin) {
        return redirect(ctx, '/admin');
      } else {
        const r = await action(ctx, S, doIt, f, page, origin);
        return r;
      }
    } catch (err) {
      if (err instanceof UserError || err instanceof GhlError || err instanceof AdsError || err instanceof JobberError) flash(ctx, err.message, 'danger');
      else { await appLog('Admin ' + doIt + ': ' + (err as Error).message, page); flash(ctx, 'Something went wrong: ' + (err as Error).message, 'danger'); }
      return redirect(ctx, here);
    }
  }
  if (!S.adminHash || !ctx.session.admin) return html(ctx, gatePage(S, csrfField(ctx), page, ctx.flashes, gateError));
  return html(ctx, await renderPage(ctx, S, page, origin));
}

async function action(ctx: Ctx, S: Settings, doIt: string, f: Record<string, string>, page: string, origin: string): Promise<Response> {
  const back = (p = page) => redirect(ctx, '/admin?page=' + p);
  switch (doIt) {
    case 'logout': signOut(ctx); return redirect(ctx, '/');
    case 'connect': {
      const loc = strIn(f.locationId, 64);
      const token = strIn(f.token, 400) || S.ghl.token;
      stash(ctx, 'loc', loc);
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(loc)) throw new UserError('Enter the sub-account’s Location ID (Settings › Business Profile in GHL).');
      if (!token) throw new UserError('Paste the Private Integration token.');
      const T: Settings = { ...S, ghl: { ...S.ghl, locationId: loc, token } };
      const budget = new Budget(8);
      let name = '';
      try { const l = await ghl(T, { method: 'GET', path: '/locations/' + encodeURIComponent(loc) }, budget); name = String(l.location?.name ?? l.name ?? ''); }
      catch (err) { if (err instanceof GhlError && err.status === 401) throw err; if (err instanceof GhlError && err.status === 404) throw new UserError('No sub-account found with that Location ID for this token.'); }
      let namesOk = true;
      try { await fetchPipelines(T, budget); }
      catch (err) { if (err instanceof GhlError && err.status === 401) throw err; namesOk = false; await ghl(T, { method: 'GET', path: '/opportunities/search', query: { location_id: loc, limit: 1 } }, budget); }
      await updateSettings((x) => { x.ghl = { locationId: loc, token, locationName: name, connectedAt: new Date().toISOString() }; });
      ctx.setCookies.push('kx_loc=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
      const started = await triggerSync(origin, 'connected', true);
      flash(ctx, `Connected to ${name || loc}. ${started ? 'The first sync has started — it copies about a year of data and can take a few minutes. Check Overview for progress.' : 'Start the first sync from Overview › Sync now.'}`
        + (namesOk ? '' : ' Note: the token can read opportunities but not pipeline names, so stages are shown by ID.'));
      return back('overview');
    }
    case 'disconnect':
      await updateSettings((x) => { x.ghl = defaults().ghl; });
      flash(ctx, 'Disconnected. The token was deleted. Synced data stays in Supabase until the next connection.'); return back('connection');
    case 'sync': {
      const ok = await triggerSync(origin, 'manual', f.full === '1');
      flash(ctx, ok ? (f.full === '1' ? 'Full re-sync started. It can take a few minutes; this page shows when it finishes.' : 'Sync started. Refresh this page in a minute to see the result.') : 'Couldn’t start the sync. Check SYNC_SECRET in Netlify’s environment variables (System check).', ok ? 'success' : 'danger');
      return back('overview');
    }
    case 'display': {
      const tzName = strIn(f.timezone, 64);
      if (!DateTime.now().setZone(tzName).isValid) throw new UserError('That time zone isn’t recognized. Use a name like America/Los_Angeles.');
      await updateSettings((x) => {
        x.display = { company: strIn(f.company, 80) || 'Keil Electric', region: strIn(f.region, 80), title: strIn(f.title, 80) || 'Daily Pipeline Scorecard',
          weekStartsOn: Number(f.weekStartsOn) === 0 ? 0 : 1, timezone: tzName, refreshSeconds: Math.max(0, Math.min(86400, Number(f.refreshSeconds) || 0)),
          defaultRange: PRESETS[f.defaultRange || ''] && f.defaultRange !== 'custom' ? f.defaultRange : 'last_week' };
        x.sources.qualifiedTags = strIn(f.qualifiedTags, 300);
        x.sources.useTransactions = f.useTransactions === '1';
      });
      flash(ctx, 'Display settings saved.'); return back();
    }
    case 'viewer':
      if (f.remove) { await updateSettings((x) => { x.viewerHash = null; }); flash(ctx, 'Report password removed. Anyone with the link can open the report.'); }
      else {
        const pw = f.viewerPassword || '';
        if (pw.length < 6) throw new UserError('Use at least 6 characters for the report password.');
        await updateSettings((x) => { x.viewerHash = hashPassword(pw); }); flash(ctx, 'Report password set. Share it with your team.');
      }
      return back('access');
    case 'adminpw': {
      const pw = f.adminPassword || '';
      if (pw.length < 8) throw new UserError('Use at least 8 characters for the admin password.');
      if (pw !== (f.adminPassword2 || '')) throw new UserError('The two passwords don’t match.');
      await updateSettings((x) => { x.adminHash = hashPassword(pw); }); flash(ctx, 'Admin password changed.'); return back('access');
    }
    case 'ads_meta': {
      if (f.disconnect) { await updateSettings((x) => { x.ads.meta = defaults().ads.meta; delete x.ads.pending?.meta; }); flash(ctx, 'Meta Ads disconnected. The token was deleted.'); return back('ads'); }
      const acct = strIn(f.accountId, 40).replace(/^act_/, '').replace(/[^0-9]/g, '');
      if (!acct) throw new UserError('Enter the Meta ad account ID (the number after act_ in Ads Manager).');
      const pend = S.ads.pending?.meta ?? {};
      const meta = { accountId: acct, token: strIn(f.token, 600) || pend.token || S.ads.meta.token, version: /^v\d+\.\d+$/.test((f.version || '').trim()) ? f.version.trim() : '' };
      if (!meta.token) throw new UserError('Paste a Meta access token with the ads_read permission.');
      await updateSettings((x) => { (x.ads.pending ??= {}).meta = meta; }); // kept server-side so a failed test needn't be retyped
      const today = DateTime.now().toFormat('yyyy-MM-dd');
      const d = await metaSpend({ ...S, ads: { ...S.ads, meta } }, addDays(today, -6), today, new Budget(8));
      await updateSettings((x) => { x.ads.meta = meta; delete x.ads.pending?.meta; });
      await triggerSync(origin, 'ads connected');
      flash(ctx, `Meta Ads connected — ${money(Object.values(d).reduce((a, b) => a + b, 0))} spent in the last 7 days. A sync has started to copy the past year.`); return back('ads');
    }
    case 'ads_google': {
      if (f.disconnect) { await updateSettings((x) => { x.ads.google = defaults().ads.google; delete x.ads.pending?.google; }); flash(ctx, 'Google Ads disconnected. The keys were deleted.'); return back('ads'); }
      const old = { ...S.ads.google, ...Object.fromEntries(Object.entries(S.ads.pending?.google ?? {}).filter(([, v]) => v)) };
      const g = { customerId: strIn(f.customerId, 20).replace(/[^0-9-]/g, ''), loginCustomerId: strIn(f.loginCustomerId, 20).replace(/[^0-9-]/g, ''),
        developerToken: strIn(f.developerToken, 100) || old.developerToken, clientId: strIn(f.clientId, 200), clientSecret: strIn(f.clientSecret, 200) || old.clientSecret,
        refreshToken: strIn(f.refreshToken, 600) || old.refreshToken, version: /^v\d+$/.test((f.version || '').trim()) ? f.version.trim() : '' };
      for (const [k, l] of [['customerId', 'customer ID'], ['developerToken', 'developer token'], ['clientId', 'OAuth client ID'], ['clientSecret', 'OAuth client secret'], ['refreshToken', 'refresh token']] as const)
        if (!g[k]) throw new UserError('Enter the Google Ads ' + l + '.');
      await updateSettings((x) => { (x.ads.pending ??= {}).google = g; });
      const today = DateTime.now().toFormat('yyyy-MM-dd');
      const r = await googleSpend({ ...S, ads: { ...S.ads, google: g } }, addDays(today, -6), today, new Budget(8));
      await updateSettings((x) => { x.ads.google = g; if (!g.version) x.ads.googleVersionFound = r.version; delete x.ads.pending?.google; });
      await triggerSync(origin, 'ads connected');
      flash(ctx, `Google Ads connected — ${money(Object.values(r.days).reduce((a, b) => a + b, 0))} spent in the last 7 days. A sync has started to copy the past year.`); return back('ads');
    }
    case 'ads_manual_add': {
      const ch = f.channel as Channel;
      if (!AD_CHANNELS[ch]) throw new UserError('Pick a channel.');
      let from = f.from || '', to = f.to || '';
      if (!validYmd(from) || !validYmd(to)) throw new UserError('Enter the start and end dates.');
      if (to < from) [from, to] = [to, from];
      const amt = Number(String(f.amount || '').replace(/[,$\s]/g, ''));
      if (!(amt > 0)) throw new UserError('Enter the amount spent.');
      await updateSettings((x) => { x.ads.manual.push({ id: randomKey(6), channel: ch, from, to, amount: Math.round(amt * 100) / 100, note: strIn(f.note, 120) }); x.ads.manual.sort((a, b) => b.from.localeCompare(a.from)); });
      const fd = (d: string) => ymdObj(d).toFormat('LLL d', { locale: 'en-US' });
      flash(ctx, `Added ${money(amt)} of ${AD_CHANNELS[ch].label} spend for ${fd(from)}${from !== to ? ' – ' + fd(to) : ''}, ${to.slice(0, 4)}.`); return back('ads');
    }
    case 'ads_manual_del':
      await updateSettings((x) => { x.ads.manual = x.ads.manual.filter((m) => m.id !== f.id); }); flash(ctx, 'Spend entry removed.'); return back('ads');
    case 'ads_match':
      await updateSettings((x) => { for (const ch of Object.keys(AD_CHANNELS) as Channel[]) x.ads.match[ch] = strIn(f['match[' + ch + ']'], 300); });
      flash(ctx, 'Channel matching saved.'); return back('ads');
    case 'jobber_save': {
      const S2 = await updateSettings((x) => {
        x.jobber.clientId = strIn(f.clientId, 200);
        const sec = strIn(f.clientSecret, 300); if (sec) x.jobber.clientSecret = sec;
        x.jobber.version = /^\d{4}-\d{2}-\d{2}$/.test((f.version || '').trim()) ? f.version.trim() : '2025-01-20';
      });
      if (!S2.jobber.clientId || !S2.jobber.clientSecret) throw new UserError('Enter the Client ID and Client secret from your Jobber app.');
      if (f.connect) {
        const state = randomKey(16);
        ctx.setCookies.push(`kjs=${state}; Path=/admin; Max-Age=900; HttpOnly; SameSite=Lax${ctx.url.protocol === 'https:' ? '; Secure' : ''}`);
        return redirect(ctx, jobberAuthorizeUrl(S2, origin, state));
      }
      flash(ctx, 'Jobber app details saved. Click “Connect to Jobber” to sign in.'); return back('jobber');
    }
    case 'jobber_test': {
      const t0 = Date.now(); const rows: [string, boolean, string][] = []; const budget = new Budget(9);
      try { const a = await jobberGraphql(S, 'query { account { id name } }', {}, budget); rows.push(['Account', true, String(a.account?.name ?? 'connected')]); } catch (err) { rows.push(['Account', false, (err as Error).message]); }
      const today = DateTime.now().toFormat('yyyy-MM-dd'), from = addDays(today, -30);
      try { const p = await jobberPayments(S, from, today, budget); rows.push(['Payments (last 30 days)', true, `${p.length} payments, ${money(p.reduce((s: number, x: { amount?: number }) => s + (Number(x.amount) || 0), 0))}`]); } catch (err) { rows.push(['Payments (last 30 days)', false, (err as Error).message]); }
      try { const i = await jobberInvoices(S, from, today, budget); rows.push(['Invoices (last 30 days)', true, i.length + ' invoices']); } catch (err) { rows.push(['Invoices (last 30 days)', false, (err as Error).message]); }
      stash(ctx, 'jt', { at: Date.now(), rows, ms: Date.now() - t0 });
      return back('jobber');
    }
    case 'jobber_disconnect':
      await updateSettings((x) => { const keep = { clientId: x.jobber.clientId, clientSecret: x.jobber.clientSecret, version: x.jobber.version }; x.jobber = { ...defaults().jobber, ...keep }; });
      flash(ctx, 'Disconnected from Jobber. Payments come from GoHighLevel again (after the next sync).'); return back('jobber');
    case 'export_on': case 'export_regen':
      await updateSettings((x) => { x.export.key = randomKey(20); });
      flash(ctx, doIt === 'export_on' ? 'Google Sheets export is on. Copy the link below into the Setup tab of the marketing sheet.' : 'New link created. The old link stopped working — paste the new one into your Google Sheet.'); return back('sheets');
    case 'export_off':
      await updateSettings((x) => { x.export.key = ''; }); flash(ctx, 'Google Sheets export is off. The link no longer works.'); return back('sheets');
    case 'clearlog': await clearLog(); flash(ctx, 'Error log cleared.'); return back('system');
    case 'datatest': {
      const rows: [string, boolean, string, number][] = []; const budget = new Budget(9);
      const today = DateTime.now().setZone(S.display.timezone || 'America/Los_Angeles');
      const tests: [string, () => Promise<string>][] = [
        ['Pipelines', async () => (await fetchPipelines(S, budget)).length + ' pipelines'],
        ['Contacts (last 7 days)', async () => { const r = await ghl(S, { method: 'POST', path: '/contacts/search', body: contactsSearchBody(S.ghl.locationId, today.minus({ days: 7 }), today, 1, 1) }, budget); return Number(r.total ?? 0).toLocaleString('en-US') + ' contacts'; }],
        ['Opportunities', async () => { const r = await ghl(S, { method: 'GET', path: '/opportunities/search', query: { location_id: S.ghl.locationId, limit: 1, status: 'all', page: 1 } }, budget); return r.meta?.total !== undefined ? Number(r.meta.total).toLocaleString('en-US') + ' opportunities' : (r.opportunities ?? []).length + ' read'; }],
        ['Payments', async () => { const r = await ghl(S, { method: 'GET', path: '/payments/transactions', query: { altId: S.ghl.locationId, altType: 'location', startAt: today.minus({ days: 7 }).toFormat('yyyy-MM-dd'), endAt: today.toFormat('yyyy-MM-dd'), limit: 1, offset: 0 } }, budget); return r.totalCount !== undefined ? Number(r.totalCount).toLocaleString('en-US') + ' transactions (last 7 days)' : 'readable'; }],
      ];
      for (const [label, fn] of tests) { const t = Date.now(); try { rows.push([label, true, await fn(), Date.now() - t]); } catch (err) { rows.push([label, false, (err as Error).message, Date.now() - t]); } }
      stash(ctx, 'dt', { at: Date.now(), rows });
      return back('system');
    }
  }
  return back();
}

async function renderPage(ctx: Ctx, S: Settings, page: string, origin: string): Promise<string> {
  const csrf = csrfField(ctx);
  const connected = !!(S.ghl.token && S.ghl.locationId);
  const zone = S.display.timezone || 'America/Los_Angeles';
  let body = ''; let badge: [string, string] = connected ? ['success', 'Connected to GHL'] : ['secondary', 'Not connected'];
  if (page === 'overview') {
    let R: Scorecard | null = null; let err: string | null = null;
    const syncs = await recentSyncs(8).catch(() => []);
    if (connected) { try { const P = resolvePeriod(S, {}); R = scorecard(await buildRaw(S, P), P); } catch (e) { err = (e as Error).message; await appLog('Overview: ' + err); } }
    if (err) badge = ['danger', 'Data error'];
    body = overviewPage(S, csrf, R, err, syncs, zone);
  } else if (page === 'connection') {
    const typed = unstash<string>(ctx, 'loc');
    body = connectionPage(S, csrf, typed ?? null);
  } else if (page === 'pipelines') {
    let st: Structure | null = null; let err: string | null = null;
    if (connected) { try { st = await loadStructure(); } catch (e) { err = (e as Error).message; } }
    body = pipelinesPage(S, st, err);
  } else if (page === 'display') body = displayPage(S, csrf);
  else if (page === 'ads') {
    const counts = new Map<string, number>();
    if (connected) {
      try {
        const rows = await select<{ source: string | null }>('ghl_contacts', `select=source&added_at=gte.${encodeURIComponent(new Date(Date.now() - 30 * 86400000).toISOString())}&limit=20000`);
        for (const r of rows) { const k = (r.source || '').trim() || '(no source)'; counts.set(k, (counts.get(k) ?? 0) + 1); }
      } catch { /* preview only */ }
    }
    body = adsPage(S, csrf, [...counts.entries()].sort((a, b) => b[1] - a[1]));
  } else if (page === 'jobber') {
    const t = unstash<{ at: number; rows: [string, boolean, string][]; ms: number }>(ctx, 'jt');
    body = jobberPage(S, csrf, origin, t ?? null);
  } else if (page === 'sheets') body = sheetsPage(S, csrf, origin);
  else if (page === 'access') body = accessPage(S, csrf);
  else if (page === 'system') body = systemPage(S, csrf, await systemInfo(ctx), zone);
  return adminFrame(S, page, csrf, ctx.flashes, badge, body);
}

async function systemInfo(ctx: Ctx): Promise<SystemInfo> {
  const has = (k: string) => (process.env[k] || '').trim() !== '';
  const env: SystemInfo['env'] = [
    ['SUPABASE_URL', has('SUPABASE_URL'), 'Your Supabase project URL (Project Settings › API).'],
    ['SUPABASE_SERVICE_ROLE_KEY', has('SUPABASE_SERVICE_ROLE_KEY'), 'Server-side secret key (service_role or sb_secret_…). Never the anon key.'],
    ['SESSION_SECRET', (process.env.SESSION_SECRET || '').trim().length >= 16, 'Signs sign-in cookies. Any long random text (32+ characters).'],
    ['SYNC_SECRET', has('SYNC_SECRET'), 'Protects the background sync from being started by anyone else. Any long random text.'],
  ];
  const tables = ['app_settings', 'ghl_pipelines', 'ghl_opportunities', 'ghl_contacts', 'ghl_transactions', 'ghl_invoices', 'jobber_payments', 'jobber_invoices', 'ad_spend_daily', 'sync_runs', 'app_log'];
  const db = { ok: dbConfigured(), message: dbConfigured() ? 'Connected' : 'Not configured', tables: [] as [string, number | null][] };
  for (const t of tables) { try { db.tables.push([t, await count(t)]); } catch (err) { db.tables.push([t, null]); db.ok = false; db.message = (err as Error).message.slice(0, 120); } }
  const dt = unstash<SystemInfo['dataTest']>(ctx, 'dt');
  return { env, db, syncs: await recentSyncs(5).catch(() => []), errors: await recentErrors(15), dataTest: dt ?? null };
}
