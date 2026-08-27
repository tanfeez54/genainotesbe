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

import { deleteFromStorage } from '../lib/r2';

// DELETE /api/classes/:id — delete class & cascade clean all its subjects, chapters, scans & questions
router.delete('/:id', requireSchoolAccess(['super_admin', 'school_admin']), async (req: Request, res: Response): Promise<void> => {
  try {
    const classId = req.params.id;

    // 1. Fetch subjects
    const { data: subjects } = await supabaseService
      .from('subjects')
      .select('id')
      .eq('class_id', classId)
      .eq('school_id', req.school_id);

    const subjectIds = (subjects || []).map((s: any) => s.id);

    if (subjectIds.length > 0) {
      // 2. Fetch chapters
      const { data: chapters } = await supabaseService
        .from('chapters')
        .select('id')
        .in('subject_id', subjectIds)
        .eq('school_id', req.school_id);

      const chapterIds = (chapters || []).map((c: any) => c.id);

      if (chapterIds.length > 0) {
        // 3. Delete scans from R2 & DB
        const { data: scans } = await supabaseService
          .from('scanned_documents')
          .select('id, image_url')
          .in('chapter_id', chapterIds)
          .eq('school_id', req.school_id);

        if (scans && scans.length > 0) {
          for (const s of scans) {
            if (s.image_url) {
              await deleteFromStorage(s.image_url).catch(() => {});
            }
          }
          await supabaseService
            .from('scanned_documents')
            .delete()
            .in('chapter_id', chapterIds)
            .eq('school_id', req.school_id);
        }

        // 4. Delete questions
        await supabaseService
          .from('questions')
          .delete()
          .in('chapter_id', chapterIds)
          .eq('school_id', req.school_id);

        // 5. Delete chapters
        await supabaseService
          .from('chapters')
          .delete()
          .in('id', chapterIds)
          .eq('school_id', req.school_id);
      }

      // 6. Delete subjects
      await supabaseService
        .from('subjects')
        .delete()
        .in('id', subjectIds)
        .eq('school_id', req.school_id);
    }

    // 7. Delete the class row
    const { error } = await supabaseService
      .from('classes')
      .delete()
      .eq('id', classId)
      .eq('school_id', req.school_id);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.status(204).send();
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to delete class' });
  }
});

export default router;
