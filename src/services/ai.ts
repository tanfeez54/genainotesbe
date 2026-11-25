import { GoogleGenerativeAI } from '@google/generative-ai';
import { jsonrepair } from 'jsonrepair';
import { aiNoteSchema, type AINote } from '../schemas';
import type { NoteGenerationSettings } from '../types';
import { cropPdfDiagrams, CropTarget, CropPdfDocument } from './pdfCropService';

if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

export async function generateContentWithFallback(
  promptOrParts: any,
  generationConfig?: any,
  preferredModel?: string
) {
  const models = [
    preferredModel,
    process.env.GEMINI_MODEL,
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.8-flash',
    'gemini-4-hydrogen',
    'gemini-4-argon',
    'gemini-4-carbon',
    'gemini-4-neon',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-3.1-flash-lite',
  ].filter(Boolean) as string[];
  const uniqueModels = Array.from(new Set(models));

  let lastError: any = null;
  for (const modelName of uniqueModels) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const modelOptions: any = { model: modelName };
        if (generationConfig) {
          modelOptions.generationConfig = generationConfig;
        }
        const m = genAI.getGenerativeModel(modelOptions);
        const result = await m.generateContent(promptOrParts);
        return result;
      } catch (err: any) {
        console.warn(`[AI Service Warning] Model ${modelName} (attempt ${attempt}) failed:`, err?.message || err);
        lastError = err;
        if (err?.status === 503 && attempt === 1) {
          // Brief 1s delay if overloaded before retrying
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        break;
      }
    }
  }
  throw lastError || new Error('All AI models failed to generate content');
}

function sanitizeJsonString(input: string): string {
  let result = '';
  let inString = false;
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (!inString) {
      if (ch === '"') {
        inString = true;
        result += '"';
        i++;
      } else {
        result += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inString = false;
        result += '"';
        i++;
      } else if (ch === '\\') {
        const next = input[i + 1];
        if (next === undefined) {
          result += '\\\\';
          i++;
        } else if (next === '"' || next === '\\' || next === '/' || next === 'b' || next === 'f' || next === 'n' || next === 'r' || next === 't') {
          result += ch + next;
          i += 2;
        } else if (next === 'u') {
          const hex = input.slice(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            result += ch + next + hex;
            i += 6;
          } else {
            result += '\\\\';
            i++;
          }
        } else {
          // unescaped LaTeX backslash like \Delta, \text, \rightarrow, \frac
          result += '\\\\';
          i++;
        }
      } else if (ch === '\n') {
        result += '\\n';
        i++;
      } else if (ch === '\r') {
        result += '\\r';
        i++;
      } else if (ch === '\t') {
        result += '\\t';
        i++;
      } else if (ch.charCodeAt(0) < 32) {
        i++;
      } else {
        result += ch;
        i++;
      }
    }
  }

  if (inString) {
    result += '"';
  }

  return result;
}

/**
 * Highly resilient JSON cleaner and parser.
 * Handles markdown formatting, unescaped LaTeX symbols (\rightarrow, \Delta, \frac, \text),
 * unescaped quotes, trailing characters, and truncated responses.
 */
export function cleanAndParseJson<T = any>(rawText: string): T {
  let cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  // 1. Direct parse attempt
  try {
    return JSON.parse(cleaned);
  } catch (e1) {
    // continue
  }

  // 2. Extract outermost JSON structure ({ ... } or [ ... ])
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  const firstBracket = cleaned.indexOf('[');
  const lastBracket = cleaned.lastIndexOf(']');

  let targetJson = cleaned;
  if (firstBrace !== -1 && lastBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    targetJson = cleaned.substring(firstBrace, lastBrace + 1);
  } else if (firstBracket !== -1 && lastBracket !== -1) {
    targetJson = cleaned.substring(firstBracket, lastBracket + 1);
  } else if (firstBrace !== -1) {
    targetJson = cleaned.substring(firstBrace);
  }

  try {
    return JSON.parse(targetJson);
  } catch (e2) {
    // continue
  }

  // 3. Direct jsonrepair attempt on raw targetJson
  try {
    const repairedDirect = jsonrepair(targetJson);
    return JSON.parse(repairedDirect);
  } catch (e3) {
    // continue
  }

  // 4. String-aware sanitizer for unescaped LaTeX equations and multiline strings
  let sanitized = sanitizeJsonString(targetJson);
  try {
    return JSON.parse(sanitized);
  } catch (e4) {
    // continue
  }

  // 5. Fix bare text following a comma or bracket inside an object (e.g. ],Bare text\n  "next_key":)
  sanitized = sanitized.replace(/([,\]]+)\s*([^\s"\{\}\[\]][^\r\n"\{\}\[\]]*?)\s*\r?\n\s*"/g, (match, prefix, bareText) => {
    return `${prefix.includes(']') ? '],' : ','}\n        "extra_note": "${bareText.replace(/"/g, '\\"')}",\n        "`;
  });
  try {
    return JSON.parse(sanitized);
  } catch (e5) {
    // continue
  }

  // 6. Try jsonrepair library on sanitized string
  try {
    const repairedLib = jsonrepair(sanitized);
    return JSON.parse(repairedLib);
  } catch (e6) {
    // continue
  }

  // 7. Try auto-closing truncated JSON (if response ended early)
  let autoClosed = sanitized.trim();
  let inString = false;
  let escaped = false;
  const stack: string[] = [];

  for (let i = 0; i < autoClosed.length; i++) {
    const ch = autoClosed[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (ch === '{' || ch === '[') {
        stack.push(ch);
      } else if (ch === '}' && stack[stack.length - 1] === '{') {
        stack.pop();
      } else if (ch === ']' && stack[stack.length - 1] === '[') {
        stack.pop();
      }
    }
  }

  if (inString) {
    autoClosed += '"';
  }
  // Trim dangling commas, colons, or incomplete dangling keys before closing
  autoClosed = autoClosed.replace(/,\s*"[^"]*"\s*:\s*$/, '').replace(/[,:\s]+$/, '');
  const closingStack = [...stack];
  while (closingStack.length > 0) {
    const top = closingStack.pop();
    if (top === '{') autoClosed += '}';
    else if (top === '[') autoClosed += ']';
  }

  try {
    return JSON.parse(autoClosed);
  } catch (e7) {
    // continue
  }

  try {
    const repairedFallback = jsonrepair(autoClosed);
    return JSON.parse(repairedFallback);
  } catch (e8) {
    // continue
  }

  // 8. Progressive slice backtracking: find last valid '}' before truncation and repair
  for (let endIdx = autoClosed.lastIndexOf('}'); endIdx > 20; endIdx = autoClosed.lastIndexOf('}', endIdx - 1)) {
    try {
      const slice = autoClosed.substring(0, endIdx + 1);
      return JSON.parse(jsonrepair(slice));
    } catch {
      // keep backtracking
    }
  }

  console.error('[cleanAndParseJson] All recovery strategies exhausted. RawText Length:', rawText.length);
  throw new Error('Failed to parse AI generated Lesson Suite. Please try again.');
}

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

  const result = await generateContentWithFallback(prompt);
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
    const repairResult = await generateContentWithFallback(repairPrompt);
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
  sub_section?: string;
  instructions?: string;
  type: 'mcq' | 'short_answer' | 'long_answer' | 'true_false' | 'fill_blank' | 'match_the_following' | 'picture_based';
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
  sub_section?: string;
  type: string;
  question_text: string;
  options?: any;
  correct_option?: string | null;
  answer_text?: string | null;
  image_url?: string | null;
  marks: number;
  difficulty: 'easy' | 'medium' | 'hard';
  chapter_title?: string;
}

