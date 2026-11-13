-- Keil Pipeline Scorecard — Supabase schema.
-- Run once in Supabase › SQL Editor (safe to run again: everything is "if not exists").
-- Every table has Row Level Security ON and no policies, so the public (anon) key can read nothing.
-- Only the app's server-side service_role key (a Netlify environment variable) can read and write.

-- Settings: one row (admin password hash, GHL / ads / Jobber credentials, display options).
create table if not exists public.app_settings (
  id          int primary key default 1 check (id = 1),
  data        jsonb not null default '{}'::jsonb,
  version     int not null default 1,          -- optimistic locking (Jobber refresh tokens rotate)
  updated_at  timestamptz not null default now()
);

-- GoHighLevel copies, refreshed by the background sync.
create table if not exists public.ghl_pipelines (
  id text primary key, name text not null default '', stages jsonb not null default '[]'::jsonb, synced_at timestamptz not null default now()
);
create table if not exists public.ghl_opportunities (
  id text primary key, name text, pipeline_id text, stage_id text, status text, value numeric, source text,
  contact_id text, contact jsonb not null default '{}'::jsonb,
  created_at timestamptz, updated_at timestamptz, stage_changed_at timestamptz, status_changed_at timestamptz,
  synced_at timestamptz not null default now()
);
create index if not exists ghl_opportunities_pipeline on public.ghl_opportunities (pipeline_id);
create index if not exists ghl_opportunities_synced on public.ghl_opportunities (synced_at);

create table if not exists public.ghl_contacts (
  id text primary key, added_at timestamptz not null, name text, source text, tags text[] not null default '{}',
  email text, phone text, synced_at timestamptz not null default now()
);
create index if not exists ghl_contacts_added on public.ghl_contacts (added_at);

create table if not exists public.ghl_transactions (
  id text primary key, created_at timestamptz, amount numeric, status text, method text, contact_name text, detail text,
  synced_at timestamptz not null default now()
);
create index if not exists ghl_transactions_created on public.ghl_transactions (created_at);

create table if not exists public.ghl_invoices (
  id text primary key, number text, status text, total numeric, amount_paid numeric, amount_due numeric,
  issue_date timestamptz, due_date date, paid_at timestamptz, contact_name text, synced_at timestamptz not null default now()
);
create index if not exists ghl_invoices_issue on public.ghl_invoices (issue_date);

-- Jobber copies.
create table if not exists public.jobber_payments (
  id text primary key, amount numeric, entry_date timestamptz, method text, client_name text, invoice_id text, invoice_number text,
  synced_at timestamptz not null default now()
);
create index if not exists jobber_payments_entry on public.jobber_payments (entry_date);
create table if not exists public.jobber_invoices (
  id text primary key, number text, status text, total numeric, balance numeric, issued_date timestamptz, due_date date, client_name text,
  synced_at timestamptz not null default now()
);
create index if not exists jobber_invoices_issued on public.jobber_invoices (issued_date);

-- Daily ad spend per channel (Google Ads, Meta Ads) from the ad platforms.
create table if not exists public.ad_spend_daily (
  channel text not null, day date not null, amount numeric not null default 0, source text, synced_at timestamptz not null default now(),
  primary key (channel, day)
);

-- Sync history and the app's error log (shown in Admin › System check).
create table if not exists public.sync_runs (
  id bigserial primary key, started_at timestamptz not null default now(), finished_at timestamptz,
  status text not null default 'running', trigger text, counts jsonb not null default '{}'::jsonb,
  messages jsonb not null default '[]'::jsonb, duration_ms int
);
create index if not exists sync_runs_started on public.sync_runs (started_at desc);
create table if not exists public.app_log (
  id bigserial primary key, at timestamptz not null default now(), level text not null default 'error', message text not null, context text
);
create index if not exists app_log_at on public.app_log (at desc);

-- Lock everything down: RLS on, no policies, no rights for the public roles.
do $$
declare t text;
begin
  foreach t in array array['app_settings','ghl_pipelines','ghl_opportunities','ghl_contacts','ghl_transactions','ghl_invoices',
                           'jobber_payments','jobber_invoices','ad_spend_daily','sync_runs','app_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
grant usage, select on all sequences in schema public to service_role;

insert into public.app_settings (id) values (1) on conflict (id) do nothing;
