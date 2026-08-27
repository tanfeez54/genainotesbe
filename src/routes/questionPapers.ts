import { Router, Request, Response } from 'express';
import { supabaseService } from '../lib/supabase';
import { z } from 'zod';
import { requireSchoolAccess } from '../middleware/schoolAccess';
import { generateQuestionsWithAI, QuestionSectionConfig } from '../services/ai';

const router = Router();

// GET /api/question-papers — List all saved question papers for the school
router.get('/', requireSchoolAccess(), async (req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabaseService
      .from('question_papers')
      .select('*, classes(id, name), subjects(id, name)')
      .eq('school_id', req.school_id)
      .order('created_at', { ascending: false });

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ data: data || [] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/question-papers/:id — Get details of a single question paper with school branding
router.get('/:id', requireSchoolAccess(), async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const { data: paper, error: paperError } = await supabaseService
      .from('question_papers')
      .select('*, classes(id, name), subjects(id, name)')
      .eq('id', id)
      .eq('school_id', req.school_id)
      .single();

    if (paperError || !paper) {
      res.status(404).json({ error: 'Question paper not found' });
      return;
    }

    // Fetch school branding info (logo, stamp, signature)
    const { data: school } = await supabaseService
      .from('schools')
      .select('id, name, logo_url, stamp_url, signature_url, board, address, contact_email, phone')
      .eq('id', req.school_id)
      .single();

    res.json({
      data: {
        ...paper,
        school: school || null
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/question-papers — Save a newly designed question paper
router.post('/', requireSchoolAccess(['super_admin', 'school_admin', 'teacher', 'data_entry']), async (req: Request, res: Response): Promise<void> => {
  try {
    const schema = z.object({
      title: z.string().min(1, 'Paper title is required'),
      class_id: z.string().uuid().optional().nullable(),
      subject_id: z.string().uuid().optional().nullable(),
      exam_type: z.string().optional().default('Exam'),
      total_marks: z.number().min(1, 'Total marks must be at least 1'),
      time_allowed_minutes: z.number().optional().default(120),
      blueprint: z.any().optional(),
      selected_questions: z.array(z.any()).min(1, 'At least 1 question is required in the paper'),
      status: z.enum(['draft', 'finalized', 'printed']).default('draft'),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const blueprintData = {
      ...(parsed.data.blueprint || {}),
      exam_type: parsed.data.exam_type || 'Exam',
      selected_questions: parsed.data.selected_questions,
      time_allowed_minutes: parsed.data.time_allowed_minutes || 120,
    };

    const insertPayload: any = {
      school_id: req.school_id,
      created_by: req.userId || undefined,
      title: parsed.data.title,
      class_id: parsed.data.class_id || null,
      subject_id: parsed.data.subject_id || null,
      total_marks: parsed.data.total_marks,
      duration_minutes: parsed.data.time_allowed_minutes || 120,
      instructions: parsed.data.blueprint?.instructions || null,
      blueprint: blueprintData,
      status: parsed.data.status || 'draft'
    };

    const { data, error } = await supabaseService
      .from('question_papers')
      .insert(insertPayload)
      .select('*, classes(id, name), subjects(id, name)')
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.status(201).json({ message: 'Question paper saved successfully', data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/question-papers/:id — Update existing question paper
router.patch('/:id', requireSchoolAccess(['super_admin', 'school_admin', 'teacher', 'data_entry']), async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const updatePayload = { ...req.body };
    delete updatePayload.id;
    delete updatePayload.school_id;

    if (updatePayload.time_allowed_minutes !== undefined) {
      updatePayload.duration_minutes = updatePayload.time_allowed_minutes;
      delete updatePayload.time_allowed_minutes;
    }
    delete updatePayload.exam_type;
    delete updatePayload.selected_questions;

    const { data, error } = await supabaseService
      .from('question_papers')
      .update(updatePayload)
      .eq('id', id)
      .eq('school_id', req.school_id)
      .select('*, classes(id, name), subjects(id, name)')
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ message: 'Question paper updated successfully', data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/question-papers/:id — Delete a question paper
router.delete('/:id', requireSchoolAccess(['super_admin', 'school_admin', 'teacher']), async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { error } = await supabaseService
      .from('question_papers')
      .delete()
      .eq('id', id)
      .eq('school_id', req.school_id);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ message: 'Question paper deleted successfully' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/question-papers/ai-generate — Generate full question paper via Gemini AI
router.post('/ai-generate', requireSchoolAccess(['super_admin', 'school_admin', 'teacher', 'data_entry']), async (req: Request, res: Response): Promise<void> => {
  try {
    const schema = z.object({
      class_id: z.string().uuid().optional(),
      subject_id: z.string().uuid().optional(),
      class_name: z.string().optional(),
      subject_name: z.string().optional(),
      chapter_ids: z.array(z.string().uuid()).optional(),
      chapter_names: z.array(z.string()).optional(),
      scan_ids: z.array(z.string().uuid()).optional(),
      raw_ocr_text: z.string().optional(),
      strict_ocr_only: z.boolean().optional().default(true),
      sections: z.array(
        z.object({
          section_name: z.string(),
          type: z.enum(['mcq', 'short_answer', 'long_answer', 'true_false', 'fill_blank', 'match_the_following']),
          count: z.number().min(1).max(50),
          marks_per_question: z.number().min(1).max(100),
          difficulty: z.enum(['easy', 'medium', 'hard']).optional().default('medium'),
        })
      ).min(1, 'At least one section must be specified in the blueprint'),
      language: z.string().optional().default('English'),
      custom_instructions: z.string().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    let resolvedClassName = parsed.data.class_name || 'General Grade';
    let resolvedSubjectName = parsed.data.subject_name || 'General Subject';
    let resolvedChapterTitles: string[] = parsed.data.chapter_names || [];

    // Fetch class name if class_id provided
    if (parsed.data.class_id && !parsed.data.class_name) {
      const { data: cls } = await supabaseService
        .from('classes')
        .select('name')
        .eq('id', parsed.data.class_id)
        .maybeSingle();
      if (cls?.name) resolvedClassName = cls.name;
    }

    // Fetch subject name if subject_id provided
    if (parsed.data.subject_id && !parsed.data.subject_name) {
      const { data: sub } = await supabaseService
        .from('subjects')
        .select('name')
        .eq('id', parsed.data.subject_id)
        .maybeSingle();
      if (sub?.name) resolvedSubjectName = sub.name;
    }

    let contextOcrContent = '';

    // 1. Fetch OCR text from selected scanned documents
    if (parsed.data.scan_ids && parsed.data.scan_ids.length > 0) {
      const { data: scans } = await supabaseService
        .from('scanned_documents')
        .select('id, raw_ocr_text, doc_type, chapters(id, title, subjects(id, name, classes(id, name)))')
        .in('id', parsed.data.scan_ids);

      if (scans && scans.length > 0) {
        const scanTexts = scans
          .map((s, idx) => `[SCANNED DOCUMENT ${idx + 1} (${s.doc_type || 'document'})]:\n${s.raw_ocr_text || ''}`)
          .filter(Boolean)
          .join('\n\n');

        contextOcrContent += scanTexts;

        // Auto resolve class/subject/chapter from scan if missing
        if (scans[0]?.chapters) {
          const ch: any = scans[0].chapters;
          if (!resolvedChapterTitles.includes(ch.title)) resolvedChapterTitles.push(ch.title);
          if (ch.subjects?.name && resolvedSubjectName === 'General Subject') resolvedSubjectName = ch.subjects.name;
          if (ch.subjects?.classes?.name && resolvedClassName === 'General Grade') resolvedClassName = ch.subjects.classes.name;
        }
      }
    }

    // 2. Add raw OCR text if explicitly provided
    if (parsed.data.raw_ocr_text) {
      contextOcrContent = (contextOcrContent ? contextOcrContent + '\n\n' : '') + parsed.data.raw_ocr_text;
    }

    // 3. Fetch chapter titles and chapter content if chapter_ids provided
    if (parsed.data.chapter_ids && parsed.data.chapter_ids.length > 0) {
      const { data: chaps } = await supabaseService
        .from('chapters')
        .select('id, title, content_text')
        .in('id', parsed.data.chapter_ids);

      if (chaps && chaps.length > 0) {
        const newTitles = chaps.map(c => c.title);
        resolvedChapterTitles = Array.from(new Set([...resolvedChapterTitles, ...newTitles]));
        
        const chapTexts = chaps
          .map(c => c.content_text ? `Chapter "${c.title}":\n${c.content_text}` : '')
          .filter(Boolean)
          .join('\n\n');

        if (chapTexts) {
          contextOcrContent = (contextOcrContent ? contextOcrContent + '\n\n' : '') + chapTexts;
        }
      }
    }

    const generatedQuestions = await generateQuestionsWithAI({
      className: resolvedClassName,
      subjectName: resolvedSubjectName,
      chapterTitles: resolvedChapterTitles,
      contextContent: contextOcrContent || undefined,
      sections: parsed.data.sections as QuestionSectionConfig[],
      language: parsed.data.language,
      customInstructions: parsed.data.custom_instructions,
    });

    res.json({
      message: 'Questions generated successfully with AI',
      data: generatedQuestions,
      meta: {
        className: resolvedClassName,
        subjectName: resolvedSubjectName,
        chapters: resolvedChapterTitles,
        totalQuestions: generatedQuestions.length,
        totalMarks: generatedQuestions.reduce((acc, q) => acc + (q.marks || 0), 0),
      }
    });
  } catch (err: any) {
    console.error('AI Paper Generation Error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate questions with AI' });
  }
});

// POST /api/question-papers/from-bank — Pick questions from question bank according to blueprint
router.post('/from-bank', requireSchoolAccess(), async (req: Request, res: Response): Promise<void> => {
  try {
    const { chapter_ids, sections } = req.body;

    let query = supabaseService
      .from('questions')
      .select('*, chapters(id, title)')
      .eq('school_id', req.school_id)
      .eq('is_active', true);

    if (Array.isArray(chapter_ids) && chapter_ids.length > 0) {
      query = query.in('chapter_id', chapter_ids);
    }

    const { data: bankQuestions, error } = await query;
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    if (!bankQuestions || bankQuestions.length === 0) {
      res.status(404).json({ error: 'No questions found in Question Bank for the selected criteria.' });
      return;
    }

    const shuffle = <T>(arr: T[]): T[] => [...arr].sort(() => Math.random() - 0.5);

    const pickedQuestions: any[] = [];
    const usedIds = new Set<string>();

    if (Array.isArray(sections)) {
      for (const sec of sections) {
        const matching = bankQuestions.filter(
          q => !usedIds.has(q.id) && (sec.type ? q.type === sec.type : true)
        );

        const count = sec.count || 5;
        const selected = shuffle(matching).slice(0, count);

        for (const q of selected) {
          usedIds.add(q.id);
          pickedQuestions.push({
            id: q.id,
            section_name: sec.section_name || 'Section',
            type: q.type,
            question_text: q.question_text,
            options: q.options,
            correct_option: q.correct_option,
            answer_text: q.answer_text,
            marks: sec.marks_per_question || q.marks || 1,
            difficulty: q.difficulty || 'medium',
            chapter_title: q.chapters?.title || '',
          });
        }
      }
    }

    res.json({
      message: 'Questions selected from bank successfully',
      data: pickedQuestions.length > 0 ? pickedQuestions : bankQuestions.slice(0, 15),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