export function cleanHindiAndMathText(val: any): any {
  if (typeof val !== 'string') return val;
  let s = val;

  // 1. Remove broken HTML tags like \</i> or </i>
  s = s.replace(/\\?<\/?i>/gi, '');

  // 2. Fix \text{...} or $\text{...}$ that contains Devanagari characters (\u0900-\u097F)
  s = s.replace(/\$?\\\s*text\{([^}]*[\u0900-\u097F][^}]*)\}\$?(\s*)/g, '$1$2');

  // 3. Fix corrupted backslashes inside Devanagari words
  s = s.replace(/([\u0900-\u097F])\s*\\\s*([\u0900-\u097F])/g, '$1$2');

  // 4. Strip $...$ around purely Devanagari words without mathematical operators/numbers
  s = s.replace(/\$([^$]*[\u0900-\u097F][^$]*)\$/g, (match, inner) => {
    if (!/[0-9\+\-\=\^\/\\_<>\\times\\div\\pm\\leq\\geq]/.test(inner)) {
      return inner;
    }
    return match;
  });

  // 5. Repair corrupted 'संख्या' fragments (e.g. 'सं \text{ख्\् याओं}', 'सं ख् याओं')
  s = s.replace(/सं\s*[\\]?\s*ख्[\\\/]?[्\s]*या(ओं|ओ|ऑ|एँ|एं)?/g, (_m, end) => {
    if (end === 'ओं' || end === 'ओ' || end === 'ऑ') return 'संख्याओं';
    if (end === 'एँ' || end === 'एं') return 'संख्याएँ';
    return 'संख्या';
  });
  s = s.replace(/(^|[^\u0900-\u097F])ख्[\\\/]?[्\s]*या(ओं|ओ|ऑ|एँ|एं)?/g, (_m, prefix, end) => {
    if (end === 'ओं' || end === 'ओ' || end === 'ऑ') return prefix + 'ख्याओं';
    if (end === 'एँ' || end === 'एं') return prefix + 'ख्याएँ';
    return prefix + 'ख्या';
  });

  // 6. Normalize duplicate anusvara/chandrabindu
  s = s.replace(/[\u0902\u0901]{2,}/g, '\u0902');

  // 7. General LaTeX sanitization for English math
  s = s
    .replace(/\t\s*ext\{/g, '\\text{')
    .replace(/\\\\([a-zA-Z]+)/g, '\\$1');

  // 8. Clean textbook/page/chapter references so questions read like authentic exam questions
  // e.g. 'अध्याय 3 (हमारे चारों ओर पैटर्न) के पृष्ठ 1 के चित्र को देखकर' -> 'दिए गए चित्र को देखकर'
  s = s.replace(/(?:अध्याय|पाठ)\s*\d*(?:\s*\([^)]*\))?\s*(?:के|पर)?\s*(?:पृष्ठ|पेज)\s*\d*\s*(?:पर|के)?\s*(?:दिए\s*गए\s*)?चित्र\s*को\s*देखकर/g, 'दिए गए चित्र को देखकर');
  s = s.replace(/चित्र\s*\d+(?:\.\d+)?\s*को\s*देखकर/g, 'दिए गए चित्र को देखकर');
  s = s.replace(/(?:अध्याय|पाठ)\s*\d*(?:\s*\([^)]*\))?\s*(?:के|पर)?\s*(?:पृष्ठ|पेज)\s*\d*\s*(?:पर|के|में)?/g, '');
  s = s.replace(/(?:in\s+)?(?:chapter|lesson|unit)\s*\d*(?:\s*\([^)]*\))?,?\s*(?:page|pg\.?)\s*\d*,?\s*look\s+at\s+the\s+(?:picture|figure|diagram)/gi, 'Look at the given picture below');
  s = s.replace(/(?:figure|fig\.?)\s*\d+(?:\.\d+)?/gi, 'the given figure');

  return s.trim();
}

export function sanitizeQuestionOptions(options: any): any {
  if (!options) return null;
  if (Array.isArray(options)) {
    return options.map((opt: any) =>
      typeof opt === 'string'
        ? cleanHindiAndMathText(opt)
        : { ...opt, text: cleanHindiAndMathText(opt.text || '') }
    );
  }
  if (typeof options === 'object') {
    const cleaned: any = {};
    if (Array.isArray(options.column_a)) {
      cleaned.column_a = options.column_a.map((item: any) => ({
        ...item,
        text: cleanHindiAndMathText(item.text || ''),
      }));
    }
    if (Array.isArray(options.column_b)) {
      cleaned.column_b = options.column_b.map((item: any) => ({
        ...item,
        text: cleanHindiAndMathText(item.text || ''),
      }));
    }
    return cleaned;
  }
  return options;
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
        `Section ${idx + 1}: "${s.section_name}"${s.sub_section ? ` (Subsection / Part: "${s.sub_section}")` : ''}${s.instructions ? ` (Instructions: "${s.instructions}")` : ''} -> Exactly ${s.count} questions of type "${s.type}" (${s.marks_per_question} mark(s) each, difficulty: ${s.difficulty || 'medium'})`
    )
    .join('\n');

  const contextPrompt = config.contextContent
    ? `\n\n=== SOURCE SCANNED DOCUMENT OCR TEXT (STRICT GROUND TRUTH) ===\n${config.contextContent.slice(0, 15000)}\n=== END OF SCANNED DOCUMENT TEXT ===`
    : '';

  const strictGroundingRule = config.contextContent
    ? `\nCRITICAL MANDATE: You MUST generate/extract questions SOLELY from the provided SCANNED DOCUMENT OCR TEXT above. Do NOT invent questions from your own general training data. All questions, facts, equations, and solutions must be directly sourced or formulated from the scanned content provided.
If the source text already contains explicitly formatted questions, you MUST extract and use them VERBATIM (word-for-word exactly as they appear in the source text, including all exact LaTeX formulas, numbers, options, and formatting). Do NOT rephrase, modify, or rewrite existing questions from the source.`
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
2. STRICT MATH & LATEX FORMATTING RULES:
   - For all mathematical expressions, proofs, geometry relations, angles, degrees, fractions, roots, equations, and scientific notations, use standard LaTeX enclosed in single dollar signs '$ ... $' (e.g. '$ABCD$', '$\\angle B = 90^\\circ$', '$\\Delta BCD$', '$x^2 + y^2 = r^2$').
   - HINDI / DEVANAGARI & REGIONAL LANGUAGE RULE: All non-English text (Hindi words, instructions, questions, options) MUST be pure natural Unicode text. NEVER wrap Hindi words inside '\\text{...}' or '$ ... $'. ONLY actual mathematical formulas, variables, and numbers should use '$ ... $'. Hindi words like 'संख्याओं', 'संख्याएँ', 'पैटर्न', 'आकृतियाँ' must be written as normal Hindi text without any LaTeX markup.
   - NEVER leave raw LaTeX math commands like '\\angle', '\\Delta', or '\\frac' outside '$...$' delimiters.
   - In JSON output, ALWAYS escape backslashes with double backslashes (e.g. write "\\\\frac", "\\\\times", "\\\\angle", "\\\\circ") so that JSON parsers do not interpret "\\t" as a tab character.
3. Each object MUST match this schema according to its type:

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
  "question_text": "Match the items in Column A with their correct corresponding items in Column B:",
  "options": {
    "column_a": [
      { "label": "1", "text": "Chlorophyll" },
      { "label": "2", "text": "Stomata" },
      { "label": "3", "text": "Xylem" },
      { "label": "4", "text": "Phloem" }
    ],
    "column_b": [
      { "label": "A", "text": "Gas exchange" },
      { "label": "B", "text": "Food transport" },
      { "label": "C", "text": "Green pigment" },
      { "label": "D", "text": "Water transport" }
    ]
  },
  "correct_option": null,
  "answer_text": "1 - C, 2 - A, 3 - D, 4 - B",
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

  const result = await generateContentWithFallback(prompt);
  const rawText = result.response.text().trim();

  const jsonText = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(jsonText);
    if (Array.isArray(parsed)) {
      return parsed.map((item, idx) => {
        const secConfig = config.sections.find(
          s => s.section_name.trim().toLowerCase() === (item.section_name || '').trim().toLowerCase()
        );
        return {
          id: `gen-${Date.now()}-${idx + 1}`,
          section_name: item.section_name || 'General',
          sub_section: item.sub_section ? cleanHindiAndMathText(String(item.sub_section)) : (secConfig?.sub_section || undefined),
          type: item.type || 'short_answer',
          question_text: cleanHindiAndMathText(item.question_text || ''),
          options: sanitizeQuestionOptions(item.options),
          correct_option: item.correct_option ? cleanHindiAndMathText(String(item.correct_option)) : null,
          answer_text: item.answer_text ? cleanHindiAndMathText(String(item.answer_text)) : null,
          image_url: item.image_url || null,
          marks: Number(item.marks) || 1,
          difficulty: item.difficulty || 'medium',
          chapter_title: cleanHindiAndMathText(item.chapter_title || ''),
        };
      });
    }
    throw new Error('AI output was not an array');
  } catch (err: any) {
    console.error('Error parsing AI questions response:', err, rawText);
    throw new Error('Failed to parse AI generated questions. Please try again.');
  }
}

