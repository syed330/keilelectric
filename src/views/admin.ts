/** Admin panel views (Vuexy layout; the bundled stand-in theme unless USE_VUEXY=1). Port of admin/index.php. */
import type { Settings } from '../lib/settings.js';
import { PRESETS } from '../lib/period.js';
import type { Scorecard } from '../lib/report.js';
import type { Structure } from '../lib/data.js';
import { CAT_LABELS } from '../lib/classify.js';
import { AD_CHANNELS, adsConfigured, channelOf, type Channel } from '../lib/ads.js';
import { jobberConnected, jobberCallbackUrl } from '../lib/jobber.js';
import { e, money, num, ymdObj, daysBetween } from '../lib/util.js';
import { logoImg } from './common.js';
import { DateTime } from 'luxon';

export const PAGES: Record<string, [string, string, string]> = {
  overview: ['Overview', 'Numbers from your GoHighLevel sub-account, and the sync status', 'smart-home'],
  connection: ['GHL connection', 'The GoHighLevel sub-account the report reads', 'plug'],
  pipelines: ['Detected pipelines', 'Pipelines and stages selected automatically from your opportunities', 'adjustments-horizontal'],
  display: ['Display', 'Names, week settings and how leads are qualified', 'layout-dashboard'],
  ads: ['Ad spend', 'Google Ads and Meta Ads spend by source channel', 'currency-dollar'],
  jobber: ['Jobber', 'Payments and invoices from Jobber', 'cash'],
  sheets: ['Google Sheets', 'Live reporting in a Google Sheet, with CAC & ROI', 'file-text'],
  access: ['Access', 'Who can see the report and the admin panel', 'lock'],
  system: ['System check', 'Netlify settings, Supabase, sync health and errors', 'list-details'],
};

export function alertBox(html: string, kind = 'warning'): string {
  return `<div class="alert alert-${kind} d-flex gap-2 align-items-start" role="alert"><i class="kicon kicon-sm kicon-${kind === 'success' ? 'check' : 'alert-triangle'} mt-1"></i><div>${html}</div></div>`;
}
function statusCard(icon: string, color: string, label: string, value: string, note: string, href?: string, action = ''): string {
  return `<div class="col-sm-6 col-xl-3"><div class="card status-card h-100"><div class="card-body"><div class="d-flex justify-content-between align-items-start"><span class="text-heading">${e(label)}</span>`
    + `<div class="avatar"><span class="avatar-initial rounded bg-label-${color}"><i class="kicon kicon-${icon}"></i></span></div></div><h4>${value}</h4><small class="text-body-secondary">${note}</small>`
    + (href ? `<a class="btn btn-sm btn-label-primary align-self-start mt-auto" href="${e(href)}">${e(action)}</a>` : '') + '</div></div></div>';
}
const vuexy = () => process.env.USE_VUEXY === '1';
function head(title: string, gate: boolean): string {
  const v = vuexy();
  return '<!doctype html><html lang="en" class="' + (gate ? 'layout-wide customizer-hide' : 'layout-navbar-fixed layout-menu-fixed layout-compact') + '" dir="ltr" data-skin="default" data-bs-theme="light" data-assets-path="/vendor/vuexy/" data-template="vertical-menu-template"><head>'
    + `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="robots" content="noindex, nofollow"><title>${e(title)}</title>`
    + '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@300;400;500;600;700&display=swap">'
    + (v ? '<link rel="stylesheet" href="/vendor/vuexy/vendor/libs/node-waves/node-waves.css"><link rel="stylesheet" href="/vendor/vuexy/vendor/css/core.css"><link rel="stylesheet" href="/vendor/vuexy/css/demo.css"><link rel="stylesheet" href="/vendor/vuexy/vendor/libs/perfect-scrollbar/perfect-scrollbar.css">'
      + (gate ? '<link rel="stylesheet" href="/vendor/vuexy/vendor/css/pages/page-auth.css">' : '') + '<script src="/vendor/vuexy/vendor/js/helpers.js"></script><script src="/vendor/vuexy/js/config.js"></script>'
      : '<link rel="stylesheet" href="/assets/vendor/bootstrap/bootstrap.min.css"><link rel="stylesheet" href="/assets/css/vuexy-lite.css">')
    + '<link rel="stylesheet" href="/assets/css/icons.css"><link rel="stylesheet" href="/assets/css/admin-app.css"></head><body>';
}
function foot(): string {
  return (vuexy()
    ? '<script src="/vendor/vuexy/vendor/libs/jquery/jquery.js"></script><script src="/vendor/vuexy/vendor/libs/popper/popper.js"></script><script src="/vendor/vuexy/vendor/js/bootstrap.js"></script><script src="/vendor/vuexy/vendor/libs/node-waves/node-waves.js"></script><script src="/vendor/vuexy/vendor/libs/perfect-scrollbar/perfect-scrollbar.js"></script><script src="/vendor/vuexy/vendor/libs/hammer/hammer.js"></script><script src="/vendor/vuexy/vendor/js/menu.js"></script><script src="/vendor/vuexy/js/main.js"></script>'
    : '<script src="/assets/vendor/bootstrap/bootstrap.bundle.min.js"></script><script src="/assets/js/layout-lite.js"></script>') + '</body></html>';
}

/** Sign-in / first-time setup page. */
export function gatePage(S: Settings, csrf: string, page: string, flashes: [string, string][], error: string | null): string {
  const first = !S.adminHash; const company = S.display.company || 'Keil Electric';
  return head(first ? 'Create admin password' : 'Admin sign in', true)
    + `<div class="container-xxl"><div class="authentication-wrapper authentication-basic container-p-y"><div class="authentication-inner py-6"><div class="card"><div class="card-body">`
    + `<div class="app-brand justify-content-center mb-6 px-0"><span class="app-brand-link admin-logo admin-logo-lg">${logoImg(S)}</span></div>`
    + `<h4 class="mb-1">${first ? 'Create the admin password' : 'Admin sign in'}</h4><p class="mb-6">${first ? 'First time here. Choose a password (8+ characters) to protect the admin panel.' : 'Enter the admin password.'}</p>`
    + flashes.map(([k, m]) => alertBox(e(m), k)).join('')
    + `<form method="post" action="/admin?page=${e(page)}">${csrf}<input type="hidden" name="do" value="${first ? 'setup' : 'login'}">`
    + `<label class="form-label" for="pw">Password</label><input type="password" class="form-control mb-3" id="pw" name="password" autocomplete="${first ? 'new-password' : 'current-password'}" required autofocus>`
    + (first ? '<label class="form-label" for="pw2">Repeat password</label><input type="password" class="form-control mb-3" id="pw2" name="password2" autocomplete="new-password" required>' : '')
    + (error ? `<div class="text-danger small mb-3" role="alert">${e(error)}</div>` : '')
    + `<button class="btn btn-primary d-grid w-100">${first ? 'Create password' : 'Sign in'}</button></form><p class="text-center mb-0 mt-4"><a href="/">View the report</a></p></div></div></div></div></div>` + foot();
}

