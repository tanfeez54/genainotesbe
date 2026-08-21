import { Router, Request, Response } from 'express';
import { supabaseService } from '../lib/supabase';
import { z } from 'zod';
import { requireSchoolAccess } from '../middleware/schoolAccess';

const router = Router();

const createChapterSchema = z.object({
  title: z.string().min(1),
  subject_id: z.string().uuid(),
  description: z.string().optional(),
  order_index: z.number().int().default(0)
});
const updateChapterSchema = createChapterSchema.partial();

// GET /api/chapters — list school's chapters
router.get('/', requireSchoolAccess(), async (req: Request, res: Response): Promise<void> => {
  let query = supabaseService
    .from('chapters')
    .select('*, subjects(name)')
    .eq('school_id', req.school_id)
    .order('order_index', { ascending: true });

  if (req.query.subject_id) {
    query = query.eq('subject_id', req.query.subject_id);
  }

  const { data, error } = await query;

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ data });
});

// POST /api/chapters — create chapter
router.post('/', requireSchoolAccess(['super_admin', 'school_admin', 'teacher']), async (req: Request, res: Response): Promise<void> => {
  const parsed = createChapterSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { data, error } = await supabaseService
    .from('chapters')
    .insert({ ...parsed.data, school_id: req.school_id })
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.status(201).json({ data });
});

// PATCH /api/chapters/:id — update chapter
router.patch('/:id', requireSchoolAccess(['super_admin', 'school_admin', 'teacher']), async (req: Request, res: Response): Promise<void> => {
  const parsed = updateChapterSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { data, error } = await supabaseService
    .from('chapters')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('school_id', req.school_id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ data });
});

// DELETE /api/chapters/:id — delete chapter
router.delete('/:id', requireSchoolAccess(['super_admin', 'school_admin', 'teacher']), async (req: Request, res: Response): Promise<void> => {
  const { error } = await supabaseService
    .from('chapters')
    .delete()
    .eq('id', req.params.id)
    .eq('school_id', req.school_id);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.status(204).send();
});

export default router;