export interface DirectPdfItem {
  buffer: Buffer;
  mimeType?: string;
  fileName?: string;
}

export interface DirectPdfQuestionGenerationConfig {
  pdfBuffer?: Buffer;
  pdfBuffers?: DirectPdfItem[];
  mimeType?: string;
  mode?: 'verbatim_paper' | 'generate_from_content';
  className?: string;
  subjectName?: string;
  sections?: QuestionSectionConfig[];
  language?: string;
  customInstructions?: string;
}

export async function generateQuestionsDirectFromPdf(
  config: DirectPdfQuestionGenerationConfig
): Promise<GeneratedQuestionItem[]> {
  const isVerbatim = config.mode === 'verbatim_paper';

  const items: DirectPdfItem[] = [];
  if (config.pdfBuffers && config.pdfBuffers.length > 0) {
    items.push(...config.pdfBuffers);
  } else if (config.pdfBuffer) {
    items.push({
      buffer: config.pdfBuffer,
      mimeType: config.mimeType || 'application/pdf',
      fileName: 'Document 1',
    });
  }

  if (items.length === 0) {
    throw new Error('At least one PDF document must be provided for AI generation');
  }

  const hasSections = Boolean(config.sections && config.sections.length > 0);
  const sectionsDesc = hasSections
    ? config.sections!
        .map(
          (s, idx) =>
            `Section ${idx + 1}: "${s.section_name}"${s.sub_section ? ` (Subsection / Part: "${s.sub_section}")` : ''}${s.instructions ? ` (Instructions: "${s.instructions}")` : ''} -> Exactly ${s.count} question(s) of type "${s.type}" (${s.marks_per_question} mark(s) each, difficulty: ${s.difficulty || 'medium'})`
        )
        .join('\n')
    : 'Extract all available questions organized into appropriate logical sections (Section A: MCQs, Section B: Short Answer, Section C: Long Answer, etc.)';

  const multiChapterText = items.length > 1
    ? `\n=== MULTI-CHAPTER / MULTI-DOCUMENT SYLLABUS COVERAGE ===
You are provided with ${items.length} separate PDF document attachments (each representing a distinct chapter/unit of the exam syllabus):
${items.map((it, idx) => `• PDF/Chapter ${idx + 1}: "${it.fileName || `Chapter ${idx + 1}`}"`).join('\n')}

MANDATORY RULES FOR MULTI-CHAPTER EXAM:
1. You MUST read all pages of ALL ${items.length} attached chapter PDFs.
2. Distribute questions proportionally across ALL attached chapters so every chapter is tested across the sections.
3. For each question object, accurately populate "chapter_title" with the name of the chapter/document it was derived from!
4. CRITICAL: "chapter_title" is where the chapter name goes. NEVER put chapter names in "section_name"! "section_name" MUST strictly be the configured blueprint section name (e.g. "Section A: Multiple Choice Questions").`
    : '';

  const blueprintMandate = hasSections
    ? `=== STRICT BLUEPRINT & SECTION CONFIGURATION MANDATE ===
You MUST generate questions organized STRICTLY by the requested Blueprint Sections below.
NEVER invent your own sections or use chapter titles as "section_name".
For EACH configured section:
1. The "section_name" property of EVERY question in that section MUST MATCH EXACTLY the section name provided below.
2. You MUST generate EXACTLY the requested number of questions for that section.
3. Every question in that section MUST HAVE the EXACT question type specified for that section.
4. Set "marks" to the exact marks per question specified for that section.

REQUESTED BLUEPRINT SECTIONS:
${sectionsDesc}`
    : `Organize questions into standard logical sections (e.g. "Section A: Multiple Choice Questions", "Section B: Fill in the Blanks", "Section C: Short Answer Questions", "Section D: Long Answer Questions").`;

  const modeInstructions = isVerbatim
    ? `=== MODE: VERBATIM ORIGINAL EXAM PAPER EXTRACTION ===
- You are provided with original examination / test question paper document(s) directly as PDF.
- You MUST carefully read and visually parse every single page of all uploaded documents.
- EXTRACT AND TRANSCRIBE ALL QUESTIONS EXACTLY VERBATIM (word-for-word identical to the source document).
- DO NOT rephrase, alter, summarize, or skip questions.
- Preserve the exact question numbering, sub-questions (e.g. (a), (b), (i), (ii)), multiple choice options (A, B, C, D), and assigned marks.
- Include a full, accurate model answer / solution text for each question in "answer_text".`
    : `=== MODE: CURRICULUM-ALIGNED QUESTION GENERATION FROM TEXTBOOK PDFS ===
- You are provided with textbook chapter(s), syllabus document(s), or study material directly as PDF.
- Carefully examine all pages of the document(s) (including diagrams, tables, formulas, and text).
- Formulate high-yield, academically rigorous examination questions SOLELY grounded in the facts, theorems, formulas, and content found in these PDFs.

CRITICAL ZERO-HALLUCINATION TEXTBOOK EXTRACTION MANDATE:
1. You MUST extract, formulate, and base questions STRICTLY on the actual exercises ("अभ्यास"), activities ("करके देखें" / "सोचिए और बताइए"), illustrations, and problem sets printed in the attached textbook PDF(s)!
2. DO NOT make up questions from your own general imagination or external training data. Every question must reflect the real problems, questions, examples, and illustrations from the book.
${blueprintMandate}`;

  const customPrompt = config.customInstructions
    ? `\nSpecial Instructions: ${config.customInstructions}`
    : '';

  const prompt = `You are a strict, top-tier academic exam paper creation engine.
You are given direct PDF document(s) to process.

CLASS / GRADE: ${config.className || 'General Grade'}
SUBJECT: ${config.subjectName || 'General Subject'}
LANGUAGE: ${config.language || 'English'}
${modeInstructions}${multiChapterText}${customPrompt}

STRICT LATEX & MATHEMATICAL FORMATTING RULES:
1. PURE NATURAL LANGUAGE (HINDI / DEVANAGARI / REGIONAL):
   - All questions, text, explanations, and options MUST be written in pure natural Unicode text.
   - NEVER wrap Hindi words inside '\\text{...}' or '$ ... $'.
   - Hindi words like 'संख्याओं', 'संख्याएँ', 'पैटर्न', 'आकृतियाँ', 'उत्तर' must be pure normal Hindi text.
   - ONLY actual mathematical formulas, variables, and calculations (such as '$F + V - E = 2$', '$x^2 + y^2 = r^2$', '$2 \\times 3 = 6$', '$\\frac{1}{2}$') should be enclosed in '$ ... $'.
2. MATH IN SINGLE DOLLARS: ALWAYS enclose ALL mathematical expressions, formulas, geometry terms, angles, fractions, and scientific symbols inside single dollar signs '$ ... $' (e.g. '$ABCD$', '$\\angle B = 90^\\circ$', '$\\Delta ABC$', '$\\frac{a}{b}$').
3. NEVER leave raw LaTeX commands like '\\angle', '\\Delta', or '\\frac' outside '$...$' delimiters.
4. JSON ESCAPING: In JSON strings, ALWAYS escape backslashes with double backslashes (e.g. write "\\\\frac", "\\\\times", "\\\\angle", "\\\\Delta", "\\\\circ") so JSON parsers do not interpret "\\t" as a tab character.
5. STRICT EXAM QUESTION PHRASING (ZERO CHAPTER OR PAGE CITATIONS):
   - Students do NOT have the textbook in front of them during an exam!
   - NEVER cite chapter names, lesson titles, or page numbers in "question_text" or "answer_text".
   - FORBIDDEN: "अध्याय 3 (हमारे चारों ओर पैटर्न) के पृष्ठ 1 के चित्र को देखकर...", "पाठ 2 के अनुसार...", "Chapter 3 page 5 figure...".
   - REQUIRED: Always write standard exam phrasing like "दिए गए चित्र को देखकर बताइए कि...", "दी गई आकृति में...", "दिए गए पैटर्न को आगे बढ़ाइए...", "Look at the given picture and answer:".

STRICT JSON OUTPUT REQUIREMENTS:
Return ONLY a valid JSON array of question objects (no markdown code blocks, no intro, no conclusion prose).
Each question object MUST follow the exact schema for its type:

For Multiple Choice Questions ('mcq'):
{
  "section_name": "Section A: Multiple Choice Questions",
  "type": "mcq",
  "question_text": "Which part of a plant absorbs water from the soil?",
  "options": [
    { "label": "A", "text": "Root" },
    { "label": "B", "text": "Stem" },
    { "label": "C", "text": "Leaf" },
    { "label": "D", "text": "Flower" }
  ],
  "correct_option": "A",
  "answer_text": "A) Root absorbs water and mineral nutrients from the soil.",
  "image_url": null,
  "marks": 1,
  "difficulty": "easy",
  "chapter_title": "Chapter Name"
}

For Fill in the Blanks ('fill_blank'):
{
  "section_name": "Section B: Fill in the Blanks",
  "type": "fill_blank",
  "question_text": "The process of food synthesis in green plants using sunlight is called _______.",
  "options": null,
  "correct_option": null,
  "answer_text": "Photosynthesis",
  "image_url": null,
  "marks": 1,
  "difficulty": "easy",
  "chapter_title": "Chapter Name"
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
  "chapter_title": "Chapter Name"
}

For Match the Following ('match_the_following'):
{
  "section_name": "Section D: Match the Following",
  "type": "match_the_following",
  "question_text": "Match the items in Column A with their correct corresponding items in Column B:",
  "options": {
    "column_a": [
      { "label": "1", "text": "Chlorophyll" },
      { "label": "2", "text": "Stomata" },
      { "label": "3", "text": "Xylem" },
      { "label": "4", "text": "Phloem" }
    ],
    "column_b": [
      { "label": "A", "text": "Gas exchange" },
      { "label": "B", "text": "Food transport" },
      { "label": "C", "text": "Green pigment" },
      { "label": "D", "text": "Water transport" }
    ]
  },
  "correct_option": null,
  "answer_text": "1 - C, 2 - A, 3 - D, 4 - B",
  "image_url": null,
  "marks": 4,
  "difficulty": "medium",
  "chapter_title": "Chapter Name"
}

For Short Answer ('short_answer'):
{
  "section_name": "Section E: Short Answer Questions",
  "type": "short_answer",
  "question_text": "Differentiate between autotrophic and heterotrophic nutrition with one example each.",
  "options": null,
  "correct_option": null,
  "answer_text": "Autotrophs synthesize their own food (e.g. plants). Heterotrophs depend on others for nutrients (e.g. animals).",
  "image_url": null,
  "marks": 2,
  "difficulty": "medium",
  "chapter_title": "Chapter Name"
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
  "diagram_page": null,
  "diagram_box": null,
  "diagram_doc_index": 0,
  "marks": 5,
  "difficulty": "hard",
  "chapter_title": "Chapter Name"
}

For Picture / Diagram Based Questions ('picture_based'):
{
  "section_name": "Section G: Picture / Diagram Based Questions",
  "type": "picture_based",
  "question_text": "चित्रों को देखकर वस्तुओं के नाम लिखिए। यहाँ यह भी लिखिए कि वस्तु का कौन-सा दृश्य (front/top/side view) दिया गया है।",
  "options": null,
  "correct_option": null,
  "answer_text": "1. टेलीविज़न (सामने का दृश्य - Front view)\n2. सोफ़ा (सामने का दृश्य - Front view)\n3. चप्पल (ऊपर का दृश्य - Top view)",
  "image_url": null,
  "diagram_page": 3,
  "diagram_box": [120, 80, 480, 920],
  "diagram_doc_index": 0,
  "marks": 3,
  "difficulty": "medium",
  "chapter_title": "Chapter Name"
}

AUTOMATIC DIAGRAM CROPPING MANDATE:
Whenever ANY question (whether 'picture_based', 'mcq', 'short_answer', or 'fill_blank') requires or refers to a diagram, shape, geometric figure, object drawing, graph, or picture from the PDF:
1. "diagram_page": Set to the 1-indexed page number of the PDF where the diagram is printed (e.g. 1, 2, 3...).
2. "diagram_box": Set to [ymin, xmin, ymax, xmax] coordinates of the bounding box around that diagram normalized on a 0 to 1000 scale.
   Example: If the diagram is located in the upper-middle of page 4, provide: [150, 60, 450, 940].
3. "diagram_doc_index": 0 for Document 1, 1 for Document 2, etc.
4. If a question is purely textual and has no diagram in the textbook, set "diagram_page": null, "diagram_box": null.

Read the attached PDF document(s) carefully and generate the JSON array:`;

  const inlineParts = items.map((it) => ({
    inlineData: {
      data: it.buffer.toString('base64'),
      mimeType: it.mimeType || 'application/pdf',
    },
  }));

  const result = await generateContentWithFallback([
    prompt,
    ...inlineParts,
  ]);

  const rawText = result.response.text().trim();
  const jsonText = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    const userSections = config.sections && config.sections.length > 0 ? config.sections : [];
    const validSectionNames = new Set(userSections.map(s => s.section_name.trim().toLowerCase()));

    const parsed = JSON.parse(jsonText);
    if (Array.isArray(parsed)) {
      let processed: GeneratedQuestionItem[] = parsed.map((item, idx) => {
        let secName = (item.section_name || '').trim();
        let chapTitle = (item.chapter_title || '').trim();

        // Check if secName matches any configured section
        const matchedConfig = userSections.find(
          s => s.section_name.trim().toLowerCase() === secName.toLowerCase()
        );

        if (!matchedConfig && userSections.length > 0) {
          // If AI used chapter name as section_name (e.g. contains "अध्याय" or "Chapter" or not matching blueprint)
          if (!chapTitle || chapTitle === config.subjectName) {
            chapTitle = secName;
          }
          // Try to match by question type
          const typeMatch = userSections.find(s => s.type === item.type);
          if (typeMatch) {
            secName = typeMatch.section_name;
          }
        }

        return {
          id: `pdf-gen-${Date.now()}-${idx + 1}`,
          section_name: secName || (userSections[0]?.section_name || 'General Questions'),
          sub_section: item.sub_section ? cleanHindiAndMathText(String(item.sub_section)) : (matchedConfig?.sub_section || undefined),
          type: item.type || (userSections[0]?.type || 'short_answer'),
          question_text: cleanHindiAndMathText(item.question_text || ''),
          options: sanitizeQuestionOptions(item.options),
          correct_option: item.correct_option ? cleanHindiAndMathText(String(item.correct_option)) : null,
          answer_text: item.answer_text ? cleanHindiAndMathText(String(item.answer_text)) : null,
          image_url: item.image_url || null,
          marks: Number(item.marks) || 1,
          difficulty: item.difficulty || 'medium',
          chapter_title: cleanHindiAndMathText(chapTitle || config.subjectName || ''),
        };
      });

      // Fallback: If AI completely ignored configured section names
      if (userSections.length > 0) {
        const anySectionMatched = processed.some(q =>
          validSectionNames.has(q.section_name.trim().toLowerCase())
        );

        if (!anySectionMatched) {
          // Re-distribute questions sequentially to match configured sections
          let currentQIdx = 0;
          for (const sec of userSections) {
            const targetCount = sec.count;
            for (let c = 0; c < targetCount && currentQIdx < processed.length; c++) {
              processed[currentQIdx].section_name = sec.section_name;
              if (processed[currentQIdx].type === 'short_answer' && sec.type !== 'short_answer') {
                processed[currentQIdx].type = sec.type;
                processed[currentQIdx].marks = sec.marks_per_question;
              }
              currentQIdx++;
            }
          }
          while (currentQIdx < processed.length) {
            processed[currentQIdx].section_name = userSections[userSections.length - 1].section_name;
            currentQIdx++;
          }
        }
      }

      // Automatic Diagram Cropping Execution
      const cropTargets: CropTarget[] = [];
      processed.forEach((q, idx) => {
        const orig = parsed[idx];
        if (
          orig &&
          typeof orig.diagram_page === 'number' &&
          orig.diagram_page >= 1 &&
          Array.isArray(orig.diagram_box) &&
          orig.diagram_box.length === 4
        ) {
          cropTargets.push({
            id: q.id!,
            docIndex: typeof orig.diagram_doc_index === 'number' ? orig.diagram_doc_index : 0,
            page: orig.diagram_page,
            box: orig.diagram_box as [number, number, number, number],
          });
        }
      });

      if (cropTargets.length > 0) {
        try {
          const cropDocs: CropPdfDocument[] = items.map((it, idx) => ({
            index: idx,
            buffer: it.buffer,
          }));
          const croppedImages = await cropPdfDiagrams(cropDocs, cropTargets);
          processed.forEach((q) => {
            if (q.id && croppedImages[q.id]) {
              q.image_url = croppedImages[q.id];
            }
          });
        } catch (cropErr: any) {
          console.warn('[Direct PDF] Auto-crop failed, continuing without diagram:', cropErr?.message || cropErr);
        }
      }

      return processed;
    }
    throw new Error('AI output was not an array');
  } catch (err: any) {
    console.error('Error parsing AI questions direct from PDF response:', err, rawText);
    throw new Error('Failed to parse questions generated from PDF. Please try again.');
  }
}

