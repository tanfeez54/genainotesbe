import { Router, Request, Response } from 'express';
import { supabaseService } from '../lib/supabase';
import { z } from 'zod';
import { requireSchoolAccess } from '../middleware/schoolAccess';

const router = Router();

// Define schemas
const createClassSchema = z.object({
  name: z.string().min(1),
  order_index: z.number().int().default(0)
});
const updateClassSchema = createClassSchema.partial();

// GET /api/classes — list school's classes
router.get('/', requireSchoolAccess(), async (req: Request, res: Response): Promise<void> => {
  const { data, error } = await supabaseService
    .from('classes')
    .select('*')
    .eq('school_id', req.school_id)
    .order('order_index', { ascending: true });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ data });
});

// POST /api/classes — create class (Admins/Teachers)
router.post('/', requireSchoolAccess(['super_admin', 'school_admin', 'teacher']), async (req: Request, res: Response): Promise<void> => {
  const parsed = createClassSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { data, error } = await supabaseService
    .from('classes')
    .insert({ ...parsed.data, school_id: req.school_id })
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.status(201).json({ data });
});

// PATCH /api/classes/:id — update class
router.patch('/:id', requireSchoolAccess(['super_admin', 'school_admin', 'teacher']), async (req: Request, res: Response): Promise<void> => {
  const parsed = updateClassSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { data, error } = await supabaseService
    .from('classes')
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

// DELETE /api/classes/:id — delete class
router.delete('/:id', requireSchoolAccess(['super_admin', 'school_admin']), async (req: Request, res: Response): Promise<void> => {
  const { error } = await supabaseService
    .from('classes')
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
