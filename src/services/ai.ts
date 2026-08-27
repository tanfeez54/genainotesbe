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
  strictOcrOnly?: boolean;
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
  image_url?: string | null;
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

  const equalWeightagePrompt = config.chapterTitles && config.chapterTitles.length > 1
    ? `\nEQUAL CHAPTER WEIGHTAGE MANDATE:
- The user has selected ${config.chapterTitles.length} chapters: [${config.chapterTitles.join(', ')}].
- You MUST allocate questions and marks EQUALLY among all ${config.chapterTitles.length} selected chapters.
- Ensure each selected chapter contributes approximately equal total marks across the entire question paper.
- Tag each question with its exact corresponding chapter title in the "chapter_title" property.`
    : '';

  const sectionsDesc = config.sections
    .map(
      (s, idx) =>
        `Section ${idx + 1}: "${s.section_name}" -> Exactly ${s.count} questions of type "${s.type}" (${s.marks_per_question} mark(s) each, difficulty: ${s.difficulty || 'medium'})`
    )
    .join('\n');

  const contextPrompt = config.contextContent
    ? `\n\n=== SOURCE SCANNED DOCUMENT OCR TEXT (STRICT GROUND TRUTH) ===\n${config.contextContent.slice(0, 15000)}\n=== END OF SCANNED DOCUMENT TEXT ===`
    : '';

  const strictGroundingRule = config.contextContent
    ? `\nCRITICAL MANDATE: You MUST generate/extract questions SOLELY from the provided SCANNED DOCUMENT OCR TEXT above. Do NOT invent questions from your own general training data. All questions, facts, equations, and solutions must be directly sourced or formulated from the scanned content provided.`
    : '';

  const customPrompt = config.customInstructions
    ? `\nSpecial Instructions: ${config.customInstructions}`
    : '';

  const prompt = `You are a strict academic question paper extractor & generator for CBSE / ICSE / State Board schools.
Create a high-quality, comprehensive examination question paper.

CLASS / GRADE: ${config.className}
SUBJECT: ${config.subjectName}
SELECTED CHAPTERS: ${chaptersStr}
LANGUAGE: ${config.language || 'English'}
${equalWeightagePrompt}
${strictGroundingRule}${customPrompt}${contextPrompt}

BLUEPRINT SPECIFICATIONS:
${sectionsDesc}

STRICT JSON OUTPUT REQUIREMENTS:
1. Return ONLY a valid JSON array of question objects (no markdown wrapping, no extra prose).
2. Each object MUST match this schema according to its type:

For MCQ ('mcq'):
{
  "section_name": "Section A: Multiple Choice Questions",
  "type": "mcq",
  "question_text": "Which organelle is known as the powerhouse of the cell?",
  "options": [
    { "label": "A", "text": "Ribosome" },
    { "label": "B", "text": "Mitochondria" },
    { "label": "C", "text": "Nucleus" },
    { "label": "D", "text": "Golgi Apparatus" }
  ],
  "correct_option": "B",
  "answer_text": "B) Mitochondria generates most of the chemical energy needed by the cell.",
  "image_url": null,
  "marks": 1,
  "difficulty": "easy",
  "chapter_title": "Cell Structure and Functions"
}

For Fill in the Blanks ('fill_blank'):
{
  "section_name": "Section B: Fill in the Blanks",
  "type": "fill_blank",
  "question_text": "The process of food synthesis in green plants is called _______ using sunlight and chlorophyll.",
  "options": null,
  "correct_option": null,
  "answer_text": "Photosynthesis",
  "image_url": null,
  "marks": 1,
  "difficulty": "easy",
  "chapter_title": "Nutrition in Plants"
}

For True / False ('true_false'):
{
  "section_name": "Section C: True or False",
  "type": "true_false",
  "question_text": "Light travels in a straight line through a uniform transparent medium.",
  "options": null,
  "correct_option": "True",
  "answer_text": "True. Light exhibits rectilinear propagation in a homogeneous medium.",
  "image_url": null,
  "marks": 1,
  "difficulty": "easy",
  "chapter_title": "Light and Reflection"
}

For Match the Following ('match_the_following'):
{
  "section_name": "Section D: Match the Following",
  "type": "match_the_following",
  "question_text": "Match the items in Column A with their correct definitions in Column B:\nColumn A:\n1. Chlorophyll\n2. Stomata\n3. Xylem\n4. Phloem\n\nColumn B:\np. Gas exchange\nq. Water transport\nr. Food transport\ns. Green pigment",
  "options": [
    { "label": "1", "text": "Chlorophyll -> s. Green pigment" },
    { "label": "2", "text": "Stomata -> p. Gas exchange" },
    { "label": "3", "text": "Xylem -> q. Water transport" },
    { "label": "4", "text": "Phloem -> r. Food transport" }
  ],
  "correct_option": null,
  "answer_text": "1 - s, 2 - p, 3 - q, 4 - r",
  "image_url": null,
  "marks": 4,
  "difficulty": "medium",
  "chapter_title": "Transportation in Animals and Plants"
}

For Short Answer ('short_answer'):
{
  "section_name": "Section E: Short Answer Questions",
  "type": "short_answer",
  "question_text": "Differentiate between autotrophic and heterotrophic nutrition with one example each.",
  "options": null,
  "correct_option": null,
  "answer_text": "Autotrophs produce their own food (e.g., green plants), whereas heterotrophs depend on others for food (e.g., animals/fungi).",
  "image_url": null,
  "marks": 3,
  "difficulty": "medium",
  "chapter_title": "Life Processes"
}

For Long Answer ('long_answer'):
{
  "section_name": "Section F: Long Answer Questions",
  "type": "long_answer",
  "question_text": "Explain Newton's Three Laws of Motion with suitable everyday examples and mathematical formulations.",
  "options": null,
  "correct_option": null,
  "answer_text": "1. First Law (Inertia)... 2. Second Law (F = ma)... 3. Third Law (Action-Reaction)...",
  "image_url": null,
  "marks": 5,
  "difficulty": "hard",
  "chapter_title": "Force and Laws of Motion"
}

Generate pedagogical, error-free, balanced questions with equal marks distribution across all selected chapters.`;

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
        image_url: item.image_url || null,
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

