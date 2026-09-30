import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import {
  createNoteSchema,
  updateNoteSchema,
  updateNoteSectionSchema,
  notesQuerySchema,
} from '../schemas';
import { runGenerationPipeline } from '../services/pipeline';
import { generateLessonSuiteWithAI } from '../services/ai';

const router = Router();

// POST /api/notes/generate-lesson-suite — 7-Core Teacher Lesson & Academic Suite Generator
router.post('/generate-lesson-suite', async (req: Request, res: Response) => {
  try {
    const {
      class_id,
      subject_id,
      chapter_id,
      className,
      subjectName,
      chapterTitle,
      board,
      language,
      customInstructions,
      scan_ids,
      raw_ocr_text,
    } = req.body;

    let resolvedClassName = className || '';
    let resolvedSubjectName = subjectName || '';
    let resolvedChapterTitle = chapterTitle || '';

    // If IDs are provided, resolve names from DB if needed
    if (class_id && !resolvedClassName) {
      const { data: c } = await supabaseAdmin.from('classes').select('name').eq('id', class_id).maybeSingle();
      if (c?.name) resolvedClassName = c.name;
    }
    if (subject_id && !resolvedSubjectName) {
      const { data: s } = await supabaseAdmin.from('subjects').select('name').eq('id', subject_id).maybeSingle();
      if (s?.name) resolvedSubjectName = s.name;
    }
    if (chapter_id && !resolvedChapterTitle) {
      const { data: ch } = await supabaseAdmin.from('chapters').select('title, content_text').eq('id', chapter_id).maybeSingle();
      if (ch?.title) resolvedChapterTitle = ch.title;
    }

    if (!resolvedClassName || !resolvedSubjectName || !resolvedChapterTitle) {
      res.status(400).json({ error: 'Class, Subject, and Chapter title are required' });
      return;
    }

    let contextOcrContent = raw_ocr_text || '';

    // 1. Fetch from specific scan_ids if selected (strictly syllabus / textbook scans)
    if (Array.isArray(scan_ids) && scan_ids.length > 0) {
      const { data: scans } = await supabaseAdmin
        .from('scanned_documents')
        .select('raw_ocr_text, doc_type')
        .in('id', scan_ids)
        .in('doc_type', ['chapter_syllabus', 'chapter_page']);
      if (scans && scans.length > 0) {
        const texts = scans.map((s, idx) => `[SCANNED SYLLABUS / TEXTBOOK PAGE ${idx + 1}]:\n${s.raw_ocr_text}`).filter(Boolean).join('\n\n');
        contextOcrContent = (contextOcrContent ? contextOcrContent + '\n\n' : '') + texts;
      }
    } else if (chapter_id) {
      // 2. Automatically load all syllabus OCR scans attached to this chapter (isolated from question paper scans)
      const { data: scans } = await supabaseAdmin
        .from('scanned_documents')
        .select('raw_ocr_text, doc_type')
        .eq('chapter_id', chapter_id)
        .in('doc_type', ['chapter_syllabus', 'chapter_page']);
      if (scans && scans.length > 0) {
        const texts = scans.map((s, idx) => `[SCANNED SYLLABUS / TEXTBOOK PAGE ${idx + 1}]:\n${s.raw_ocr_text}`).filter(Boolean).join('\n\n');
        contextOcrContent = (contextOcrContent ? contextOcrContent + '\n\n' : '') + texts;
      }

      // Also check if chapter has content_text
      const { data: ch } = await supabaseAdmin.from('chapters').select('content_text').eq('id', chapter_id).maybeSingle();
      if (ch?.content_text) {
        contextOcrContent = (contextOcrContent ? contextOcrContent + '\n\n' : '') + `[CHAPTER SYLLABUS & NOTES]:\n${ch.content_text}`;
      }
    }

    const suite = await generateLessonSuiteWithAI({
      className: resolvedClassName,
      subjectName: resolvedSubjectName,
      chapterTitle: resolvedChapterTitle,
      board: board || 'CBSE',
      language: language || 'English',
      customInstructions,
      contextContent: contextOcrContent || undefined,
    });

    res.json({
      message: '7-Core Teacher Lesson Suite generated successfully',
      data: suite,
      scans_used: Boolean(contextOcrContent),
    });
  } catch (err: any) {
    console.error('Lesson Suite Generation Error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate lesson suite' });
  }
});

// GET /api/notes — list user's notes with filters
router.get('/', async (req: Request, res: Response) => {
  const parsed = notesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { subject, search, status, page, limit } = parsed.data;
  const offset = (page - 1) * limit;

  let query = supabaseAdmin
    .from('notes')
    .select('*, subjects(name), note_sources(url, domain, fetch_status)', { count: 'exact' })
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (subject) query = query.eq('subject_id', subject);
  if (status) query = query.eq('status', status);
  if (search) query = query.ilike('title', `%${search}%`);

  const { data, error, count } = await query;

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({
    data,
    pagination: {
      page,
      limit,
      total: count ?? 0,
      totalPages: Math.ceil((count ?? 0) / limit),
    },
  });
});

