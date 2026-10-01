-- =========================================================================
-- ONLY THE REQUIRED UPDATES FOR SUPABASE SQL EDITOR
-- Copy and paste this directly into Supabase Dashboard -> SQL Editor -> Run
-- =========================================================================

-- 1. Add missing columns to question_papers table
ALTER TABLE question_papers ADD COLUMN IF NOT EXISTS exam_type text DEFAULT 'Exam';
ALTER TABLE question_papers ADD COLUMN IF NOT EXISTS time_allowed_minutes int DEFAULT 120;
ALTER TABLE question_papers ADD COLUMN IF NOT EXISTS selected_questions jsonb DEFAULT '[]'::jsonb;

-- 2. Update status check constraint for question_papers (allows 'draft', 'final', 'finalized', 'printed', 'archived')
DO $$
BEGIN
  ALTER TABLE question_papers DROP CONSTRAINT IF EXISTS question_papers_status_check;
  ALTER TABLE question_papers ADD CONSTRAINT question_papers_status_check 
    CHECK (status IN ('draft', 'final', 'finalized', 'archived', 'printed'));
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- 3. Fix foreign key cascade for scanned_documents (prevents error when deleting chapters)
DO $$
BEGIN
  ALTER TABLE scanned_documents DROP CONSTRAINT IF EXISTS scanned_documents_chapter_id_fkey;
  ALTER TABLE scanned_documents ADD CONSTRAINT scanned_documents_chapter_id_fkey 
    FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE;
  
  ALTER TABLE scanned_documents DROP CONSTRAINT IF EXISTS scanned_documents_status_check;
  ALTER TABLE scanned_documents ADD CONSTRAINT scanned_documents_status_check 
    CHECK (status IN ('pending', 'processing', 'ocr_completed', 'completed', 'failed', 'reviewed'));
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
