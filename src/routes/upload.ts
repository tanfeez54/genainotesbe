import { Router, Request, Response } from 'express';
import { uploadToR2 } from '../lib/r2';
import { z } from 'zod';

const router = Router();

// POST /api/upload — Upload base64 encoded image to Cloudflare R2
router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const schema = z.object({
      base64: z.string().min(1, 'Base64 image content is required'),
      folder: z.enum(['logos', 'stamps', 'signatures', 'scans']).default('scans'),
      fileName: z.string().optional(),
      contentType: z.string().default('image/jpeg'),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid upload payload', details: parsed.error.flatten() });
      return;
    }

    const { base64, folder, fileName, contentType } = parsed.data;

    // Strip out standard data URL prefix (e.g. data:image/png;base64,) if present
    const cleanBase64 = base64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');

    // Generate unique key
    const ext = contentType.split('/')[1] || 'jpg';
    const finalFileName = fileName || `${Date.now()}_${Math.random().toString(36).substring(2, 9)}.${ext}`;
    const key = `${folder}/${finalFileName}`;

    const url = await uploadToR2(buffer, key, contentType);

    res.json({
      success: true,
      url,
      key,
    });
  } catch (error: any) {
    console.error('R2 Upload error:', error);
    res.status(500).json({ error: error.message || 'Failed to upload to Cloudflare R2' });
  }
});

export default router;