// POST /api/notes — create draft note + source + settings
router.post('/', async (req: Request, res: Response) => {
  const parsed = createNoteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const {
    source_url,
    title,
    subject_id,
    topic,
    purpose,
    level,
    language,
    note_length,
    include_summary,
    include_key_points,
    include_examples,
    include_formulas,
    include_common_mistakes,
    include_practice_questions,
    custom_instruction,
  } = parsed.data;

  // Create note
  const { data: note, error: noteError } = await supabaseAdmin
    .from('notes')
    .insert({
      user_id: req.userId,
      title,
      subject_id: subject_id ?? null,
      topic: topic ?? null,
      purpose: purpose ?? null,
      level: level ?? null,
      language,
      note_length,
      status: 'draft',
    })
    .select()
    .single();

  if (noteError || !note) {
    res.status(500).json({ error: noteError?.message ?? 'Failed to create note' });
    return;
  }

  // Create note source
  const { error: sourceError } = await supabaseAdmin
    .from('note_sources')
    .insert({
      note_id: note.id,
      url: source_url,
      fetch_status: 'pending',
    });

  if (sourceError) {
    await supabaseAdmin.from('notes').delete().eq('id', note.id);
    res.status(500).json({ error: sourceError.message });
    return;
  }

  // Create generation settings
  const { error: settingsError } = await supabaseAdmin
    .from('note_generation_settings')
    .insert({
      note_id: note.id,
      purpose: purpose ?? null,
      level: level ?? null,
      language,
      note_length,
      include_summary,
      include_key_points,
      include_examples,
      include_formulas,
      include_common_mistakes,
      include_practice_questions,
      custom_instruction: custom_instruction ?? null,
    });

  if (settingsError) {
    console.warn('Failed to save generation settings:', settingsError.message);
  }

  res.status(201).json({ data: note });
});

// GET /api/notes/:id — fetch note with sections
router.get('/:id', async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('notes')
    .select(`
      *,
      subjects(id, name),
      note_sources(*),
      note_sections(*),
      note_generation_settings(*),
      note_generation_jobs(*)
    `)
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .order('position', { foreignTable: 'note_sections', ascending: true })
    .order('created_at', { foreignTable: 'note_generation_jobs', ascending: false })
    .limit(1, { foreignTable: 'note_generation_jobs' })
    .single();

  if (error || !data) {
    if (error) console.error('[GET Note Error]', error);
    res.status(404).json({ error: 'Note not found' });
    return;
  }

  res.json({ data });
});

// PATCH /api/notes/:id — update note
router.patch('/:id', async (req: Request, res: Response) => {
  const parsed = updateNoteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { data: existing } = await supabaseAdmin
    .from('notes')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .single();

  if (!existing) {
    res.status(404).json({ error: 'Note not found' });
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('notes')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ data });
});

// PATCH /api/notes/:id/sections/:sectionId — update section
router.patch('/:id/sections/:sectionId', async (req: Request, res: Response) => {
  const parsed = updateNoteSectionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  // Verify note ownership
  const { data: note } = await supabaseAdmin
    .from('notes')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .single();

  if (!note) {
    res.status(404).json({ error: 'Note not found' });
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('note_sections')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('id', req.params.sectionId)
    .eq('note_id', req.params.id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ data });
});

// DELETE /api/notes/:id — delete note
router.delete('/:id', async (req: Request, res: Response) => {
  const { data: existing } = await supabaseAdmin
    .from('notes')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .single();

  if (!existing) {
    res.status(404).json({ error: 'Note not found' });
    return;
  }

  const { error } = await supabaseAdmin
    .from('notes')
    .delete()
    .eq('id', req.params.id);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(204).send();
});

// POST /api/notes/:id/generate — kick off generation pipeline
router.post('/:id/generate', async (req: Request, res: Response) => {
  // Verify ownership and get note data
  const { data: note, error: noteError } = await supabaseAdmin
    .from('notes')
    .select(`
      *,
      note_sources(url),
      note_generation_settings(*)
    `)
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .single();

  if (noteError || !note) {
    res.status(404).json({ error: 'Note not found' });
    return;
  }

  if (note.status === 'generating') {
    res.status(409).json({ error: 'Generation already in progress' });
    return;
  }

  const sources = note.note_sources as Array<{ url: string }>;
  if (!sources || sources.length === 0) {
    res.status(400).json({ error: 'No source URL found for this note' });
    return;
  }

  // Create generation job
  const { data: job, error: jobError } = await supabaseAdmin
    .from('note_generation_jobs')
    .insert({
      note_id: note.id,
      user_id: req.userId,
      status: 'queued',
      progress: 0,
    })
    .select()
    .single();

  if (jobError || !job) {
    res.status(500).json({ error: 'Failed to create generation job' });
    return;
  }

  const settings = Array.isArray(note.note_generation_settings)
    ? note.note_generation_settings[0]
    : note.note_generation_settings;

  // Run pipeline in background (don't await)
  runGenerationPipeline(job.id, {
    noteId: note.id,
    userId: req.userId!,
    sourceUrl: sources[0].url,
    settings: settings ?? {},
  }).catch((err) => console.error('[Pipeline Error]', err));

  res.status(202).json({
    message: 'Generation started',
    jobId: job.id,
  });
});

// GET /api/notes/:id/status — poll generation job status
router.get('/:id/status', async (req: Request, res: Response) => {
  const { data: note } = await supabaseAdmin
    .from('notes')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .single();

  if (!note) {
    res.status(404).json({ error: 'Note not found' });
    return;
  }

  const { data: job, error } = await supabaseAdmin
    .from('note_generation_jobs')
    .select('*')
    .eq('note_id', req.params.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !job) {
    res.status(404).json({ error: 'No generation job found' });
    return;
  }

  res.json({ data: job });
});

export default router;
