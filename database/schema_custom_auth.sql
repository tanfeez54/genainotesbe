-- ============================================================
-- NoteGen AI Database Schema (Custom Auth Version)
-- Run this in Supabase SQL Editor → New Query → Run
-- ============================================================

-- Drop existing tables to avoid 'already exists' errors
drop table if exists note_generation_jobs cascade;
drop table if exists note_sections cascade;
drop table if exists note_generation_settings cascade;
drop table if exists note_sources cascade;
drop table if exists notes cascade;
drop table if exists subjects cascade;
drop table if exists profiles cascade;
drop table if exists users cascade;

create extension if not exists pgcrypto;

-- Custom Users Table
create table users (
    id uuid primary key default gen_random_uuid(),
    email text unique not null,
    full_name text,
    mobile text,
    password_hash text,
    avatar_url text,
    otp text,
    otp_expires_at timestamptz,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

create table subjects (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    name text not null,
    description text,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

create table notes (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
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
    user_id uuid not null references users(id) on delete cascade,
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
-- Indexes for performance
-- ============================================================
create index idx_users_email on users(email);
create index idx_notes_user_id on notes(user_id);
create index idx_notes_status on notes(status);
create index idx_notes_subject_id on notes(subject_id);
create index idx_note_sections_note_id on note_sections(note_id);
create index idx_note_sections_position on note_sections(note_id, position);
create index idx_note_generation_jobs_note_id on note_generation_jobs(note_id);
create index idx_subjects_user_id on subjects(user_id);
