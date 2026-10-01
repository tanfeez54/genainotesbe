-- ============================================================
-- NoteGen AI -> SchoolPapers AI Migration
-- ============================================================

-- 4.1 Core Tenant Tables
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

-- Safely add new columns if table already existed before this update
do $$ 
begin
  begin
    alter table schools add column stamp_url text;
  exception when duplicate_column then null; end;
  begin
    alter table schools add column signature_url text;
  exception when duplicate_column then null; end;
  begin
    alter table schools add column classes_range text;
  exception when duplicate_column then null; end;
  begin
    alter table schools add column num_teachers int;
  exception when duplicate_column then null; end;
  begin
    alter table schools add column num_students int;
  exception when duplicate_column then null; end;
end $$;

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

-- Safely fix FK if school_users was pointing to auth.users
do $$
begin
  alter table school_users drop constraint if exists school_users_user_id_fkey;
  alter table school_users add constraint school_users_user_id_fkey foreign key (user_id) references public.users(id) on delete cascade;
exception when others then null;
end $$;

-- Academic Structure
create table if not exists classes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid references schools(id) on delete cascade,
  name text not null,            -- Nursery, LKG, UKG, 1st ... 10th
  order_index int not null,      -- for correct sequencing in UI
  created_at timestamptz default now()
);

-- Note: 'subjects' might already exist from the old NoteGen schema. 
-- If so, we need to alter it to add school_id and class_id.
do $$ 
begin
  if exists (select from pg_tables where schemaname = 'public' and tablename = 'subjects') then
    -- Add columns if they don't exist
    begin
      alter table subjects add column school_id uuid references schools(id) on delete cascade;
    exception when duplicate_column then null; end;
    
    begin
      alter table subjects add column class_id uuid references classes(id) on delete cascade;
    exception when duplicate_column then null; end;
  else
    create table subjects (
      id uuid primary key default gen_random_uuid(),
      school_id uuid references schools(id) on delete cascade,
      class_id uuid references classes(id) on delete cascade,
      name text not null,            
      created_at timestamptz default now()
    );
  end if;
end $$;

create table if not exists chapters (
  id uuid primary key default gen_random_uuid(),
  school_id uuid references schools(id) on delete cascade,
  subject_id uuid references subjects(id) on delete cascade,
  title text not null,
  description text,
  content_text text,             -- full chapter text extracted from OCR
  order_index int,
  created_at timestamptz default now()
);

-- 4.3 Scanning & OCR
create table if not exists scanned_documents (
  id uuid primary key default gen_random_uuid(),
  school_id uuid references schools(id) on delete cascade,
  uploaded_by uuid references public.users(id),
  chapter_id uuid references chapters(id) on delete cascade,
  image_url text not null,       -- Supabase Storage / Cloudflare R2 path
  doc_type text check (doc_type in ('question_paper','chapter_page')) not null,
  status text check (status in ('pending','processing','ocr_completed','failed','reviewed','completed')) default 'pending',
  raw_ocr_text text,
  raw_ocr_json jsonb,            -- structured Gemini output before human review
  error_message text,
  created_at timestamptz default now(),
  processed_at timestamptz
);

-- Safely fix foreign key cascade & status check constraint for existing table
do $$
begin
  alter table scanned_documents drop constraint if exists scanned_documents_chapter_id_fkey;
  alter table scanned_documents add constraint scanned_documents_chapter_id_fkey foreign key (chapter_id) references chapters(id) on delete cascade;
  alter table scanned_documents drop constraint if exists scanned_documents_status_check;
  alter table scanned_documents add constraint scanned_documents_status_check check (status in ('pending','processing','ocr_completed','completed','failed','reviewed'));
exception when others then null;
end $$;

-- 4.4 Question Bank
create table if not exists questions (
  id uuid primary key default gen_random_uuid(),
  school_id uuid references schools(id) on delete cascade,
  chapter_id uuid references chapters(id) on delete cascade,
  question_text text not null,
  answer_text text,
  marks numeric not null,
  difficulty text check (difficulty in ('easy','medium','hard')) default 'medium',
  type text check (type in ('mcq','short_answer','long_answer','true_false','fill_blank','match_the_following')) not null,
  options jsonb,                 -- for MCQ: [{ "label": "A", "text": "..." }, ...]
  correct_option text,           -- for MCQ/true-false
  source_scan_id uuid references scanned_documents(id),
  created_by uuid references public.users(id),
  is_active boolean default true,
  is_shared boolean default false,
  created_at timestamptz default now()
);

-- 4.5 Question Papers
create table if not exists question_papers (
  id uuid primary key default gen_random_uuid(),
  school_id uuid references schools(id) on delete cascade,
  class_id uuid references classes(id),
  subject_id uuid references subjects(id),
  created_by uuid references auth.users(id),
  title text not null,
  total_marks numeric not null,
  duration_minutes int not null default 120,
  time_allowed_minutes int default 120,
  exam_type text default 'Exam',
  selected_questions jsonb default '[]'::jsonb,
  instructions text,
  blueprint jsonb,
  status text check (status in ('draft','final','archived','finalized','printed')) default 'draft',
  created_at timestamptz default now()
);

