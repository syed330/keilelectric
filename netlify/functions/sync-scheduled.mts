// Every 15 minutes: start the background sync (scheduled functions themselves may only run 30 seconds).
import type { Config } from '@netlify/functions';
export default async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || '';
  if (!base || !process.env.SYNC_SECRET) { console.error('[keil-scorecard] scheduled sync skipped: URL or SYNC_SECRET missing'); return new Response('skipped'); }
  const res = await fetch(base + '/.netlify/functions/sync-background', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-sync-secret': process.env.SYNC_SECRET }, body: JSON.stringify({ trigger: 'schedule' }) });
  console.log('[keil-scorecard] scheduled sync started:', res.status);
  return new Response('ok');
};
export const config: Config = { schedule: '*/15 * * * *' };
