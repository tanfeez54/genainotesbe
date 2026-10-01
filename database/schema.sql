-- ============================================================
-- NoteGen AI Database Schema
-- Run this in Supabase SQL Editor → New Query → Run
-- ============================================================

create extension if not exists pgcrypto;

-- Profile row is auto-created by trigger on auth.users insert
create table profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    full_name text,
    avatar_url text,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

create table subjects (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    name text not null,
    description text,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

create table notes (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    subject_id uuid references subjects(id) on delete set null,
    title text not null,
    topic text,
    purpose text,
    level text,
    language text default 'English',
    note_length text default 'medium',
    status text default 'draft'
        check (status in ('draft','generating','completed','failed')),
    summary text,
    content jsonb,
    word_count integer default 0,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

create table note_sources (
    id uuid primary key default gen_random_uuid(),
    note_id uuid not null references notes(id) on delete cascade,
    url text not null,
    title text,
    domain text,
    extracted_content text,
    content_hash text,
    fetch_status text default 'pending'
        check (fetch_status in ('pending','processing','completed','failed')),
    error_message text,
    fetched_at timestamptz,
    created_at timestamptz default now()
);

create table note_generation_settings (
    id uuid primary key default gen_random_uuid(),
    note_id uuid not null references notes(id) on delete cascade,
    purpose text,
    level text,
    language text,
    note_length text,
    tone text,
    include_summary boolean default true,
    include_key_points boolean default true,
    include_examples boolean default true,
    include_formulas boolean default false,
    include_common_mistakes boolean default false,
    include_practice_questions boolean default false,
    custom_instruction text,
    created_at timestamptz default now()
);

create table note_sections (
    id uuid primary key default gen_random_uuid(),
    note_id uuid not null references notes(id) on delete cascade,
    section_type text,
    title text not null,
    content text,
    position integer default 0,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

create table note_generation_jobs (
    id uuid primary key default gen_random_uuid(),
    note_id uuid not null references notes(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    status text default 'queued'
        check (status in ('queued','processing','completed','failed')),
    current_step text,
    progress integer default 0,
    error_message text,
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz default now()
);

-- ============================================================
-- Auto-create profile on signup
-- ============================================================
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- Row Level Security
-- ============================================================
alter table profiles enable row level security;
alter table subjects enable row level security;
alter table notes enable row level security;
alter table note_sources enable row level security;
alter table note_generation_settings enable row level security;
alter table note_sections enable row level security;
alter table note_generation_jobs enable row level security;

create policy "own profile" on profiles for all using (auth.uid() = id);
create policy "own subjects" on subjects for all using (auth.uid() = user_id);
create policy "own notes" on notes for all using (auth.uid() = user_id);
create policy "own note_sources" on note_sources for all using (
  auth.uid() = (select user_id from notes where notes.id = note_sources.note_id)
);
create policy "own note_generation_settings" on note_generation_settings for all using (
  auth.uid() = (select user_id from notes where notes.id = note_generation_settings.note_id)
);
create policy "own note_sections" on note_sections for all using (
  auth.uid() = (select user_id from notes where notes.id = note_sections.note_id)
);
create policy "own note_generation_jobs" on note_generation_jobs for all using (auth.uid() = user_id);

-- ============================================================
-- Indexes for performance
-- ============================================================
create index idx_notes_user_id on notes(user_id);
create index idx_notes_status on notes(status);
create index idx_notes_subject_id on notes(subject_id);
create index idx_note_sections_note_id on note_sections(note_id);
create index idx_note_sections_position on note_sections(note_id, position);
create index idx_note_generation_jobs_note_id on note_generation_jobs(note_id);
create index idx_subjects_user_id on subjects(user_id);
