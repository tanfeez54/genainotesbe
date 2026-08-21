// Shared TypeScript types for the backend

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      school_id?: string;
      role?: string;
    }
  }
}

export interface Profile {
  id: string;
  full_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface Subject {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface Note {
  id: string;
  user_id: string;
  subject_id: string | null;
  title: string;
  topic: string | null;
  purpose: string | null;
  level: string | null;
  language: string;
  note_length: string;
  status: 'draft' | 'generating' | 'completed' | 'failed';
  summary: string | null;
  content: Record<string, unknown> | null;
  word_count: number;
  created_at: string;
  updated_at: string;
}

export interface NoteSource {
  id: string;
  note_id: string;
  url: string;
  title: string | null;
  domain: string | null;
  extracted_content: string | null;
  content_hash: string | null;
  fetch_status: 'pending' | 'processing' | 'completed' | 'failed';
  error_message: string | null;
  fetched_at: string | null;
  created_at: string;
}

export interface NoteGenerationSettings {
  id: string;
  note_id: string;
  purpose: string | null;
  level: string | null;
  language: string | null;
  note_length: string | null;
  tone: string | null;
  include_summary: boolean;
  include_key_points: boolean;
  include_examples: boolean;
  include_formulas: boolean;
  include_common_mistakes: boolean;
  include_practice_questions: boolean;
  custom_instruction: string | null;
  created_at: string;
}

export interface NoteSection {
  id: string;
  note_id: string;
  section_type: string | null;
  title: string;
  content: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface NoteGenerationJob {
  id: string;
  note_id: string;
  user_id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  current_step: string | null;
  progress: number;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface AIGeneratedNote {
  title: string;
  summary: string;
  sections: Array<{
    type: 'concept' | 'formula' | 'example' | 'mistake' | 'revision';
    title: string;
    content: string;
  }>;
  key_points: string[];
  common_mistakes: string[];
  quick_revision: string[];
}
