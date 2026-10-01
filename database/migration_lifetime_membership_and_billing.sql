-- ==============================================================================
-- DATABASE MIGRATION: One-Time Lifetime Membership & ₹5 Per Generation Billing
-- Database: Supabase / PostgreSQL
-- Features:
--   1. One-Time Lifetime Membership Plans (Starter @ ₹1,999 & Institutional @ ₹4,999)
--   2. Pay-as-you-go "Recharge & Use" Wallet (₹5.00 per AI Paper Generation)
--   3. Atomic deduction and recharge stored procedures (RPCs)
--   4. Wallet transactions ledger & Cashfree PG invoices
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. SUBSCRIPTION PLANS TABLE (Lifetime Membership)
-- ------------------------------------------------------------------------------
create table if not exists subscription_plans (
  id uuid primary key default gen_random_uuid(),
  slug text,
  name text not null,
  price_monthly numeric(10,2) not null default 0.00,
  price_yearly numeric(10,2) not null default 0.00,
  included_generations_per_month integer not null default 10,
  cost_per_extra_generation numeric(10,2) not null default 5.00,
  max_teachers integer not null default 5,
  features jsonb not null default '[]'::jsonb,
  is_active boolean default true,
  created_at timestamptz default now()
);

-- Safely add missing columns if table already existed without them
do $$ 
begin
  begin alter table subscription_plans add column slug text; exception when duplicate_column then null; end;
  begin alter table subscription_plans add column included_generations_per_month integer not null default 10; exception when duplicate_column then null; end;
  begin alter table subscription_plans add column cost_per_extra_generation numeric(10,2) not null default 5.00; exception when duplicate_column then null; end;
end $$;

-- Populate slug for any existing rows where slug might be null
update subscription_plans
set slug = lower(regexp_replace(trim(name), '[^a-zA-Z0-9]+', '_', 'g'))
where slug is null or slug = '';

-- Ensure unique constraint on slug
do $$ 
begin
  alter table subscription_plans add constraint subscription_plans_slug_key unique (slug);
exception when others then null;
end $$;

-- Seed / Upsert One-Time Lifetime Membership plans
insert into subscription_plans (slug, name, price_monthly, price_yearly, included_generations_per_month, cost_per_extra_generation, max_teachers, features)
values
  (
    'trial',
    '14-Day Free Trial',
    0.00,
    0.00,
    10,
    5.00,
    2,
    '["10 Free AI Generations (₹50 welcome credit)", "Paper Generator & Watermark Customization", "Basic Email Support", "Up to 2 Teachers"]'::jsonb
  ),
  (
    'lifetime_starter',
    'Starter Lifetime Membership',
    500.00,
    500.00,
    120,
    5.00,
    5,
    '["One-Time Payment — Lifetime Access (No Renewals)", "Includes ₹600 Free Generation Credits (120 Generations • +20% Bonus)", "Custom School Logo, Stamp & Watermark", "Full Question Bank & PDF Export", "Up to 5 Teachers", "Pay-as-you-go @ ₹5/extra generation with bonuses"]'::jsonb
  ),
  (
    'lifetime_pro',
    'Institutional Lifetime Membership',
    1000.00,
    1000.00,
    300,
    5.00,
    100,
    '["One-Time Payment — Lifetime Access (No Renewals)", "Includes ₹1,500 Free Generation Credits (300 Generations • +50% Bonus)", "Unlimited Teachers & Coordinators", "OCR Document & Textbook Scanning", "Priority AI Generation Queue", "Dedicated Support", "Pay-as-you-go @ ₹5/extra generation with bonuses"]'::jsonb
  )
on conflict (slug) do update set
  name = excluded.name,
  price_monthly = excluded.price_monthly,
  price_yearly = excluded.price_yearly,
  included_generations_per_month = excluded.included_generations_per_month,
  cost_per_extra_generation = excluded.cost_per_extra_generation,
  max_teachers = excluded.max_teachers,
  features = excluded.features;


