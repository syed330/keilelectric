/**
 * Local stand-in for Netlify (testing only): serves public/ and routes requests to the function files exactly as
 * their config.path says; /.netlify/functions/sync-background runs in the background and answers 202 like Netlify.
 * Usage: npx tsx scripts/local-netlify.mts  (PORT, plus the same environment variables as on Netlify)
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import site from '../netlify/functions/site.mts';
import admin from '../netlify/functions/admin.mts';
import exportFn from '../netlify/functions/export.mts';
import syncBg from '../netlify/functions/sync-background.mts';

const ROOT = new URL('../public/', import.meta.url).pathname;
const TYPES: Record<string, string> = { '.css': 'text/css', '.js': 'text/javascript', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.json': 'application/json' };
const port = Number(process.env.PORT || 8888);

function route(path: string): ((req: Request) => Promise<Response>) | null {
  const p = path.replace(/\/+$/, '') || '/';
  if (p === '/' || p === '/pipelines') return site;
  if (p === '/admin' || p === '/admin/jobber/callback') return admin;
  if (p === '/export') return exportFn;
  return null;
}
http.createServer(async (nreq, nres) => {
  const url = new URL(nreq.url || '/', `http://${nreq.headers.host}`);
  const chunks: Buffer[] = []; for await (const c of nreq) chunks.push(c as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers(); for (const [k, v] of Object.entries(nreq.headers)) if (typeof v === 'string') headers.set(k, v); else if (Array.isArray(v)) headers.set(k, v.join(', '));
  const req = new Request(url, { method: nreq.method, headers, body: ['GET', 'HEAD'].includes(nreq.method || 'GET') ? undefined : body });
  try {
    if (url.pathname === '/.netlify/functions/sync-background') {
      nres.writeHead(202); nres.end();
      syncBg(req).catch((err: Error) => console.error('background error', err));
      return;
    }
    const fn = route(url.pathname);
    if (fn) {
      const res = await fn(req);
      const h: Record<string, string | string[]> = {};
      res.headers.forEach((v, k) => { if (k !== 'set-cookie') h[k] = v; });
      const sc = res.headers.getSetCookie(); if (sc.length) h['set-cookie'] = sc;
      nres.writeHead(res.status, h); nres.end(Buffer.from(await res.arrayBuffer()));
      return;
    }
    const file = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (!file.startsWith(ROOT)) { nres.writeHead(403); nres.end(); return; }
    const st = await stat(file).catch(() => null);
    if (!st || !st.isFile()) { nres.writeHead(404, { 'Content-Type': 'text/plain' }); nres.end('Not found'); return; }
    nres.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }); nres.end(await readFile(file));
  } catch (err) { console.error(err); nres.writeHead(500); nres.end('local server error'); }
}).listen(port, () => console.log('local netlify on', port));
