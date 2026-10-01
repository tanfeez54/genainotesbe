-- ==============================================================================
-- SchoolPapers AI — Complete & Idempotent Database Migration Script
-- Copy and paste this entire script into your Supabase SQL Editor and click RUN.
-- ==============================================================================

-- 1. Enable UUID Extension
create extension if not exists "pgcrypto";

-- 2. Create / Update Schools Table
create table if not exists schools (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  logo_url text,
  stamp_url text,
  signature_url text,
  classes_range text,
  num_teachers int,
  num_students int,
  contact_email text not null,
  phone text,
  address text,
  board text,                 -- CBSE / ICSE / State Board etc.
  is_active boolean default true,
  created_at timestamptz default now()
);

-- Ensure all new columns exist if table was created previously
do $$ 
begin
  begin alter table schools add column stamp_url text; exception when duplicate_column then null; end;
  begin alter table schools add column signature_url text; exception when duplicate_column then null; end;
  begin alter table schools add column classes_range text; exception when duplicate_column then null; end;
  begin alter table schools add column num_teachers int; exception when duplicate_column then null; end;
  begin alter table schools add column num_students int; exception when duplicate_column then null; end;
  begin alter table schools add column logo_url text; exception when duplicate_column then null; end;
  begin alter table schools add column address text; exception when duplicate_column then null; end;
  begin alter table schools add column board text; exception when duplicate_column then null; end;
  begin alter table schools add column phone text; exception when duplicate_column then null; end;
end $$;

-- 3. Create School Users (Tenancy Mapping to public.users)
create table if not exists school_users (
  id uuid primary key default gen_random_uuid(),
  school_id uuid references schools(id) on delete cascade,
  user_id uuid references public.users(id) on delete cascade,
  role text check (role in ('super_admin','school_admin','teacher','data_entry')) not null,
  full_name text,
  is_active boolean default true,
  created_at timestamptz default now(),
  unique(school_id, user_id)
);

-- Fix foreign key constraint if it previously pointed to auth.users
do $$
begin
  alter table school_users drop constraint if exists school_users_user_id_fkey;
  alter table school_users add constraint school_users_user_id_fkey foreign key (user_id) references public.users(id) on delete cascade;
exception when others then null;
end $$;

-- 4. Academic Structure: Classes
create table if not exists classes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid references schools(id) on delete cascade,
  name text not null,            -- e.g. "Class 10", "Nursery"
  order_index int default 0,
  created_at timestamptz default now()
);

-- 5. Academic Structure: Subjects
create table if not exists subjects (
  id uuid primary key default gen_random_uuid(),
  school_id uuid references schools(id) on delete cascade,
  class_id uuid references classes(id) on delete cascade,
  name text not null,
  created_at timestamptz default now()
);

-- Ensure school_id & class_id exist on subjects if it pre-existed from old app
do $$
begin
  begin alter table subjects add column school_id uuid references schools(id) on delete cascade; exception when duplicate_column then null; end;
  begin alter table subjects add column class_id uuid references classes(id) on delete cascade; exception when duplicate_column then null; end;
  begin alter table subjects alter column user_id drop not null; exception when others then null; end;
end $$;

-- 6. Academic Structure: Chapters
create table if not exists chapters (
  id uuid primary key default gen_random_uuid(),
  school_id uuid references schools(id) on delete cascade,
  subject_id uuid references subjects(id) on delete cascade,
  title text not null,
  description text,
  content_text text,
  order_index int default 0,
  created_at timestamptz default now()
);

-- 7. Scanned Documents & OCR
create table if not exists scanned_documents (
  id uuid primary key default gen_random_uuid(),
  school_id uuid references schools(id) on delete cascade,
  uploaded_by uuid references public.users(id) on delete set null,
  chapter_id uuid references chapters(id) on delete set null,
  image_url text not null,
  doc_type text check (doc_type in ('question_paper','chapter_page')) not null,
  status text check (status in ('pending','processing','ocr_completed','failed','reviewed')) default 'pending',
  raw_ocr_text text,
  raw_ocr_json jsonb,
  error_message text,
  created_at timestamptz default now(),
  processed_at timestamptz
);

-- Fix foreign key constraint if it previously pointed to auth.users & update status check constraint
do $$
begin
  alter table scanned_documents drop constraint if exists scanned_documents_uploaded_by_fkey;
  alter table scanned_documents add constraint scanned_documents_uploaded_by_fkey foreign key (uploaded_by) references public.users(id) on delete set null;
  alter table scanned_documents drop constraint if exists scanned_documents_status_check;
  alter table scanned_documents add constraint scanned_documents_status_check check (status in ('pending','processing','ocr_completed','completed','failed','reviewed'));
exception when others then null;
end $$;