/** The admin frame around a page body. */
export function adminFrame(S: Settings, page: string, csrf: string, flashes: [string, string][], badge: [string, string], body: string): string {
  const company = S.display.company || 'Keil Electric';
  let menu = '<li class="menu-header small"><span class="menu-header-text">Setup</span></li>';
  for (const [key, [label, , icon]] of Object.entries(PAGES)) menu += `<li class="menu-item${key === page ? ' active' : ''}"><a href="/admin?page=${key}" class="menu-link"><i class="menu-icon kicon kicon-${icon}"></i><div>${e(label)}</div></a></li>`;
  menu += '<li class="menu-header small"><span class="menu-header-text">Report</span></li>'
    + '<li class="menu-item"><a href="/" target="_blank" rel="noopener" class="menu-link"><i class="menu-icon kicon kicon-chart-bar"></i><div>Pipeline scorecard</div><i class="kicon kicon-xs kicon-external-link ext"></i></a></li>'
    + '<li class="menu-item"><a href="/pipelines" target="_blank" rel="noopener" class="menu-link"><i class="menu-icon kicon kicon-list-details"></i><div>Pipeline board</div><i class="kicon kicon-xs kicon-external-link ext"></i></a></li>';
  return head(PAGES[page][0] + ' – Admin', false)
    + '<div class="layout-wrapper layout-content-navbar"><div class="layout-container"><aside id="layout-menu" class="layout-menu menu-vertical menu bg-menu-theme"><div class="app-brand demo">'
    + `<a href="/admin" class="app-brand-link admin-logo" aria-label="${e(company)} admin">${logoImg(S)}</a>`
    + '<a href="javascript:void(0);" class="layout-menu-toggle menu-link text-large ms-auto d-xl-none" aria-label="Close menu"><i class="kicon kicon-x"></i></a></div><div class="menu-inner-shadow"></div>'
    + `<ul class="menu-inner py-1">${menu}</ul></aside><div class="layout-page">`
    + '<nav class="layout-navbar container-xxl navbar-detached navbar navbar-expand-xl align-items-center bg-navbar-theme" id="layout-navbar"><div class="layout-menu-toggle navbar-nav align-items-xl-center me-3 me-xl-0 d-xl-none"><a class="nav-item nav-link px-0 me-xl-6" href="javascript:void(0)" aria-label="Open menu"><i class="kicon kicon-menu-2"></i></a></div>'
    + `<div class="navbar-nav-right d-flex align-items-center justify-content-end w-100"><div class="navbar-title d-flex flex-column me-3"><h5 class="mb-0">${e(PAGES[page][0])}</h5><small class="text-body-secondary">${e(PAGES[page][1])}</small></div>`
    + `<ul class="navbar-nav flex-row align-items-center ms-auto gap-3"><li class="nav-item"><span class="badge bg-label-${badge[0]}">${e(badge[1])}</span></li>`
    + '<li class="nav-item"><a class="btn btn-primary" href="/" target="_blank" rel="noopener"><i class="kicon kicon-sm kicon-chart-bar"></i><span class="d-none d-sm-inline">Open report</span></a></li>'
    + `<li class="nav-item"><form method="post" action="/admin" class="m-0">${csrf}<input type="hidden" name="do" value="logout"><button class="btn btn-outline-secondary"><i class="kicon kicon-sm kicon-logout"></i><span class="d-none d-md-inline">Sign out</span></button></form></li></ul></div></nav>`
    + '<div class="content-wrapper"><div class="container-xxl flex-grow-1 container-p-y">' + flashes.map(([k, m]) => alertBox(e(m), k)).join('') + body + '</div>'
    + `<footer class="content-footer footer bg-footer-theme"><div class="container-xxl"><div class="footer-container d-flex align-items-center justify-content-between py-4 flex-md-row flex-column gap-2"><div class="text-body">© ${new Date().getFullYear()} ${e(company)} pipeline scorecard</div><div><a href="/" target="_blank" class="footer-link">Open report</a></div></div></div></footer>`
    + '<div class="content-backdrop fade"></div></div></div></div><div class="layout-overlay layout-menu-toggle"></div><div class="drag-target"></div></div>' + foot();
}

// ---------------------------------------------------------------- pages
export interface SyncRow { id: number; started_at: string; finished_at: string | null; status: string; trigger: string; counts: Record<string, unknown>; messages: string[]; duration_ms: number | null }
const statusBadge = (s: string) => `<span class="badge bg-label-${s === 'ok' ? 'success' : s === 'partial' ? 'warning' : s === 'running' ? 'info' : 'danger'}">${e({ ok: 'OK', partial: 'Partial', running: 'Running', error: 'Error' }[s] ?? s)}</span>`;
function when(iso: string | null, zone: string): string { return iso ? DateTime.fromISO(iso).setZone(zone).toFormat('LLL d, h:mm a', { locale: 'en-US' }) : '—'; }

