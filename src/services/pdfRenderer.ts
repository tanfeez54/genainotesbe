import katex from 'katex';

// ==========================================
// STAGE 1: NORMALIZATION
// ==========================================

const MACROS: Record<string, string> = {
  "\\rupee": "\\text{₹}",
  "\\Rs": "\\text{₹}",
  "\\deg": "^\\circ",
  "\\therefore": "\\therefore",
};

export interface NormalizationStats {
  autoWrapped: boolean;
  matrixFixed: boolean;
  macrosApplied: boolean;
  strayFixed: boolean;
}

export function normalizeMathContent(rawText: string | null | undefined): { normalized: string; stats: NormalizationStats } {
  if (!rawText) return { normalized: '', stats: { autoWrapped: false, matrixFixed: false, macrosApplied: false, strayFixed: false } };

  let text = rawText;
  const stats: NormalizationStats = {
    autoWrapped: false,
    matrixFixed: false,
    macrosApplied: false,
    strayFixed: false,
  };

  // 0. Auto-decode literal unicode escapes (e.g. \u2018 -> ‘)
  text = text.replace(/\\u([0-9a-fA-F]{4})/g, (match, grp) => String.fromCharCode(parseInt(grp, 16)));

  // 1. Auto-correct prime character to transpose / prime (A′ -> A')
  if (text.includes('′') || text.includes('\'')) {
    const before = text;
    text = text.replace(/([A-Za-z0-9])[′']/g, '$1^T'); // Replace with transpose as requested or just standard prime
    if (before !== text) stats.strayFixed = true;
  }

  // 2. Auto-correct simple flat matrices like [1,6,5,7] or [1,2,3,4] to 2x2
  const matrixRegex = /\[(\s*\d+\s*(?:,\s*\d+\s*)+)\]/g;
  text = text.replace(matrixRegex, (match, inner) => {
    const parts = inner.split(',').map((p: string) => p.trim());
    if (parts.length === 4) {
      stats.matrixFixed = true;
      return `$\\begin{bmatrix} ${parts[0]} & ${parts[1]} \\\\ ${parts[2]} & ${parts[3]} \\end{bmatrix}$`;
    }
    // Could support 9 for 3x3 etc.
    return match; // return as is if not perfectly 4
  });

  // 3. Macros Expansion (mostly for things that might break if outside math mode)
  for (const [macro, replacement] of Object.entries(MACROS)) {
    if (text.includes(macro)) {
      text = text.split(macro).join(replacement);
      stats.macrosApplied = true;
    }
  }

  // 4. Auto-wrap LaTeX-like fragments not in delimiters
  // We detect things like \frac{..}{..}, R_i, x^2, \alpha
  // First, we split the text into math mode vs text mode to avoid double wrapping
  const parts = text.split('$');
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      // In text mode: look for mathy things
      // This is risky, but we look for distinct patterns.
      const mathyRegex = /\\(frac|sqrt|begin|end|alpha|beta|pi|theta|leftrightarrow|rightarrow|int|sum|times|div|text)\b[^{]*(\{[^}]*\})?|([a-zA-Z]_[a-zA-Z0-9]+)|([a-zA-Z]\^[a-zA-Z0-9]+)/g;
      const matched = parts[i].match(mathyRegex);
      if (matched && matched.length > 0) {
        // We found math commands outside $...$
        // To be safe, we wrap the specific commands/patterns in $...$
        let modified = parts[i];
        modified = modified.replace(/(\\(?:frac|sqrt|begin|end|alpha|beta|pi|theta|leftrightarrow|rightarrow|int|sum|times|div|text)[^a-zA-Z\s]*(?:\{[^}]*\})?(?:\{[^}]*\})?)/g, '$$$1$$');
        modified = modified.replace(/\b([a-zA-Z]_[a-zA-Z0-9]+)\b/g, '$$$1$$');
        modified = modified.replace(/\b([a-zA-Z]\^[a-zA-Z0-9]+)\b/g, '$$$1$$');
        
        // Cleanup adjacent $$ $$
        modified = modified.replace(/\$\$\s*\$\$/g, ' ');
        
        if (parts[i] !== modified) {
           parts[i] = modified;
           stats.autoWrapped = true;
        }
      }
    }
  }
  
  // Rejoin and clean up multiple consecutive $ due to our crude replace
  text = parts.join('$');
  text = text.replace(/\$\$/g, '$').replace(/\$\$/g, '$'); // Fix double wrap if existed

  // Replace stray non-latex backslashes (e.g. \rupee if it wasn't caught because of case or something)
  // At minimum fallback \rupee to ₹
  if (text.includes('\\rupee')) {
    text = text.replace(/\\rupee/g, '₹');
    stats.strayFixed = true;
  }

  return { normalized: text, stats };
}

