import { GoogleGenerativeAI } from '@google/generative-ai';
import { aiNoteSchema, type AINote } from '../schemas';
import type { NoteGenerationSettings } from '../types';

if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

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

export interface QuestionSectionConfig {
  section_name: string;
  type: 'mcq' | 'short_answer' | 'long_answer' | 'true_false' | 'fill_blank' | 'match_the_following';
  count: number;
  marks_per_question: number;
  difficulty?: 'easy' | 'medium' | 'hard';
}

export interface QuestionGenerationConfig {
  className: string;
  subjectName: string;
  chapterTitles?: string[];
  contextContent?: string;
  sections: QuestionSectionConfig[];
  language?: string;
  customInstructions?: string;
}

export interface GeneratedQuestionItem {
  id?: string;
  section_name: string;
  type: string;
  question_text: string;
  options?: { label: string; text: string }[] | null;
  correct_option?: string | null;
  answer_text?: string | null;
  marks: number;
  difficulty: 'easy' | 'medium' | 'hard';
  chapter_title?: string;
}

export async function generateQuestionsWithAI(
  config: QuestionGenerationConfig
): Promise<GeneratedQuestionItem[]> {
  const chaptersStr = config.chapterTitles && config.chapterTitles.length > 0
    ? config.chapterTitles.join(', ')
    : 'All Chapters / General Syllabus';

  const sectionsDesc = config.sections
    .map(
      (s, idx) =>
        `Section ${idx + 1}: "${s.section_name}" -> Exactly ${s.count} questions of type "${s.type}" (${s.marks_per_question} mark(s) each, difficulty: ${s.difficulty || 'medium'})`
    )
    .join('\n');

  const contextPrompt = config.contextContent
    ? `\n\nReference Material / OCR Textbook Extracts:\n${config.contextContent.slice(0, 10000)}`
    : '';

  const customPrompt = config.customInstructions
    ? `\nSpecial Instructions: ${config.customInstructions}`
    : '';

  const prompt = `You are a master academic question paper creator for CBSE / ICSE / State Board schools.
Create a high-quality, comprehensive examination question paper strictly following the curriculum standards.

CLASS / GRADE: ${config.className}
SUBJECT: ${config.subjectName}
CHAPTERS / SYLLABUS: ${chaptersStr}
LANGUAGE: ${config.language || 'English'}
${customPrompt}${contextPrompt}

BLUEPRINT SPECIFICATIONS:
${sectionsDesc}

STRICT JSON OUTPUT REQUIREMENTS:
1. Return ONLY a valid JSON array of question objects (no markdown wrapping, no extra prose).
2. Each object MUST match this schema:
[
  {
    "section_name": "Section A - Multiple Choice Questions",
    "type": "mcq",
    "question_text": "Complete question text clearly stated",
    "options": [
      { "label": "A", "text": "Option text" },
      { "label": "B", "text": "Option text" },
      { "label": "C", "text": "Option text" },
      { "label": "D", "text": "Option text" }
    ],
    "correct_option": "A",
    "answer_text": "Explanation and correct answer",
    "marks": 1,
    "difficulty": "easy",
    "chapter_title": "Chapter name"
  },
  {
    "section_name": "Section B - Short Answer Questions",
    "type": "short_answer",
    "question_text": "Short answer question text",
    "options": null,
    "correct_option": null,
    "answer_text": "Detailed model answer / points expected for grading",
    "marks": 3,
    "difficulty": "medium",
    "chapter_title": "Chapter name"
  }
]

Generate pedagogical, error-free, and syllabus-appropriate questions.`;

  const result = await model.generateContent(prompt);
  const rawText = result.response.text().trim();

  const jsonText = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(jsonText);
    if (Array.isArray(parsed)) {
      return parsed.map((item, idx) => ({
        id: `gen-${Date.now()}-${idx + 1}`,
        section_name: item.section_name || 'General',
        type: item.type || 'short_answer',
        question_text: item.question_text || '',
        options: item.options || null,
        correct_option: item.correct_option || null,
        answer_text: item.answer_text || null,
        marks: Number(item.marks) || 1,
        difficulty: item.difficulty || 'medium',
        chapter_title: item.chapter_title || '',
      }));
    }
    throw new Error('AI output was not an array');
  } catch (err: any) {
    console.error('Error parsing AI questions response:', err, rawText);
    throw new Error('Failed to parse AI generated questions. Please try again.');
  }
}