export function overviewPage(S: Settings, csrf: string, R: Scorecard | null, reportError: string | null, syncs: SyncRow[], zone: string): string {
  const connected = !!(S.ghl.token && S.ghl.locationId);
  const E = R?.events;
  const found = R ? R.cats.filter((c) => c.events.some((k) => E![k].found)).length : 0;
  const latest = E && E.lead.found ? E.lead.week[0] : null;
  const last = syncs.find((x) => x.status !== 'running');
  const running = syncs.find((x) => x.status === 'running');
  let h = '<div class="row g-6 mb-6">'
    + statusCard('plug', !connected ? 'warning' : reportError ? 'danger' : 'success', 'GoHighLevel', !connected ? 'Not connected' : reportError ? 'Can’t read' : 'Connected', !connected ? 'Add the Location ID and token' : e(reportError ? reportError.split('.')[0] : (S.ghl.locationName || S.ghl.locationId)), '/admin?page=connection', connected ? 'Manage' : 'Connect')
    + statusCard('refresh', running ? 'info' : !last ? 'warning' : last.status === 'ok' ? 'success' : last.status === 'partial' ? 'warning' : 'danger', 'Last sync', running ? 'Running…' : last ? e(when(last.finished_at, zone)) : 'Never', running ? 'Started ' + e(when(running.started_at, zone)) : last ? `${statusBadge(last.status)} · every ${S.sources.syncMinutes || 15} min` : 'Run the first sync below')
    + statusCard('users', 'info', 'Leads · ' + (R ? R.P.label : 'last week'), E && E.lead.found ? num(E.lead.week.length) : '—', R ? e(R.P.short) + (E!.lead.found ? ' · ' + e(R.P.compareShort) + ' ' + E!.lead.prev.length : '') : '—')
    + statusCard('calendar', 'success', 'Latest lead', latest ? e(latest.name) : '—', latest ? e(ymdObj(latest.date).toFormat('ccc MM/dd', { locale: 'en-US' }) + (latest.detail ? ' · ' + latest.detail : '')) : 'None in this period')
    + '</div>';
  // sync panel
  h += '<div class="card mb-6"><div class="card-header d-flex justify-content-between align-items-start flex-wrap gap-3"><div><h5 class="card-title">Sync from GoHighLevel</h5>'
    + `<p class="card-subtitle mb-0">The report reads a copy of your data in Supabase, refreshed automatically every ${S.sources.syncMinutes || 15} minutes. Run a sync now after changing connections.</p></div>`
    + (connected ? `<div class="d-flex gap-2"><form method="post" action="/admin?page=overview" class="m-0">${csrf}<input type="hidden" name="do" value="sync"><button class="btn btn-primary btn-sm"${running ? ' disabled' : ''}><i class="kicon kicon-sm kicon-refresh"></i>${running ? 'Sync running…' : 'Sync now'}</button></form>`
      + `<form method="post" action="/admin?page=overview" class="m-0">${csrf}<input type="hidden" name="do" value="sync"><input type="hidden" name="full" value="1"><button class="btn btn-outline-secondary btn-sm"${running ? ' disabled' : ''}>Full re-sync</button></form></div>` : '')
    + '</div>';
  if (syncs.length) {
    h += '<div class="table-responsive"><table class="table mb-0"><thead><tr><th>Started</th><th>Status</th><th>How</th><th class="text-end">Took</th><th>Copied</th></tr></thead><tbody>';
    for (const x of syncs.slice(0, 6)) {
      const c = x.counts || {};
      const copied = ['opportunities', 'contacts', 'invoices', 'transactions', 'jobberPayments', 'jobberInvoices'].filter((k) => c[k] !== undefined).map((k) => `${num(c[k])} ${k.replace(/([A-Z])/g, ' $1').toLowerCase()}`).join(', ');
      h += `<tr><td>${e(when(x.started_at, zone))}</td><td>${statusBadge(x.status)}</td><td class="text-body-secondary">${e(x.trigger)}${c.contactsMode === 'full' ? ' · full' : ''}</td><td class="text-end">${x.duration_ms !== null ? (x.duration_ms / 1000).toFixed(1) + ' s' : '—'}</td>`
        + `<td class="text-body-secondary" style="white-space:normal;min-width:260px">${e(copied || '—')}${x.messages?.length ? `<div class="small text-warning mt-1">${x.messages.slice(0, 3).map(e).join('<br>')}</div>` : ''}</td></tr>`;
    }
    h += '</tbody></table></div>';
  } else h += `<div class="card-body">${connected ? alertBox('No sync has run yet. Click <strong>Sync now</strong> — the first one copies about a year of contacts and can take a few minutes for large accounts.') : alertBox('Connect GoHighLevel first under <a href="/admin?page=connection">GHL connection</a>.')}</div>`;
  h += '</div>';
  // category table
  h += `<div class="card"><div class="card-header"><h5 class="card-title">${e(R ? R.P.label : 'Last week')} by scorecard category</h5><p class="card-subtitle mb-0">${R ? e(R.P.short) : ''}</p></div><div class="card-body">`;
  if (!connected) h += alertBox('Connect your GoHighLevel sub-account under <a href="/admin?page=connection">GHL connection</a> to see numbers.');
  else if (reportError) h += alertBox(e(reportError), 'danger');
  else if (R) {
    if (R.meta.warnings.length) h += alertBox(R.meta.warnings.map(e).join('<br>'));
    h += `<div class="table-responsive"><table class="table week-table mb-0"><thead><tr><th>Category</th><th>Metric</th><th class="text-end">${e(R.P.label)}</th><th class="text-end">${e(R.P.compareShort.charAt(0).toUpperCase() + R.P.compareShort.slice(1))}</th><th>Contacts</th></tr></thead><tbody>`;
    const pn = R.meta.permitNow;
    const names = (items: { name: string }[]) => items.length ? e(items.slice(0, 4).map((x) => x.name).join(', ')) + (items.length > 4 ? ` and ${items.length - 4} more` : '') : '—';
    for (const c of R.cats) {
      const extra = c.key === 'permitting' && E!.permitIn.found;
      const badge = (rows: number) => `<td rowspan="${rows}"><span class="badge" style="background:${e(c.color)};color:#fff">${e(c.label)}</span></td>`;
      if (extra) h += `<tr>${badge(c.events.length + 1)}<td class="text-heading">In process now</td><td class="text-end fw-semibold text-heading">${num(pn.count)}${pn.value ? ` <small class="text-body-secondary">(${money(pn.value)})</small>` : ''}</td><td class="text-end text-body-secondary">right now</td><td class="text-body-secondary" style="white-space:normal;min-width:260px">${names(pn.items)}</td></tr>`;
      c.events.forEach((k, i) => {
        const ev = E![k]; const amt = ['sold', 'completed', 'paid', 'invoiced', 'paidInv'].includes(k) && ev.hasAmount; const n = ev.week.length;
        h += '<tr>' + (i === 0 && !extra ? badge(c.events.length) : '') + `<td class="text-heading">${e(ev.label)}</td>`
          + `<td class="text-end fw-semibold text-heading">${!ev.found ? '<span class="text-body-secondary fw-normal">no source</span>' : amt ? money(ev.sum) + ` <small class="text-body-secondary">(${n})</small>` : n}</td>`
          + `<td class="text-end">${!ev.found ? '' : amt ? money(ev.prevSum) : ev.prev.length}</td><td class="text-body-secondary" style="white-space:normal;min-width:260px">${!ev.found ? '' : names(ev.week)}</td></tr>`;
      });
    }
    h += '</tbody></table></div>';
  }
  h += `</div></div><p class="text-body-secondary small mt-3">Categories with data: ${found} of ${R ? R.cats.length : 7}.</p>`;
  return h;
}

export function connectionPage(S: Settings, csrf: string, typedLoc: string | null): string {
  const g = S.ghl; const connected = !!(g.token && g.locationId); const hint = g.token ? '••••' + g.token.slice(-4) : '';
  return '<div class="card mb-6"><div class="card-body">'
    + (connected ? `<div class="d-flex flex-wrap gap-4 align-items-center"><div class="avatar avatar-lg"><span class="avatar-initial rounded bg-label-success"><i class="kicon kicon-plug"></i></span></div><div class="me-auto"><h5 class="mb-1">${e(g.locationName || g.locationId)}</h5><span class="badge bg-label-success">Connected</span>`
      + `<small class="text-body-secondary ms-2">Location ${e(g.locationId)} · token ${e(hint)}${g.connectedAt ? ' · since ' + e(DateTime.fromISO(g.connectedAt).toFormat('LLL d, yyyy', { locale: 'en-US' })) : ''}</small></div>`
      + `<form method="post" action="/admin?page=connection" class="m-0" onsubmit="return confirm('Disconnect GoHighLevel? The saved token is deleted and syncing stops.')">${csrf}<input type="hidden" name="do" value="disconnect"><button class="btn btn-label-danger">Disconnect</button></form></div>`
      : '<div class="d-flex flex-wrap gap-4 align-items-center"><div class="avatar avatar-lg"><span class="avatar-initial rounded bg-label-warning"><i class="kicon kicon-plug"></i></span></div><div><h5 class="mb-1">Not connected</h5><small class="text-body-secondary">Enter the sub-account’s Location ID and a Private Integration token below.</small></div></div>')
    + '</div></div>'
    + `<form class="card mb-6" method="post" action="/admin?page=connection">${csrf}<input type="hidden" name="do" value="connect"><div class="card-header"><h5 class="card-title">Sub-account and token</h5><p class="card-subtitle mb-0">The token is stored in your Supabase database (server-side only). Browsers never see it.</p></div>`
    + `<div class="card-body"><div class="row g-4"><div class="col-lg-5"><label class="form-label" for="locId">Location ID</label><input class="form-control" id="locId" name="locationId" value="${e(typedLoc ?? g.locationId)}" placeholder="e.g. ve9EPM428h8vShlRW1KT" autocomplete="off" spellcheck="false" required><div class="form-text">In the sub-account: Settings › Business Profile › Location ID.</div></div>`
    + `<div class="col-lg-7"><label class="form-label" for="token">Private Integration token</label><input class="form-control" id="token" name="token" type="password" placeholder="${e(hint ? `Saved (${hint}) — paste a new one to replace it` : 'pit-…')}" autocomplete="off" spellcheck="false"${hint ? '' : ' required'}><div class="form-text">Settings › Private Integrations › Create new integration.</div></div>`
    + '</div><button class="btn btn-primary mt-4">Connect and test</button></div></form>'
    + '<div class="card"><div class="card-header"><h5 class="card-title">How to create the token</h5></div><div class="card-body"><ol class="mb-0 ps-4" style="line-height:1.9">'
    + '<li>In GoHighLevel, open the <strong>sub-account</strong> (not the agency view).</li><li>Go to <strong>Settings › Private Integrations › Create new integration</strong>, name it “Pipeline Scorecard”.</li>'
    + '<li>Give it these <strong>read-only</strong> scopes: <code>View Contacts</code>, <code>View Opportunities</code>, <code>View Locations</code> and, for Cash, <code>View Payment Transactions</code> and <code>View Invoices</code>.</li>'
    + '<li>Copy the token (it’s shown once), paste it above with the Location ID, and click <strong>Connect and test</strong>. The first sync starts automatically.</li></ol></div></div>';
}

