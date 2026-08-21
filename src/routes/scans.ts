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
    .select('*, chapters(title, subjects(name, classes(name)))')
    .eq('school_id', req.school_id)
    .order('created_at', { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ data });
});

// POST /api/scans — Create a new scan record
router.post('/', requireSchoolAccess(['super_admin', 'school_admin', 'teacher', 'data_entry']), async (req: Request, res: Response): Promise<void> => {
  const schema = z.object({
    image_url: z.string().url(),
    doc_type: z.enum(['question_paper', 'chapter_page']),
    chapter_id: z.string().uuid().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { data, error } = await supabaseService
    .from('scanned_documents')
    .insert({
      ...parsed.data,
      school_id: req.school_id,
      uploaded_by: req.userId,
      status: 'pending'
    })
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(201).json({ data });
});

// POST /api/scans/:id/process — Trigger OCR via Gemini
router.post('/:id/process', requireSchoolAccess(['super_admin', 'school_admin', 'teacher', 'data_entry']), async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    // 1. Fetch the scan record
    const { data: scan, error: scanError } = await supabaseService
      .from('scanned_documents')
      .select('*')
      .eq('id', id)
      .eq('school_id', req.school_id)
      .single();

    if (scanError || !scan) {
      res.status(404).json({ error: 'Scan not found' });
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

    // 3. Fetch image from URL
    const imageResponse = await fetch(scan.image_url);
    if (!imageResponse.ok) throw new Error('Failed to download image from URL');
    
    const arrayBuffer = await imageResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = imageResponse.headers.get('content-type') || 'image/jpeg';

    // 4. Send to Gemini
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const prompt = `
      You are an expert OCR and data extraction system for educational question papers.
      Analyze the provided image (which is a school test paper or textbook page).
      Extract ALL the questions, their associated answers (if provided or if you can reliably infer a short one, otherwise leave blank), and marks.
      
      Return the extracted data as a JSON array where each object has:
      {
        "question_text": "The full text of the question",
        "question_type": "mcq" | "short_answer" | "long_answer" | "true_false" | "fill_blanks",
        "options": ["A", "B", "C", "D"], // Only if it's an MCQ, otherwise null or empty array
        "marks": 5, // A number representing the marks, if visible. If not visible, guess based on length (1 for MCQ, 2 for short, 5 for long)
        "answer_text": "The answer" // Optional
      }

      Do NOT return markdown formatting like \`\`\`json. Return ONLY valid JSON array.
    `;

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: buffer.toString('base64'),
          mimeType
        }
      }
    ]);

    const text = result.response.text();
    
    // Clean up markdown if Gemini adds it accidentally
    let jsonStr = text.trim();
    if (jsonStr.startsWith('```json')) jsonStr = jsonStr.substring(7);
    if (jsonStr.startsWith('```')) jsonStr = jsonStr.substring(3);
    if (jsonStr.endsWith('```')) jsonStr = jsonStr.substring(0, jsonStr.length - 3);
    
    const extractedData = JSON.parse(jsonStr.trim());

    // 5. Save results
    const { data: updatedScan, error: updateError } = await supabaseService
      .from('scanned_documents')
      .update({
        status: 'ocr_completed',
        raw_ocr_json: extractedData,
        raw_ocr_text: text,
        processed_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (updateError) throw updateError;

    res.json({ message: 'Processed successfully', data: updatedScan });
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

    res.status(500).json({ error: 'Failed to process document', details: error.message });
  }
});

// GET /api/scans/:id — Get a specific scan
router.get('/:id', requireSchoolAccess(), async (req: Request, res: Response): Promise<void> => {
  const { data, error } = await supabaseService
    .from('scanned_documents')
    .select('*, chapters(title, subjects(name, classes(name)))')
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