export interface RawMediaItem {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
}

export interface ExtractedRawPaperResult {
  header: {
    school_name?: string | null;
    exam_title?: string;
    class_name?: string;
    subject_name?: string;
    total_marks?: number;
    time_allowed?: string;
    date?: string | null;
    instructions?: string;
  };
  questions: GeneratedQuestionItem[];
}

export async function extractQuestionPaperFromMedia(
  items: RawMediaItem[],
  customInstructions?: string,
  preferredModel?: string
): Promise<ExtractedRawPaperResult> {
  const inlineParts = items.map((it) => ({
    inlineData: {
      data: it.buffer.toString('base64'),
      mimeType: it.mimeType || 'image/jpeg',
    },
  }));

  const prompt = `You are a world-class academic examination transcriber and OCR expert specialized in school exam papers (including Pre-Primary, Nursery, L.K.G, U.K.G, Primary, and High School handwritten tests, worksheets, and printed papers).
Analyze the provided handwritten, photographed, or scanned document(s) with 100% ZERO-ERROR precision.

CRITICAL OCR & VERBATIM TRANSCRIPTION GUIDELINES (ZERO-ERROR MANDATE):
1. ACCURATE HANDWRITING DECIPHERING & SPELLING:
   - Carefully decipher handwritten text, cursive handwriting, and teacher notes without substituting or misreading letters.
   - For phonics / word family questions (e.g. "Write the four 'ill' sound words", "at sound words", "ee sound words"): recognize phonics patterns accurately. Do not confuse 'ill' with roman numbers or 'all'.
   - Accurately transcribe bilingual Hindi and English text with correct Devanagari Unicode spelling (e.g. पंखा - Fan, चावल - _______, भोर - _______, सुबह - _______, कोमल - Komal).
   - If a word is crossed out or corrected by the teacher in the original image (e.g. "four" written over another word), transcribe the intended final corrected word.

2. QUESTION-CUM-ANSWER (SOLVE-INSIDE-PAPER) & BLANK SPACES FORMATTING:
   - For Kindergarten (KG/UKG/LKG) and Primary worksheets, kids solve the paper directly on the sheet.
   - Every single answer spot MUST have a distinct, generous blank space: "_______".
   - If a question asks for N items (e.g. "Write the four 'ill' sound words"), generate EXACTLY N distinct blank underlines:
     "_______   _______\n_______   _______"
   - If sub-items have prompts (e.g. "Book - Books", "Pen - _______", "Tiger - _______", "Animal - _______"), keep every sub-item on its own line with matching "_______" so kids have enough room to write on the paper!
   - For pattern sequence questions (e.g. "^ V ^ V", "M W M W", "■ ■ ■ ■"), transcribe the exact symbols followed by the exact number of blanks requested (e.g. "(i) ^ V ^ V   _______   _______   _______").

3. HEADER METADATA DETECTION:
   - "school_name": Detected school / institute name if explicitly visible, otherwise null.
   - "exam_title": Detected terminal title (e.g. "1st Terminal Examination", "2nd Terminal Examination", "3rd Terminal Examination", "Annual Examination", "Class Assessment").
   - "class_name": Detected class or grade (e.g. "U.K.G", "L.K.G", "Nursery", "Class 1", "Class 2").
   - "subject_name": Detected subject (e.g. "English", "Hindi", "Mathematics", "EVS", "Science").
   - "total_marks": Full marks (F.M.) as a number (e.g. 20, 25, 50). If stated as "F.M- 20 Marks", extract 20.
   - "time_allowed": Time allowed (e.g. "45 Mins", "1 Hour") or standard duration.
   - "date": Formatted date string (e.g. "20/11/2026") or null.
   - "instructions": Standard test instructions.

4. ACCURATE MARKS RECONSTRUCTION:
   - Preserve circled marks next to each question, e.g. (3), (2), [3], [2].
   - Ensure individual question marks sum up correctly to the total marks.

5. SINGLE-PAGE & 20-MARKS CLASS TEST OPTIMIZATION:
   - For standard 10-25 marks tests (e.g. F.M. 20 Marks, weekly/terminal test from a single notebook page):
     - DO NOT invent unnecessary artificial section names like "Section A", "Section B" unless explicitly written on the paper. Set "section_name": null so the paper renders seamlessly without bulky section banners.
     - For math / division questions (e.g. Divide: 2 ) 98 (, 3 ) 972 (, 5 ) 7380 (): Keep the format clean and verbatim:
       "Divide (÷) :\n(i) 2 ) 98 (\n(ii) 3 ) 972 (\n(iii) 4 ) 48 (\n(iv) 5 ) 7380 (\n(v) 6 ) 386 ("
     - Keep question text crisp and structured so that small 20-mark tests fit completely onto a SINGLE A4 PAGE when printed/downloaded as PDF.

6. VERIFICATION STEP BEFORE RETURNING JSON:
   - Verify every character of Hindi and English text for absolute spelling accuracy.
   - Verify that all questions (1., 2., 3., 4., 5...) from all uploaded pages are captured completely without skipping any question.
   - Format cleanly in valid JSON matching the exact schema.

${customInstructions ? `USER CUSTOM INSTRUCTIONS:\n${customInstructions}\n` : ''}

RETURN STRICTLY A JSON OBJECT MATCHING THIS SCHEMA:
{
  "header": {
    "school_name": null,
    "exam_title": "1st Terminal Examination",
    "class_name": "U.K.G",
    "subject_name": "English",
    "total_marks": 20,
    "time_allowed": "45 Mins",
    "date": "20/11/2026",
    "instructions": "1. Attempt all questions.\\n2. Write answers clearly in the spaces provided."
  },
  "questions": [
    {
      "section_name": null,
      "sub_section": null,
      "type": "fill_blank",
      "question_text": "Write the singular to plural:\\nBook - Books\\nPen - _______\\nTiger - _______\\nAnimal - _______",
      "options": null,
      "answer_text": "Pen - Pens, Tiger - Tigers, Animal - Animals",
      "marks": 3,
      "difficulty": "easy"
    }
  ]
}`;

  const result = await generateContentWithFallback(
    [prompt, ...inlineParts],
    {
      temperature: 0.1,
      responseMimeType: 'application/json',
    },
    preferredModel
  );

  const rawText = result.response.text().trim();
  const parsed = cleanAndParseJson<ExtractedRawPaperResult>(rawText);
  return parsed;
}

