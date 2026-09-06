import { chromium } from 'playwright';
import { normalizeMathContent, renderLatexSafe, verifyNoRawLatex } from './pdfRenderer';

export interface PaperGenerationHealth {
  questionId: string;
  autoWrapped: boolean;
  matrixFixed: boolean;
  macrosApplied: boolean;
  strayFixed: boolean;
  fallbackLevel: number;
  verificationViolations: string[];
}

export async function generatePdfFromData(data: any): Promise<{ pdfBuffer: Buffer, healthReport: PaperGenerationHealth[] }> {
  const healthReport: PaperGenerationHealth[] = [];

  const processText = (raw: string | null | undefined, qId: string): string => {
    if (!raw) return '';
    const { normalized, stats: normStats } = normalizeMathContent(raw);
    const { html, stats: renderStats } = renderLatexSafe(normalized);
    
    // Check if we need to log this
    if (normStats.autoWrapped || normStats.matrixFixed || normStats.macrosApplied || normStats.strayFixed || renderStats.fallbackLevel > 0) {
      let log = healthReport.find(h => h.questionId === qId);
      if (!log) {
        log = { questionId: qId, ...normStats, fallbackLevel: renderStats.fallbackLevel, verificationViolations: [] };
        healthReport.push(log);
      } else {
        log.autoWrapped = log.autoWrapped || normStats.autoWrapped;
        log.matrixFixed = log.matrixFixed || normStats.matrixFixed;
        log.macrosApplied = log.macrosApplied || normStats.macrosApplied;
        log.strayFixed = log.strayFixed || normStats.strayFixed;
        log.fallbackLevel = Math.max(log.fallbackLevel, renderStats.fallbackLevel);
      }
    }
    return html;
  };

  const schoolName = (data.school?.name || 'Modern Public School').trim();
  const schoolLogo = data.school?.logo_url;
  const schoolAddress = data.school?.address;
  const examTitle = (data.title || 'Annual Examination').trim();
  const className = (data.classes?.name || 'N/A').trim();
  const subjectName = (data.subjects?.name || 'N/A').trim();
  const timeAllowed = (data.duration_minutes ? `${data.duration_minutes} Mins` : '2.5 Hours').trim();
  const totalMarks = data.total_marks || 50;
  const instructions = data.instructions || '1. Attempt all questions.\n2. Write answers clearly and neatly.\n3. Section A is compulsory.';
  const questions = data.blueprint?.selected_questions || [];

  // 1. Generate HTML Sections
  // This logic is adapted from the frontend paperPrinter but heavily utilizes our robust backend renderer
  const sectionGroups: any[] = [];
  const sectionTypeOrder = ['mcq', 'fill_blank', 'match_the_following', 'true_false', 'short_answer', 'long_answer'];

  sectionTypeOrder.forEach((t) => {
    const matched = questions.filter((q: any) => q.type === t);
    if (matched.length > 0) {
      let secTitle = '';
      let secInstruction = '';
      if (t === 'mcq') {
        secTitle = 'SECTION A: MULTIPLE CHOICE QUESTIONS';
        secInstruction = 'Choose and write the correct option for each question:';
      } else if (t === 'fill_blank') {
        secTitle = 'SECTION B: FILL IN THE BLANKS';
        secInstruction = 'Fill in the blanks with suitable words / phrases:';
      } else if (t === 'match_the_following') {
        secTitle = 'SECTION C: MATCH THE FOLLOWING';
        secInstruction = 'Match the items in Column A with Column B:';
      } else if (t === 'true_false') {
        secTitle = 'SECTION D: TRUE OR FALSE';
        secInstruction = 'State whether the following statements are True or False:';
      } else if (t === 'short_answer') {
        secTitle = 'SECTION E: SHORT ANSWER QUESTIONS';
        secInstruction = 'Answer the following short answer questions:';
      } else {
        secTitle = 'SECTION F: LONG ANSWER QUESTIONS';
        secInstruction = 'Answer the following questions in detail:';
      }

      const totalSecMarks = matched.reduce((acc: number, q: any) => acc + (Number(q.marks) || 1), 0);
      sectionGroups.push({
        sectionName: \`\${secTitle} (\${totalSecMarks} MARKS)\`,
        type: t,
        instruction: secInstruction,
        questions: matched,
      });
    }
  });

  const remaining = questions.filter((q: any) => !sectionTypeOrder.includes(q.type));
  if (remaining.length > 0) {
    const totalSecMarks = remaining.reduce((acc: number, q: any) => acc + (Number(q.marks) || 1), 0);
    sectionGroups.push({
      sectionName: \`ADDITIONAL QUESTIONS (\${totalSecMarks} MARKS)\`,
      type: 'other',
      instruction: 'Answer the following questions:',
      questions: remaining,
    });
  }

  const sectionsHtml = sectionGroups.map((sec, secIdx) => {
    const qHtml = sec.questions.map((q: any, qIdx: number) => {
      const qNum = qIdx + 1;
      const qText = processText(q.question_text || q.text || '', q.id);
      
      let detailsHtml = '';

      if (sec.type === 'mcq' && Array.isArray(q.options) && q.options.length > 0) {
        const optItems = q.options.map((opt: any, oIdx: number) => {
          const label = String.fromCharCode(65 + oIdx);
          const text = typeof opt === 'string' ? opt : opt.text || '';
          return \`<div class="mcq-col"><strong>(\${label})</strong> \${processText(text, q.id)}</div>\`;
        }).join('');
        detailsHtml = \`<div class="options">\${optItems}</div>\`;
      } else if (sec.type === 'true_false') {
        detailsHtml = \`
          <div class="tf-row">
            <span><span class="box"></span> (A) True</span>
            <span><span class="box"></span> (B) False</span>
          </div>
        \`;
      }

      const marksHtml = q.marks ? \`<span class="q-marks">[\${q.marks}]</span>\` : '';
      
      return \`
        <div class="question">
          <div class="q-head">
            <span class="q-num">\${qNum}.</span>
            <span class="q-text">\${qText}</span>
            \${marksHtml}
          </div>
          \${detailsHtml}
        </div>
      \`;
    }).join('');

    return \`
      <div class="section-container">
        <div class="sec-title">\${sec.sectionName}</div>
        <div class="sec-inst">\${sec.instruction}</div>
        <div class="sec-questions">\${qHtml}</div>
      </div>
    \`;
  }).join('');

  // Build the full HTML document
  const fullHtml = \`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <link href="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css" rel="stylesheet">
        <style>
          @page { size: A4; margin: 20mm 15mm; }
          body { 
            font-family: "Noto Serif", "Times New Roman", serif; 
            font-size: 12pt; 
            line-height: 1.5; 
            margin: 0;
            padding: 0;
            color: #000;
          }
          .paper-header {
            text-align: center;
            border-bottom: 2px solid #000;
            padding-bottom: 10px;
            margin-bottom: 20px;
          }
          .school-name { font-size: 18pt; font-weight: bold; text-transform: uppercase; }
          .exam-title { font-size: 14pt; font-weight: bold; margin-top: 5px; }
          .meta-table { width: 100%; border-top: 1.5px solid #000; border-bottom: 1.5px solid #000; margin-top: 10px; font-size: 11pt; font-weight: bold; }
          .meta-table td { padding: 4px; text-align: center; }
          .instructions { margin-bottom: 20px; font-size: 11pt; border: 1px solid #000; padding: 10px; }
          .section-container { margin-bottom: 20px; }
          .sec-title { font-size: 12pt; font-weight: bold; text-align: center; text-transform: uppercase; margin-bottom: 5px; }
          .sec-inst { font-size: 11pt; font-style: italic; margin-bottom: 10px; font-weight: bold; }
          
          /* Specific requirements from prompt */
          .question { break-inside: avoid; margin-bottom: 12px; }
          .katex-display, .katex { break-inside: avoid; }
          .options { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px; margin-top: 8px; padding-left: 24px; }
          
          .q-head { display: flex; align-items: flex-start; }
          .q-num { font-weight: bold; min-width: 24px; }
          .q-text { flex-grow: 1; }
          .q-marks { font-weight: bold; margin-left: 10px; white-space: nowrap; }
          .tf-row { padding-left: 24px; margin-top: 8px; display: flex; gap: 40px; }
          .box { display: inline-block; width: 12px; height: 12px; border: 1px solid #000; margin-right: 5px; }
        </style>
      </head>
      <body>
        <div class="paper-header">
          <div class="school-name">\${schoolName}</div>
          \${schoolAddress ? \`<div style="font-size: 10pt;">\${schoolAddress}</div>\` : ''}
          <div class="exam-title">\${examTitle}</div>
          <table class="meta-table">
            <tr>
              <td>CLASS: \${className}</td>
              <td>SUBJECT: \${subjectName}</td>
              <td>TIME: \${timeAllowed}</td>
              <td>MARKS: \${totalMarks}</td>
            </tr>
          </table>
        </div>
        \${instructions ? \`<div class="instructions"><strong>Instructions:</strong><br>\${instructions.replace(/\\n/g, '<br>')}</div>\` : ''}
        \${sectionsHtml}
        <div style="text-align: center; font-weight: bold; margin-top: 30px;">*** END OF PAPER ***</div>
      </body>
    </html>
  \`;

  // STAGE 3: Verification
  const violations = verifyNoRawLatex(fullHtml);
  if (violations.length > 0) {
    throw new Error(\`Verification Failed: The generated paper contains visible broken LaTeX. Violations: \${violations.join(', ')}\`);
  }

  // Generate PDF via Playwright
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(fullHtml, { waitUntil: 'networkidle' }); // Wait for KaTeX CSS to load
    const pdfBuffer = await page.pdf({ 
      format: 'A4',
      printBackground: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' } // Margins are handled via CSS @page
    });
    return { pdfBuffer, healthReport };
  } finally {
    await browser.close();
  }
}
