# Keil Electric — Pipeline Scorecard (Netlify + Supabase)

The scorecard, pipeline board, admin panel, Google Sheets export and all integrations (GoHighLevel, Jobber, Google Ads, Meta Ads),
rebuilt as **Netlify Functions (TypeScript)** with **Supabase** as the database. Same pages, same numbers as the PHP version.

## How it works

```
Every 15 min (and “Sync now”) ──► sync-background (Netlify background function, up to 15 min)
                                   │  reads GoHighLevel · Jobber · Google Ads · Meta Ads
                                   ▼
                              Supabase (Postgres) ◄── pages read from here: /, /pipelines, /admin, /export
```

- Netlify doesn’t run PHP and stops normal functions after ~10 seconds, so the slow work (reading GHL) happens in a
  **background sync**. Report pages compute from the Supabase copy and load in well under a second.
- The first sync copies about **400 days** of contacts (month by month), every opportunity, invoices/payments and ad spend.
  Later syncs refresh recent data, plus a full refresh once a day. A source you connect later (Jobber, an ad account) gets its
  full year on its first sync. Opportunities deleted in GHL are removed — but only after a complete read.
- All secrets (GHL token, Jobber/Google/Meta keys, password hashes) live in Supabase, readable only with the server-side key.
  Every table has Row Level Security on with no policies, so the public (anon) key can read nothing.

## Deploy (about 15 minutes)

### 1. Supabase
1. Create a project at supabase.com (any region near you; the free plan works).
2. **SQL Editor › New query** → paste all of `supabase/schema.sql` → **Run**. (Safe to run again later.)
3. **Project Settings › API** (or *API Keys*): copy the **Project URL** and the **service_role** key
   (or a new **secret** key, `sb_secret_…`). Do **not** use the anon / publishable key.

### 2. Netlify
1. Put this folder in a GitHub repository and **Add new site › Import an existing project**, or deploy it with the Netlify CLI
   (`npm install`, then `npx netlify deploy --prod`). Build settings come from `netlify.toml` — nothing to fill in.
2. **Site configuration › Environment variables** — add (see `.env.example`):

   | Variable | Value |
   |---|---|
   | `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | the service_role / secret key |
   | `SESSION_SECRET` | a long random string (`openssl rand -hex 32`) |
   | `SYNC_SECRET` | another long random string |

3. **Deploys › Trigger deploy** so the functions pick up the variables.

### 3. First run
1. Open `https://<your-site>/admin` → create the admin password.
2. **GHL connection** → Location ID + Private Integration token → **Connect and test**. The first sync starts automatically;
   watch it on **Overview** (large accounts: a few minutes).
3. Optional: **Ad spend** (Google Ads / Meta), **Jobber**, **Google Sheets**, **Access** (report password).
4. **System check** confirms the environment variables, every Supabase table, the last sync and recent errors.

Old addresses still work: `/index.php` → `/`, `/pipelines.php` → `/pipelines`, `/export.php` → `/export`.

## GoHighLevel token scopes
`View Contacts`, `View Opportunities`, `View Locations`; for Cash without Jobber: `View Payment Transactions`, `View Invoices`.

## Jobber
Admin › Jobber shows the **callback URL** to register in your Jobber app: `https://<your-site>/admin/jobber/callback`.
Give the app read access to Invoices, Payments and Clients. Jobber’s refresh tokens rotate; each new pair is saved with a
version check in Supabase, so two requests refreshing at the same moment can’t lock you out.

## Ad spend
GoHighLevel’s API doesn’t expose its Ads Reporting numbers, so spend comes from the Meta Marketing API and the Google Ads API
(found automatically: the newest Google Ads API version that answers), or from manual entries. Leads, bookings and sales are
matched to a channel by their GHL source (keywords in Admin › Ad spend).

## Google Sheets
Admin › Google Sheets → turn on the export, copy the link → open `public/downloads/Keil-Marketing-CAC-ROI.xlsx` in Google
Sheets → paste the link on the Setup tab. The sheet reads `/export?key=…&view=summary|months` with `IMPORTDATA`.

## Where each number comes from
Same rules as the PHP version:

| Category | Metric | Source |
|---|---|---|
| Marketing | Leads | GHL contacts, dated by when they were added |
| | Sales Qualified Leads | leads tagged like “qualified”/“sql” (never “unqualified”, “dq”, “spam”), or whose opportunity moved past the first stage and isn’t lost — counted on the lead’s day |
| CSR | Jobs Booked / Booking % | stages like “Appointment Set”, “Estimate Scheduled” / booked ÷ leads |
| Sales | Sales Completed | opportunities marked Won (status-change date) |
| Permitting | In process now / Moved in / Finalized | jobs in a permit stage right now / moved into one / “Permit Issued”, “Final Inspection Passed” |
| Production | Jobs Completed | stages like “Job Complete”, “Installed” |
| Cash / Payments | Collected, payments, paid invoices, invoiced, owed now | Jobber → GHL Payments → GHL Invoices → “Paid” stages |
| Ad Spend | spend, cost per lead/booking, ROAS | Google Ads / Meta Ads APIs or manual entries |

## Project layout
```
netlify/functions/   site.mts (/, /pipelines) · admin.mts (/admin, Jobber callback) · export.mts (/export)
                     sync-background.mts (the sync) · sync-scheduled.mts (every 15 min)
src/lib/             db (Supabase REST) · settings · sync · data (report data) · report · period · ghl · jobber · ads · http (sessions, CSRF)
src/views/           scorecard · board · admin
src/routes/          site · admin · guard (setup errors → clear pages)
public/              CSS, JS, Chart.js, Bootstrap, the Google Sheets workbook
supabase/schema.sql  the database
scripts/local-netlify.mts  run everything locally: npx tsx scripts/local-netlify.mts (needs the env vars)
```

## Changing the sync interval
Edit the cron in `netlify/functions/sync-scheduled.mts` (`*/15 * * * *` = every 15 minutes) and redeploy.

## Troubleshooting
- **“Finish setting up the app”** — an environment variable is missing; add it and redeploy.
- **“Create the database tables”** — run `supabase/schema.sql` in the Supabase SQL Editor.
- **Numbers look old** — Admin › Overview shows the last sync and its messages; click **Sync now**.
- **Errors** — Admin › System check › Recent errors, and Netlify › Logs › Functions (`sync-background` logs each run).
- **Supabase free projects pause** after a week without activity; the 15-minute sync keeps it active.
