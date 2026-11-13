/**
 * Report data, built from the Supabase copy of GHL / Jobber (kept fresh by the background sync).
 * Same rules as the PHP app: leads, SQLs (tags or pipeline progress), stage events, permits right now,
 * cash from Jobber → GHL Payments → GHL Invoices → “Paid” stages, invoices owed.
 */
import { DateTime } from 'luxon';
import type { Settings } from './settings.js';
import type { Period } from './period.js';
import { select, selectAll, count } from './db.js';
import { dtLocal, lower, addDays, ucwords } from './util.js';
import { smartCategory, tagsQualify, tagWords, type Cat, type StageStats } from './classify.js';
import { contactName } from './ghl.js';

const F = 'yyyy-MM-dd HH:mm';
export interface Item { date: string; at: string; name: string; detail?: string; src?: string; id?: string; cid?: string; amount?: number | null;
  qualified?: boolean; tagq?: boolean; method?: string; number?: string; due?: string | null; total?: number }
export interface Ev { found: boolean; how: string; hasAmount: boolean; items: Item[]; trend?: number[]; knownFrom?: string }
export interface StageX { id: string; name: string; position: number; stats: StageStats; cat: Cat }
export interface PipeX { id: string; name: string; stages: StageX[]; emptyStages: number }
export interface OppRow { id: string; name: string | null; pipeline_id: string | null; stage_id: string | null; status: string | null; value: number | string | null; source: string | null;
  contact_id: string | null; contact: Record<string, any>; created_at: string | null; updated_at: string | null; stage_changed_at: string | null; status_changed_at: string | null } // eslint-disable-line @typescript-eslint/no-explicit-any
export interface Structure { pipelines: PipeX[]; opps: OppRow[]; skippedPipelines: number }
export interface Snapshot { found: boolean; count: number; value: number; items: (Item & { due?: string | null })[]; how: string; stages?: string[] }
export interface Raw {
  meta: { first: string; last: string; generatedAt: string | null; location: string; warnings: string[]; permitNow: Snapshot; outstanding: Snapshot; synced: boolean };
  events: Record<string, Ev>;
}

/** Local "yyyy-MM-dd HH:mm" → UTC ISO for database filters. */
export function utc(local: string, zone: string, plusSeconds = 0): string {
  return DateTime.fromFormat(local, F, { zone }).plus({ seconds: plusSeconds }).toUTC().toISO() as string;
}
const enc = encodeURIComponent;

/** Pipelines and every opportunity, with each stage's counts and detected category (read fresh for every request). */
export function loadStructure(): Promise<Structure> {
  return (async () => {
    const [named, opps] = await Promise.all([
      select<{ id: string; name: string; stages: { id: string; name: string; position: number }[] }>('ghl_pipelines', 'select=id,name,stages&order=name.asc'),
      selectAll<OppRow>('ghl_opportunities', 'select=id,name,pipeline_id,stage_id,status,value,source,contact_id,contact,created_at,updated_at,stage_changed_at,status_changed_at&order=id.asc'),
    ]);
    const stats: Record<string, Record<string, StageStats>> = {};
    for (const o of opps) {
      const pid = o.pipeline_id || '', sid = o.stage_id || '';
      if (!pid || !sid) continue;
      const st = lower(o.status || 'open');
      const c = ((stats[pid] ??= {})[sid] ??= { total: 0, open: 0, won: 0, lost: 0, other: 0 });
      c.total++; c[(['open', 'won', 'lost'].includes(st) ? st : 'other') as keyof StageStats]++;
    }
    const byId = new Map(named.map((p) => [p.id, p]));
    const order = [...named.map((p) => p.id), ...Object.keys(stats).filter((id) => !byId.has(id))];
    const pipelines: PipeX[] = [];
    for (const pid of order) {
      if (!stats[pid]) continue; // no opportunities → not used
      const p = byId.get(pid) ?? { id: pid, name: 'Pipeline ' + pid.slice(0, 6), stages: [] };
      const known = new Set(p.stages.map((s) => s.id));
      const stages: StageX[] = [];
      for (const st of p.stages) if (stats[pid][st.id]) stages.push({ ...st, stats: stats[pid][st.id], cat: 'none' });
      let pos = p.stages.length;
      for (const sid of Object.keys(stats[pid])) if (!known.has(sid)) stages.push({ id: sid, name: 'Stage ' + sid.slice(0, 6), position: pos++, stats: stats[pid][sid], cat: 'none' });
      for (const st of stages) st.cat = smartCategory(st.name, st.stats);
      pipelines.push({ id: pid, name: p.name, stages, emptyStages: p.stages.length - p.stages.filter((x) => stats[pid][x.id]).length });
    }
    return { pipelines, opps, skippedPipelines: named.filter((p) => !stats[p.id]).length };
  })();
}

