/**
 * Background sync: copies GoHighLevel (and Jobber, Google Ads, Meta Ads) into Supabase so report pages are instant.
 * Runs every 15 minutes (netlify/functions/sync-scheduled.mts) and on demand (Admin › Sync now), as a Netlify
 * background function (up to 15 minutes). One run at a time; a partial read never deletes data.
 */
import { DateTime } from 'luxon';
import { loadSettings, updateSettings, type Settings } from './settings.js';
import { select, insert, patch, upsert, remove } from './db.js';
import { appLog } from './log.js';
import { Budget, GhlError, fetchPipelines, fetchOpportunities, fetchContacts, fetchTransactions, fetchInvoices, fetchLocationName, contactName } from './ghl.js';
import { jobberConnected, jobberPayments, jobberInvoices } from './jobber.js';
import { adsConfigured, metaSpend, googleSpend, AD_CHANNELS, type Channel } from './ads.js';
import { isoUtc, lower, addDays } from './util.js';
import { zoneOf } from './period.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface SyncResult { status: 'ok' | 'partial' | 'error' | 'skipped'; counts: Record<string, number | string>; messages: string[]; durationMs: number }

const BACKFILL_DAYS = 400;

export async function runSync(trigger: string, opts: { full?: boolean } = {}): Promise<SyncResult> {
  const t0 = Date.now();
  const S = await loadSettings();
  if (!S.ghl.token || !S.ghl.locationId) return { status: 'skipped', counts: {}, messages: ['GoHighLevel isn’t connected yet.'], durationMs: 0 };
  // one run at a time: if another sync is running, wait for it (a request made meanwhile — e.g. after connecting Jobber — must not be lost)
  for (let waited = 0; ; waited += 5) {
    const running = await select<{ id: number; started_at: string }>('sync_runs', `select=id,started_at&status=eq.running&started_at=gte.${encodeURIComponent(new Date(Date.now() - 14 * 60000).toISOString())}&limit=1`);
    if (!running.length) break;
    if (waited >= 600) return { status: 'skipped', counts: {}, messages: ['Another sync is still running (started ' + running[0].started_at + ').'], durationMs: 0 };
    await new Promise((r) => setTimeout(r, 5000));
  }
  const fresh = await loadSettings(); Object.assign(S, fresh); // settings may have changed while waiting
  const run = await insert<{ id: number }>('sync_runs', { trigger, status: 'running' });
  const runStart = new Date().toISOString();
  const budget = new Budget(13 * 60);
  const counts: Record<string, number | string> = {};
  const messages: string[] = [];
  let failed = false, fatal = false;
  const zone = zoneOf(S);
  const nowZ = DateTime.now().setZone(zone);
  const today = nowZ.toFormat('yyyy-MM-dd');

  // first run, a requested full sync, or the daily refresh → read the whole window again
  const lastFull = await select<{ started_at: string }>('sync_runs', 'select=started_at&counts->>contactsMode=eq.full&status=in.(ok,partial)&order=started_at.desc&limit=1');
  const full = !!opts.full || !lastFull.length || Date.parse(lastFull[0].started_at) < Date.now() - 24 * 3600 * 1000;
  counts.contactsMode = full ? 'full' : 'recent';
  const step = async (name: string, fn: () => Promise<void>) => {
    if (budget.out()) { messages.push(`${name}: skipped — out of time; the next sync continues.`); failed = true; return; }
    try { await fn(); }
    catch (err) {
      failed = true;
      const msg = `${name}: ${(err as Error).message}`;
      messages.push(msg); await appLog('Sync ' + msg, trigger);
      if (err instanceof GhlError && err.status === 401) fatal = true;
    }
  };

  await step('Location', async () => {
    const name = await fetchLocationName(S, budget);
    if (name && name !== S.ghl.locationName) await updateSettings((x) => { x.ghl.locationName = name; });
  });
  if (!fatal) await step('Pipelines', async () => {
    const pipes = await fetchPipelines(S, budget);
    await upsert('ghl_pipelines', pipes.map((p) => ({ id: p.id, name: p.name, stages: p.stages, synced_at: runStart })));
    await remove('ghl_pipelines', `synced_at=lt.${encodeURIComponent(runStart)}`);
    counts.pipelines = pipes.length;
  });
  if (!fatal) await step('Opportunities', async () => {
    const warn: string[] = [];
    const opps = await fetchOpportunities(S, warn, budget);
    const rows = opps.filter((o) => o?.id).map((o) => {
      const c: Json = o.contact && typeof o.contact === 'object' ? o.contact : {};
      const keep: Json = {}; for (const k of ['id', 'name', 'firstName', 'lastName', 'companyName', 'email', 'phone', 'tags']) if (c[k] !== undefined) keep[k] = c[k];
      const v = o.monetaryValue === null || o.monetaryValue === undefined || o.monetaryValue === '' ? null : Number(o.monetaryValue);
      return { id: String(o.id), name: o.name ?? null, pipeline_id: o.pipelineId ?? null, stage_id: o.pipelineStageId ?? null, status: lower(o.status ?? 'open'),
        value: Number.isFinite(v) ? v : null, source: o.source ?? null, contact_id: String(o.contactId ?? c.id ?? '') || null, contact: keep,
        created_at: isoUtc(o.createdAt), updated_at: isoUtc(o.updatedAt), stage_changed_at: isoUtc(o.lastStageChangeAt), status_changed_at: isoUtc(o.lastStatusChangeAt), synced_at: runStart };
    });
    await upsert('ghl_opportunities', rows);
    if (!warn.length && !budget.out()) await remove('ghl_opportunities', `synced_at=lt.${encodeURIComponent(runStart)}`); // deleted in GHL — only after a complete read
    messages.push(...warn.map((w) => 'Opportunities: ' + w));
    counts.opportunities = rows.length;
  });
  if (!fatal) await step('Contacts', async () => {
    const warn: string[] = [];
    const startYmd = full ? addDays(today, -BACKFILL_DAYS) : addDays(today, -30);
    let n = 0;
    // month by month: GHL's contact search stops serving deep pages around 10,000 results per query
    let ws = DateTime.fromFormat(startYmd + ' 00:00', 'yyyy-MM-dd HH:mm', { zone });
    while (ws <= nowZ && !budget.out()) {
      const we = DateTime.min(ws.endOf('month'), nowZ.endOf('day'));
      const contacts = await fetchContacts(S, ws, we, warn, budget);
      const rows = contacts.filter((c) => c?.id && isoUtc(c.dateAdded)).map((c) => ({
        id: String(c.id), added_at: isoUtc(c.dateAdded), name: contactName(c), source: c.source ?? null,
        tags: Array.isArray(c.tags) ? c.tags.map((t: unknown) => String(t)) : [], email: c.email ?? null, phone: c.phone ?? null, synced_at: runStart }));
      await upsert('ghl_contacts', rows);
      n += rows.length;
      ws = we.plus({ minutes: 1 }).startOf('day');
    }
    messages.push(...warn);
    counts.contacts = n;
  });
  const jobber = jobberConnected(S);
  /** Has this table got rows older than ~40 days? If not, the source is new (connected after the last full sync): backfill a year. */
  const hasHistory = async (table: string, col: string, extra = '') => (await select(table, `select=${col}&${col}=lt.${encodeURIComponent(addDays(today, -40))}${extra}&limit=1`)).length > 0;
  if (!fatal && !jobber && S.sources.useTransactions) {
    await step('GHL Payments', async () => {
      try {
        const back = full || !(await hasHistory('ghl_transactions', 'created_at'));
        const txs = await fetchTransactions(S, back ? addDays(today, -BACKFILL_DAYS) : addDays(today, -45), today, budget);
        const rows = txs.filter((t) => t?._id || t?.id).map((t) => {
          const cd: Json = t.contactDetails ?? {};
          return { id: String(t._id ?? t.id), created_at: isoUtc(t.createdAt ?? t.fulfilledAt ?? t.updatedAt), amount: Number(t.amount) || 0, status: lower(t.status ?? 'succeeded'),
            method: String(t.paymentProviderType ?? t.paymentMode ?? t.chargeType ?? 'card'), contact_name: contactName({ contactName: t.contactName ?? cd.name ?? '', ...cd }),
            detail: String(t.entitySourceName ?? t.entitySourceType ?? 'Payment'), synced_at: runStart };
        });
        await upsert('ghl_transactions', rows); counts.transactions = rows.length;
      } catch (err) { if (err instanceof GhlError && [403, 404].includes(err.status)) messages.push('GHL Payments not readable: ' + err.message); else throw err; }
    });
    await step('GHL Invoices', async () => {
      try {
        const invs = await fetchInvoices(S, addDays(today, -BACKFILL_DAYS), today, budget); // balances change for months: always the last year
        const rows = invs.filter((i) => i?._id || i?.id).map((i) => {
          const cd: Json = i.contactDetails ?? {}; const st = lower(i.status);
          return { id: String(i._id ?? i.id), number: String(i.invoiceNumber ?? ''), status: st, total: Number(i.total ?? i.invoiceTotal) || 0,
            amount_paid: Number(i.amountPaid) || 0, amount_due: i.amountDue === undefined || i.amountDue === null ? null : Number(i.amountDue),
            issue_date: isoUtc(i.issueDate ?? i.createdAt), due_date: i.dueDate ? String(i.dueDate).slice(0, 10) : null,
            paid_at: isoUtc(i.paidAt ?? i.lastPaymentDate ?? (st === 'paid' || Number(i.amountPaid) > 0 ? i.updatedAt : null)),
            contact_name: contactName({ ...cd, name: cd.name ?? i.name ?? '' }), synced_at: runStart };
        });
        await upsert('ghl_invoices', rows); counts.invoices = rows.length;
      } catch (err) { if (err instanceof GhlError && [403, 404].includes(err.status)) messages.push('GHL Invoices not readable (add the View Invoices scope): ' + err.message); else throw err; }
    });
  }
  if (jobber) await step('Jobber', async () => {
    const S2 = await loadSettings(); // fresh tokens
    const back = full || !(await hasHistory('jobber_payments', 'entry_date'));
    const pays = await jobberPayments(S2, back ? addDays(today, -BACKFILL_DAYS) : addDays(today, -45), today, budget);
    await upsert('jobber_payments', pays.map((r: Json) => ({ id: String(r.id), amount: Number(r.amount) || 0, entry_date: isoUtc(r.entryDate), method: String(r.paymentType ?? 'other'),
      client_name: String(r.client?.name ?? '').trim() || 'Client', invoice_id: r.invoice?.id ?? null, invoice_number: r.invoice?.invoiceNumber ?? null, synced_at: runStart })));
    const invs = await jobberInvoices(S2, addDays(today, -BACKFILL_DAYS), today, budget);
    await upsert('jobber_invoices', invs.map((r: Json) => ({ id: String(r.id), number: String(r.invoiceNumber ?? ''), status: lower(r.invoiceStatus), total: Number(r.amounts?.total) || 0,
      balance: Number(r.amounts?.invoiceBalance) || 0, issued_date: isoUtc(r.issuedDate), due_date: r.dueDate ? String(r.dueDate).slice(0, 10) : null,
      client_name: String(r.client?.name ?? '').trim() || 'Client', synced_at: runStart })));
    counts.jobberPayments = pays.length; counts.jobberInvoices = invs.length;
  });
  for (const ch of Object.keys(AD_CHANNELS) as Channel[]) {
    if (!adsConfigured(S, ch)) continue;
    await step(AD_CHANNELS[ch].label, async () => {
      const back = full || !(await hasHistory('ad_spend_daily', 'day', `&channel=eq.${ch}`));
      const from = back ? addDays(today, -BACKFILL_DAYS) : addDays(today, -35); // ad platforms revise recent days; new channels get the year
      let days: Record<string, number>; let source: string;
      if (ch === 'meta') { days = await metaSpend(S, from, today, budget); source = `Meta Marketing API (ad account ${S.ads.meta.accountId.replace(/^act_/, '')})`; }
      else {
        const r = await googleSpend(S, from, today, budget); days = r.days; source = `Google Ads API (customer ${S.ads.google.customerId})`;
        if (!S.ads.google.version && r.version !== S.ads.googleVersionFound) await updateSettings((x) => { x.ads.googleVersionFound = r.version; });
      }
      const rows = [];
      for (let d = from; d <= today; d = addDays(d, 1)) rows.push({ channel: ch, day: d, amount: Math.round((days[d] ?? 0) * 100) / 100, source, synced_at: runStart });
      await upsert('ad_spend_daily', rows, 'channel,day');
      counts['spend_' + ch] = Math.round(Object.values(days).reduce((a, b) => a + b, 0));
    });
  }

  const status: SyncResult['status'] = fatal ? 'error' : failed || messages.length ? 'partial' : 'ok';
  const durationMs = Date.now() - t0;
  await patch('sync_runs', `id=eq.${run.id}`, { status, finished_at: new Date().toISOString(), counts, messages, duration_ms: durationMs });
  // keep the history short
  await remove('sync_runs', `started_at=lt.${encodeURIComponent(new Date(Date.now() - 30 * 86400000).toISOString())}`).catch(() => undefined);
  return { status, counts, messages, durationMs };
}

/** Latest runs for Admin › Overview / System check. */
export async function recentSyncs(n = 8) {
  return select<{ id: number; started_at: string; finished_at: string | null; status: string; trigger: string; counts: Record<string, unknown>; messages: string[]; duration_ms: number | null }>(
    'sync_runs', `select=id,started_at,finished_at,status,trigger,counts,messages,duration_ms&order=started_at.desc&limit=${n}`);
}