-- Safely add columns to question_papers if table already exists
do $$
begin
  alter table question_papers add column if not exists exam_type text default 'Exam';
  alter table question_papers add column if not exists time_allowed_minutes int default 120;
  alter table question_papers add column if not exists selected_questions jsonb default '[]'::jsonb;
exception when others then null;
end $$;

create table if not exists paper_questions (
  id uuid primary key default gen_random_uuid(),
  question_paper_id uuid references question_papers(id) on delete cascade,
  question_id uuid references questions(id) on delete cascade,
  section_name text,
  sequence_number int not null,
  marks_override numeric
);

-- 4.6 Row Level Security
alter table schools enable row level security;
alter table school_users enable row level security;
alter table classes enable row level security;
alter table subjects enable row level security;
alter table chapters enable row level security;
alter table scanned_documents enable row level security;
alter table questions enable row level security;
alter table question_papers enable row level security;
alter table paper_questions enable row level security;

-- Questions RLS
create policy "school_isolation_select_questions" on questions for select using (school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true));
create policy "school_isolation_insert_questions" on questions for insert with check (school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true));
create policy "school_isolation_update_questions" on questions for update using (school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true));
create policy "school_isolation_delete_questions" on questions for delete using (school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true));

-- Classes RLS
create policy "school_isolation_select_classes" on classes for select using (school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true));
create policy "school_isolation_insert_classes" on classes for insert with check (school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true));
create policy "school_isolation_update_classes" on classes for update using (school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true));
create policy "school_isolation_delete_classes" on classes for delete using (school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true));

-- Subjects RLS
create policy "school_isolation_select_subjects" on subjects for select using (school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true));
create policy "school_isolation_insert_subjects" on subjects for insert with check (school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true));
create policy "school_isolation_update_subjects" on subjects for update using (school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true));
create policy "school_isolation_delete_subjects" on subjects for delete using (school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true));

-- Chapters RLS
create policy "school_isolation_select_chapters" on chapters for select using (school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true));
create policy "school_isolation_insert_chapters" on chapters for insert with check (school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true));
create policy "school_isolation_update_chapters" on chapters for update using (school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true));
create policy "school_isolation_delete_chapters" on chapters for delete using (school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true));

-- Scanned Documents RLS
create policy "school_isolation_select_scanned_docs" on scanned_documents for select using (school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true));
create policy "school_isolation_insert_scanned_docs" on scanned_documents for insert with check (school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true));
create policy "school_isolation_update_scanned_docs" on scanned_documents for update using (school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true));
create policy "school_isolation_delete_scanned_docs" on scanned_documents for delete using (school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true));

-- Question Papers RLS
create policy "school_isolation_select_question_papers" on question_papers for select using (school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true));
create policy "school_isolation_insert_question_papers" on question_papers for insert with check (school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true));
create policy "school_isolation_update_question_papers" on question_papers for update using (school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true));
create policy "school_isolation_delete_question_papers" on question_papers for delete using (school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true));

-- Paper Questions RLS
create policy "school_isolation_select_paper_questions" on paper_questions for select using (question_paper_id in (select id from question_papers where school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true)));
create policy "school_isolation_insert_paper_questions" on paper_questions for insert with check (question_paper_id in (select id from question_papers where school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true)));
create policy "school_isolation_update_paper_questions" on paper_questions for update using (question_paper_id in (select id from question_papers where school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true)));
create policy "school_isolation_delete_paper_questions" on paper_questions for delete using (question_paper_id in (select id from question_papers where school_id in (select school_id from school_users where user_id = auth.uid() and is_active = true)));

-- School Users RLS
create policy "school_users_select" on school_users for select using (user_id = auth.uid() or school_id in (select school_id from school_users where user_id = auth.uid() and role in ('super_admin', 'school_admin')));
-- (Other operations on school_users should ideally be restricted to super_admin or school_admin)

-- Schools RLS
create policy "schools_select" on schools for select using (id in (select school_id from school_users where user_id = auth.uid()));

-- ============================================================
-- STORAGE BUCKETS & RLS
-- ============================================================
insert into storage.buckets (id, name, public) 
values ('school_assets', 'school_assets', true)
on conflict (id) do nothing;

create policy "Public access to school_assets" on storage.objects for select
  using (bucket_id = 'school_assets');

create policy "Authenticated users can upload to school_assets" on storage.objects for insert
  with check (bucket_id = 'school_assets' and auth.uid() is not null);

create policy "Authenticated users can update school_assets" on storage.objects for update
  using (bucket_id = 'school_assets' and auth.uid() is not null);
