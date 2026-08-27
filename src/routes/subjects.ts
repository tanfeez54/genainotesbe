import { Router, Request, Response } from 'express';
import { supabaseService } from '../lib/supabase';
import { z } from 'zod';
import { requireSchoolAccess } from '../middleware/schoolAccess';

const router = Router();

const createSubjectSchema = z.object({
  name: z.string().min(1),
  class_id: z.string().uuid()
});
const updateSubjectSchema = createSubjectSchema.partial();

// GET /api/subjects — list school's subjects
router.get('/', requireSchoolAccess(), async (req: Request, res: Response): Promise<void> => {
  // Can filter by class_id if provided
  let query = supabaseService
    .from('subjects')
    .select('*, classes(name)')
    .eq('school_id', req.school_id)
    .order('created_at', { ascending: false });

  if (req.query.class_id) {
    query = query.eq('class_id', req.query.class_id);
  }

  const { data, error } = await query;

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ data });
});

// POST /api/subjects — create subject
router.post('/', requireSchoolAccess(['super_admin', 'school_admin', 'teacher']), async (req: Request, res: Response): Promise<void> => {
  const parsed = createSubjectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { data, error } = await supabaseService
    .from('subjects')
    .insert({ ...parsed.data, school_id: req.school_id, user_id: req.userId || undefined })
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.status(201).json({ data });
});

// PATCH /api/subjects/:id — update subject
router.patch('/:id', requireSchoolAccess(['super_admin', 'school_admin', 'teacher']), async (req: Request, res: Response): Promise<void> => {
  const parsed = updateSubjectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { data, error } = await supabaseService
    .from('subjects')
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

// DELETE /api/subjects/:id — delete subject & cascade clean its chapters, scans & questions
router.delete('/:id', requireSchoolAccess(['super_admin', 'school_admin']), async (req: Request, res: Response): Promise<void> => {
  try {
    const subjectId = req.params.id;

    // 1. Fetch all chapters of this subject
    const { data: chapters } = await supabaseService
      .from('chapters')
      .select('id')
      .eq('subject_id', subjectId)
      .eq('school_id', req.school_id);

    const chapterIds = (chapters || []).map((c: any) => c.id);

    if (chapterIds.length > 0) {
      // 2. Fetch and delete scans
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

      // 3. Delete questions
      await supabaseService
        .from('questions')
        .delete()
        .in('chapter_id', chapterIds)
        .eq('school_id', req.school_id);

      // 4. Delete chapters
      await supabaseService
        .from('chapters')
        .delete()
        .in('id', chapterIds)
        .eq('school_id', req.school_id);
    }

    // 5. Delete the subject row
    const { error } = await supabaseService
      .from('subjects')
      .delete()
      .eq('id', subjectId)
      .eq('school_id', req.school_id);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.status(204).send();
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to delete subject' });
  }
});

export default router;