export async function lastSync(): Promise<{ finished_at: string | null; status: string; started_at: string } | null> {
  const rows = await select<{ finished_at: string | null; status: string; started_at: string }>('sync_runs', 'select=finished_at,status,started_at&status=in.(ok,partial)&order=started_at.desc&limit=1');
  return rows[0] ?? null;
}

function newEv(k: string): Ev { return { found: false, how: '', hasAmount: ['sold', 'permitIn', 'permitFin', 'completed', 'paid', 'paidInv', 'invoiced'].includes(k), items: [] }; }

/** The data for one period. `lite` skips trend counts and the previous period (the CSV export reads one wide window). */
export async function buildRaw(S: Settings, P: Period, opts: { lite?: boolean } = {}): Promise<Raw> {
  const zone = P.zone;
  const first = opts.lite ? P.from : P.fetchFrom.toFormat(F);
  const last = P.to;
  const inRange = (at: string | null | undefined): at is string => !!at && at >= first && at <= last;
  const warnings: string[] = [];
  const ev: Record<string, Ev> = {};
  for (const k of ['lead', 'sql', 'booked', 'sold', 'permitIn', 'permitFin', 'completed', 'paid', 'paidInv', 'invoiced']) ev[k] = newEv(k);
  const outstanding: Snapshot = { found: false, count: 0, value: 0, items: [], how: '' };
  const permitNow: Snapshot = { found: false, count: 0, value: 0, items: [], how: '', stages: [] };
  const fromYmd = first.slice(0, 10), toYmd = last.slice(0, 10);
  const owedFrom = [fromYmd, addDays(toYmd, -365)].sort()[0]; // balances still owed: invoices from the last year
  const jobberOn = S.jobber.refreshToken !== '' && S.jobber.clientId !== '';

  // ---- everything we need from Supabase, in parallel
  const words = tagWords(S.sources.qualifiedTags);
  const cFromLocal = opts.lite ? first : [P.prevFrom, P.from].sort()[0];
  const trendCountsP = opts.lite ? Promise.resolve(null) : Promise.all(P.trend.map((t) => count('ghl_contacts', `added_at=gte.${enc(utc(t.start, zone))}&added_at=lte.${enc(utc(t.end, zone, 59))}`))).catch(() => null);
  const [contacts, struct, trendCounts, txs, invs, jPays, jInvs, sync] = await Promise.all([
    selectAll<{ id: string; added_at: string; name: string | null; source: string | null; tags: string[] }>('ghl_contacts',
      `select=id,added_at,name,source,tags&added_at=gte.${enc(utc(cFromLocal, zone))}&added_at=lte.${enc(utc(last, zone, 59))}&order=added_at.desc`),
    loadStructure(),
    trendCountsP,
    jobberOn ? Promise.resolve([]) : selectAll<{ id: string; created_at: string; amount: number; status: string; method: string; contact_name: string; detail: string }>('ghl_transactions',
      `select=id,created_at,amount,status,method,contact_name,detail&created_at=gte.${enc(utc(first, zone))}&created_at=lte.${enc(utc(last, zone, 59))}&order=created_at.desc`),
    jobberOn ? Promise.resolve([]) : selectAll<{ id: string; number: string; status: string; total: number; amount_paid: number; amount_due: number; issue_date: string; due_date: string | null; paid_at: string | null; contact_name: string }>('ghl_invoices',
      `select=id,number,status,total,amount_paid,amount_due,issue_date,due_date,paid_at,contact_name&issue_date=gte.${enc(utc(owedFrom + ' 00:00', zone))}&order=issue_date.desc`),
    jobberOn ? selectAll<{ id: string; amount: number; entry_date: string; method: string; client_name: string; invoice_id: string | null; invoice_number: string | null }>('jobber_payments',
      `select=id,amount,entry_date,method,client_name,invoice_id,invoice_number&entry_date=gte.${enc(utc(owedFrom + ' 00:00', zone))}&order=entry_date.desc`) : Promise.resolve([]),
    jobberOn ? selectAll<{ id: string; number: string; status: string; total: number; balance: number; issued_date: string | null; due_date: string | null; client_name: string }>('jobber_invoices',
      `select=id,number,status,total,balance,issued_date,due_date,client_name&issued_date=gte.${enc(utc(owedFrom + ' 00:00', zone))}&order=issued_date.desc`) : Promise.resolve([]),
    lastSync().catch(() => null),
  ]);
  const synced = !!sync;

  // ---- leads (contacts), dated by when they were added
  if (S.ghl.token && synced) {
    ev.lead.found = true;
    ev.lead.how = 'GHL contacts, dated by when they were added';
    if (trendCounts) { ev.lead.trend = trendCounts; ev.sql.knownFrom = cFromLocal; }
    for (const c of contacts) {
      const at = dtLocal(c.added_at, zone);
      if (!inRange(at)) continue;
      ev.lead.items.push({ date: at.slice(0, 10), at, name: contactName({ name: c.name }), detail: c.source || '', src: c.source || '', id: c.id, cid: c.id, tagq: tagsQualify(c.tags, words) });
    }
  }

  // ---- pipeline stages + opportunities
  const pipes = struct.pipelines;
  const stageInfo: Record<string, { name: string; pipeline: string; cat: Cat }> = {};
  const byCat: Partial<Record<Cat, string[]>> = {};
  for (const p of pipes) for (const st of p.stages) {
    stageInfo[st.id] = { name: st.name, pipeline: p.name, cat: st.cat };
    if (st.cat !== 'none') (byCat[st.cat] ??= []).push(st.name);
  }
  const multi = pipes.length > 1;
  const pipeIds = new Set(pipes.map((p) => p.id));
  permitNow.stages = byCat.permitIn ?? [];
  permitNow.found = !!byCat.permitIn?.length;
  if (synced && S.ghl.token) ev.sold.found = true;
  for (const o of struct.opps) {
    if (!pipeIds.has(o.pipeline_id || '')) continue;
    const st = stageInfo[o.stage_id || ''];
    const c = o.contact || {};
    const name = contactName({ ...c, name: c.name ?? o.name ?? '' });
    const amount = o.value === null || o.value === undefined ? null : Number(o.value);
    const detail = st ? st.name + (multi ? ' · ' + st.pipeline : '') : (o.source || '');
    const base = { name, amount, detail, src: o.source || '', id: o.id, cid: o.contact_id || String(c.id ?? '') };
    const status = lower(o.status);
    if (st && st.cat === 'permitIn' && !['lost', 'abandoned'].includes(status)) {
      // “In process” is a right-now count: every job currently waiting on a permit, however long it has waited
      const since = dtLocal(o.stage_changed_at ?? o.updated_at ?? o.created_at, zone);
      permitNow.count++; permitNow.value += Number(amount) || 0;
      permitNow.items.push({ ...base, date: since ? since.slice(0, 10) : '', at: since ?? '' });
    }
    if (status === 'won') {
      const at = dtLocal(o.status_changed_at ?? o.updated_at, zone);
      if (inRange(at)) ev.sold.items.push({ date: at.slice(0, 10), at, ...base });
    }
    if (st && st.cat !== 'none' && st.cat !== 'sql' && !(st.cat === 'sold' && status === 'won')) {
      const at = dtLocal(o.stage_changed_at ?? o.updated_at, zone);
      if (inRange(at)) ev[st.cat].items.push({ date: at.slice(0, 10), at, ...base });
    }
  }
  const quoteList = (names: string[], n = 4) => names.slice(0, n).map((x) => `“${x}”`).join(', ') + (names.length > n ? '…' : '');
  ev.sold.how = 'opportunities marked Won, dated by the status change' + (byCat.sold?.length ? ', plus stage ' + quoteList(byCat.sold, 99) : '');
  for (const k of ['booked', 'permitIn', 'permitFin', 'completed', 'paid'] as Cat[]) {
    if (!byCat[k]?.length) continue;
    ev[k].found = true;
    const t = 'opportunities moved into ' + quoteList(byCat[k] as string[]) + ', dated by the stage change';
    ev[k].how = ev[k].how ? ev[k].how + '; ' + t : t;
  }

  // ---- Sales Qualified Leads: tagged as qualified, or whose opportunity moved past the first stage and isn’t lost
  if (ev.lead.found) {
    const minPos: Record<string, number> = {}; const stagePos: Record<string, [number, string, string]> = {};
    for (const p of pipes) for (const st of p.stages) { minPos[p.id] = Math.min(minPos[p.id] ?? Infinity, st.position); stagePos[st.id] = [st.position, p.id, st.name]; }
    const prog: Record<string, boolean> = {};
    for (const o of struct.opps) {
      const cid = o.contact_id || String(o.contact?.id ?? '');
      if (!cid) continue;
      const status = lower(o.status);
      const sp = stagePos[o.stage_id || ''];
      const [pos, pid, sname] = sp ?? [null, o.pipeline_id || '', ''];
      const cat = stageInfo[o.stage_id || '']?.cat ?? 'none';
      const neg = ['lost', 'abandoned'].includes(status) || (sname !== '' && /\blost\b|dead|junk|spam|un.?qualif|dis.?qualif|not.?qualif|non.?qualif|not.?interested|no.?show|cancel|declin|reject|wrong.?number|\bdq\b/.test(lower(sname)));
      const adv = status === 'won' || ['sql', 'booked', 'sold', 'permitIn', 'permitFin', 'completed', 'paid'].includes(cat) || (pos !== null && pos > (minPos[pid] ?? pos));
      prog[cid] = (prog[cid] ?? false) || (adv && !neg);
    }
    ev.sql.items = [];
    for (const it of ev.lead.items) { it.qualified = !!it.tagq || !!prog[it.cid || '']; if (it.qualified) ev.sql.items.push(it); }
    ev.sql.found = true;
    ev.sql.how = 'leads tagged ' + (words.length ? words.map((t) => `“${t}”`).join(' / ') : '(no tags set)') + ', or whose opportunity moved past the first pipeline stage and isn’t lost — counted on the day the lead came in';
  }

  // ---- cash, payments and invoices: Jobber → GHL Payments → GHL Invoices → “Paid” stages
  const stagePaid = ev.paid;
  const notes: string[] = [];
  const method = (s: string | null | undefined) => ucwords(String(s || 'Other').replace(/_/g, ' ').toLowerCase());
  if (jobberOn) {
    const lastPay: Record<string, string> = {};
    const items: Item[] = [];
    for (const r of jPays) {
      const at = dtLocal(r.entry_date, zone);
      if (at && r.invoice_id) lastPay[r.invoice_id] = [lastPay[r.invoice_id] ?? '', at].sort()[1];
      if (!inRange(at)) continue;
      items.push({ date: at.slice(0, 10), at, name: r.client_name || 'Client', amount: Number(r.amount) || 0, method: method(r.method),
        detail: (method(r.method) + (r.invoice_number ? ' · Invoice #' + r.invoice_number : '')).trim(), id: r.id });
    }
    ev.paid = { found: true, how: 'Jobber payment records, dated by payment date', hasAmount: true, items };
    const paidInv: Item[] = [], billed: Item[] = [];
    for (const r of jInvs) {
      const st = lower(r.status); const total = Number(r.total) || 0; const bal = Number(r.balance) || 0;
      const issued = dtLocal(r.issued_date, zone);
      const base = { name: r.client_name || 'Client', id: r.id, number: r.number || '' };
      if (st === 'draft' || st === 'bad_debt') continue;
      if (inRange(issued)) billed.push({ ...base, date: issued.slice(0, 10), at: issued, amount: total, detail: `Invoice #${base.number} · ${st.replace(/_/g, ' ')}` });
      if (bal <= 0.005 && total > 0) {
        const pd = lastPay[r.id];                                   // paid on the date of its final payment
        if (pd && inRange(pd)) paidInv.push({ ...base, date: pd.slice(0, 10), at: pd, amount: total, detail: `Invoice #${base.number} · paid` });
      } else if (bal > 0.005) {
        outstanding.items.push({ ...base, date: issued ? issued.slice(0, 10) : '', at: issued ?? '', due: r.due_date ? String(r.due_date).slice(0, 10) : null, amount: bal, total,
          detail: `Invoice #${base.number}` + (st === 'past_due' ? ' · past due' : '') });
        outstanding.count++; outstanding.value += bal;
      }
    }
    ev.paidInv = { found: true, how: 'Jobber invoices with nothing left to pay, dated by their final payment', hasAmount: true, items: paidInv };
    ev.invoiced = { found: true, how: 'Jobber invoices issued (not drafts), dated by issue date', hasAmount: true, items: billed };
    outstanding.found = true; outstanding.how = 'Jobber invoices with a balance, issued in the last year';
  } else if (synced && S.sources.useTransactions) {
    const items: Item[] = [];
    for (const t of txs) {
      if (!['succeeded', 'success', 'paid', 'completed', 'captured', 'partially_refunded'].includes(lower(t.status || 'succeeded'))) continue;
      const at = dtLocal(t.created_at, zone);
      if (!inRange(at)) continue;
      items.push({ date: at.slice(0, 10), at, name: t.contact_name || 'Customer', amount: Number(t.amount) || 0, method: method(t.method || 'Card'), detail: t.detail || 'Payment', id: t.id });
    }
    if (items.length) ev.paid = { found: true, how: 'GHL Payments › Transactions (successful), dated by payment date', hasAmount: true, items };
    else notes.push('GHL Payments has no successful payments in this time window');
    if (invs.length || S.ghl.token) {
      const billed: Item[] = [], paidInv: Item[] = [], paidAsCash: Item[] = [];
      for (const inv of invs) {
        const st = lower(inv.status);
        if (['draft', 'void', 'voided', 'cancelled', 'canceled'].includes(st)) continue;
        const total = Number(inv.total) || 0;
        let paidAmt = Number(inv.amount_paid) || 0; if (paidAmt <= 0 && st === 'paid') paidAmt = total;
        const due = Math.max(0, inv.amount_due !== null && inv.amount_due !== undefined ? Number(inv.amount_due) : total - paidAmt);
        const name = inv.contact_name || 'Customer';
        const issued = dtLocal(inv.issue_date, zone);
        if (inRange(issued)) billed.push({ date: issued.slice(0, 10), at: issued, name, amount: total, detail: `Invoice ${inv.number || ''} · ${st.replace(/_/g, ' ')}`.trim(), id: inv.id });
        const paidAt = dtLocal(inv.paid_at ?? inv.issue_date, zone);
        if (paidAmt > 0 && inRange(paidAt)) {
          const row: Item = { date: paidAt.slice(0, 10), at: paidAt, name, amount: paidAmt, method: 'Invoice payment', detail: `Invoice ${inv.number || ''}${st === 'partially_paid' ? ' · part paid' : ''}`.trim(), id: inv.id };
          paidAsCash.push(row);
          if (st === 'paid' || due <= 0.005) paidInv.push({ ...row, amount: total });
        }
        if (due > 0.005 && ['sent', 'viewed', 'partially_paid', 'overdue', 'payment_processing', 'unpaid'].includes(st)) {
          outstanding.items.push({ date: issued ? issued.slice(0, 10) : '', at: issued ?? '', due: inv.due_date ? String(inv.due_date).slice(0, 10) : null, name, amount: due, total,
            detail: `Invoice ${inv.number || ''}${st === 'overdue' ? ' · overdue' : ''}`.trim(), id: inv.id });
          outstanding.count++; outstanding.value += due;
        }
      }
      ev.invoiced = { found: true, how: 'GHL Invoices sent (not drafts or voided), dated by issue date', hasAmount: true, items: billed };
      ev.paidInv = { found: true, how: 'GHL Invoices marked paid, dated by payment', hasAmount: true, items: paidInv };
      outstanding.found = true; outstanding.how = 'GHL Invoices sent with a balance due, issued in the last year';
      if (!ev.paid.items.length || ev.paid === stagePaid) {
        if (paidAsCash.length) ev.paid = { found: true, how: 'paid GHL Invoices, dated by payment', hasAmount: true, items: paidAsCash };
        else notes.push('no paid GHL invoices in this time window');
      }
    }
  }
  if (!jobberOn) {
    if (ev.paid === stagePaid && stagePaid.found) ev.paid = { ...stagePaid, how: stagePaid.how + (notes.length ? ' (' + notes.join('; ') + ')' : '') };
    else if (!ev.paid.items.length && !stagePaid.found && notes.length) ev.paid = { found: true, how: 'Jobber isn’t connected; GHL Payments, Invoices and “Paid” stages were checked: ' + notes.join('; '), hasAmount: true, items: [] };
  }
  outstanding.items.sort((a, b) => String(a.due ?? a.date ?? '').localeCompare(String(b.due ?? b.date ?? '')));

  // ---- a contact counts once per metric; each payment / sale / invoice counts on its own
  for (const [k, e] of Object.entries(ev)) {
    if (['paid', 'sold', 'invoiced', 'paidInv'].includes(k)) continue;
    const seen = new Set<string>();
    e.items = e.items.filter((it) => { const key = it.cid || it.id || it.name + it.date; if (seen.has(key)) return false; seen.add(key); return true; });
  }
  if (!synced && S.ghl.token) warnings.push('The first sync from GoHighLevel hasn’t finished yet. An admin can start it in Admin › Overview › Sync now.');
  if (jobberOn && !jPays.length && !jInvs.length) warnings.push('Jobber is connected but its payments and invoices haven’t been synced yet. They appear after the next sync (Admin › Overview › Sync now).');
  return {
    meta: { first, last, generatedAt: sync?.finished_at ?? null, location: S.ghl.locationName || S.ghl.locationId, warnings, permitNow, outstanding, synced },
    events: ev,
  };
}