-- ------------------------------------------------------------------------------
-- 2. SCHOOLS TABLE (Add Wallet & Membership Columns)
-- ------------------------------------------------------------------------------
do $$ 
begin
  begin alter table schools add column wallet_balance numeric(10,2) not null default 50.00 check (wallet_balance >= 0); exception when duplicate_column then null; end;
  begin alter table schools add column cost_per_generation numeric(10,2) not null default 5.00 check (cost_per_generation >= 0); exception when duplicate_column then null; end;
  begin alter table schools add column generations_used integer not null default 0 check (generations_used >= 0); exception when duplicate_column then null; end;
  begin alter table schools add column monthly_generation_quota integer not null default 10; exception when duplicate_column then null; end;
  begin alter table schools add column plan_id uuid references subscription_plans(id); exception when duplicate_column then null; end;
  begin alter table schools add column subscription_status text check (subscription_status in ('trial','active','past_due','cancelled','suspended','expired')) default 'trial'; exception when duplicate_column then null; end;
  begin alter table schools add column trial_ends_at timestamptz default (now() + interval '14 days'); exception when duplicate_column then null; end;
  begin alter table schools add column subscription_starts_at timestamptz default now(); exception when duplicate_column then null; end;
  begin alter table schools add column subscription_ends_at timestamptz default (now() + interval '14 days'); exception when duplicate_column then null; end;
  begin alter table schools add column billing_cycle text default 'lifetime'; exception when duplicate_column then null; end;
end $$;

-- Update billing_cycle check constraint to allow 'lifetime'
do $$
begin
  alter table schools drop constraint if exists schools_billing_cycle_check;
  alter table schools add constraint schools_billing_cycle_check check (billing_cycle in ('monthly','yearly','lifetime'));
exception when others then null;
end $$;

-- Link existing schools without a plan to default 'trial' plan
update schools
set plan_id = (select id from subscription_plans where slug = 'trial' limit 1)
where plan_id is null;

-- Ensure existing schools have at least ₹50 welcome balance
update schools
set wallet_balance = 50.00
where wallet_balance is null or wallet_balance = 0;


-- ------------------------------------------------------------------------------
-- 3. WALLET TRANSACTIONS LEDGER TABLE
-- ------------------------------------------------------------------------------
create table if not exists wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(id) on delete cascade,
  user_id uuid references public.users(id) on delete set null,
  amount numeric(10,2) not null,              -- negative for deductions (-5.00), positive for topups (+100.00)
  type text check (type in ('welcome_bonus','topup','generation_fee','plan_quota','refund','adjustment')) not null,
  description text not null,
  reference_id text,                           -- e.g. question_paper_id, cashfree_payment_id, order_id
  balance_after numeric(10,2) not null,
  created_at timestamptz default now()
);

create index if not exists idx_wallet_tx_school on wallet_transactions(school_id);
create index if not exists idx_wallet_tx_created on wallet_transactions(created_at desc);


-- ------------------------------------------------------------------------------
-- 4. INVOICES TABLE (Cashfree Integration)
-- ------------------------------------------------------------------------------
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(id) on delete cascade,
  plan_id uuid references subscription_plans(id) on delete set null,
  amount numeric(10,2) not null,
  currency text default 'INR',
  status text check (status in ('pending','paid','failed','refunded')) default 'pending',
  type text check (type in ('subscription','wallet_recharge')) default 'subscription',
  period_start date,
  period_end date,
  payment_gateway text default 'cashfree',
  razorpay_order_id text,
  razorpay_payment_id text,
  razorpay_signature text,
  paid_at timestamptz,
  created_at timestamptz default now()
);

do $$
begin
  begin alter table invoices add column if not exists type text check (type in ('subscription','wallet_recharge')) default 'subscription'; exception when others then null; end;
  begin alter table invoices add column if not exists razorpay_order_id text; exception when others then null; end;
  begin alter table invoices add column if not exists razorpay_payment_id text; exception when others then null; end;
  begin alter table invoices add column if not exists razorpay_signature text; exception when others then null; end;
end $$;