export function pipelinesPage(S: Settings, struct: Structure | null, error: string | null): string {
  let h = '<div class="card mb-6"><div class="card-body"><p class="mb-0">Nothing to set up here. The app looks at your <strong>opportunities</strong> and uses <strong>only the pipelines and stages that have opportunities in them</strong>, in the same order as in GoHighLevel. Each stage is placed in a scorecard category <strong>automatically</strong>, from its name (“Appointment Set” → Jobs Booked, “Permit Approved” → Permits Finalized, “Job Completed” → Production…) and from its opportunities: a stage where most opportunities are Won counts as Sales. Opportunities marked <strong>Won</strong> always count as Sales. Changes in GHL show up after the next sync.</p></div></div>';
  if (!S.ghl.token) return h + alertBox('Connect GoHighLevel first under <a href="/admin?page=connection">GHL connection</a>.');
  if (error) return h + alertBox(e(error), 'danger');
  if (!struct || !struct.pipelines.length) return h + '<div class="card"><div class="card-body text-body-secondary">No opportunities synced yet. Leads still come from contacts; pipelines appear here after a sync once opportunities exist in GHL.</div></div>';
  for (const p of struct.pipelines) {
    const tot = p.stages.reduce((s, x) => s + x.stats.total, 0);
    h += `<div class="card mb-6"><div class="card-header d-flex flex-wrap gap-3 justify-content-between align-items-center"><div><h5 class="card-title">${e(p.name)}</h5><p class="card-subtitle mb-0">${p.stages.length} stages with opportunities · ${num(tot)} opportunities${p.emptyStages ? ` · ${p.emptyStages} empty stage${p.emptyStages > 1 ? 's' : ''} not shown` : ''}</p></div><span class="badge bg-label-success">Used automatically</span></div>`
      + '<div class="table-responsive"><table class="table mb-0"><thead><tr><th>Stage</th><th class="text-end">Open</th><th class="text-end">Won</th><th class="text-end">Lost</th><th class="text-end">Total</th><th>Scorecard category</th></tr></thead><tbody>'
      + p.stages.map((st, i) => `<tr><td class="text-heading fw-medium"><span class="text-body-secondary me-2">${i + 1}</span>${e(st.name)}</td><td class="text-end">${num(st.stats.open)}</td><td class="text-end">${num(st.stats.won)}</td><td class="text-end">${num(st.stats.lost)}</td><td class="text-end fw-semibold">${num(st.stats.total)}</td>`
        + `<td>${st.cat === 'none' ? '<span class="text-body-secondary">Not a scorecard category</span>' : `<span class="badge bg-label-primary">${e(CAT_LABELS[st.cat])}</span>`}</td></tr>`).join('')
      + '</tbody></table></div></div>';
  }
  if (struct.skippedPipelines) h += `<p class="text-body-secondary small">${struct.skippedPipelines} pipeline${struct.skippedPipelines > 1 ? 's have' : ' has'} no opportunities and ${struct.skippedPipelines > 1 ? 'are' : 'is'} skipped.</p>`;
  return h;
}

export function displayPage(S: Settings, csrf: string): string {
  const D = S.display, src = S.sources, def = D.defaultRange || 'last_week';
  const sec = (icon: string, color: string, title: string, sub: string, body: string) => `<div class="card settings-section"><div class="card-header d-flex align-items-center gap-3"><div class="avatar"><span class="avatar-initial rounded bg-label-${color}"><i class="kicon kicon-sm kicon-${icon}"></i></span></div><div><h5 class="card-title">${title}</h5><p class="card-subtitle mb-0">${sub}</p></div></div><div class="card-body">${body}</div></div>`;
  const presets = Object.entries(PRESETS).filter(([k]) => k !== 'custom').map(([k, l]) => `<input type="radio" name="defaultRange" id="dr-${k}" value="${k}"${k === def ? ' checked' : ''}><label for="dr-${k}">${e(l)}</label>`).join('');
  return `<form method="post" action="/admin?page=display">${csrf}<input type="hidden" name="do" value="display">`
    + sec('layout-dashboard', 'primary', 'Report header', 'Shown at the top of the Scorecard and the Pipeline board.', '<div class="row g-4">'
      + `<div class="col-md-4"><label class="form-label" for="dCompany">Company name</label><input class="form-control" id="dCompany" name="company" value="${e(D.company)}" placeholder="Keil Electric"></div>`
      + `<div class="col-md-4"><label class="form-label" for="dRegion">Region</label><input class="form-control" id="dRegion" name="region" value="${e(D.region)}" placeholder="San Diego"><div class="form-text">Shown before the title. Leave blank to hide it.</div></div>`
      + `<div class="col-md-4"><label class="form-label" for="dTitle">Report title</label><input class="form-control" id="dTitle" name="title" value="${e(D.title)}" placeholder="Daily Pipeline Scorecard"></div></div>`)
    + sec('calendar', 'info', 'Reporting period', 'What the report shows when someone opens it, and how weeks and days are counted.',
      `<label class="form-label d-block mb-2">Default report period</label><div class="preset-choices" role="radiogroup" aria-label="Default report period">${presets}</div><div class="form-text mb-4">Viewers can still pick any other period with the buttons on the report.</div><div class="row g-4">`
      + `<div class="col-md-4"><label class="form-label" for="dWeek">Week starts on</label><select class="form-select" id="dWeek" name="weekStartsOn"><option value="1"${Number(D.weekStartsOn) === 1 ? ' selected' : ''}>Monday</option><option value="0"${Number(D.weekStartsOn) === 0 ? ' selected' : ''}>Sunday</option></select></div>`
      + `<div class="col-md-4"><label class="form-label" for="dTz">Time zone</label><input class="form-control" id="dTz" name="timezone" list="tzList" value="${e(D.timezone)}"><datalist id="tzList"><option>America/Los_Angeles</option><option>America/Denver</option><option>America/Phoenix</option><option>America/Chicago</option><option>America/New_York</option></datalist><div class="form-text">Days and times on the report use this zone.</div></div>`
      + `<div class="col-md-4"><label class="form-label" for="dRefresh">Open report reloads every</label><div class="input-group"><input class="form-control" id="dRefresh" name="refreshSeconds" type="number" min="0" max="86400" value="${Number(D.refreshSeconds)}"><span class="input-group-text">seconds</span></div><div class="form-text">Only while the period includes now. 0 turns it off.</div></div></div>`)
    + sec('plug', 'success', 'GoHighLevel data', 'How leads are qualified and how payments are read.', '<div class="row g-4 mb-4">'
      + `<div class="col-md-6"><label class="form-label" for="dTags">Tags that mark a qualified lead</label><input class="form-control" id="dTags" name="qualifiedTags" value="${e(src.qualifiedTags)}" placeholder="qualified, sql"><div class="form-text">Comma separated, matched anywhere in a tag (“Qualified Lead” counts; “Unqualified” never does). Leads whose opportunity moved past the first stage also count.</div></div>`
      + `<div class="col-md-6"><label class="form-label">Sync schedule</label><div class="form-control" style="background:#f3f2f6">Every ${src.syncMinutes || 15} minutes</div><div class="form-text">Set in <code>netlify/functions/sync-scheduled.mts</code>. Admins can also sync any time from Overview.</div></div></div>`
      + `<div class="setting-row"><div><div class="title">Read Cash from GHL Payments</div><div class="desc">Uses successful payment transactions and invoices for Cash Collected when Jobber isn’t connected. Needs the View Payment Transactions and View Invoices scopes.</div></div><div class="form-check form-switch"><input class="form-check-input" type="checkbox" role="switch" id="dTx" name="useTransactions" value="1"${src.useTransactions ? ' checked' : ''} aria-label="Read Cash from GHL Payments"></div></div>`)
    + '<div class="form-actions"><button class="btn btn-primary">Save display settings</button><a class="btn btn-outline-secondary" href="/admin?page=display">Cancel</a></div></form>';
}

