/** Shared pieces of the report pages: page shell, top bar, contact lists. Same markup as the PHP app, so its CSS/JS work unchanged. */
import type { Settings } from '../lib/settings.js';
import type { Period } from '../lib/period.js';
import type { Item } from '../lib/data.js';
import { e, money, ymdObj, daysBetween } from '../lib/util.js';
import { DateTime } from 'luxon';

export function reportTitle(S: Settings): string { const D = S.display; return (D.region ? D.region + ' – ' : '') + D.title; }
export function topbar(S: Settings, active: 'scorecard' | 'pipelines', title: string, subtitle: string): string {
  const parts = (S.display.company.trim() || 'Keil').split(/\s+/);
  const last = parts.length > 1 ? parts.pop() as string : '';
  const mark = (S.display.company.trim() || 'K').slice(0, 1).toUpperCase();
  return `<header class="topbar"><a class="brand" href="/"><div class="brand-mark">${e(mark)}</div><div class="brand-name">${e(parts.join(' '))}${last ? ' <span>' + e(last) + '</span>' : ''}</div></a>`
    + `<div class="title"><h1>${e(title)}</h1><p>${subtitle ? e(subtitle) : '&nbsp;'}</p></div>`
    + `<nav class="nav" aria-label="Pages"><a href="/"${active === 'scorecard' ? ' aria-current="page"' : ''}>Scorecard</a><a href="/pipelines"${active === 'pipelines' ? ' aria-current="page"' : ''}>Pipelines</a><a href="/admin">Admin</a></nav></header>`;
}
export function page(title: string, head: string, body: string, scripts: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${head}`
    + `<title>${e(title)}</title><link rel="stylesheet" href="/assets/css/app.css"><script>document.documentElement.classList.add('js')</script></head>`
    + `<body>${body}${scripts}</body></html>`;
}
export function lcfirstPeriod(P: Period): string { return P.key === 'custom' ? 'this period' : P.label.toLowerCase(); }
export function whenText(x: Item): string {
  const at = x.at || x.date + ' 00:00';
  const d = DateTime.fromFormat(at, 'yyyy-MM-dd HH:mm');
  const day = ymdObj(x.date);
  return day.toFormat('ccc', { locale: 'en-US' }) + ' ' + day.toFormat('MM/dd') + ' · ' + (d.isValid ? d.toFormat('h:mm a', { locale: 'en-US' }).replace(/^0/, '') : '');
}
export function ratioMoney(a: number, b: number): string { return b > 0 ? money(a / b) : '—'; }
export function daysSince(ymd: string, today: string): number { return Math.max(0, daysBetween(ymd, today)); }

/** “Synced 9:14 AM · every 15 min” for the report header. */
export function syncedText(S: Settings, generatedAt: string | null, zone: string): string {
  if (!generatedAt) return 'Waiting for the first sync';
  const d = DateTime.fromISO(generatedAt).setZone(zone);
  const today = DateTime.now().setZone(zone).toFormat('yyyy-MM-dd');
  return 'Synced ' + (d.toFormat('yyyy-MM-dd') === today ? '' : d.toFormat('LLL d', { locale: 'en-US' }) + ', ') + d.toFormat('h:mm a', { locale: 'en-US' }) + ' · every ' + (S.sources.syncMinutes || 15) + ' min';
}
export function moreList<T>(items: T[], limit: number, row: (x: T) => string, max = 500): string {
  let h = `<ul class="clist">${items.slice(0, limit).map(row).join('')}</ul>`;
  if (items.length > limit) h += `<details class="more-list"><summary>Show all ${items.length}</summary><ul class="clist">${items.slice(limit, max).map(row).join('')}</ul></details>`;
  return h;
}
