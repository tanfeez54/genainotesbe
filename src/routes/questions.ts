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
      .select('*, chapters(id, title, subjects(id, name, classes(id, name)))')
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

// POST /api/questions/batch — Save multiple extracted questions from OCR scan
router.post('/batch', requireSchoolAccess(['super_admin', 'school_admin', 'teacher', 'data_entry']), async (req: Request, res: Response): Promise<void> => {
  try {
    const { questions, scan_id, chapter_id } = req.body;

    if (!Array.isArray(questions) || questions.length === 0) {
      res.status(400).json({ error: 'No questions provided' });
      return;
    }

    const rowsToInsert = questions.map((q: any) => ({
      school_id: req.school_id,
      created_by: req.userId || undefined,
      chapter_id: q.chapter_id || chapter_id || null,
      source_scan_id: scan_id || null,
      question_text: q.question_text || q.text,
      answer_text: q.answer_text || q.answer || null,
      marks: Number(q.marks) || 1,
      difficulty: q.difficulty || 'medium',
      type: q.type || q.question_type || 'short_answer',
      options: q.options || null,
      correct_option: q.correct_option || null,
      is_active: true,
    }));

    const { data, error } = await supabaseService
      .from('questions')
      .insert(rowsToInsert)
      .select();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    // Update scanned document status to 'reviewed'
    if (scan_id) {
      await supabaseService
        .from('scanned_documents')
        .update({ status: 'reviewed' })
        .eq('id', scan_id);
    }

    res.status(201).json({ message: 'Questions saved successfully', count: data?.length, data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
