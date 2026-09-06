import { normalizeMathContent, renderLatexSafe, verifyNoRawLatex } from '../services/pdfRenderer';

const testCases = [
  "R_i \\leftrightarrow R_j", // Unwrapped LaTeX
  "\\rupee 2.50", // Unmapped macro
  "[1,6,5,7]", // Matrix
  "(A + A′)", // Stray prime
  "\\frac{1}{2} + \\unknownCommand{3}", // Will trigger fallback level 1
  "\\invalid{syntax} {that} breaks \\everyth!ng", // Will trigger fallback level 2
];

console.log("=== PDF Pipeline Tests ===");

let passed = 0;

for (let i = 0; i < testCases.length; i++) {
  const raw = testCases[i];
  console.log(`\nTest ${i + 1}: ${raw}`);
  
  const { normalized, stats: normStats } = normalizeMathContent(raw);
  console.log(`Normalized: ${normalized}`);
  console.log(`Norm Stats: ${JSON.stringify(normStats)}`);

  const { html, stats: renderStats } = renderLatexSafe(normalized);
  console.log(`Fallback Level: ${renderStats.fallbackLevel}`);
  
  const violations = verifyNoRawLatex(html);
  if (violations.length > 0) {
    console.log(`❌ FAIL - Violations: ${violations.join(', ')}`);
  } else {
    console.log(`✅ PASS - Clean HTML generated (Length: ${html.length})`);
    passed++;
  }
}

console.log(`\n=== Results: ${passed}/${testCases.length} Passed ===`);
if (passed === testCases.length) {
  process.exit(0);
} else {
  process.exit(1);
}