// ---------------------------------------------------------------- pipeline board
export interface BoardOpp { id: string; name: string; title: string; stage: string; status: string; value: number; source: string; phone: string; email: string; created: string | null; moved: string | null; statusAt: string | null }
export interface BoardPipe extends PipeX { opps: BoardOpp[] }
export async function buildBoard(S: Settings, zone: string): Promise<{ pipelines: BoardPipe[]; skippedPipelines: number; generatedAt: string | null; location: string; synced: boolean }> {
  const [struct, sync] = await Promise.all([loadStructure(), lastSync().catch(() => null)]);
  const byPipe: Record<string, BoardOpp[]> = {};
  for (const o of struct.opps) {
    const c = o.contact || {};
    (byPipe[o.pipeline_id || ''] ??= []).push({
      id: o.id, name: contactName({ ...c, name: c.name ?? o.name ?? '' }), title: o.name || '', stage: o.stage_id || '', status: lower(o.status || 'open'),
      value: Number(o.value) || 0, source: o.source || '', phone: String(c.phone ?? ''), email: String(c.email ?? ''),
      created: dtLocal(o.created_at, zone), moved: dtLocal(o.stage_changed_at ?? o.updated_at ?? o.created_at, zone), statusAt: dtLocal(o.status_changed_at ?? o.updated_at, zone),
    });
  }
  return { pipelines: struct.pipelines.map((p) => ({ ...p, opps: byPipe[p.id] ?? [] })), skippedPipelines: struct.skippedPipelines,
    generatedAt: sync?.finished_at ?? null, location: S.ghl.locationName || S.ghl.locationId, synced: !!sync };
}

