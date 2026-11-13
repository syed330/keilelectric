/** Which scorecard category a pipeline stage feeds, decided from its name (and, failing that, its opportunities). */
import { lower } from './util.js';

export type Cat = 'none' | 'sql' | 'booked' | 'sold' | 'permitIn' | 'permitFin' | 'completed' | 'paid';
export const CAT_LABELS: Record<Cat, string> = {
  none: 'Not counted', sql: 'Marketing › Sales Qualified Leads', booked: 'CSR › Jobs Booked', sold: 'Sales › Sales Completed',
  permitIn: 'Permitting › In Process', permitFin: 'Permitting › Finalized', completed: 'Production › Jobs Completed', paid: 'Cash › Cash Collected',
};

export function autoCategory(name: string): Cat {
  const n = lower(name);
  // stages that never count (lost, cancelled, rejected…), and “unpaid / awaiting payment” style stages
  if (/\blost\b|dead|junk|spam|un.?qualif|dis.?qualif|not.?qualif|non.?qualif|not.?interested|no.?show|cancel|declin|reject|unpaid|awaiting.?pay|pending.?pay|past.?due|overdue/.test(n)) return 'none';
  if (/\bpaid\b|payment.?(received|collected|complete|made|in)|collected|deposit.?(received|paid|collected)|\bfunded\b|funding.?received|final.?payment/.test(n)) return 'paid';
  // permits & inspections (electrical / solar / HVAC work)
  if (/permit|inspection|plan.?(check|review)|city.?(submittal|approval|review)|county|interconnect|utility.?(app|approval)|\bpto\b|\bahj\b|hoa.?approval/.test(n)) {
    return /final|approv|issued|received|passed|complete|closed|granted|signed.?off|\bpto\b/.test(n) ? 'permitFin' : 'permitIn';
  }
  if (/complet|installed|install.?done|\bdone\b|finish/.test(n)) return 'completed';
  if (/\bwon\b|\bsold\b|closed.?won|signed|contract|proposal.?accepted|estimate.?(approved|accepted)|accepted/.test(n)) return 'sold';
  if (/book|appoint|appt|consult|estimate.?(set|sched)|meeting.?set|site.?visit|walk.?through/.test(n)) return 'booked';
  if (/qualif/.test(n)) return 'sql';
  return 'none';
}
export interface StageStats { total: number; open: number; won: number; lost: number; other: number }
export function smartCategory(name: string, c: StageStats): Cat {
  const cat = autoCategory(name);
  if (cat !== 'none') return cat;
  if (/\blost\b|dead|junk|spam|unqualif|disqualif|not.?interested|no.?show|cancel/.test(lower(name))) return 'none';
  if (c.total >= 3 && c.won / c.total >= 0.6) return 'sold';
  return 'none';
}
/** Do a contact's tags mark it as qualified? Words match anywhere in a tag; “unqualified”, “dq”, “spam”… never count. */
export function tagsQualify(tags: unknown, words: string[]): boolean {
  if (!words.length || !Array.isArray(tags)) return false;
  let yes = false;
  for (const raw of tags) {
    const t = lower(raw).trim();
    if (!t) continue;
    if (/un.?qualif|dis.?qualif|not.?qualif|non.?qualif|\bdq\b|spam|junk|bad.?lead|wrong.?number/.test(t)) return false;
    for (const w of words) {
      if (!w) continue;
      const hit = w.length <= 3 ? new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)').test(t) : t.includes(w);
      if (hit) yes = true;
    }
  }
  return yes;
}
export function tagWords(qualifiedTags: string): string[] {
  return String(qualifiedTags || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
}
