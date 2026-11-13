// CSV export read by the Google Sheet with IMPORTDATA (/export?key=…&view=summary|months).
import type { Config } from '@netlify/functions';
import { guard } from '../../src/routes/guard.js';
import { handleExport } from '../../src/routes/site.js';
export default guard(handleExport);
export const config: Config = { path: '/export' };
