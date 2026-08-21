import { GoogleGenerativeAI } from '@google/generative-ai';
import { aiNoteSchema, type AINote } from '../schemas';
import type { NoteGenerationSettings } from '../types';

if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });

function buildPrompt(
  content: string,
  settings: Partial<NoteGenerationSettings>,
  isRepair = false,
  previousResponse?: string
): string {
  const purposeMap: Record<string, string> = {
    exam_prep: 'Exam Preparation (focus on important concepts, formulas, and likely exam questions)',
    revision: 'Quick Revision (concise summaries and key points)',
    beginner_learning: 'Beginner Learning (explain concepts simply with many examples)',
    deep_understanding: 'Deep Understanding (thorough explanations, nuances, and connections)',
  };

  const lengthMap: Record<string, string> = {
    short: 'Keep notes concise — 3-5 key sections, 150-200 words per section.',
    medium: 'Balanced length — 5-7 sections, 200-350 words per section.',
    detailed: 'Comprehensive notes — 7-10+ sections, 350-500 words per section.',
  };

  const purpose = settings.purpose ? purposeMap[settings.purpose] || settings.purpose : 'General Study';
  const noteLength = settings.note_length ? lengthMap[settings.note_length] : lengthMap['medium'];
  const language = settings.language || 'English';
  const level = settings.level || 'intermediate';

  const sectionInstructions: string[] = [];
  if (settings.include_summary !== false) sectionInstructions.push('- A "summary" field with a 2-3 sentence overview');
  if (settings.include_key_points !== false) sectionInstructions.push('- "key_points" array with 5-10 bullet points');
  if (settings.include_examples !== false) sectionInstructions.push('- At least one section of type "example"');
  if (settings.include_formulas) sectionInstructions.push('- Sections of type "formula" for any mathematical/technical formulas');
  if (settings.include_common_mistakes) sectionInstructions.push('- "common_mistakes" array and sections of type "mistake"');
  if (settings.include_practice_questions) sectionInstructions.push('- A section of type "revision" with practice questions');

  const customInstr = settings.custom_instruction
    ? `\nCustom Instructions from user: ${settings.custom_instruction}`
    : '';

  const repairNote = isRepair && previousResponse
    ? `\n\nIMPORTANT: Your previous response was not valid JSON. Previous response:\n${previousResponse}\n\nPlease fix it and return ONLY valid JSON matching the schema below.`
    : '';

  return `You are an expert study notes creator. Generate detailed, structured study notes from the following content.

PURPOSE: ${purpose}
LEVEL: ${level}
LANGUAGE: Write all notes in ${language}
LENGTH: ${noteLength}
${customInstr}${repairNote}

CONTENT TO PROCESS:
---
${content}
---

Return ONLY a valid JSON object (no markdown code blocks, no extra text) matching this exact schema:
{
  "title": "string — a descriptive title for these notes",
  "summary": "string — 2-3 sentence overview of the content",
  "sections": [
    {
      "type": "concept | formula | example | mistake | revision",
      "title": "string — section heading",
      "content": "string — detailed content for this section"
    }
  ],
  "key_points": ["string — concise key point", "..."],
  "common_mistakes": ["string — common mistake to avoid", "..."],
  "quick_revision": ["string — quick revision bullet", "..."]
}

REQUIREMENTS:
${sectionInstructions.join('\n')}
- Write all content in ${language}
- Do NOT include any text outside the JSON object
- Ensure the JSON is valid and parseable`;
}

export async function generateNotesWithAI(
  content: string,
  settings: Partial<NoteGenerationSettings>
): Promise<AINote> {
  const prompt = buildPrompt(content, settings);

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  // Clean potential markdown code blocks
  const jsonText = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    // Retry with repair prompt
    const repairPrompt = buildPrompt(content, settings, true, text);
    const repairResult = await model.generateContent(repairPrompt);
    const repairText = repairResult.response.text().trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    try {
      parsed = JSON.parse(repairText);
    } catch {
      throw new Error('AI returned invalid JSON after retry');
    }
  }

  // Validate with Zod
  const validated = aiNoteSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`AI output failed validation: ${validated.error.message}`);
  }

  return validated.data;
}