export function adsPage(S: Settings, csrf: string, srcCounts: [string, number][]): string {
  const A = S.ads; const mask = (v: string) => v ? '••••' + v.slice(-4) : '';
  const p = (S.ads as { pending?: Record<string, Record<string, string>> }).pending ?? {};
  const val = (ch: string, k: string, cur: string) => p[ch]?.[k] || cur;
  const metaOn = adsConfigured(S, 'meta'), gOn = adsConfigured(S, 'google');
  const head2 = (title: string, sub: string, on: boolean, bg: string, fg: string) => `<div class="card-header d-flex align-items-center gap-3"><div class="avatar"><span class="avatar-initial rounded" style="background:${bg};color:${fg}"><i class="kicon kicon-sm kicon-link"></i></span></div><div class="me-auto"><h5 class="card-title">${title}</h5><p class="card-subtitle mb-0">${sub}</p></div><span class="badge bg-label-${on ? 'success' : 'secondary'}">${on ? 'Connected' : 'Not connected'}</span></div>`;
  let h = '<div class="card mb-6"><div class="card-body d-flex gap-4 align-items-start"><div class="avatar avatar-lg"><span class="avatar-initial rounded bg-label-info"><i class="kicon kicon-currency-dollar"></i></span></div><div><h5 class="mb-1">Where spend comes from</h5>'
    + '<p class="mb-2">GoHighLevel’s API doesn’t include the numbers on its Ads Reporting page, so the app reads spend <strong>straight from Google Ads and Meta Ads</strong> — the same place GHL gets it — during each sync. Connect either platform below, or enter spend by hand. A connected platform is used first; manual entries fill in for channels that aren’t connected.</p>'
    + '<p class="mb-0 text-body-secondary small">Leads, bookings and sales are matched to a channel by their GHL source, so the report can show cost per lead, cost per booking and return on ad spend.</p></div></div></div>';
  h += '<div class="row g-6 mb-6"><div class="col-xl-6">' + `<form class="card h-100 settings-section" method="post" action="/admin?page=ads">${csrf}<input type="hidden" name="do" value="ads_meta">`
    + head2('Meta Ads', 'Facebook and Instagram ads, via the Marketing API', metaOn, '#efeafd', '#6c47c1')
    + `<div class="card-body"><div class="mb-3"><label class="form-label" for="mAcct">Ad account ID</label><input class="form-control" id="mAcct" name="accountId" value="${e(val('meta', 'accountId', A.meta.accountId))}" placeholder="e.g. 123456789012345" autocomplete="off"><div class="form-text">Ads Manager › the number after <code>act_</code> in the address bar.</div></div>`
    + `<div class="mb-3"><label class="form-label" for="mTok">Access token</label><input class="form-control" id="mTok" name="token" type="password" placeholder="${e(A.meta.token || p.meta?.token ? 'Saved (' + mask(p.meta?.token || A.meta.token) + ') — paste a new one to replace it' : 'EAAG…')}" autocomplete="off"><div class="form-text">Business Settings › Users › System users › Generate new token, with <code>ads_read</code> and access to this ad account.</div></div>`
    + `<div class="mb-1"><label class="form-label" for="mVer">API version <span class="text-body-secondary fw-normal">(optional)</span></label><input class="form-control" id="mVer" name="version" value="${e(A.meta.version)}" placeholder="Leave blank to use your app’s default"></div>`
    + `<div class="form-actions"><button class="btn btn-primary">Save and test</button>${metaOn ? '<button class="btn btn-outline-secondary" name="disconnect" value="1" formnovalidate onclick="return confirm(\'Disconnect Meta Ads and delete the token?\')">Disconnect</button>' : ''}</div></div></form></div>`;
  h += '<div class="col-xl-6">' + `<form class="card h-100 settings-section" method="post" action="/admin?page=ads">${csrf}<input type="hidden" name="do" value="ads_google">`
    + head2('Google Ads', 'Search, Performance Max and LSA campaigns, via the Google Ads API', gOn, '#e7f0fb', '#3a7bd5') + '<div class="card-body"><div class="row g-3">'
    + `<div class="col-sm-6"><label class="form-label" for="gCid">Customer ID</label><input class="form-control" id="gCid" name="customerId" value="${e(val('google', 'customerId', A.google.customerId))}" placeholder="123-456-7890"></div>`
    + `<div class="col-sm-6"><label class="form-label" for="gLogin">Manager (MCC) ID <span class="text-body-secondary fw-normal">(if any)</span></label><input class="form-control" id="gLogin" name="loginCustomerId" value="${e(val('google', 'loginCustomerId', A.google.loginCustomerId))}" placeholder="Only if managed by an MCC"></div>`
    + `<div class="col-sm-6"><label class="form-label" for="gDev">Developer token</label><input class="form-control" id="gDev" name="developerToken" type="password" placeholder="${e(A.google.developerToken || p.google?.developerToken ? 'Saved (' + mask(p.google?.developerToken || A.google.developerToken) + ')' : 'From Google Ads › API Center')}" autocomplete="off"></div>`
    + `<div class="col-sm-6"><label class="form-label" for="gVer">API version <span class="text-body-secondary fw-normal">(optional)</span></label><input class="form-control" id="gVer" name="version" value="${e(A.google.version)}" placeholder="Blank = newest available"></div>`
    + `<div class="col-12"><label class="form-label" for="gCli">OAuth client ID</label><input class="form-control" id="gCli" name="clientId" value="${e(val('google', 'clientId', A.google.clientId))}" placeholder="….apps.googleusercontent.com" autocomplete="off"></div>`
    + `<div class="col-sm-6"><label class="form-label" for="gSec">OAuth client secret</label><input class="form-control" id="gSec" name="clientSecret" type="password" placeholder="${e(A.google.clientSecret || p.google?.clientSecret ? 'Saved (' + mask(p.google?.clientSecret || A.google.clientSecret) + ')' : 'GOCSPX-…')}" autocomplete="off"></div>`
    + `<div class="col-sm-6"><label class="form-label" for="gRef">Refresh token</label><input class="form-control" id="gRef" name="refreshToken" type="password" placeholder="${e(A.google.refreshToken || p.google?.refreshToken ? 'Saved (' + mask(p.google?.refreshToken || A.google.refreshToken) + ')' : '1//0…')}" autocomplete="off"></div></div>`
    + '<div class="form-text mt-2">Needs a Google Ads API developer token (Basic access), a Google Cloud OAuth client, and a refresh token for a Google user who can see the ad account. The README walks through it.</div>'
    + `<div class="form-actions"><button class="btn btn-primary">Save and test</button>${gOn ? '<button class="btn btn-outline-secondary" name="disconnect" value="1" formnovalidate onclick="return confirm(\'Disconnect Google Ads and delete the keys?\')">Disconnect</button>' : ''}</div></div></form></div></div>`;
  // manual
  const chOpts = (Object.keys(AD_CHANNELS) as Channel[]).map((k) => `<option value="${k}">${e(AD_CHANNELS[k].label)}</option>`).join('');
  h += '<div class="card mb-6 settings-section"><div class="card-header d-flex align-items-center gap-3"><div class="avatar"><span class="avatar-initial rounded bg-label-primary"><i class="kicon kicon-sm kicon-calendar"></i></span></div><div><h5 class="card-title">Enter spend by hand</h5><p class="card-subtitle mb-0">For channels that aren’t connected. Amounts are spread evenly over the dates, so a monthly figure shows correctly in any week or day.</p></div></div><div class="card-body">'
    + `<form method="post" action="/admin?page=ads" class="row g-3 align-items-end mb-4">${csrf}<input type="hidden" name="do" value="ads_manual_add">`
    + `<div class="col-md-2"><label class="form-label" for="aCh">Channel</label><select class="form-select" id="aCh" name="channel">${chOpts}</select></div>`
    + '<div class="col-md-2"><label class="form-label" for="aFrom">From</label><input class="form-control" id="aFrom" type="date" name="from" required></div><div class="col-md-2"><label class="form-label" for="aTo">To</label><input class="form-control" id="aTo" type="date" name="to" required></div>'
    + '<div class="col-md-2"><label class="form-label" for="aAmt">Amount</label><div class="input-group"><span class="input-group-text">$</span><input class="form-control" id="aAmt" name="amount" inputmode="decimal" placeholder="0.00" required></div></div>'
    + '<div class="col-md-2"><label class="form-label" for="aNote">Note <span class="text-body-secondary fw-normal">(optional)</span></label><input class="form-control" id="aNote" name="note" placeholder="e.g. October invoice"></div><div class="col-md-2"><button class="btn btn-primary w-100">Add spend</button></div></form>';
  if (!A.manual.length) h += '<p class="text-body-secondary mb-0">No spend entered yet.</p>';
  else {
    h += '<div class="table-responsive"><table class="table mb-0"><thead><tr><th>Channel</th><th>Dates</th><th class="text-end">Amount</th><th class="text-end">Per day</th><th>Note</th><th></th></tr></thead><tbody>';
    for (const m of A.manual) {
      const nd = daysBetween(m.from, m.to) + 1; const ch = AD_CHANNELS[m.channel as Channel];
      const fd = (d: string) => ymdObj(d).toFormat('LLL d, yyyy', { locale: 'en-US' });
      h += `<tr><td class="text-heading"><i class="dot" style="display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:${e(ch?.color ?? '#999')}"></i>${e(ch?.label ?? m.channel)}</td><td>${e(fd(m.from))}${m.from !== m.to ? ' – ' + e(fd(m.to)) : ''} <small class="text-body-secondary">(${nd} day${nd === 1 ? '' : 's'})</small></td>`
        + `<td class="text-end fw-semibold text-heading">${money(m.amount)}</td><td class="text-end">${money(m.amount / Math.max(1, nd))}</td><td class="text-body-secondary">${e(m.note)}</td>`
        + `<td class="text-end"><form method="post" action="/admin?page=ads" class="m-0" onsubmit="return confirm('Remove this spend entry?')">${csrf}<input type="hidden" name="do" value="ads_manual_del"><input type="hidden" name="id" value="${e(m.id)}"><button class="btn btn-sm btn-outline-secondary">Remove</button></form></td></tr>`;
    }
    h += '</tbody></table></div>';
  }
  h += '</div></div>';
  // matching
  h += `<form class="card settings-section" method="post" action="/admin?page=ads">${csrf}<input type="hidden" name="do" value="ads_match"><div class="card-header d-flex align-items-center gap-3"><div class="avatar"><span class="avatar-initial rounded bg-label-success"><i class="kicon kicon-sm kicon-users"></i></span></div><div><h5 class="card-title">Which GHL lead sources belong to each channel</h5><p class="card-subtitle mb-0">A lead counts for a channel when its GHL source contains one of these words (comma separated).</p></div></div><div class="card-body"><div class="row g-4">`
    + (Object.keys(AD_CHANNELS) as Channel[]).map((k) => `<div class="col-md-6"><label class="form-label" for="mt-${k}">${e(AD_CHANNELS[k].label)}</label><input class="form-control" id="mt-${k}" name="match[${k}]" value="${e(A.match[k] ?? '')}"></div>`).join('') + '</div>';
  if (srcCounts.length) {
    h += '<p class="form-label mt-4 mb-2">Your GHL lead sources in the last 30 days</p><div class="table-responsive"><table class="table mb-0"><thead><tr><th>GHL source</th><th class="text-end">Leads</th><th>Counts as</th></tr></thead><tbody>'
      + srcCounts.slice(0, 15).map(([src, n]) => { const chn = src === '(no source)' ? null : channelOf(src, S); return `<tr><td class="text-heading">${e(src)}</td><td class="text-end">${num(n)}</td><td>${chn ? `<span class="badge" style="background:${e(AD_CHANNELS[chn].color)};color:#fff">${e(AD_CHANNELS[chn].label)}</span>` : '<span class="text-body-secondary">Other sources</span>'}</td></tr>`; }).join('')
      + '</tbody></table></div>';
  }
  return h + '<div class="form-actions"><button class="btn btn-primary">Save channel matching</button></div></div></form>';
}

