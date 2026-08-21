import { supabaseAdmin } from '../lib/supabase';
import { extractContentFromUrl, chunkContent } from './scraper';
import { generateNotesWithAI } from './ai';
import type { NoteGenerationSettings } from '../types';

interface PipelineContext {
  noteId: string;
  userId: string;
  sourceUrl: string;
  settings: Partial<NoteGenerationSettings>;
}

async function updateJobProgress(
  jobId: string,
  progress: number,
  currentStep: string,
  status: 'queued' | 'processing' | 'completed' | 'failed' = 'processing',
  errorMessage?: string
) {
  await supabaseAdmin
    .from('note_generation_jobs')
    .update({
      progress,
      current_step: currentStep,
      status,
      ...(errorMessage && { error_message: errorMessage }),
      ...(status === 'completed' && { completed_at: new Date().toISOString() }),
      ...(status === 'processing' && progress === 5 && { started_at: new Date().toISOString() }),
    })
    .eq('id', jobId);
}

async function updateNoteStatus(
  noteId: string,
  status: 'draft' | 'generating' | 'completed' | 'failed'
) {
  await supabaseAdmin
    .from('notes')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', noteId);
}

/**
 * Main generation pipeline — runs server-side after /generate is called
 * Uses Firecrawl (via GoodSender) for URL extraction
 * Updates job progress at each step for frontend polling
 */
export async function runGenerationPipeline(
  jobId: string,
  ctx: PipelineContext
): Promise<void> {
  const { noteId, userId: _userId, sourceUrl, settings } = ctx;

  try {
    // Step 1: Mark as processing
    await updateJobProgress(jobId, 5, 'Validating URL...');
    await updateNoteStatus(noteId, 'generating');

    // Step 2: Validate URL format
    try {
      new URL(sourceUrl);
    } catch {
      throw new Error('Invalid URL format');
    }

    await updateJobProgress(jobId, 20, 'Fetching page with Firecrawl...');

    // Step 3: Extract content using Firecrawl (handles JS rendering, ads removal, etc.)
    let extracted: Awaited<ReturnType<typeof extractContentFromUrl>>;
    try {
      extracted = await extractContentFromUrl(sourceUrl);
    } catch (e) {
      throw new Error(`Content extraction failed: ${(e as Error).message}`);
    }

    await updateJobProgress(jobId, 45, 'Content extracted successfully...');

    // Step 4: Update note_sources with extracted content
    await supabaseAdmin
      .from('note_sources')
      .update({
        title: extracted.title,
        domain: extracted.domain,
        extracted_content: extracted.content.substring(0, 50000),
        fetch_status: 'completed',
        fetched_at: new Date().toISOString(),
      })
      .eq('note_id', noteId)
      .eq('url', sourceUrl);

    await updateJobProgress(jobId, 55, 'Preparing AI prompt...');

    // Step 5: Chunk content if necessary (use first chunk for MVP)
    const chunks = chunkContent(extracted.content);
    const contentForAI = chunks[0];

    await updateJobProgress(jobId, 65, 'Generating notes with Gemini AI...');

    // Step 6: Call Gemini AI model
    const aiResult = await generateNotesWithAI(contentForAI, settings);

    await updateJobProgress(jobId, 85, 'Saving notes to database...');

    // Step 7: Write note sections to DB
    const sectionsToInsert: Array<{
      note_id: string;
      section_type: string;
      title: string;
      content: string;
      position: number;
    }> = aiResult.sections.map((section, idx) => ({
      note_id: noteId,
      section_type: section.type,
      title: section.title,
      content: section.content,
      position: idx,
    }));

    // Add key_points as a section
    if (aiResult.key_points.length > 0) {
      sectionsToInsert.push({
        note_id: noteId,
        section_type: 'key_points',
        title: 'Key Points',
        content: aiResult.key_points.map((p) => `• ${p}`).join('\n'),
        position: sectionsToInsert.length,
      });
    }

    // Add common_mistakes as a section
    if (aiResult.common_mistakes.length > 0) {
      sectionsToInsert.push({
        note_id: noteId,
        section_type: 'mistake',
        title: 'Common Mistakes',
        content: aiResult.common_mistakes.map((m) => `⚠️ ${m}`).join('\n'),
        position: sectionsToInsert.length,
      });
    }

    // Add quick_revision as a section
    if (aiResult.quick_revision.length > 0) {
      sectionsToInsert.push({
        note_id: noteId,
        section_type: 'revision',
        title: 'Quick Revision',
        content: aiResult.quick_revision.map((r) => `📌 ${r}`).join('\n'),
        position: sectionsToInsert.length,
      });
    }

    // Delete any old sections (in case of regeneration)
    await supabaseAdmin.from('note_sections').delete().eq('note_id', noteId);

    const { error: sectionsError } = await supabaseAdmin
      .from('note_sections')
      .insert(sectionsToInsert);

    if (sectionsError) throw new Error(`Failed to save sections: ${sectionsError.message}`);

    // Step 8: Update note with summary, title, and status
    const wordCount = aiResult.sections.reduce(
      (acc, s) => acc + s.content.split(/\s+/).length,
      0
    );

    await supabaseAdmin
      .from('notes')
      .update({
        title: aiResult.title,
        summary: aiResult.summary,
        content: aiResult as unknown as Record<string, unknown>,
        status: 'completed',
        word_count: wordCount,
        updated_at: new Date().toISOString(),
      })
      .eq('id', noteId);

    // Step 9: Mark job as completed
    await updateJobProgress(jobId, 100, 'Notes generated successfully! 🎉', 'completed');

  } catch (error) {
    const errorMessage = (error as Error).message;
    console.error(`[Pipeline] Failed for note ${noteId}:`, errorMessage);

    await updateJobProgress(jobId, 0, 'Generation failed', 'failed', errorMessage);
    await updateNoteStatus(noteId, 'failed');

    // Update note_sources with error
    await supabaseAdmin
      .from('note_sources')
      .update({
        fetch_status: 'failed',
        error_message: errorMessage,
      })
      .eq('note_id', noteId)
      .eq('url', sourceUrl);
  }
}
