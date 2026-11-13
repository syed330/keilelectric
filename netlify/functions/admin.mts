// Admin panel (/admin) and the Jobber sign-in callback (/admin/jobber/callback).
import type { Config } from '@netlify/functions';
import { guard } from '../../src/routes/guard.js';
import { handleAdmin } from '../../src/routes/admin.js';
import { handleJobberCallback } from '../../src/routes/site.js';
export default guard(async (req) => (new URL(req.url).pathname.startsWith('/admin/jobber/callback') ? handleJobberCallback(req) : handleAdmin(req)));
export const config: Config = { path: ['/admin', '/admin/jobber/callback'] };