export function jobberPage(S: Settings, csrf: string, origin: string, test: { at: number; rows: [string, boolean, string][]; ms: number } | null): string {
  const J = S.jobber, on = jobberConnected(S);
  let h = '<div class="card mb-6"><div class="card-body d-flex gap-4 align-items-start"><div class="avatar avatar-lg"><span class="avatar-initial rounded bg-label-success"><i class="kicon kicon-cash"></i></span></div><div><h5 class="mb-1">Payments and invoices from Jobber</h5>'
    + '<p class="mb-0">When Jobber is connected, the report’s <strong>Cash</strong> and <strong>Payments</strong> categories use Jobber: payments received (with method), paid invoices, invoices sent and balances still owed. GoHighLevel is used when Jobber isn’t connected. Access is read-only.</p></div></div></div><div class="row g-6">';
  h += `<div class="col-xl-7"><form class="card settings-section h-100" method="post" action="/admin?page=jobber">${csrf}<input type="hidden" name="do" value="jobber_save"><div class="card-header d-flex align-items-center gap-3"><div class="avatar"><span class="avatar-initial rounded bg-label-primary"><i class="kicon kicon-sm kicon-plug"></i></span></div>`
    + `<div class="me-auto"><h5 class="card-title">Jobber connection</h5><p class="card-subtitle mb-0">${on ? 'Connected' + (J.account ? ' to ' + e(J.account) : '') + (J.connectedAt ? ' since ' + e(DateTime.fromISO(J.connectedAt).toFormat('LLL d, yyyy', { locale: 'en-US' })) : '') : 'Not connected'}</p></div><span class="badge bg-label-${on ? 'success' : 'secondary'}">${on ? 'Connected' : 'Not connected'}</span></div><div class="card-body"><div class="row g-3">`
    + `<div class="col-md-6"><label class="form-label" for="jId">Client ID</label><input class="form-control" id="jId" name="clientId" value="${e(J.clientId)}" autocomplete="off" required></div>`
    + `<div class="col-md-6"><label class="form-label" for="jSec">Client secret</label><input class="form-control" id="jSec" name="clientSecret" type="password" placeholder="${e(J.clientSecret ? 'Saved (••••' + J.clientSecret.slice(-4) + ') — paste to replace' : 'From your Jobber app')}" autocomplete="off"></div>`
    + `<div class="col-12"><label class="form-label" for="jCb">Callback URL — add this to your Jobber app</label><div class="input-group"><input class="form-control" id="jCb" value="${e(jobberCallbackUrl(origin))}" readonly onclick="this.select()"><button class="btn btn-outline-secondary" type="button" onclick="var i=document.getElementById('jCb');i.select();(navigator.clipboard?navigator.clipboard.writeText(i.value):Promise.reject()).catch(function(){document.execCommand('copy')});this.textContent='Copied'">Copy</button></div></div>`
    + `<div class="col-md-6"><label class="form-label" for="jVer">GraphQL API version</label><input class="form-control" id="jVer" name="version" value="${e(J.version)}" placeholder="2025-01-20"><div class="form-text">Shown in the Jobber Developer Center. Change it if Jobber retires this one.</div></div></div>`
    + `<div class="form-actions"><button class="btn btn-primary" name="connect" value="1">${on ? 'Reconnect to Jobber' : 'Connect to Jobber'}</button><button class="btn btn-outline-secondary">Save without connecting</button></div></div></form></div>`;
  h += '<div class="col-xl-5"><div class="card settings-section h-100"><div class="card-header d-flex align-items-center gap-3"><div class="avatar"><span class="avatar-initial rounded bg-label-info"><i class="kicon kicon-sm kicon-refresh"></i></span></div><div class="me-auto"><h5 class="card-title">Test the connection</h5><p class="card-subtitle mb-0">Reads your account name, and the last 30 days of payments and invoices.</p></div></div><div class="card-body">';
  if (!on) h += '<p class="text-body-secondary mb-0">Connect to Jobber first.</p>';
  else {
    if (test) h += '<div class="table-responsive mb-3"><table class="table mb-0"><tbody>' + test.rows.map(([l, ok, msg]) => `<tr><td class="text-heading fw-medium">${e(l)}</td><td>${ok ? '<span class="badge bg-label-success">OK</span>' : '<span class="badge bg-label-danger">Problem</span>'}</td><td class="${ok ? '' : 'text-danger'}" style="white-space:normal">${e(msg)}</td></tr>`).join('') + `</tbody></table></div><p class="small text-body-secondary">${num(test.ms)} ms</p>`;
    h += `<div class="d-flex gap-2 flex-wrap"><form method="post" action="/admin?page=jobber" class="m-0">${csrf}<input type="hidden" name="do" value="jobber_test"><button class="btn btn-label-primary">Run test</button></form>`
      + `<form method="post" action="/admin?page=jobber" class="m-0" onsubmit="return confirm('Disconnect from Jobber? Payments will come from GoHighLevel again.')">${csrf}<input type="hidden" name="do" value="jobber_disconnect"><button class="btn btn-outline-secondary">Disconnect</button></form></div>`;
  }
  h += '</div></div></div></div>';
  return h + '<div class="card settings-section mt-6"><div class="card-header"><h5 class="card-title">How to create the Jobber app (one time)</h5></div><div class="card-body"><ol class="mb-0 ps-4" style="line-height:1.9">'
    + '<li>Sign in to the <strong>Jobber Developer Center</strong> (developer.getjobber.com) and click <strong>Create app</strong>.</li><li>Paste the <strong>Callback URL</strong> above into the app’s OAuth callback URL.</li>'
    + '<li>Give it <strong>read</strong> access to <strong>Invoices</strong>, <strong>Payments</strong> and <strong>Clients</strong> (client names). Nothing needs write access.</li>'
    + '<li>Copy the app’s <strong>Client ID</strong> and <strong>Client secret</strong> into the form above and click <strong>Connect to Jobber</strong>. Approve the access on Jobber’s screen.</li><li>Click <strong>Run test</strong>, then <strong>Sync now</strong> on the Overview.</li></ol></div></div>';
}