/** Numbers for one pipeline and one reporting period. status: open | all | won | lost */
export function boardView(p: BoardPipe, P: Period, status: string) {
  const inR = (d: string | null, a: string, b: string) => d !== null && d >= a && d <= b;
  const match = (o: BoardOpp) => status === 'all' || o.status === status;
  const stages = p.stages.map((st, index) => {
    const now = p.opps.filter((o) => o.stage === st.id && match(o)).sort((a, b) => String(b.moved).localeCompare(String(a.moved)));
    const entered = now.filter((o) => inR(o.moved, P.from, P.to));
    const enteredPrev = now.filter((o) => inR(o.moved, P.prevFrom, P.prevTo)).length;
    const byDay = P.buckets.map((bk) => entered.filter((o) => inR(o.moved, bk.start, bk.end)).length);
    return { ...st, index, now, count: now.length, value: now.reduce((s, o) => s + o.value, 0), entered, enteredPrev, byDay };
  });
  const all = p.opps; const open = all.filter((o) => o.status === 'open');
  const cnt = (field: 'created' | 'statusAt', st: string | null, a: string, b: string): [number, number] => {
    const l = all.filter((o) => (st === null || o.status === st) && inR(o[field], a, b)); return [l.length, l.reduce((s, o) => s + o.value, 0)];
  };
  const [created] = cnt('created', null, P.from, P.to); const [createdPrev] = cnt('created', null, P.prevFrom, P.prevTo);
  const [won, wonValue] = cnt('statusAt', 'won', P.from, P.to); const [wonPrev, wonPrevValue] = cnt('statusAt', 'won', P.prevFrom, P.prevTo);
  const [lost] = cnt('statusAt', 'lost', P.from, P.to); const [lostPrev] = cnt('statusAt', 'lost', P.prevFrom, P.prevTo);
  return { stages, openCount: open.length, openValue: open.reduce((s, o) => s + o.value, 0), created, createdPrev, won, wonValue, wonPrev, wonPrevValue, lost, lostPrev,
    createdTrend: P.trend.map((t) => cnt('created', null, t.start, t.end)[0]), wonTrend: P.trend.map((t) => cnt('statusAt', 'won', t.start, t.end)[0]), total: all.length };
}
