/** Pipeline board (port of pipelines.php): every pipeline and stage with opportunities, for the chosen period. */
import type { Period } from '../lib/period.js';
import { periodToolbar, periodQuery, qs } from '../lib/period.js';
import type { BoardPipe, BoardOpp, boardView } from '../lib/data.js';
import { changeHtml } from '../lib/report.js';
import { CAT_LABELS } from '../lib/classify.js';
import { e, money, num, ymdObj } from '../lib/util.js';
import { daysSince } from './common.js';

export const STATUSES: Record<string, string> = { open: 'Open', won: 'Won', lost: 'Lost', all: 'All' };
const PALETTE = ['#3a7bd5', '#00a3b4', '#2e8b57', '#7cb342', '#c99a06', '#e8850c', '#e3193b', '#c2185b', '#6c47c1', '#5d6d7e'];
const stageColor = (i: number, n: number) => PALETTE[n <= 1 ? 0 : Math.round(i * (PALETTE.length - 1) / Math.max(1, n - 1))];
const ucfirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
function moved(o: BoardOpp): string {
  if (!o.moved) return '';
  const d = ymdObj(o.moved.slice(0, 10));
  const [h, m] = o.moved.slice(11, 16).split(':').map(Number);
  return `${d.toFormat('ccc', { locale: 'en-US' })} ${d.toFormat('MM/dd')} ${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
function stagePeople(now: BoardOpp[], P: Period): string {
  const LIMIT = 15, MAX = 400;
  const row = (o: BoardOpp) => {
    const md = o.moved ? o.moved.slice(0, 10) : null;
    const days = md ? daysSince(md, P.today) : null;
    const sub = [o.source, o.phone].filter(Boolean);
    const isNew = !!o.moved && o.moved >= P.from && o.moved <= P.to;
    const st = o.status !== 'open' ? `<span class="tag ${o.status === 'won' ? '' : 'lost'}">${e(ucfirst(o.status))}</span>` : '';
    return `<li><div><span class="nm">${e(o.name)}</span>${isNew ? '<span class="tag new">Moved in this period</span>' : ''}${st}${sub.length ? `<span class="sub">${e(sub.join(' · '))}</span>` : ''}</div>`
      + `<div class="when">${o.value ? `<span class="amt">${money(o.value)}</span>` : ''}${md ? e(moved(o)) + (days !== null ? ' · ' + (days === 0 ? 'today' : days + 'd in stage') : '') : ''}</div></li>`;
  };
  const n = now.length;
  if (!n) return '<ul class="clist"><li class="empty-li">No leads in this stage</li></ul>';
  let h = `<ul class="clist">${now.slice(0, LIMIT).map(row).join('')}</ul>`;
  if (n > LIMIT) h += `<details class="more-list"><summary>Show all ${n}</summary><ul class="clist">${now.slice(LIMIT, MAX).map(row).join('')}${n > MAX ? `<li class="empty-li">… and ${n - MAX} more in GoHighLevel</li>` : ''}</ul></details>`;
  return h;
}

export function boardBody(pipes: BoardPipe[], Pp: BoardPipe, V: ReturnType<typeof boardView>, PER: Period, status: string, right: string, customFlag: boolean, warnings: string[]): string {
  const pLabel = PER.key === 'custom' ? 'Selected period' : PER.label;
  const inPeriod = PER.key === 'custom' ? 'this period' : PER.label.toLowerCase();
  const link = (over: Record<string, string | null>) => '/pipelines' + qs({ p: Pp.id, status: status === 'open' ? null : status, ...periodQuery(PER), ...over });
  let h = '';
  if (warnings.length) h += `<div class="banner error">${warnings.map(e).join('<br>')}</div>`;
  if (pipes.length > 1) {
    h += '<nav class="pipe-tabs" aria-label="Pipelines">' + pipes.map((p) => `<a href="${e(link({ p: p.id }))}"${p.id === Pp.id ? ' aria-current="page"' : ''}>${e(p.name)} <span>${p.opps.filter((o) => o.status === 'open').length}</span></a>`).join('') + '</nav>';
  }
  let seg = '<div class="seg" role="group" aria-label="Opportunity status">';
  for (const [k, l] of Object.entries(STATUSES)) seg += `<a class="segbtn" href="${e(link({ status: k === 'open' ? null : k }))}" aria-pressed="${k === status ? 'true' : 'false'}">${e(l)}</a>`;
  seg += '</div>';
  h += periodToolbar(PER, '/pipelines', { p: Pp.id, status: status === 'open' ? null : status }, seg + right, customFlag);
  h += '<section class="kpis">'
    + `<article class="kpi"><h3>Open opportunities</h3><div class="val">${num(V.openCount)}</div><div class="sub">Right now</div><div class="chg">&nbsp;</div></article>`
    + `<article class="kpi"><h3>Open value</h3><div class="val">${money(V.openValue)}</div><div class="sub">Right now</div><div class="chg">&nbsp;</div></article>`
    + `<article class="kpi"><h3>New leads</h3><div class="val">${num(V.created)}</div><div class="sub">${e(pLabel)}</div><div>${changeHtml(V.created, V.createdPrev, PER.compareShort)}</div></article>`
    + `<article class="kpi"><h3>Won</h3><div class="val">${num(V.won)}</div><div class="sub">${e(pLabel)}</div><div>${changeHtml(V.won, V.wonPrev, PER.compareShort)}</div></article>`
    + `<article class="kpi"><h3>Won value</h3><div class="val">${money(V.wonValue)}</div><div class="sub">${e(pLabel)}</div><div>${changeHtml(V.wonValue, V.wonPrevValue, PER.compareShort)}</div></article>`
    + `<article class="kpi"><h3>Lost</h3><div class="val">${num(V.lost)}</div><div class="sub">${e(pLabel)}</div><div>${V.lostPrev || V.lost ? `<span class="chg">${e(ucfirst(PER.compareShort))}: ${V.lostPrev}</span>` : '<span class="chg">&nbsp;</span>'}</div></article>`
    + '</section>';
  const n = V.stages.length;
  const colors = V.stages.map((st) => stageColor(st.index, n));
  const names = V.stages.map((st) => st.name);
  const chartStages = { type: 'bar', horizontal: true, labels: names, datasets: [{ label: STATUSES[status] + ' leads in stage', data: V.stages.map((s) => s.count), colors }] };
  const chartMoves = { type: 'bar', labels: names, datasets: [{ label: pLabel, data: V.stages.map((s) => s.entered.length), color: '#3a7bd5' }, { label: ucfirst(PER.compare), data: V.stages.map((s) => s.enteredPrev), color: '#b9cdee' }] };
  const chartTrend = { type: 'line', labels: PER.trend.map((t) => t.label), datasets: [{ label: 'New leads', data: V.createdTrend, color: '#e3193b' }, { label: 'Won', data: V.wonTrend, color: '#2e8b57', dash: true }] };
  const hgt = Math.max(220, 34 * n + 60);
  h += '<section class="charts board-charts">'
    + `<div class="box"><h2>${e(Pp.name)} by stage <small>${e(STATUSES[status].toLowerCase())} opportunities now</small></h2><div class="chart-wrap" style="height:${hgt}px"><canvas data-gchart="${e(JSON.stringify(chartStages))}" role="img" aria-label="Opportunities by stage"></canvas></div></div>`
    + `<div class="box"><h2>Moved into each stage <small>${e(inPeriod)} vs ${e(PER.compare)}</small></h2><div class="chart-wrap" style="height:${hgt}px"><canvas data-gchart="${e(JSON.stringify(chartMoves))}" role="img" aria-label="Opportunities moved into each stage"></canvas></div></div>`
    + `<div class="box wide"><h2>New leads and wins <small>last ${PER.trend.length} periods of this length, ${e(Pp.name)}</small></h2><div class="chart-wrap short"><canvas data-gchart="${e(JSON.stringify(chartTrend))}" role="img" aria-label="New leads and wins per period"></canvas></div></div>`
    + '</section>';
  h += `<h2 class="sec-title">${e(Pp.name)} stages <small>${n} stage${n === 1 ? '' : 's'} with opportunities${Pp.emptyStages ? ` (${Pp.emptyStages} empty not shown)` : ''} · ${num(V.total)} opportunities · showing ${e(STATUSES[status].toLowerCase())}</small></h2>`;
  h += '<div class="acc-tools"><button class="linkbtn" type="button" data-acc="open">Open all</button><button class="linkbtn" type="button" data-acc="close">Close all</button></div>';
  for (const st of V.stages) {
    const c = stageColor(st.index, n), ent = st.entered.length;
    const byDay = { type: 'bar', labels: PER.buckets.map((b) => b.label), datasets: [{ label: 'Moved into ' + st.name, data: st.byDay, color: c }] };
    h += `<details class="acc stage" data-cat="${e(Pp.id + ':' + st.id)}" style="--c:${e(c)}"><summary><span class="label"><span class="stage-no">${st.index + 1}</span>${e(st.name)}</span><span class="sum">`
      + `<span class="m"><small>In stage</small><b>${num(st.count)}</b><span class="chg">${money(st.value)}</span></span>`
      + `<span class="m"><small>Moved in · ${e(pLabel)}</small><b>${num(ent)}</b>${changeHtml(ent, st.enteredPrev, PER.compareShort)}</span>`
      + (st.cat !== 'none' ? `<span class="m"><small>Scorecard</small><span class="catpill">${e(CAT_LABELS[st.cat])}</span></span>` : '')
      + '</span><span class="chev"></span></summary><div class="acc-body"><div class="charts-col">'
      + `<h4>Moved in by ${e(PER.unit)} <small>${e(PER.short)}</small></h4><div class="chart-wrap short"><canvas data-gchart="${e(JSON.stringify(byDay))}" role="img" aria-label="Moved into ${e(st.name)} by ${e(PER.unit)}"></canvas></div>`
      + `<h4 style="margin-top:18px">Moved in · ${e(pLabel)} <small>${ent}</small></h4>`
      + (ent ? `<ul class="clist">${st.entered.slice(0, 10).map((o) => `<li><div><span class="nm">${e(o.name)}</span>${o.source ? `<span class="sub">${e(o.source)}</span>` : ''}</div><div class="when">${o.value ? `<span class="amt">${money(o.value)}</span>` : ''}${e(moved(o))}</div></li>`).join('')}</ul>`
        + (ent > 10 ? `<p class="meta" style="margin:6px 0 0">+ ${ent - 10} more — all are in the list on the right.</p>` : '') : `<ul class="clist"><li class="empty-li">Nobody moved into this stage in ${e(inPeriod)}</li></ul>`)
      + `</div><div class="contacts"><h4>Leads in this stage now <small>${num(st.count)} · ${money(st.value)}</small></h4>${stagePeople(st.now, PER)}</div></div></details>`;
  }
  h += '<p class="board-note">Pipelines and stages are selected automatically from your GoHighLevel opportunities: only pipelines and stages that hold opportunities are shown, in GHL’s order. “Moved in” uses each opportunity’s last stage change, and the status filter (Open / Won / Lost / All) applies to the counts and lists. Changes in GHL show up after the next sync.</p>';
  return h;
}
