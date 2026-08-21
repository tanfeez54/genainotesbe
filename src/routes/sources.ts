import { Router, Request, Response } from 'express';
import { previewExtract } from '../services/scraper';
import { extractSourceSchema } from '../schemas';

const router = Router();

// POST /api/sources/extract — preview-extract content from a URL using Firecrawl
router.post('/extract', async (req: Request, res: Response) => {
  const parsed = extractSourceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { url } = parsed.data;

  try {
    const preview = await previewExtract(url);
    res.json({ data: preview });
  } catch (e) {
    const message = (e as Error).message;

    if (message.includes('FIRECRAWL_API_KEY')) {
      res.status(503).json({
        error: 'Firecrawl API key not configured. Please set FIRECRAWL_API_KEY in backend/.env',
      });
    } else {
      res.status(400).json({ error: message });
    }
  }
});

export default router;
