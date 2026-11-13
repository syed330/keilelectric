// Background sync (Netlify background function: runs up to 15 minutes; the caller gets 202 right away).
// Started by sync-scheduled (every 15 min) and by Admin › Sync now. Protected by SYNC_SECRET.
import { runSync } from '../../src/lib/sync.js';
import { appLog } from '../../src/lib/log.js';
export default async (req: Request) => {
  const secret = process.env.SYNC_SECRET || '';
  if (!secret || req.headers.get('x-sync-secret') !== secret) { await appLog('Sync request refused: wrong or missing SYNC_SECRET.', 'sync-background'); return new Response('Forbidden', { status: 403 }); }
  let body: { trigger?: string; full?: boolean } = {};
  try { body = await req.json(); } catch { /* defaults */ }
  try {
    const r = await runSync(String(body.trigger || 'background').slice(0, 40), { full: !!body.full });
    console.log('[keil-scorecard] sync', r.status, JSON.stringify(r.counts), `${r.durationMs} ms`);
  } catch (err) { await appLog('Sync crashed: ' + ((err as Error).stack || (err as Error).message).slice(0, 1500), 'sync-background'); }
  return new Response('done');
};
