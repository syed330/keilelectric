/** Error log kept in Supabase (app_log) and shown in Admin › System check. Never throws. */
import { insert, select, remove, dbConfigured } from './db.js';

export async function appLog(message: string, context = '', level = 'error'): Promise<void> {
  const msg = message.replace(/\s+/g, ' ').slice(0, 2000);
  console.error(`[keil-scorecard] ${level}: ${msg}${context ? ' (' + context + ')' : ''}`);
  if (!dbConfigured()) return;
  try { await insert('app_log', { level, message: msg, context: context.slice(0, 300) }); } catch { /* logging must never break a page */ }
}
export async function recentErrors(n = 15): Promise<{ at: string; level: string; message: string; context: string }[]> {
  try { return await select('app_log', `select=at,level,message,context&order=at.desc&limit=${n}`); } catch { return []; }
}
export async function clearLog(): Promise<void> { await remove('app_log', 'id=gte.0'); }
