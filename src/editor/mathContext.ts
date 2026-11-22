/**
 * Context-aware LaTeX math mode detection and delimiter auto-wrapping for symbols
 * inserted from the Math Symbols sidebar (click or drag-and-drop).
 */

const VERBATIM_ENVS = new Set([
  "verbatim", "verbatim*", "Verbatim", "Verbatim*",
  "BVerbatim", "BVerbatim*", "LVerbatim", "LVerbatim*",
  "lstlisting", "minted", "comment", "filecontents", "filecontents*",
  "spverbatim", "verbatimtab",
]);

const MATH_ENVS = new Set([
  "equation", "equation*", "align", "align*", "alignat", "alignat*",
  "flalign", "flalign*", "gather", "gather*", "multline", "multline*",
  "eqnarray", "eqnarray*", "math", "displaymath", "dmath", "dmath*",
]);

const TEXT_MODE_COMMANDS = new Set([
  "text", "textrm", "textbf", "textit", "textsf", "texttt",
  "mbox", "hbox", "intertext", "shortintertext",
]);

type MathMode = "none" | "dollar" | "double" | "paren" | "bracket" | "env";

interface Frame {
  mode: MathMode;
  envName: string;
  returnBraceDepth: number;
}

export interface MathSymbolInsertionPlan {
  from: number;
  to: number;
  text: string;
  moveAfterClosingDollar: boolean;
}