export function sheetsPage(S: Settings, csrf: string, origin: string): string {
  const xk = S.export.key; const xUrl = origin + '/export?key=' + xk; const https = origin.startsWith('https://');
  let h = '<div class="card mb-6"><div class="card-body d-flex gap-4 align-items-start"><div class="avatar avatar-lg"><span class="avatar-initial rounded bg-label-success"><i class="kicon kicon-file-text"></i></span></div><div><h5 class="mb-1">Your reporting in a Google Sheet</h5>'
    + '<p class="mb-2">The <strong>Keil Marketing – CAC &amp; ROI</strong> workbook pulls this app’s numbers live with Google Sheets’ <code>IMPORTDATA</code> — dashboard, scorecard, ad spend per channel, CAC, ROAS and ROI, plus a 12-month trend. Google refreshes it about once an hour.</p>'
    + '<ol class="mb-0 ps-3" style="line-height:1.8"><li>Turn the export on and copy the link below.</li><li>Upload <a href="/downloads/Keil-Marketing-CAC-ROI.xlsx" download>Keil-Marketing-CAC-ROI.xlsx</a> to Google Drive and open it with <strong>Google Sheets</strong> (File › Save as Google Sheets).</li><li>Paste the link into the yellow cell on the <strong>Setup</strong> tab.</li></ol></div></div></div>';
  h += `<div class="card mb-6 settings-section"><div class="card-header d-flex align-items-center gap-3"><div class="avatar"><span class="avatar-initial rounded bg-label-primary"><i class="kicon kicon-sm kicon-link"></i></span></div><div class="me-auto"><h5 class="card-title">Export link</h5><p class="card-subtitle mb-0">Private: anyone with this link can read the report numbers (not contact names). Create a new link at any time to cut off the old one.</p></div><span class="badge bg-label-${xk ? 'success' : 'secondary'}">${xk ? 'On' : 'Off'}</span></div><div class="card-body">`;
  if (!xk) h += `<form method="post" action="/admin?page=sheets">${csrf}<input type="hidden" name="do" value="export_on"><button class="btn btn-primary">Turn on Google Sheets export</button></form>`;
  else h += `<label class="form-label" for="xUrl">Link for the Setup tab</label><div class="input-group mb-2"><input class="form-control" id="xUrl" value="${e(xUrl)}" readonly onclick="this.select()"><button class="btn btn-outline-secondary" type="button" id="xCopy">Copy</button></div>`
    + (https ? '' : '<div class="form-text text-warning mb-2">This page isn’t on https://. Google Sheets can only import from a public https address — use your site’s https link.</div>')
    + `<div class="d-flex flex-wrap gap-2 mt-3"><a class="btn btn-outline-secondary btn-sm" href="${e(xUrl)}&amp;view=summary" target="_blank" rel="noopener">Open summary table</a><a class="btn btn-outline-secondary btn-sm" href="${e(xUrl)}&amp;view=months" target="_blank" rel="noopener">Open 12-month table</a><span class="flex-grow-1"></span>`
    + `<form method="post" action="/admin?page=sheets" class="m-0" onsubmit="return confirm('Create a new link? The current link stops working and must be replaced in your Google Sheet.')">${csrf}<input type="hidden" name="do" value="export_regen"><button class="btn btn-outline-secondary btn-sm">Create a new link</button></form>`
    + `<form method="post" action="/admin?page=sheets" class="m-0" onsubmit="return confirm('Turn the export off? Your Google Sheet will stop updating.')">${csrf}<input type="hidden" name="do" value="export_off"><button class="btn btn-label-danger btn-sm">Turn off</button></form></div>`
    + `<script>document.getElementById('xCopy').addEventListener('click',function(){var i=document.getElementById('xUrl');i.select();(navigator.clipboard?navigator.clipboard.writeText(i.value):Promise.reject()).catch(function(){document.execCommand('copy')});this.textContent='Copied';var b=this;setTimeout(function(){b.textContent='Copy'},1800)});</script>`;
  return h + '</div></div>';
}

