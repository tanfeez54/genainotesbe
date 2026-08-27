import { Router, Request, Response } from 'express';
import { supabaseService } from '../lib/supabase';
import { z } from 'zod';
import { requireSchoolAccess } from '../middleware/schoolAccess';

const router = Router();

// GET /api/questions — Search & list questions
router.get('/', requireSchoolAccess(), async (req: Request, res: Response): Promise<void> => {
  try {
    let query = supabaseService
      .from('questions')
      .select('*, chapters(id, title, subject_id, subjects(id, name, class_id, classes(id, name)))')
      .eq('school_id', req.school_id)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (req.query.chapter_id) {
      query = query.eq('chapter_id', req.query.chapter_id);
    }
    if (req.query.type) {
      query = query.eq('type', req.query.type);
    }
    if (req.query.difficulty) {
      query = query.eq('difficulty', req.query.difficulty);
    }
    if (req.query.search) {
      query = query.ilike('question_text', `%${req.query.search}%`);
    }

    const { data, error } = await query;

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ data: data || [] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/questions/batch — Save multiple extracted questions from OCR scan with STRICT Chapter validation
router.post('/batch', requireSchoolAccess(['super_admin', 'school_admin', 'teacher', 'data_entry']), async (req: Request, res: Response): Promise<void> => {
  try {
    const { questions, scan_id, chapter_id } = req.body;

    if (!Array.isArray(questions) || questions.length === 0) {
      res.status(400).json({ error: 'No questions provided to save' });
      return;
    }

    if (!chapter_id) {
      res.status(400).json({ error: 'Validation failed: Chapter is strictly required to save questions.' });
      return;
    }

    // Verify that chapter belongs to the user's school
    const { data: chapter, error: chapterErr } = await supabaseService
      .from('chapters')
      .select('id, title, subject_id')
      .eq('id', chapter_id)
      .eq('school_id', req.school_id)
      .single();

    if (chapterErr || !chapter) {
      res.status(404).json({ error: 'Selected chapter was not found for your school.' });
      return;
    }

    const rowsToInsert = questions.map((q: any) => {
      let options = q.options;
      if (Array.isArray(options)) {
        // Standardize options array format
        options = options.map((opt: any, idx: number) => {
          if (typeof opt === 'string') {
            const label = String.fromCharCode(65 + idx);
            return { label, text: opt };
          }
          return opt;
        });
      }

      return {
        school_id: req.school_id,
        created_by: req.userId || undefined,
        chapter_id: chapter_id,
        source_scan_id: scan_id || null,
        question_text: (q.question_text || q.text || '').trim(),
        answer_text: q.answer_text || q.answer || null,
        marks: Number(q.marks) > 0 ? Number(q.marks) : 1,
        difficulty: ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : 'medium',
        type: ['mcq', 'short_answer', 'long_answer', 'true_false', 'fill_blank', 'match_the_following'].includes(q.type || q.question_type)
          ? (q.type || q.question_type)
          : 'short_answer',
        options: options || null,
        correct_option: q.correct_option || null,
        is_active: true,
      };
    }).filter(q => q.question_text.length > 0);

    if (rowsToInsert.length === 0) {
      res.status(400).json({ error: 'No valid questions with text provided' });
      return;
    }

    const { data, error } = await supabaseService
      .from('questions')
      .insert(rowsToInsert)
      .select('*, chapters(id, title, subjects(id, name, classes(id, name)))');

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    // Update scanned document status to 'reviewed'
    if (scan_id) {
      await supabaseService
        .from('scanned_documents')
        .update({ status: 'reviewed', chapter_id: chapter_id })
        .eq('id', scan_id);
    }

    res.status(201).json({
      message: `Successfully saved ${data?.length} questions into Question Bank under chapter "${chapter.title}"`,
      count: data?.length,
      data
    });
  } catch (err: any) {
    console.error('Error in batch question saving:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/questions — Single question create
router.post('/', requireSchoolAccess(['super_admin', 'school_admin', 'teacher']), async (req: Request, res: Response): Promise<void> => {
  try {
    const { chapter_id, question_text, answer_text, marks, difficulty, type, options, correct_option } = req.body;

    if (!chapter_id || !question_text) {
      res.status(400).json({ error: 'Chapter and question text are required' });
      return;
    }

    const { data, error } = await supabaseService
      .from('questions')
      .insert({
        school_id: req.school_id,
        created_by: req.userId,
        chapter_id,
        question_text,
        answer_text,
        marks: marks || 1,
        difficulty: difficulty || 'medium',
        type: type || 'short_answer',
        options: options || null,
        correct_option: correct_option || null,
        is_active: true
      })
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.status(201).json({ data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/questions/:id
router.delete('/:id', requireSchoolAccess(['super_admin', 'school_admin', 'teacher']), async (req: Request, res: Response): Promise<void> => {
  try {
    const { error } = await supabaseService
      .from('questions')
      .update({ is_active: false })
      .eq('id', req.params.id)
      .eq('school_id', req.school_id);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ message: 'Question deleted' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
