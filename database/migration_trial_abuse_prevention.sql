-- ==============================================================================
-- NoteGen / SchoolPapers AI — Device Fingerprint & Trial Abuse Prevention
-- Run this in Supabase SQL Editor to enable device tracking across trials
-- ==============================================================================

create extension if not exists "pgcrypto";

create table if not exists device_trial_claims (
  id uuid primary key default gen_random_uuid(),
  device_fingerprint text not null,
  device_id text,
  ip_address text,
  user_id uuid references public.users(id) on delete set null,
  school_id uuid references schools(id) on delete cascade,
  claimed_at timestamptz default now()
);

-- Fast lookup indexes
create index if not exists idx_device_trial_claims_fp on device_trial_claims(device_fingerprint);
create index if not exists idx_device_trial_claims_did on device_trial_claims(device_id);
create index if not exists idx_device_trial_claims_ip on device_trial_claims(ip_address);
create index if not exists idx_device_trial_claims_school on device_trial_claims(school_id);