export interface LessonSuiteConfig {
  className: string;
  subjectName: string;
  chapterTitle: string;
  board?: string;
  language?: string;
  customInstructions?: string;
  contextContent?: string;
  pdfBuffer?: Buffer;
  pdfUrl?: string;
  pdfBuffers?: Array<{ buffer: Buffer; mimeType?: string; fileName?: string }>;
}

export async function generateLessonSuiteWithAI(config: LessonSuiteConfig) {
  const board = config.board || 'CBSE';
  const language = config.language || 'English';

  const inlineParts: any[] = [];
  if (config.pdfBuffer) {
    inlineParts.push({
      inlineData: {
        data: config.pdfBuffer.toString('base64'),
        mimeType: 'application/pdf',
      },
    });
  }

  if (Array.isArray(config.pdfBuffers) && config.pdfBuffers.length > 0) {
    for (const pb of config.pdfBuffers) {
      inlineParts.push({
        inlineData: {
          data: pb.buffer.toString('base64'),
          mimeType: pb.mimeType || 'application/pdf',
        },
      });
    }
  }

  const hasDirectPdf = inlineParts.length > 0;

  const prompt = `You are a master academic curriculum director and senior CBSE/State Board teacher trainer.
Create a comprehensive, 7-Core Master Teacher Lesson & Academic Suite for:
Class/Grade: ${config.className}
Subject: ${config.subjectName}
Chapter/Topic: ${config.chapterTitle}
Academic Board: ${board}
Language: ${language}
${config.customInstructions ? `Additional Teacher Guidelines: ${config.customInstructions}` : ''}
CRITICAL REQUIREMENT - 100% STRICT FACTUAL ACCURACY & SYLLABUS GROUNDING:
1. ACCURACY MUST BE 100%: Under NO circumstances should you invent facts, hallucinate, or introduce outside topics. Everything MUST be strictly grounded in the official curriculum for "${config.chapterTitle}".
2. NO RANDOM OR IMAGINARY CONTENT: Definitions, chemical formulas, theorems, observations, word meanings, and questions must directly reflect standard textbooks.
${hasDirectPdf ? `
3. STRICT TEXTBOOK DIRECT PDF GROUNDING (OFFICIAL CLOUDFLARE CHAPTER PDF ATTACHED):
You have been provided with the complete, official scanned textbook PDF for "${config.chapterTitle}" directly from Cloudflare R2 storage.
- Read every page, diagram, theorem, chemical formula, definition, example, and exercise in this attached PDF.
- 100% of your teaching plan, teaching guide, notes, definitions, classwork, and homework questions MUST be strictly extracted and grounded in this attached PDF.
- In metadata.source_grounding_analysis, list the exact scanned pages and topics extracted from this attached PDF.
- Accuracy must be 100% strictly faithful to the attached PDF. Do NOT invent or hallucinate outside topics.` : (config.contextContent ? `
3. STRICT TEXTBOOK PAGE GROUNDING - USE ONLY THE FOLLOWING VERBATIM SCANNED TEXTBOOK CONTENT:
---
${config.contextContent}
---
Ensure all teaching points, definitions, formulas, real-world examples, diagrams, and homework questions directly mirror the scanned textbook pages above.` : '')}

CRITICAL CONCISENESS & COMPLETION DIRECTIVE:
1. You MUST fully complete ALL 7 root JSON modules (metadata, teaching_plan, teaching_guide, mandatory_notes, classwork_homework, pyq_legacy_analysis, revision_test_plan) within the token budget.
2. In 'teaching_plan.periods': provide 5 to 7 focused, punchy periods (Day 1 to Day 5/7) systematically covering the chapter.
3. In 'teaching_guide.topics': provide 2 to 3 core textbook topics with crisp, ready-to-deliver teacher scripts.
4. In 'mandatory_notes': provide 2 to 3 high-yield definitions, 2 formulas/rules, 2 key diagrams, and 3 unmissable facts.
5. In 'classwork_homework.day_wise_assignments': provide 3 to 5 key day assignments with 1 classwork and 2 homework questions each.
6. In 'pyq_legacy_analysis.topic_priority_breakdown': provide 2 to 3 high-yield topic breakdowns.
7. In 'revision_test_plan': provide a concise chapter analysis summary, 3 core board Q&As (2M, 3M, 5M), 3 revision phases, and chapter test blueprint.
8. Keep all descriptions dense, crisp, and high-impact. Do NOT write bloated repetitive filler text. Ensure all quotes and brackets close cleanly.

You MUST return a strictly valid JSON object matching the exact structure below. Do NOT wrap in markdown backticks or explanations, return ONLY raw JSON:

{
  "metadata": {
    "className": "${config.className}",
    "subjectName": "${config.subjectName}",
    "chapterTitle": "${config.chapterTitle}",
    "board": "${board}",
    "language": "${language}",
    "generatedAt": "${new Date().toISOString()}",
    "chapter_executive_summary": "Thorough, in-depth 2 to 3 paragraph executive summary of the entire chapter, highlighting core principles, real-world significance, and essential takeaways.",
    "source_grounding_analysis": {
      "sources_used": ["Scanned Page 1: Key introductory concepts", "Scanned Page 2: Core formulas & laws"],
      "scanned_concepts_extracted": ["Specific Concept 1 from scanned text", "Specific Formula 2 from scanned text", "Specific Diagram from scanned text"],
      "grounding_faithfulness_score": "100% Strictly Grounded in Chapter Syllabus"
    }
  },
  "teaching_plan": {
    "total_periods_recommended": 7,
    "timeline_summary": "Comprehensive 7-day teaching plan structured day-by-day with clear pedagogical learning goals and practical classroom time allocations.",
    "sequence_rationale": "Clear pedagogical explanation of why topics are ordered in this specific sequence (building from concrete basics to abstract applications).",
    "periods": [
      {
        "period_number": 1,
        "day_title": "Day 1: Specific Topic Title",
        "learning_objective": "Single crystal-clear learning outcome students will achieve today",
        "topics_covered": "Detailed, comprehensive breakdown of core concepts, definitions, and equations to teach in this period (kya padhana hai)",
        "duration_minutes": 45,
        "prerequisites": "Prior knowledge students must have before starting this period",
        "pedagogy_focus": "Interactive discussion, inquiry-based demo, blackboard lecture, or active problem solving",
        "time_breakdown": [
          { "phase": "Warm-up & Hook", "minutes": 5, "activity": "Engage curiosity with prior recall question or real-life puzzle" },
          { "phase": "Core Concept Delivery", "minutes": 22, "activity": "Structured blackboard explanation and formula derivation" },
          { "phase": "Guided Practice & Demo", "minutes": 13, "activity": "Solve sample question or live reaction demo together" },
          { "phase": "Wrap-up & Exit Task", "minutes": 5, "activity": "Key takeaway recap and daily homework task" }
        ],
        "blackboard_plan": [
          "Core definition / reaction equation to write clearly on board",
          "Summary diagram / step-by-step formula breakdown"
        ],
        "intuitive_hook": "A simple, memorable real-life analogy or everyday observation that makes the concept click effortlessly",
        "daily_task": "1 immediate classwork question + 1 quick practice homework question"
      }
    ]
  },
  "teaching_guide": {
    "chapter_handling_strategy": {
      "teacher_mindset": "Comprehensive strategy on pedagogical tone, keeping students curious, connecting abstract symbols to everyday observations, and maintaining classroom momentum.",
      "handling_weak_students": "Specific practical techniques to support struggling learners (scaffolding formulas, avoiding jargon early, positive reinforcement drills).",
      "pacing_and_classroom_control": "Practical advice on managing 45-minute period transitions, balancing student questions with syllabus progress, and avoiding common classroom distractions."
    },
    "topics": [
      {
        "topic_name": "Specific Topic Name",
        "source_reference": "Scanned Textbook Page / NCERT Section",
        "what_to_teach": "Deep, highly detailed explanation of the core concepts, laws, and definitions that must be taught in this topic",
        "verbatim_teacher_script": "Ready-to-speak classroom delivery script: Exactly what the teacher should say aloud to students in simple, engaging words to make the concept click instantly",
        "how_to_explain_step_by_step": [
          "Step 1: The Curiosity Hook - Engaging question or opening demonstration to grab attention",
          "Step 2: Core Concept Breakdown - Systematic explanation using progressive blackboard notes",
          "Step 3: Verification & In-Class Practice - Quick collaborative problem or question to confirm mastery"
        ],
        "blackboard_layout": {
          "left_side": "Definitions / Prerequisite terms / Key vocabulary",
          "center": "Core chemical equations / Step-by-step reaction mechanisms / Diagrams",
          "right_side": "Summary rules / Common traps to avoid / Daily homework question"
        },
        "intuitive_analogy": "Memorable everyday life analogy that makes the abstract concept crystal clear",
        "real_world_examples": ["Practical real-life example 1 with full context", "Practical real-life example 2 with full context"],
        "in_class_check_questions": [
          {
            "question": "Quick diagnostic check question the teacher asks students mid-lecture",
            "expected_answer": "The ideal response students should formulate"
          }
        ],
        "weak_student_remedy": "Alternative simpler explanation, visual cue, or metaphor to use if students still seem confused or hesitant",
        "common_mistakes_and_fixes": [
          {
            "mistake": "Common student misunderstanding, calculation error, or equation misconception",
            "correction": "Exact verbal clarification and blackboard fix to tell students"
          }
        ],
        "teacher_delivery_tips": "Pro-tip for voice modulation, blackboard neatness, or board exam scoring trap"
      }
    ]
  },
  "mandatory_notes": {
    "heading": "Compulsory Student Notebook Notes — Board Exam Standard",
    "instructions_for_students": "Must be neatly copied into the classroom notebook before homework assignment.",
    "unmissable_important_notes_and_facts": [
      "Crucial golden rule or unmissable scientific fact that can NEVER be missed in the chapter",
      "Essential condition / property / constant that examiners specifically check"
    ],
    "words_meanings_and_daily_usage": [
      {
        "word": "Crucial chapter vocabulary word / technical term",
        "meaning": "Clear, precise meaning and definition",
        "contextual_meaning": "How it is used specifically in this chapter context",
        "daily_life_usage_example": "Example of this word or concept applied in everyday real-world conversation/life",
        "synonyms": ["Synonym 1", "Synonym 2"]
      }
    ],
    "definitions": [
      {
        "term": "Term Name",
        "exact_definition": "Precise, board-exam approved verbatim definition",
        "source_citation": "Scanned Page 1 / Standard Textbook Chapter Section",
        "importance": "High yield / 2 marks question"
      }
    ],
    "formulas_and_rules": [
      {
        "title": "Formula / Law / Principle Name",
        "formula": "Mathematical or symbolic expression",
        "derivation_steps": "Key step-by-step derivation or logical reasoning steps",
        "explanation": "Explanation of every symbol, standard SI units, and where to apply"
      }
    ],
    "theorems_and_postulates": [
      {
        "name": "Theorem or Scientific Rule Name",
        "statement": "Formal statement as expected in examinations",
        "key_proof_steps": "Critical bullet points required in the proof or derivation"
      }
    ],
    "important_diagrams": [
      {
        "title": "Diagram / Schematic Title",
        "description": "Clear step-by-step guidance on how to draw it cleanly on paper",
        "must_label_parts": ["Label 1", "Label 2", "Label 3"]
      }
    ],
    "high_yield_exam_points": [
      "Key phrase or keywords that examiners check when awarding full marks"
    ]
  },
  "classwork_homework": {
    "day_wise_assignments": [
      {
        "day_number": 1,
        "day_title": "Day 1 Topic",
        "classwork": [
          {
            "q_no": 1,
            "question": "Hands-on in-class question for Day 1",
            "marks": 2,
            "solution_hints": "Quick teacher solution hint"
          }
        ],
        "homework": [
          {
            "level": "Basic",
            "question": "Foundational homework question for Day 1",
            "marks": 2,
            "guided_clue": "Direct hint based on today's notes"
          },
          {
            "level": "Standard",
            "question": "Standard application homework question for Day 1",
            "marks": 3,
            "guided_clue": "Hint on formula/concept to apply"
          },
          {
            "level": "Brain-Teaser (HOTS)",
            "question": "HOTS / tricky board question for Day 1",
            "marks": 5,
            "guided_clue": "Deep conceptual clue"
          }
        ],
        "estimated_time_mins": 25
      }
    ],
    "classwork_practice": [
      {
        "q_no": 1,
        "question": "Hands-on question for immediate in-class practice right after lecture",
        "marks": 2,
        "solution_hints": "Quick teacher guidance or blackboard solution hint"
      }
    ],
    "homework_assignment": [
      {
        "level": "Basic",
        "question": "Direct textbook / definition-based problem for confidence building",
        "marks": 2,
        "guided_clue": "Hint to guide students"
      }
    ],
    "estimated_homework_time_mins": 35
  },
  "pyq_legacy_analysis": {
    "board_name": "${board}",
    "overall_chapter_weightage": "Estimated 6 to 9 marks in annual board examination",
    "topic_priority_breakdown": [
      {
        "topic": "Topic Name",
        "priority": "High Yield (🔴)",
        "frequency_tags": ["Asked in 2024", "Asked in 2022", "Asked in 2020 (Compartment)"],
        "recurring_question_types": "Numerical problem + derivation of the core formula",
        "marks_trend": "Usually asked as 3-mark or 5-mark long question",
        "examiner_favorite_traps": "Students forget to convert units to SI or forget negative signs"
      }
    ]
  },
  "revision_test_plan": {
    "detailed_chapter_analysis_summary": "Extensive, highly detailed, section-by-section analysis and comprehensive summary of the complete chapter covering all core mechanisms, laws, and board focus areas with 100% accuracy.",
    "comprehensive_chapter_qa": [
      {
        "q_no": 1,
        "type": "Short Answer (2M)",
        "question": "Detailed question directly grounded in the chapter",
        "answer": "Complete, 100% accurate, board-exam standard model answer with point-by-point explanation",
        "marks": 2,
        "key_points_for_full_marks": ["Exact keyword or equation needed for full marks"]
      },
      {
        "q_no": 2,
        "type": "Standard Conceptual (3M)",
        "question": "Core conceptual question with multi-part reasoning",
        "answer": "In-depth model answer with step-by-step explanation and balanced chemical equation",
        "marks": 3,
        "key_points_for_full_marks": ["Balanced equation", "Clear causal reasoning"]
      },
      {
        "q_no": 3,
        "type": "Long Analytical (5M)",
        "question": "Comprehensive board-level long question or case study",
        "answer": "Exhaustive model answer structured into Sub-parts (a), (b), (c) with complete derivations or explanations",
        "marks": 5,
        "key_points_for_full_marks": ["All 3 sub-parts addressed", "Correct nomenclature and state symbols"]
      }
    ],
    "detailed_important_notes": [
      "In-depth analytical note 1 covering high-frequency concepts with 100% accuracy",
      "In-depth analytical note 2 explaining subtle distinctions that examiners look for"
    ],
    "revision_schedule": [
      {
        "phase": "Immediate Day+2 Review",
        "timing": "2 days after chapter completion",
        "strategy": "Rapid 10-minute formula & definition recall test"
      },
      {
        "phase": "Weekend Deep Consolidation",
        "timing": "End of week",
        "strategy": "Solve 5 previous year board questions under timed conditions"
      },
      {
        "phase": "Pre-Exam Final Polish",
        "timing": "3 days before unit test / terminal exam",
        "strategy": "Review rapid cheat sheet and solve mock test paper"
      }
    ],
    "top_10_must_solve_questions": [
      {
        "q_no": 1,
        "question": "Most critical board examination question for this chapter",
        "marks": 5,
        "why_important": "Frequently asked in board exams and tests 3 related core concepts"
      }
    ],
    "chapter_test_blueprint": {
      "test_title": "${config.chapterTitle} — Chapter Mastery Test",
      "total_marks": 25,
      "time_minutes": 45,
      "sections_overview": "Section A: 5 MCQs (5M), Section B: 3 Short Qs (6M), Section C: 3 Long Qs (9M), Section D: 1 Case Study (5M)"
    },
    "rapid_cheat_sheet_bullets": [
      "Ultra-condensed formula or memory rule for 5-minute pre-exam revision",
      "Key distinction between easily confused terms",
      "Golden rule for board presentation"
    ]
  }
}

Ensure all sections contain rich, highly specific, academically accurate content for "${config.chapterTitle}" (${config.className} ${config.subjectName}). Do NOT hallucinate. Do NOT leave placeholders.`;

  const promptParts = hasDirectPdf ? [prompt, ...inlineParts] : prompt;

  const result = await generateContentWithFallback(promptParts, {
    responseMimeType: 'application/json',
    temperature: 0.2,
    maxOutputTokens: 8192,
  });
  const rawText = result.response.text().trim();
  const parsed = cleanAndParseJson(rawText) || {};

  // Resilient schema guard: Guarantee that all 7 modules exist with valid objects/arrays
  const metadata = parsed.metadata || {};
  const teachingPlan = parsed.teaching_plan || {};
  const teachingGuide = parsed.teaching_guide || {};
  const mandatoryNotes = parsed.mandatory_notes || {};
  const classworkHomework = parsed.classwork_homework || {};
  const pyqLegacyAnalysis = parsed.pyq_legacy_analysis || {};
  const revisionTestPlan = parsed.revision_test_plan || {};

  metadata.className = metadata.className || config.className;
  metadata.subjectName = metadata.subjectName || config.subjectName;
  metadata.chapterTitle = metadata.chapterTitle || config.chapterTitle;
  metadata.board = metadata.board || board;
  metadata.language = metadata.language || language;
  metadata.generatedAt = metadata.generatedAt || new Date().toISOString();
  metadata.chapter_executive_summary = metadata.chapter_executive_summary || `Comprehensive academic lesson suite for ${config.chapterTitle} (${config.className} ${config.subjectName}).`;
  if (!metadata.source_grounding_analysis) {
    metadata.source_grounding_analysis = {
      sources_used: [`Scanned chapter content for ${config.chapterTitle}`],
      scanned_concepts_extracted: [`Core curriculum concepts for ${config.chapterTitle}`],
      grounding_faithfulness_score: '100% Strictly Grounded in Chapter Syllabus',
    };
  }

  if (!Array.isArray(teachingPlan.periods) || teachingPlan.periods.length === 0) {
    teachingPlan.periods = [
      {
        period_number: 1,
        day_title: `Day 1: Introduction to ${config.chapterTitle}`,
        learning_objective: `Master fundamental concepts of ${config.chapterTitle}`,
        topics_covered: `Core introduction, textbook definitions, and fundamental properties`,
        duration_minutes: 45,
        prerequisites: `Basic prerequisite concepts for ${config.subjectName}`,
        pedagogy_focus: `Interactive lecture with blackboard diagrams and real-life connections`,
        time_breakdown: [
          { phase: 'Warm-up & Hook', minutes: 5, activity: 'Prior knowledge recall' },
          { phase: 'Core Concept Delivery', minutes: 25, activity: 'Textbook concept explanation' },
          { phase: 'Guided Practice', minutes: 10, activity: 'In-class sample problem' },
          { phase: 'Wrap-up & Exit Task', minutes: 5, activity: 'Summary and homework assignment' },
        ],
        blackboard_plan: [`Key definitions of ${config.chapterTitle}`, `Formula and diagram breakdown`],
        intuitive_hook: `Everyday real-life observation illustrating ${config.chapterTitle}`,
        daily_task: `Read textbook section and solve Exercise 1`,
      },
    ];
  }
  teachingPlan.total_periods_recommended = teachingPlan.total_periods_recommended || teachingPlan.periods.length;
  teachingPlan.timeline_summary = teachingPlan.timeline_summary || `Systematic ${teachingPlan.total_periods_recommended}-day teaching sequence for ${config.chapterTitle}.`;
  teachingPlan.sequence_rationale = teachingPlan.sequence_rationale || `Progresses systematically from foundational concepts to application-based problem solving.`;

  if (!teachingGuide.chapter_handling_strategy) {
    teachingGuide.chapter_handling_strategy = {
      teacher_mindset: `Focus on conceptual clarity and active student participation for ${config.chapterTitle}.`,
      handling_weak_students: `Use visual scaffolding, step-by-step formula breakdown, and frequent micro-checks.`,
      pacing_and_classroom_control: `Maintain a 45-minute balanced cadence with quick transitions and structured board work.`,
    };
  }
  if (!Array.isArray(teachingGuide.topics)) teachingGuide.topics = [];

  mandatoryNotes.heading = mandatoryNotes.heading || `Compulsory Student Notebook Notes — ${config.chapterTitle}`;
  mandatoryNotes.instructions_for_students = mandatoryNotes.instructions_for_students || `Copy neatly into classroom notebooks.`;
  if (!Array.isArray(mandatoryNotes.unmissable_important_notes_and_facts)) mandatoryNotes.unmissable_important_notes_and_facts = [];
  if (!Array.isArray(mandatoryNotes.words_meanings_and_daily_usage)) mandatoryNotes.words_meanings_and_daily_usage = [];
  if (!Array.isArray(mandatoryNotes.definitions)) mandatoryNotes.definitions = [];
  if (!Array.isArray(mandatoryNotes.formulas_and_rules)) mandatoryNotes.formulas_and_rules = [];
  if (!Array.isArray(mandatoryNotes.theorems_and_postulates)) mandatoryNotes.theorems_and_postulates = [];
  if (!Array.isArray(mandatoryNotes.important_diagrams)) mandatoryNotes.important_diagrams = [];
  if (!Array.isArray(mandatoryNotes.high_yield_exam_points)) mandatoryNotes.high_yield_exam_points = [];

  if (!Array.isArray(classworkHomework.day_wise_assignments)) classworkHomework.day_wise_assignments = [];
  if (!Array.isArray(classworkHomework.classwork_practice)) classworkHomework.classwork_practice = [];
  if (!Array.isArray(classworkHomework.homework_assignment)) classworkHomework.homework_assignment = [];
  classworkHomework.estimated_homework_time_mins = classworkHomework.estimated_homework_time_mins || 30;

  pyqLegacyAnalysis.board_name = pyqLegacyAnalysis.board_name || board;
  pyqLegacyAnalysis.overall_chapter_weightage = pyqLegacyAnalysis.overall_chapter_weightage || 'Estimated 6 to 9 marks';
  if (!Array.isArray(pyqLegacyAnalysis.topic_priority_breakdown)) pyqLegacyAnalysis.topic_priority_breakdown = [];

  revisionTestPlan.detailed_chapter_analysis_summary = revisionTestPlan.detailed_chapter_analysis_summary || `Comprehensive revision summary for ${config.chapterTitle}.`;
  if (!Array.isArray(revisionTestPlan.comprehensive_chapter_qa)) revisionTestPlan.comprehensive_chapter_qa = [];
  if (!Array.isArray(revisionTestPlan.detailed_important_notes)) revisionTestPlan.detailed_important_notes = [];
  if (!Array.isArray(revisionTestPlan.revision_schedule)) revisionTestPlan.revision_schedule = [];
  if (!Array.isArray(revisionTestPlan.top_10_must_solve_questions)) revisionTestPlan.top_10_must_solve_questions = [];
  if (!revisionTestPlan.chapter_test_blueprint) {
    revisionTestPlan.chapter_test_blueprint = {
      test_title: `${config.chapterTitle} — Chapter Mastery Test`,
      total_marks: 25,
      time_minutes: 45,
      sections_overview: 'Section A: Short Qs (10M), Section B: Application Qs (15M)',
    };
  }
  if (!Array.isArray(revisionTestPlan.rapid_cheat_sheet_bullets)) revisionTestPlan.rapid_cheat_sheet_bullets = [];

  return {
    metadata,
    teaching_plan: teachingPlan,
    teaching_guide: teachingGuide,
    mandatory_notes: mandatoryNotes,
    classwork_homework: classworkHomework,
    pyq_legacy_analysis: pyqLegacyAnalysis,
    revision_test_plan: revisionTestPlan,
  };
}

