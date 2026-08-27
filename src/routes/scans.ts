import { Router, Request, Response } from 'express';
import { supabaseService } from '../lib/supabase';
import { z } from 'zod';
import { requireSchoolAccess } from '../middleware/schoolAccess';
import { GoogleGenerativeAI } from '@google/generative-ai';

const router = Router();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// GET /api/scans — list school's scans
router.get('/', requireSchoolAccess(), async (req: Request, res: Response): Promise<void> => {
  const { data, error } = await supabaseService
    .from('scanned_documents')
    .select('*, chapters(id, title, subjects(id, name, classes(id, name)))')
    .eq('school_id', req.school_id)
    .order('created_at', { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ data });
});

// POST /api/scans — Create a new scan record with STRICT Class/Subject/Chapter validation
router.post('/', requireSchoolAccess(['super_admin', 'school_admin', 'teacher', 'data_entry']), async (req: Request, res: Response): Promise<void> => {
  try {
    const schema = z.object({
      image_url: z.string().min(1, 'Image URL or base64 data is required'),
      doc_type: z.enum(['question_paper', 'chapter_page']).default('question_paper'),
      chapter_id: z.string().uuid().optional(),
      chapter_name: z.string().min(1).optional(),
      subject_id: z.string().uuid().optional(),
      class_id: z.string().uuid().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed: Class, Subject and Chapter are required', details: parsed.error.flatten() });
      return;
    }

    let finalChapterId = parsed.data.chapter_id;

    // If chapter_name & subject_id are provided, resolve or create chapter
    if (!finalChapterId && parsed.data.chapter_name && parsed.data.subject_id) {
      // Check if chapter exists with same title in this subject
      const { data: existingChapter } = await supabaseService
        .from('chapters')
        .select('id')
        .eq('school_id', req.school_id)
        .eq('subject_id', parsed.data.subject_id)
        .ilike('title', parsed.data.chapter_name.trim())
        .maybeSingle();

      if (existingChapter) {
        finalChapterId = existingChapter.id;
      } else {
        // Create new chapter
        const { data: newChapter, error: createChapterError } = await supabaseService
          .from('chapters')
          .insert({
            school_id: req.school_id,
            subject_id: parsed.data.subject_id,
            title: parsed.data.chapter_name.trim(),
          })
          .select('id')
          .single();

        if (createChapterError || !newChapter) {
          res.status(500).json({ error: 'Failed to create chapter for scan', details: createChapterError?.message });
          return;
        }
        finalChapterId = newChapter.id;
      }
    }

    if (!finalChapterId) {
      res.status(400).json({ error: 'Chapter is strictly required. Please select or provide a chapter name.' });
      return;
    }

    const { data, error } = await supabaseService
      .from('scanned_documents')
      .insert({
        image_url: parsed.data.image_url,
        doc_type: parsed.data.doc_type,
        chapter_id: finalChapterId,
        school_id: req.school_id,
        uploaded_by: req.userId,
        status: 'pending'
      })
      .select('*, chapters(id, title, subjects(id, name, classes(id, name)))')
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.status(201).json({ data, chapter_id: finalChapterId });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Server error creating scan' });
  }
});

// POST /api/scans/:id/process — Trigger OCR via Gemini
router.post('/:id/process', requireSchoolAccess(['super_admin', 'school_admin', 'teacher', 'data_entry']), async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    // 1. Fetch the scan record
    const { data: scan, error: scanError } = await supabaseService
      .from('scanned_documents')
      .select('*, chapters(id, title, subjects(id, name, classes(id, name)))')
      .eq('id', id)
      .eq('school_id', req.school_id)
      .single();

    if (scanError || !scan) {
      res.status(404).json({ error: 'Scan record not found' });
      return;
    }

    if (!scan.chapter_id) {
      res.status(400).json({ error: 'Cannot process scan without an assigned Chapter.' });
      return;
    }

    if (scan.status === 'processing') {
      res.status(400).json({ error: 'Document is already being processed' });
      return;
    }

    // 2. Mark as processing
    await supabaseService
      .from('scanned_documents')
      .update({ status: 'processing' })
      .eq('id', id);

    // 3. Obtain image buffer (supports base64 data URL or HTTP URL)
    let buffer: Buffer;
    let mimeType = 'image/jpeg';

    if (scan.image_url.startsWith('data:')) {
      const parts = scan.image_url.split(',');
      const mimeMatch = parts[0].match(/:(.*?);/);
      if (mimeMatch) mimeType = mimeMatch[1];
      buffer = Buffer.from(parts[1], 'base64');
    } else {
      const imageResponse = await fetch(scan.image_url);
      if (!imageResponse.ok) throw new Error('Failed to download image from URL');
      const arrayBuffer = await imageResponse.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
      mimeType = imageResponse.headers.get('content-type') || 'image/jpeg';
    }

    // 4. Send to Gemini for Complete Verbatim OCR Text Extraction
    const geminiModelName = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
    const model = genAI.getGenerativeModel({ model: geminiModelName });

    const prompt = `You are an expert OCR transcription engine.
Transcribe and extract the ENTIRE text from the provided image accurately, verbatim, and completely.
- Preserve all original headings, paragraphs, bullet points, numbered lists, equations, formulas, tables, and Hindi / English text exactly as they appear on the page.
- Do NOT skip, summarize, or alter any text.
- Return the extracted raw text directly.`;

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: buffer.toString('base64'),
          mimeType: mimeType.split(';')[0].trim() || 'image/jpeg'
        }
      }
    ]);

    const extractedText = result.response.text().trim();

    // 5. Save verbatim extracted text to scanned_documents
    const { data: updatedScan, error: updateError } = await supabaseService
      .from('scanned_documents')
      .update({
        status: 'ocr_completed',
        raw_ocr_text: extractedText,
        processed_at: new Date().toISOString()
      })
      .eq('id', id)
      .select('*, chapters(id, title, subjects(id, name, classes(id, name)))')
      .single();

    if (updateError) throw updateError;

    res.json({
      message: 'Text extracted successfully',
      raw_ocr_text: extractedText,
      data: updatedScan
    });
  } catch (error: any) {
    console.error('OCR Processing Error:', error);

    // Mark as failed
    await supabaseService
      .from('scanned_documents')
      .update({
        status: 'failed',
        error_message: error.message || 'Unknown error during OCR'
      })
      .eq('id', req.params.id);

    res.status(500).json({ error: 'Failed to process document with OCR', details: error.message });
  }
});