// ==========================================
// STAGE 2: RENDERING
// ==========================================

export interface RenderStats {
  fallbackLevel: 0 | 1 | 2; // 0 = normal, 1 = stripped unknown, 2 = raw text
}

export function renderLatexSafe(text: string | null | undefined): { html: string; stats: RenderStats } {
  if (!text) return { html: '', stats: { fallbackLevel: 0 } };

  // Attempt 1: Normal
  try {
    const html = renderKatexBlocks(text, true); // throwOnError: true
    const htmlClean = html.replace(/<annotation[^>]*>.*?<\/annotation>/gs, '');
    if (/\\[a-zA-Z]{2,}/.test(htmlClean)) {
      throw new Error("Leaked raw latex detected");
    }
    return { html, stats: { fallbackLevel: 0 } };
  } catch (e) {
    // Attempt 2: Strip unknown macros and retry
    try {
      const strippedText = stripUnknownMacros(text);
      const html = renderKatexBlocks(strippedText, true);
      const htmlClean = html.replace(/<annotation[^>]*>.*?<\/annotation>/gs, '');
      if (/\\[a-zA-Z]{2,}/.test(htmlClean)) {
        throw new Error("Leaked raw latex detected");
      }
      return { html, stats: { fallbackLevel: 1 } };
    } catch (e2) {
      // Attempt 3: Plain text version (remove all latex commands but keep content)
      const plainText = stripAllLatex(text);
      // Even in fallback, we use throwOnError: false to guarantee output
      const html = renderKatexBlocks(plainText, false);
      return { html, stats: { fallbackLevel: 2 } };
    }
  }
}

function renderKatexBlocks(text: string, throwOnError: boolean): string {
  const parts = text.split('$');
  for (let i = 1; i < parts.length; i += 2) {
    parts[i] = katex.renderToString(parts[i], {
      throwOnError,
      displayMode: false,
      errorColor: 'transparent', // Custom color as requested so fallbacks blend in
      macros: MACROS,
    });
  }
  return parts.join('');
}

function stripUnknownMacros(text: string): string {
  // Very simplistic: strip things that start with \ but aren't common
  // For safety, we just remove the command prefix and keep the brackets
  return text.replace(/\\[a-zA-Z]+/g, (match) => {
    const common = ['\\frac', '\\sqrt', '\\begin', '\\end', '\\text', '\\alpha', '\\beta', '\\pi', '\\theta', '\\leftrightarrow', '\\rightarrow', '\\int', '\\sum', '\\times', '\\div', '\\bmatrix'];
    if (common.includes(match) || MACROS[match]) {
      return match;
    }
    return ''; // strip unknown
  });
}

function stripAllLatex(text: string): string {
  let plain = text.replace(/\\[a-zA-Z]+/g, '');
  plain = plain.replace(/[\{\}]/g, ''); // strip braces
  return plain;
}

// ==========================================
// STAGE 3: VERIFICATION
// ==========================================

export function verifyNoRawLatex(html: string): string[] {
  const violations: string[] = [];

  // 1. Any remaining standalone backslash-commands
  // We need to be careful: KaTeX output HTML might have backslashes? No, KaTeX HTML doesn't contain raw \commands
  // except maybe inside MathML tags, but MathML is generated by KaTeX. Let's look for visible text.
  // Actually, we can just regex the whole HTML because KaTeX renders to spans.
  // But wait, KaTeX's `<annotation encoding="application/x-tex">` contains the raw latex!
  // We must strip MathML or annotations before checking.
  const htmlWithoutAnnotations = html.replace(/<annotation[^>]*>.*?<\/annotation>/gs, '');

  if (/\\[a-zA-Z]{2,}/.test(htmlWithoutAnnotations)) {
    violations.push('Standalone backslash command detected');
  }

  // 2. Unmatched $, \begin{, \end{, ^{, _{
  if (htmlWithoutAnnotations.includes('$')) {
    violations.push('Unmatched $ symbol');
  }
  if (htmlWithoutAnnotations.includes('\\begin{') || htmlWithoutAnnotations.includes('\\end{')) {
    violations.push('Unmatched \\begin or \\end environment');
  }
  if (htmlWithoutAnnotations.includes('^{') || htmlWithoutAnnotations.includes('_{')) {
    violations.push('Unmatched superscript/subscript notation');
  }
  if (htmlWithoutAnnotations.includes('\\rupee')) {
    violations.push('Unmapped \\rupee macro');
  }

  return violations;
}
