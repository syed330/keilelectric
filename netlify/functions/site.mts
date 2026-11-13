// Report pages: / (scorecard) and /pipelines (board).
import type { Config } from '@netlify/functions';
import { guard } from '../../src/routes/guard.js';
import { handleScorecard, handleBoard } from '../../src/routes/site.js';
export default guard(async (req) => (new URL(req.url).pathname.replace(/\/+$/, '') === '/pipelines' ? handleBoard(req) : handleScorecard(req)));
export const config: Config = { path: ['/', '/pipelines'] };