// PATCH /api/scans/:id — Update extracted text or chapter mapping
router.patch('/:id', requireSchoolAccess(['super_admin', 'school_admin', 'teacher', 'data_entry']), async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { raw_ocr_text, chapter_id, status } = req.body;

    const updatePayload: any = {};
    if (raw_ocr_text !== undefined) updatePayload.raw_ocr_text = raw_ocr_text;
    if (chapter_id !== undefined) updatePayload.chapter_id = chapter_id;
    if (status !== undefined) updatePayload.status = status;

    const { data, error } = await supabaseService
      .from('scanned_documents')
      .update(updatePayload)
      .eq('id', id)
      .eq('school_id', req.school_id)
      .select('*, chapters(id, title, subjects(id, name, classes(id, name)))')
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json({ data, message: 'Extracted text saved successfully' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/scans/:id — Get a specific scan
router.get('/:id', requireSchoolAccess(), async (req: Request, res: Response): Promise<void> => {
  const { data, error } = await supabaseService
    .from('scanned_documents')
    .select('*, chapters(id, title, subjects(id, name, classes(id, name)))')
    .eq('id', req.params.id)
    .eq('school_id', req.school_id)
    .single();

  if (error || !data) {
    res.status(404).json({ error: 'Scan not found' });
    return;
  }
  res.json({ data });
});

export default router;