-- ------------------------------------------------------------------------------
-- 5. ATOMIC DEDUCTION RPC: deduct_school_generation_fee
-- Atomically checks balance and deducts ₹5.00 upon AI paper generation
-- ------------------------------------------------------------------------------
create or replace function deduct_school_generation_fee(
  p_school_id uuid,
  p_user_id uuid,
  p_paper_id text default null,
  p_description text default 'AI Question Paper Generation (₹5.00)'
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_school record;
  v_new_balance numeric(10,2);
  v_cost numeric(10,2);
  v_tx_id uuid;
begin
  -- Lock school record for row-level concurrency protection
  select id, wallet_balance, cost_per_generation, subscription_status, trial_ends_at, subscription_ends_at, generations_used
  into v_school
  from schools
  where id = p_school_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'error', 'School not found');
  end if;

  -- Check subscription status
  if v_school.subscription_status in ('suspended', 'cancelled') then
    return jsonb_build_object(
      'success', false,
      'error', 'Subscription is ' || v_school.subscription_status || '. Please contact support or activate membership.'
    );
  end if;

  -- Check trial expiration
  if v_school.subscription_status = 'trial' and v_school.trial_ends_at is not null and v_school.trial_ends_at < now() then
    return jsonb_build_object(
      'success', false,
      'error', 'Your 14-day free trial has expired. Please activate a Lifetime Membership plan to continue generating question papers.'
    );
  end if;

  v_cost := coalesce(v_school.cost_per_generation, 5.00);

  -- Check wallet balance (minimum ₹5 required)
  if v_school.wallet_balance < v_cost then
    return jsonb_build_object(
      'success', false,
      'error', 'Insufficient balance. Generation requires ₹' || to_char(v_cost, 'FM999990.00') || ', current balance is ₹' || to_char(v_school.wallet_balance, 'FM999990.00'),
      'current_balance', v_school.wallet_balance,
      'required_amount', v_cost
    );
  end if;

  -- Deduct ₹5 fee and update generation count
  v_new_balance := v_school.wallet_balance - v_cost;

  update schools
  set
    wallet_balance = v_new_balance,
    generations_used = v_school.generations_used + 1
  where id = p_school_id;

  -- Insert ledger entry
  insert into wallet_transactions (
    school_id,
    user_id,
    amount,
    type,
    description,
    reference_id,
    balance_after
  ) values (
    p_school_id,
    p_user_id,
    -v_cost,
    'generation_fee',
    p_description,
    p_paper_id,
    v_new_balance
  )
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true,
    'cost_deducted', v_cost,
    'balance_after', v_new_balance,
    'generations_used', v_school.generations_used + 1,
    'transaction_id', v_tx_id
  );
end;
$$;


-- ------------------------------------------------------------------------------
-- 6. ATOMIC RECHARGE RPC: credit_school_wallet
-- Atomically credits school wallet with recharge amount + bonus
-- ------------------------------------------------------------------------------
create or replace function credit_school_wallet(
  p_school_id uuid,
  p_user_id uuid,
  p_amount numeric(10,2),
  p_ref_id text default null,
  p_desc text default 'Wallet Recharge'
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_new_balance numeric(10,2);
  v_tx_id uuid;
begin
  if p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Recharge amount must be greater than zero');
  end if;

  update schools
  set wallet_balance = wallet_balance + p_amount
  where id = p_school_id
  returning wallet_balance into v_new_balance;

  if not found then
    return jsonb_build_object('success', false, 'error', 'School not found');
  end if;

  insert into wallet_transactions (
    school_id,
    user_id,
    amount,
    type,
    description,
    reference_id,
    balance_after
  ) values (
    p_school_id,
    p_user_id,
    p_amount,
    'topup',
    p_desc,
    p_ref_id,
    v_new_balance
  )
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true,
    'amount_credited', p_amount,
    'balance_after', v_new_balance,
    'transaction_id', v_tx_id
  );
end;
$$;


-- ------------------------------------------------------------------------------
-- 7. ROW LEVEL SECURITY (RLS) POLICIES
-- ------------------------------------------------------------------------------
alter table wallet_transactions enable row level security;

do $$
begin
  drop policy if exists "school_members_select_wallet_tx" on wallet_transactions;
  create policy "school_members_select_wallet_tx" on wallet_transactions
    for select using (
      school_id in (
        select school_id from school_users
        where user_id = auth.uid() and is_active = true
      )
    );
exception when others then null;
end $$;

alter table subscription_plans enable row level security;

do $$
begin
  drop policy if exists "public_view_subscription_plans" on subscription_plans;
  create policy "public_view_subscription_plans" on subscription_plans
    for select using (is_active = true);
exception when others then null;
end $$;
