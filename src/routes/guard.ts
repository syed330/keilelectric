/** Wraps every route: setup problems (missing env vars, Supabase unreachable, schema not run) become a clear page. */
import { ConfigError } from '../lib/http.js';
import { DbError } from '../lib/db.js';
import { appLog } from '../lib/log.js';
import { e } from '../lib/util.js';

function setupPage(title: string, msg: string, steps: string[]): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${e(title)}</title></head>`
    + '<body style="margin:0;background:#f3f4f6;font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;color:#1d1f22"><div style="max-width:640px;margin:56px auto;padding:28px 32px;background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08)">'
    + `<h1 style="font-size:20px;margin:0 0 8px">${e(title)}</h1><p style="margin:0 0 12px;color:#4a4f57">${e(msg)}</p>`
    + (steps.length ? '<ol style="margin:0;padding-left:20px;color:#4a4f57">' + steps.map((s) => `<li>${s}</li>`).join('') + '</ol>' : '')
    + '</div></body></html>';
  return new Response(body, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
export function guard(fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    try { return await fn(req); }
    catch (err) {
      if (err instanceof ConfigError || (err instanceof DbError && err.code === 'config'))
        return setupPage('Finish setting up the app', err.message, ['In Netlify, open <b>Site configuration › Environment variables</b>.', 'Add <code>SUPABASE_URL</code>, <code>SUPABASE_SERVICE_ROLE_KEY</code>, <code>SESSION_SECRET</code> and <code>SYNC_SECRET</code> (see the README).', 'Redeploy the site (Deploys › Trigger deploy), then reload this page.']);
      if (err instanceof DbError && (err.code === '42P01' || /tables are missing/.test(err.message)))
        return setupPage('Create the database tables', 'Supabase is reachable, but the app’s tables don’t exist yet.', ['In Supabase, open <b>SQL Editor › New query</b>.', 'Paste the contents of <code>supabase/schema.sql</code> and click <b>Run</b>.', 'Reload this page.']);
      if (err instanceof DbError) return setupPage('Can’t reach the database', err.message, ['Check <code>SUPABASE_URL</code> and <code>SUPABASE_SERVICE_ROLE_KEY</code> in Netlify’s environment variables.', 'Make sure the Supabase project isn’t paused (free projects pause after a week without use).']);
      await appLog('Unhandled: ' + (err as Error).stack?.slice(0, 1500), new URL(req.url).pathname);
      return setupPage('Sorry — this page couldn’t load', 'An unexpected error stopped the page. Details are in Admin › System check and in Netlify › Logs › Functions.', []);
    }
  };
}