export function accessPage(S: Settings, csrf: string): string {
  return '<div class="row g-6"><div class="col-lg-6"><div class="card h-100"><div class="card-header"><h5 class="card-title">Report password</h5>'
    + `<p class="card-subtitle mb-0">${S.viewerHash ? 'On — viewers need the password.' : 'Off — anyone with the link can open the report.'}</p></div><div class="card-body"><p>The report shows contact names from your CRM. Set a password so only your team can open it.</p>`
    + `<form method="post" action="/admin?page=access">${csrf}<input type="hidden" name="do" value="viewer"><label class="form-label" for="viewerPw">New report password</label><input type="password" class="form-control mb-3" id="viewerPw" name="viewerPassword" autocomplete="new-password" minlength="6" required><button class="btn btn-primary">Set report password</button></form>`
    + (S.viewerHash ? `<form method="post" action="/admin?page=access" class="mt-3" onsubmit="return confirm('Remove the report password? Anyone with the link will see contact names.')">${csrf}<input type="hidden" name="do" value="viewer"><input type="hidden" name="remove" value="1"><button class="btn btn-label-danger">Remove password</button></form>` : '')
    + `</div></div></div><div class="col-lg-6"><form class="card h-100" method="post" action="/admin?page=access">${csrf}<input type="hidden" name="do" value="adminpw"><div class="card-header"><h5 class="card-title">Admin password</h5><p class="card-subtitle mb-0">Used to sign in here.</p></div>`
    + '<div class="card-body"><label class="form-label" for="adminPw">New admin password</label><input type="password" class="form-control mb-3" id="adminPw" name="adminPassword" autocomplete="new-password" minlength="8" required><label class="form-label" for="adminPw2">Repeat it</label><input type="password" class="form-control mb-3" id="adminPw2" name="adminPassword2" autocomplete="new-password" minlength="8" required><button class="btn btn-primary">Change admin password</button></div></form></div></div>';
}

export interface SystemInfo {
  env: [string, boolean, string][]; db: { ok: boolean; message: string; tables: [string, number | null][] };
  syncs: SyncRow[]; errors: { at: string; level: string; message: string; context: string }[];
  dataTest: { at: number; rows: [string, boolean, string, number][] } | null;
}
export function systemPage(S: Settings, csrf: string, info: SystemInfo, zone: string): string {
  const allEnv = info.env.every(([, ok]) => ok);
  const last = info.syncs.find((x) => x.status !== 'running');
  let h = '<div class="row g-6 mb-6">'
    + statusCard('list-details', allEnv ? 'success' : 'danger', 'Netlify settings', allEnv ? 'All set' : 'Missing', allEnv ? 'Every environment variable is present' : 'See the list below')
    + statusCard('database', info.db.ok ? 'success' : 'danger', 'Supabase', info.db.ok ? 'Connected' : 'Problem', e(info.db.message))
    + statusCard('refresh', !last ? 'warning' : last.status === 'ok' ? 'success' : last.status === 'partial' ? 'warning' : 'danger', 'Last sync', last ? e(when(last.finished_at, zone)) : 'Never', last ? statusBadge(last.status) : 'Run one from Overview')
    + statusCard('alert-triangle', info.errors.length ? 'warning' : 'success', 'Recent errors', String(info.errors.length), info.errors.length ? 'Newest: ' + e(when(info.errors[0].at, zone)) : 'None recorded')
    + '</div>';
  h += '<div class="card mb-6"><div class="card-header"><h5 class="card-title">Netlify environment variables</h5><p class="card-subtitle mb-0">Site configuration › Environment variables. Values are never shown here.</p></div><div class="table-responsive"><table class="table mb-0"><thead><tr><th>Variable</th><th>Status</th><th>Used for</th></tr></thead><tbody>'
    + info.env.map(([k, ok, what]) => `<tr><td><code>${e(k)}</code></td><td>${ok ? '<span class="badge bg-label-success">Set</span>' : '<span class="badge bg-label-danger">Missing</span>'}</td><td class="text-body-secondary" style="white-space:normal">${e(what)}</td></tr>`).join('') + '</tbody></table></div></div>';
  h += '<div class="card mb-6"><div class="card-header"><h5 class="card-title">Supabase tables</h5><p class="card-subtitle mb-0">Rows in each table. Missing tables mean <code>supabase/schema.sql</code> hasn’t been run yet.</p></div><div class="table-responsive"><table class="table mb-0"><thead><tr><th>Table</th><th class="text-end">Rows</th></tr></thead><tbody>'
    + info.db.tables.map(([t, n]) => `<tr><td><code>${e(t)}</code></td><td class="text-end">${n === null ? '<span class="badge bg-label-danger">Missing</span>' : num(n)}</td></tr>`).join('') + '</tbody></table></div></div>';
  const dt = info.dataTest;
  h += `<div class="card mb-6"><div class="card-header d-flex justify-content-between align-items-start flex-wrap gap-3"><div><h5 class="card-title">Test GHL data</h5><p class="card-subtitle mb-0">Reads a little real data with your saved token and times each part.</p></div><form method="post" action="/admin?page=system" class="m-0">${csrf}<input type="hidden" name="do" value="datatest"><button class="btn btn-label-primary"${S.ghl.token ? '' : ' disabled'}><i class="kicon kicon-sm kicon-refresh"></i>Run data test</button></form></div>`
    + (!dt ? `<div class="card-body"><p class="text-body-secondary mb-0">${S.ghl.token ? 'Not run yet.' : 'Connect GoHighLevel first.'}</p></div>`
      : '<div class="table-responsive"><table class="table mb-0"><thead><tr><th>Part</th><th>Status</th><th>Result</th><th class="text-end">Time</th></tr></thead><tbody>' + dt.rows.map(([l, ok, res, ms]) => `<tr><td class="text-heading fw-medium">${e(l)}</td><td>${ok ? '<span class="badge bg-label-success">OK</span>' : '<span class="badge bg-label-danger">Problem</span>'}</td><td style="white-space:normal;min-width:280px" class="${ok ? '' : 'text-danger'}">${e(res)}</td><td class="text-end">${num(ms)} ms</td></tr>`).join('') + '</tbody></table></div>')
    + '</div>';
  h += `<div class="card"><div class="card-header d-flex justify-content-between align-items-start flex-wrap gap-3"><div><h5 class="card-title">Recent errors</h5><p class="card-subtitle mb-0">The app’s error log (Supabase table <code>app_log</code>), newest first. Function logs are also in Netlify › Logs › Functions.</p></div>`
    + (info.errors.length ? `<form method="post" action="/admin?page=system" class="m-0" onsubmit="return confirm('Clear the error log?')">${csrf}<input type="hidden" name="do" value="clearlog"><button class="btn btn-outline-secondary btn-sm">Clear log</button></form>` : '') + '</div><div class="card-body">'
    + (!info.errors.length ? '<p class="mb-0"><span class="badge bg-label-success me-2">None</span><span class="text-body-secondary">No errors recorded.</span></p>'
      : '<div class="errlog">' + info.errors.map((x) => `<div>[${e(when(x.at, zone))}] ${e(x.message)}${x.context ? ` <span class="text-body-secondary">(${e(x.context)})</span>` : ''}</div>`).join('') + '</div>')
    + '</div></div>';
  return h;
}