function isAlpha(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** True when `idx` is preceded by an odd number of consecutive backslashes. */
export function isEscapedAt(text: string, idx: number): boolean {
  let backslashes = 0;
  for (let i = idx - 1; i >= 0 && text.charCodeAt(i) === 92; i--) {
    backslashes++;
  }
  return (backslashes & 1) === 1;
}

/** Returns true when UTF-16 offset `pos` in `text` is already inside a LaTeX math region. */
export function isInMathMode(text: string, pos: number): boolean {
  const limit = Math.max(0, Math.min(Math.trunc(pos), text.length));
  let mode: MathMode = "none";
  let envName = "";
  let verbatimEnv: string | null = null;
  let braceDepth = 0;
  let atLineStart = true;
  const frames: Frame[] = [];

  let i = 0;
  while (i < limit) {
    const ch = text.charCodeAt(i);

    if (verbatimEnv !== null) {
      if (ch === 92 && text.startsWith("\\end", i)) {
        let j = i + 4;
        while (j < limit && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
        if (j < limit && text.charCodeAt(j) === 123) {
          const closeBrace = text.indexOf("}", j + 1);
          if (closeBrace !== -1 && closeBrace < limit) {
            const name = text.slice(j + 1, closeBrace).trim();
            if (name === verbatimEnv) {
              verbatimEnv = null;
              atLineStart = false;
              i = closeBrace + 1;
              continue;
            }
          }
        }
      }
      if (ch === 10) atLineStart = true;
      else if (ch !== 13 && ch !== 32 && ch !== 9) atLineStart = false;
      i++;
      continue;
    }

    if (ch === 10) {
      if (atLineStart && mode === "dollar") {
        mode = "none";
      }
      atLineStart = true;
      i++;
      continue;
    }

    if (ch === 13 || ch === 32 || ch === 9) {
      i++;
      continue;
    }

    if (ch === 37) {
      // '%' comment runs to end of line
      atLineStart = false;
      while (i < limit && text.charCodeAt(i) !== 10) i++;
      continue;
    }

    atLineStart = false;

    if (ch === 92) {
      // '\\' command or escaped char
      if (i + 1 >= limit) {
        i++;
        continue;
      }
      const next = text.charCodeAt(i + 1);
      if (!isAlpha(next)) {
        if (next === 40 && mode === "none") mode = "paren";
        else if (next === 41 && mode === "paren") mode = "none";
        else if (next === 91 && mode === "none") mode = "bracket";
        else if (next === 93 && mode === "bracket") mode = "none";
        i += 2;
        continue;
      }

      let j = i + 1;
      while (j < limit && isAlpha(text.charCodeAt(j))) j++;
      const cmd = text.slice(i + 1, j);
      i = j;

      if (cmd === "verb" || cmd === "lstinline") {
        if (i < limit && text.charCodeAt(i) === 42) i++;
        if (i < limit && text.charCodeAt(i) !== 10) {
          const delim = text.charCodeAt(i);
          i++;
          while (i < limit && text.charCodeAt(i) !== delim && text.charCodeAt(i) !== 10) i++;
          if (i < limit && text.charCodeAt(i) === delim) i++;
        }
        continue;
      }

      if (cmd === "begin" || cmd === "end") {
        let k = i;
        while (k < limit && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
        if (k < limit && text.charCodeAt(k) === 123) {
          const closeBrace = text.indexOf("}", k + 1);
          if (closeBrace !== -1 && closeBrace < limit) {
            const name = text.slice(k + 1, closeBrace).trim();
            if (cmd === "begin") {
              if (VERBATIM_ENVS.has(name)) {
                verbatimEnv = name;
              } else if (mode === "none" && MATH_ENVS.has(name)) {
                mode = "env";
                envName = name;
              }
            } else if (mode === "env" && name === envName) {
              mode = "none";
              envName = "";
            }
            i = closeBrace + 1;
          }
        }
        continue;
      }

      if (mode !== "none" && TEXT_MODE_COMMANDS.has(cmd)) {
        let k = i;
        while (k < limit && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
        if (k < limit && text.charCodeAt(k) === 123) {
          frames.push({ mode, envName, returnBraceDepth: braceDepth });
          mode = "none";
          envName = "";
          braceDepth++;
          i = k + 1;
        }
      }
      continue;
    }

    if (ch === 123) {
      braceDepth++;
      i++;
      continue;
    }

    if (ch === 125) {
      if (braceDepth > 0) braceDepth--;
      if (frames.length > 0 && frames[frames.length - 1]!.returnBraceDepth === braceDepth) {
        const restored = frames.pop()!;
        mode = restored.mode;
        envName = restored.envName;
      }
      i++;
      continue;
    }

    if (ch === 36) {
      if (mode === "dollar") {
        mode = "none";
        i++;
      } else if (mode === "double") {
        if (i + 1 < limit && text.charCodeAt(i + 1) === 36) i += 2;
        else i++;
        mode = "none";
      } else if (mode === "none") {
        if (i + 1 < limit && text.charCodeAt(i + 1) === 36) {
          mode = "double";
          i += 2;
        } else if (i + 1 === limit && i + 1 < text.length && text.charCodeAt(i + 1) === 36) {
          // Caret positioned inside empty auto-paired `$$`.
          mode = "dollar";
          i++;
        } else {
          mode = "dollar";
          i++;
        }
      } else {
        i++;
      }
      continue;
    }

    i++;
  }

  return verbatimEnv === null && mode !== "none";
}

/**
 * Wraps `snippet` in `$…$` or `\[\n…\n\]` when `[from, to]` is outside math mode,
 * or merges into an adjacent inline `$` delimiter so consecutive clicks never produce `$$`.
 */
export function prepareMathSymbolInsertion(
  text: string,
  from: number,
  to: number,
  snippet: string,
): MathSymbolInsertionPlan {
  const s = Math.max(0, Math.min(Math.trunc(from), text.length));
  const e = Math.max(s, Math.min(Math.trunc(to), text.length));

  if (isInMathMode(text, s)) {
    return { from: s, to: e, text: snippet, moveAfterClosingDollar: false };
  }

  const isMultiline = snippet.includes("\n");
  if (s === e && !isMultiline) {
    // Cursor immediately after a single closing `$`: insert before the closing `$` and step past it.
    if (
      s > 0
      && text.charCodeAt(s - 1) === 36
      && (s < 2 || text.charCodeAt(s - 2) !== 36)
      && !isEscapedAt(text, s - 1)
      && isInMathMode(text, s - 1)
    ) {
      return { from: s - 1, to: s - 1, text: snippet, moveAfterClosingDollar: true };
    }
    // Cursor immediately before a single opening `$`: step inside the opening `$`.
    if (
      s < text.length
      && text.charCodeAt(s) === 36
      && text.charCodeAt(s + 1) !== 36
      && !isEscapedAt(text, s)
      && isInMathMode(text, s + 1)
    ) {
      const nextCh = s + 1 < text.length ? text.charCodeAt(s + 1) : 0;
      const needsSpace = /\\[A-Za-z]+$/.test(snippet) && isAlpha(nextCh);
      return {
        from: s + 1,
        to: s + 1,
        text: needsSpace ? `${snippet} ` : snippet,
        moveAfterClosingDollar: false,
      };
    }
  }

  return {
    from: s,
    to: e,
    text: isMultiline ? `\\[\n${snippet}\n\\]` : `$${snippet}$`,
    moveAfterClosingDollar: false,
  };
}

export interface PackageImportPlan {
  offset: number;
  text: string;
}

const VALID_PACKAGE_NAME_RE = /^[A-Za-z0-9._-]+$/;
const PACKAGE_CMD_RE = /\\(?:usepackage|RequirePackage)(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/g;
const DOCCLASS_CMD_RE = /\\documentclass(?:\s*\[[^\]]*\])?\s*\{[^}]+\}/;
const BEGIN_DOC_RE = /\\begin\s*\{document\}/;

/** Replaces `%…` comments on each line with equal-length spaces so UTF-16 offsets remain exact. */
function maskTexComments(text: string): string {
  const chars = text.split("");
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 37 && !isEscapedAt(text, i)) {
      while (i < text.length && text.charCodeAt(i) !== 10 && text.charCodeAt(i) !== 13) {
        chars[i] = " ";
        i++;
      }
    }
  }
  return chars.join("");
}

function insertOffsetAfter(text: string, cmdEnd: number, maxLimit: number): number {
  const nl = text.indexOf("\n", cmdEnd);
  if (nl !== -1 && nl + 1 <= maxLimit) return nl + 1;
  if (maxLimit < text.length) return maxLimit;
  return cmdEnd;
}

function preambleScanInfo(text: string): {
  hasPreamble: boolean;
  imported: Set<string>;
  lastPkgOffset: number | null;
  docClassOffset: number | null;
  beginDocOffset: number | null;
} {
  const imported = new Set<string>();
  const uncommented = maskTexComments(text);
  const beginMatch = BEGIN_DOC_RE.exec(uncommented);
  const preambleLimit = beginMatch ? beginMatch.index : uncommented.length;
  const preamble = uncommented.slice(0, preambleLimit);

  let hasPreamble = Boolean(beginMatch);
  const beginDocOffset = beginMatch
    ? text.lastIndexOf("\n", Math.max(0, beginMatch.index - 1)) + 1
    : null;

  const docMatch = DOCCLASS_CMD_RE.exec(preamble);
  let docClassOffset: number | null = null;
  if (docMatch) {
    hasPreamble = true;
    docClassOffset = insertOffsetAfter(text, docMatch.index + docMatch[0].length, preambleLimit);
  }

  PACKAGE_CMD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let lastPkgEnd = -1;
  while ((m = PACKAGE_CMD_RE.exec(preamble)) !== null) {
    hasPreamble = true;
    lastPkgEnd = m.index + m[0].length;
    for (const part of m[1]!.split(",")) {
      const name = part.trim();
      if (name) imported.add(name);
    }
  }
  const lastPkgOffset = lastPkgEnd >= 0 ? insertOffsetAfter(text, lastPkgEnd, preambleLimit) : null;

  return { hasPreamble, imported, lastPkgOffset, docClassOffset, beginDocOffset };
}

/** True when `pkg` (or a superset like `mathtools`/`amssymb`) is imported in the document preamble. */
export function hasPackageImport(text: string, pkg: string): boolean {
  const target = pkg.trim();
  if (!VALID_PACKAGE_NAME_RE.test(target)) return false;
  const { imported } = preambleScanInfo(text);
  if (imported.has(target)) return true;
  if (target === "amsmath" && imported.has("mathtools")) return true;
  if (target === "amsfonts" && imported.has("amssymb")) return true;
  return false;
}

/** Plans an insertion of `\usepackage{pkg}` into a document's preamble if missing; `null` for preamble-less files. */
export function planPackageImport(text: string, pkg: string, eol = "\n"): PackageImportPlan | null {
  const target = pkg.trim();
  if (!VALID_PACKAGE_NAME_RE.test(target)) return null;
  const info = preambleScanInfo(text);
  if (!info.hasPreamble) return null;
  if (info.imported.has(target)) return null;
  if (target === "amsmath" && info.imported.has("mathtools")) return null;
  if (target === "amsfonts" && info.imported.has("amssymb")) return null;

  const insertAt = info.lastPkgOffset ?? info.docClassOffset ?? info.beginDocOffset;
  if (insertAt === null) return null;

  const prevCh = insertAt > 0 ? text.charCodeAt(insertAt - 1) : 10;
  const nextCh = insertAt < text.length ? text.charCodeAt(insertAt) : 10;
  const needsLeadingEol = insertAt > 0 && prevCh !== 10 && prevCh !== 13;
  const needsTrailingEol = insertAt < text.length && nextCh !== 10 && nextCh !== 13;
  const directive = `\\usepackage{${target}}`;
  const leading = needsLeadingEol ? eol : "";
  const trailing = needsLeadingEol && !needsTrailingEol ? "" : eol;
  return {
    offset: insertAt,
    text: `${leading}${directive}${trailing}`,
  };
}
