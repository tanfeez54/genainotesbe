import { z } from 'zod';

// Auth
export const emailSchema = z.object({
  email: z.string().email('Valid email required'),
});

// Subjects
export const createSubjectSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  description: z.string().max(500).optional(),
});

export const updateSubjectSchema = createSubjectSchema.partial();

// Notes
export const createNoteSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200),
  subject_id: z.string().uuid().optional().nullable(),
  topic: z.string().max(200).optional().nullable(),
  source_url: z.string().url('Valid URL required'),
  purpose: z.enum(['exam_prep', 'revision', 'beginner_learning', 'deep_understanding']).optional(),
  level: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
  language: z.string().default('English'),
  note_length: z.enum(['short', 'medium', 'detailed']).default('medium'),
  include_summary: z.boolean().default(true),
  include_key_points: z.boolean().default(true),
  include_examples: z.boolean().default(true),
  include_formulas: z.boolean().default(false),
  include_common_mistakes: z.boolean().default(false),
  include_practice_questions: z.boolean().default(false),
  custom_instruction: z.string().max(1000).optional().nullable(),
});

export const updateNoteSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  subject_id: z.string().uuid().optional().nullable(),
  topic: z.string().max(200).optional().nullable(),
  status: z.enum(['draft', 'generating', 'completed', 'failed']).optional(),
  summary: z.string().optional().nullable(),
});

export const updateNoteSectionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().optional().nullable(),
  position: z.number().int().min(0).optional(),
});

// Notes query params
export const notesQuerySchema = z.object({
  subject: z.string().uuid().optional(),
  search: z.string().optional(),
  status: z.enum(['draft', 'generating', 'completed', 'failed']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// Sources
export const extractSourceSchema = z.object({
  url: z.string().url('Valid URL required'),
});

// AI Output Schema (Zod validation for Gemini response)
export const aiNoteSchema = z.object({
  title: z.string().min(1),
  summary: z.string(),
  sections: z.array(z.object({
    type: z.enum(['concept', 'formula', 'example', 'mistake', 'revision']),
    title: z.string().min(1),
    content: z.string(),
  })).min(1),
  key_points: z.array(z.string()),
  common_mistakes: z.array(z.string()),
  quick_revision: z.array(z.string()),
});

export type CreateNoteInput = z.infer<typeof createNoteSchema>;
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;
export type CreateSubjectInput = z.infer<typeof createSubjectSchema>;
export type UpdateSubjectInput = z.infer<typeof updateSubjectSchema>;
export type AINote = z.infer<typeof aiNoteSchema>;
export type NotesQuery = z.infer<typeof notesQuerySchema>;