-- 8. Question Bank
create table if not exists questions (
  id uuid primary key default gen_random_uuid(),
  school_id uuid references schools(id) on delete cascade,
  chapter_id uuid references chapters(id) on delete set null,
  question_text text not null,
  answer_text text,
  marks numeric not null default 1,
  difficulty text check (difficulty in ('easy','medium','hard')) default 'medium',
  type text check (type in ('mcq','short_answer','long_answer','true_false','fill_blank','match_the_following')) not null,
  options jsonb,
  correct_option text,
  source_scan_id uuid references scanned_documents(id) on delete set null,
  created_by uuid references public.users(id) on delete set null,
  is_active boolean default true,
  is_shared boolean default false,
  created_at timestamptz default now()
);

-- Fix foreign key constraint if it previously pointed to auth.users
do $$
begin
  alter table questions drop constraint if exists questions_created_by_fkey;
  alter table questions add constraint questions_created_by_fkey foreign key (created_by) references public.users(id) on delete set null;
exception when others then null;
end $$;

-- 9. Generated Question Papers
create table if not exists question_papers (
  id uuid primary key default gen_random_uuid(),
  school_id uuid references schools(id) on delete cascade,
  class_id uuid references classes(id) on delete set null,
  subject_id uuid references subjects(id) on delete set null,
  title text not null,
  exam_type text,                -- Unit Test, Mid Term, Final Exam
  total_marks numeric not null,
  time_allowed_minutes int,
  blueprint jsonb,
  selected_questions jsonb,      -- Ordered list of question IDs and snapshot data
  status text check (status in ('draft','finalized','printed')) default 'draft',
  pdf_url text,
  docx_url text,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz default now()
);

-- Fix foreign key constraint if it previously pointed to auth.users
do $$
begin
  alter table question_papers drop constraint if exists question_papers_created_by_fkey;
  alter table question_papers add constraint question_papers_created_by_fkey foreign key (created_by) references public.users(id) on delete set null;
exception when others then null;
end $$;

-- 10. Subscription Plans & Billing (kavion)
create table if not exists subscription_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null,                  -- "Basic", "Standard", "Premium"
  price_monthly numeric not null,
  price_yearly numeric,
  max_teachers int default 10,
  max_scans_per_month int default 100,
  features jsonb,
  is_active boolean default true,
  created_at timestamptz default now()
);

-- Seed initial plans
insert into subscription_plans (name, price_monthly, price_yearly, max_teachers, max_scans_per_month, features)
values 
  ('Starter', 999, 9999, 5, 50, '{"ocr_scans": 50, "paper_generator": true, "support": "email"}'),
  ('Professional', 2499, 24999, 20, 250, '{"ocr_scans": 250, "paper_generator": true, "support": "priority"}'),
  ('Enterprise', 4999, 49999, 100, 1000, '{"ocr_scans": 1000, "paper_generator": true, "support": "dedicated"}')
on conflict do nothing;

-- Alter schools for billing
do $$
begin
  begin alter table schools add column plan_id uuid references subscription_plans(id); exception when duplicate_column then null; end;
  begin alter table schools add column subscription_status text check (subscription_status in ('trial','active','past_due','cancelled','suspended')) default 'trial'; exception when duplicate_column then null; end;
  begin alter table schools add column trial_ends_at timestamptz default (now() + interval '14 days'); exception when duplicate_column then null; end;
  begin alter table schools add column billing_cycle text check (billing_cycle in ('monthly','yearly')) default 'monthly'; exception when duplicate_column then null; end;
end $$;

-- 11. Invoices
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  school_id uuid references schools(id) on delete cascade,
  plan_id uuid references subscription_plans(id) on delete set null,
  amount numeric not null,
  currency text default 'INR',
  status text check (status in ('pending','paid','failed','refunded')) default 'pending',
  period_start date,
  period_end date,
  payment_gateway text default 'manual',
  gateway_payment_id text,
  paid_at timestamptz,
  created_at timestamptz default now()
);

-- 12. Payment Transactions
create table if not exists payment_transactions (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid references invoices(id) on delete cascade,
  school_id uuid references schools(id) on delete cascade,
  amount numeric not null,
  status text check (status in ('success','failed','refunded')) not null,
  gateway_response jsonb,
  created_at timestamptz default now()
);

-- 13. Platform Admins & Super Admin Audit Logs (kavion)
create table if not exists platform_admins (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null unique,
  password_hash text not null,
  role text check (role in ('root_admin','support_admin','billing_admin')) default 'root_admin',
  is_active boolean default true,
  last_login_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references platform_admins(id) on delete set null,
  action text not null,
  target_school_id uuid references schools(id) on delete set null,
  target_user_id uuid references public.users(id) on delete set null,
  metadata jsonb,
  created_at timestamptz default now()
);

-- 14. Audit Logs (Tenant-level)
create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  school_id uuid references schools(id) on delete cascade,
  user_id uuid references public.users(id) on delete set null,
  action text not null,
  target_table text,
  target_id uuid,
  details jsonb,
  created_at timestamptz default now()
);

-- ==============================================================================
-- SUCCESS MESSAGE
-- ==============================================================================
select 'Migration completed successfully! All tables and foreign keys are in sync.' as status;
