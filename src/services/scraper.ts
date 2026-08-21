import FirecrawlApp from '@mendable/firecrawl-js';

// Initialize Firecrawl client with GoodSender as the custom API host
// GoodSender is a Firecrawl-compatible service
const firecrawlApiKey = process.env.FIRECRAWL_API_KEY ?? '';
const firecrawlApiUrl = process.env.FIRECRAWL_API_URL ?? 'https://api.firecrawl.dev';

let firecrawl: FirecrawlApp | null = null;

function getFirecrawl(): FirecrawlApp {
  if (!firecrawl) {
    if (!firecrawlApiKey || firecrawlApiKey === 'your-goodsender-api-key-here') {
      throw new Error(
        'FIRECRAWL_API_KEY is not set. Get your key from https://goodsender.com/dashboard/w/609a8196-5bac-4af3-9d27-edf82ced4c4e/api-keys'
      );
    }
    firecrawl = new FirecrawlApp({
      apiKey: firecrawlApiKey,
      apiUrl: firecrawlApiUrl,
    });
  }
  return firecrawl;
}

export interface ExtractedContent {
  title: string;
  content: string;
  domain: string;
  wordCount: number;
  markdown?: string;
}

/**
 * Extract content from a URL using Firecrawl (via GoodSender)
 * Returns clean markdown content ready for AI processing
 */
export async function extractContentFromUrl(url: string): Promise<ExtractedContent> {
  const client = getFirecrawl();
  const domain = new URL(url).hostname;

  const result = (await client.scrapeUrl(url, {
    formats: ['markdown', 'html'],
    onlyMainContent: true,
    waitFor: 2000,
  })) as any;

  if (result.success === false) {
    throw new Error(`Firecrawl failed to scrape: ${result.error ?? 'Unknown error'}`);
  }

  const markdown = result.markdown ?? '';
  const title =
    result.metadata?.title ??
    result.metadata?.ogTitle ??
    extractTitleFromMarkdown(markdown) ??
    'Untitled';

  // Remove markdown heading markers for cleaner AI input
  const cleanContent = markdown
    .replace(/#{1,6}\s/g, '') // strip heading markers
    .replace(/\*\*(.*?)\*\*/g, '$1') // strip bold
    .replace(/\*(.*?)\*/g, '$1') // strip italic
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // strip links, keep text
    .replace(/\n{3,}/g, '\n\n') // normalize whitespace
    .trim();

  const wordCount = cleanContent.split(/\s+/).filter(Boolean).length;

  if (wordCount < 50) {
    throw new Error(
      'Could not extract enough content from this URL. The page may require login, be paywalled, or have very little text.'
    );
  }

  return {
    title: title.trim(),
    content: cleanContent,
    markdown,
    domain,
    wordCount,
  };
}

function extractTitleFromMarkdown(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * Chunk content into pieces that fit within model context
 * ~3500 words per chunk (conservative for Gemini 1.5 Pro)
 */
export function chunkContent(content: string, maxWords = 3500): string[] {
  const words = content.split(/\s+/);
  if (words.length <= maxWords) return [content];

  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += maxWords) {
    chunks.push(words.slice(i, i + maxWords).join(' '));
  }
  return chunks;
}

/**
 * Preview extract — lightweight check without full AI processing
 * Used by /api/sources/extract to show URL preview on the frontend
 */
export async function previewExtract(url: string): Promise<{
  title: string;
  domain: string;
  wordCount: number;
  contentPreview: string;
}> {
  const extracted = await extractContentFromUrl(url);
  return {
    title: extracted.title,
    domain: extracted.domain,
    wordCount: extracted.wordCount,
    contentPreview: extracted.content.substring(0, 500) + '...',
  };
}
