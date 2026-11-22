/**
 * Smart LaTeX delimiter auto-closing (`\( \)`, `\[ \]`, `\begin{env}...\end{env}`) and
 * balanced paired deletion (`{ }`, `( )`, `[ ]`, `$ $`, `$$ $$`, `\( \)`, `\[ \]`, `\begin...\end`)
 * on Backspace and Delete.
 */
import { isInMathMode, isEscapedAt } from "./mathContext";
import { commentStart, environmentBalance } from "./scan";

export interface TextRange {
  from: number;
  to: number;
}

export interface PairedDeletionPlan {
  /** Non-overlapping ascending deletion ranges. */
  ranges: TextRange[];
  /** Resulting caret offset after applying all deletions. */
  caret: number;
}

export interface BeginAutoClosePlan {
  insert: string;
  caretOffset: number;
}

const BRACKET_PAIRS: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
const REVERSE_BRACKETS: Record<string, string> = { "}": "{", ")": "(", "]": "[" };
const ENV_TAG_RE = /\\(begin|end)\s*\{([A-Za-z][A-Za-z0-9*]*)\}/g;

function isInsideLineComment(text: string, idx: number): boolean {
  const lineStart = text.lastIndexOf("\n", Math.max(0, idx - 1)) + 1;
  const cStart = commentStart(text, lineStart, idx);
  return cStart >= 0 && cStart <= idx;
}

function mergeRanges(a: TextRange, b: TextRange): TextRange[] {
  const first = a.from <= b.from ? a : b;
  const second = a.from <= b.from ? b : a;
  if (first.to >= second.from) {
    return [{ from: first.from, to: Math.max(first.to, second.to) }];
  }
  return [first, second];
}

/**
 * Checks whether typing `}` at `caretAfterBrace` (right after `}`) completes an unclosed
 * `\begin{env}` tag and returns the body + matching `\end{env}` block to insert.
 */
export function findBeginAutoClose(
  docAfterBrace: string,
  caretAfterBrace: number,
  indentUnit: string,
  eol = "\n",
): BeginAutoClosePlan | null {
  const pos = Math.max(0, Math.min(Math.trunc(caretAfterBrace), docAfterBrace.length));
  const lineStart = docAfterBrace.lastIndexOf("\n", pos - 1) + 1;
  const lineHead = docAfterBrace.slice(lineStart, pos);
  if (commentStart(lineHead, 0, lineHead.length) >= 0) return null;

  const match = /\\begin\{([A-Za-z][A-Za-z0-9*]*)\}$/.exec(lineHead);
  if (!match) return null;
  const slashIdx = lineStart + match.index;
  if (isEscapedAt(docAfterBrace, slashIdx)) return null;

  const env = match[1]!;
  const { begins, ends } = environmentBalance(env, docAfterBrace);
  if (begins <= ends) return null;

  const indentMatch = /^[ \t]*/.exec(docAfterBrace.slice(lineStart));
  const indent = indentMatch ? indentMatch[0] : "";
  const bodyPrefix = eol + indent + indentUnit;
  return {
    insert: bodyPrefix + eol + indent + `\\end{${env}}`,
    caretOffset: bodyPrefix.length,
  };
}

function findEnvDeletion(
  text: string,
  pos: number,
  direction: "backward" | "forward",
): PairedDeletionPlan | null {
  ENV_TAG_RE.lastIndex = 0;
  const matches: { kind: "begin" | "end"; env: string; from: number; to: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = ENV_TAG_RE.exec(text)) !== null) {
    const idx = m.index;
    if (isEscapedAt(text, idx) || isInsideLineComment(text, idx)) continue;
    matches.push({
      kind: m[1] as "begin" | "end",
      env: m[2]!,
      from: idx,
      to: idx + m[0].length,
    });
  }
  const hitIdx = matches.findIndex((tag) =>
    direction === "backward" ? tag.to === pos : tag.from === pos,
  );
  if (hitIdx === -1) return null;
  const hit = matches[hitIdx]!;

  let partnerIdx = -1;
  if (hit.kind === "begin") {
    let depth = 1;
    for (let i = hitIdx + 1; i < matches.length; i++) {
      const cur = matches[i]!;
      if (cur.env !== hit.env) continue;
      depth += cur.kind === "begin" ? 1 : -1;
      if (depth === 0) {
        partnerIdx = i;
        break;
      }
    }
  } else {
    let depth = 1;
    for (let i = hitIdx - 1; i >= 0; i--) {
      const cur = matches[i]!;
      if (cur.env !== hit.env) continue;
      depth += cur.kind === "end" ? 1 : -1;
      if (depth === 0) {
        partnerIdx = i;
        break;
      }
    }
  }
  if (partnerIdx === -1) return null;

  const beginTag = hit.kind === "begin" ? hit : matches[partnerIdx]!;
  const endTag = hit.kind === "end" ? hit : matches[partnerIdx]!;
  const inner = text.slice(beginTag.to, endTag.from);
  if (/^[ \t\r\n]*$/.test(inner)) {
    return {
      ranges: [{ from: beginTag.from, to: endTag.to }],
      caret: beginTag.from,
    };
  }

  let bTo = beginTag.to;
  const afterBegin = text.slice(bTo);
  const beginLineEnd = /^[ \t]*\r?\n/.exec(afterBegin);
  if (beginLineEnd) bTo += beginLineEnd[0].length;

  let eFrom = endTag.from;
  const lineStartBeforeEnd = text.lastIndexOf("\n", eFrom - 1);
  if (lineStartBeforeEnd !== -1) {
    const leadBeforeEnd = text.slice(lineStartBeforeEnd + 1, eFrom);
    if (/^[ \t]*$/.test(leadBeforeEnd)) {
      eFrom = text[lineStartBeforeEnd - 1] === "\r" ? lineStartBeforeEnd - 1 : lineStartBeforeEnd;
    }
  }

  if (bTo >= eFrom) {
    return { ranges: [{ from: beginTag.from, to: endTag.to }], caret: beginTag.from };
  }
  return {
    ranges: [
      { from: beginTag.from, to: bTo },
      { from: eFrom, to: endTag.to },
    ],
    caret: hit.kind === "begin" ? beginTag.from : Math.max(beginTag.from, eFrom - (bTo - beginTag.from)),
  };
}

function findEscapedParenBracketDeletion(
  text: string,
  pos: number,
  direction: "backward" | "forward",
): PairedDeletionPlan | null {
  const start = direction === "backward" ? pos - 2 : pos;
  if (start < 0 || start + 2 > text.length || text.charCodeAt(start) !== 92) return null;
  if (isEscapedAt(text, start) || isInsideLineComment(text, start)) return null;
  const ch = text[start + 1];
  const openChar = ch === "(" || ch === ")" ? "(" : ch === "[" || ch === "]" ? "[" : null;
  if (!openChar) return null;
  const closeChar = openChar === "(" ? ")" : "]";
  const isOpener = ch === openChar;

  if (isOpener) {
    let depth = 1;
    for (let i = start + 2; i + 1 < text.length; i++) {
      if (text.charCodeAt(i) !== 92 || isEscapedAt(text, i) || isInsideLineComment(text, i)) continue;
      const next = text[i + 1];
      if (next === openChar) { depth++; i++; }
      else if (next === closeChar) {
        depth--;
        if (depth === 0) {
          return {
            ranges: mergeRanges({ from: start, to: start + 2 }, { from: i, to: i + 2 }),
            caret: start,
          };
        }
        i++;
      }
    }
  } else {
    let depth = 1;
    let lineStart = text.length + 1;
    let cStart = -1;
    for (let i = start - 2; i >= 0; i--) {
      if (i < lineStart) {
        lineStart = text.lastIndexOf("\n", i) + 1;
        cStart = commentStart(text, lineStart, i + 1);
      }
      if (cStart >= 0 && i >= cStart) continue;
      if (text.charCodeAt(i) !== 92 || isEscapedAt(text, i)) continue;
      const next = text[i + 1];
      if (next === closeChar) depth++;
      else if (next === openChar) {
        depth--;
        if (depth === 0) {
          const ranges = mergeRanges({ from: i, to: i + 2 }, { from: start, to: start + 2 });
          const caret = i + 2 === start ? i : start - 2;
          return { ranges, caret };
        }
      }
    }
  }
  return null;
}

function findForwardUnescapedSingleDollar(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 && i + 1 < text.length) {
      let j = i + 1;
      while (j < text.length && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9 || text.charCodeAt(j) === 13)) j++;
      if (j < text.length && text.charCodeAt(j) === 10) return -1;
    }
    if (c === 37 && !isEscapedAt(text, i)) {
      while (i < text.length && text.charCodeAt(i) !== 10) i++;
      continue;
    }
    if (c === 36 && !isEscapedAt(text, i)) {
      if (text.charCodeAt(i + 1) === 36) {
        i++;
        continue;
      }
      return i;
    }
  }
  return -1;
}

function findBackwardUnescapedSingleDollar(text: string, before: number): number {
  let lineStart = text.length + 1;
  let cStart = -1;
  for (let i = before - 1; i >= 0; i--) {
    if (i < lineStart) {
      lineStart = text.lastIndexOf("\n", i) + 1;
      cStart = commentStart(text, lineStart, i + 1);
    }
    if (text.charCodeAt(i) === 10) {
      const prevNl = text.lastIndexOf("\n", i - 1);
      if (prevNl !== -1 && /^[ \t\r]*$/.test(text.slice(prevNl + 1, i))) return -1;
      continue;
    }
    if (cStart >= 0 && i >= cStart) continue;
    if (text.charCodeAt(i) === 36 && !isEscapedAt(text, i)) {
      if (i > 0 && text.charCodeAt(i - 1) === 36 && !isEscapedAt(text, i - 1)) {
        i--;
        continue;
      }
      if (!isInMathMode(text, i)) return i;
    }
  }
  return -1;
}

function findForwardUnescapedDoubleDollar(text: string, from: number): number {
  for (let i = from; i + 1 < text.length; i++) {
    if (text.charCodeAt(i) === 37 && !isEscapedAt(text, i)) {
      while (i < text.length && text.charCodeAt(i) !== 10) i++;
      continue;
    }
    if (text.charCodeAt(i) === 36 && text.charCodeAt(i + 1) === 36 && !isEscapedAt(text, i)) {
      return i;
    }
  }
  return -1;
}

function countForwardUnescapedDoubleDollars(text: string, from: number): number {
  let count = 0;
  for (let i = from; i + 1 < text.length; i++) {
    if (text.charCodeAt(i) === 37 && !isEscapedAt(text, i)) {
      while (i < text.length && text.charCodeAt(i) !== 10) i++;
      continue;
    }
    if (text.charCodeAt(i) === 36 && text.charCodeAt(i + 1) === 36 && !isEscapedAt(text, i)) {
      count++;
      i++;
    }
  }
  return count;
}

function findBackwardUnescapedDoubleDollar(text: string, before: number): number {
  let lineStart = text.length + 1;
  let cStart = -1;
  for (let i = before - 2; i >= 0; i--) {
    if (i < lineStart) {
      lineStart = text.lastIndexOf("\n", i) + 1;
      cStart = commentStart(text, lineStart, i + 1);
    }
    if (cStart >= 0 && i >= cStart) continue;
    if (text.charCodeAt(i) === 36 && text.charCodeAt(i + 1) === 36 && !isEscapedAt(text, i)) {
      if (!isInMathMode(text, i)) return i;
    }
  }
  return -1;
}

function findDollarDeletion(
  text: string,
  pos: number,
  direction: "backward" | "forward",
): PairedDeletionPlan | null {
  // 1. Caret directly inside empty inline pair `$|$`
  if (
    pos > 0
    && pos < text.length
    && text.charCodeAt(pos - 1) === 36
    && text.charCodeAt(pos) === 36
    && !isEscapedAt(text, pos - 1)
    && !isInsideLineComment(text, pos - 1)
    && !isInMathMode(text, pos - 1)
  ) {
    if (countForwardUnescapedDoubleDollars(text, pos + 1) % 2 === 0) {
      return { ranges: [{ from: pos - 1, to: pos + 1 }], caret: pos - 1 };
    }
  }

  // 2. Display `$$` at Backspace (`$$|`) or Delete (`|$$`)
  const dblStart = direction === "backward" ? pos - 2 : pos;
  if (
    dblStart >= 0
    && dblStart + 2 <= text.length
    && text.charCodeAt(dblStart) === 36
    && text.charCodeAt(dblStart + 1) === 36
    && !isEscapedAt(text, dblStart)
    && !isInsideLineComment(text, dblStart)
  ) {
    if (!isInMathMode(text, dblStart)) {
      if (countForwardUnescapedDoubleDollars(text, dblStart + 2) % 2 === 1) {
        const close = findForwardUnescapedDoubleDollar(text, dblStart + 2);
        if (close !== -1) {
          return {
            ranges: mergeRanges({ from: dblStart, to: dblStart + 2 }, { from: close, to: close + 2 }),
            caret: dblStart,
          };
        }
      }
      if (direction === "forward") {
        // `|$$` with an even number of balanced `$$` blocks after it is an empty inline pair `$|$`.
        return { ranges: [{ from: dblStart, to: dblStart + 2 }], caret: dblStart };
      }
    } else {
      const open = findBackwardUnescapedDoubleDollar(text, dblStart);
      if (open !== -1) {
        return {
          ranges: mergeRanges({ from: open, to: open + 2 }, { from: dblStart, to: dblStart + 2 }),
          caret: open + 2 === dblStart ? open : dblStart - 2,
        };
      }
    }
  }

  // 3. Single unescaped `$`
  const idx = direction === "backward" ? pos - 1 : pos;
  if (idx < 0 || idx >= text.length || text.charCodeAt(idx) !== 36) return null;
  if (isEscapedAt(text, idx) || isInsideLineComment(text, idx)) return null;
  const isPartOfDouble =
    (idx > 0 && text.charCodeAt(idx - 1) === 36 && !isEscapedAt(text, idx - 1))
    || (idx + 1 < text.length && text.charCodeAt(idx + 1) === 36);
  if (isPartOfDouble) return null;

  if (!isInMathMode(text, idx)) {
    const close = findForwardUnescapedSingleDollar(text, idx + 1);
    if (close === -1) return null;
    return {
      ranges: mergeRanges({ from: idx, to: idx + 1 }, { from: close, to: close + 1 }),
      caret: idx,
    };
  }
  const open = findBackwardUnescapedSingleDollar(text, idx);
  if (open === -1) return null;
  return {
    ranges: mergeRanges({ from: open, to: open + 1 }, { from: idx, to: idx + 1 }),
    caret: open + 1 === idx ? open : idx - 1,
  };
}

function findMatchingCloser(text: string, openIdx: number, openChar: string, closeChar: string): number {
  let depth = 1;
  for (let i = openIdx + 1; i < text.length; i++) {
    const c = text[i]!;
    if (c === "%") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === openChar) depth++;
    else if (c === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findMatchingOpener(text: string, closeIdx: number, openChar: string, closeChar: string): number {
  let depth = 1;
  let lineStart = text.length + 1;
  let cStart = -1;
  for (let i = closeIdx - 1; i >= 0; i--) {
    if (i < lineStart) {
      lineStart = text.lastIndexOf("\n", i) + 1;
      cStart = commentStart(text, lineStart, i + 1);
    }
    if ((cStart >= 0 && i >= cStart) || isEscapedAt(text, i)) continue;
    const c = text[i]!;
    if (c === closeChar) depth++;
    else if (c === openChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const SIZED_DELIM_COMMANDS = new Set([
  "left", "right", "middle",
  "big", "bigl", "bigr", "bigm",
  "Big", "Bigl", "Bigr", "Bigm",
  "bigg", "biggl", "biggr", "biggm",
  "Bigg", "Biggl", "Biggr", "Biggm",
]);

function commandEndingAt(text: string, endInclusive: number): { name: string; slashIdx: number } | null {
  let j = endInclusive;
  while (j >= 0 && /[A-Za-z@]/.test(text[j]!)) j--;
  if (j < 0 || text[j] !== "\\" || j === endInclusive || isEscapedAt(text, j)) return null;
  return { name: text.slice(j + 1, endInclusive + 1), slashIdx: j };
}

function skipBalancedGroupBackward(text: string, closeIdx: number, openChar: string, closeChar: string): number {
  let depth = 1;
  let lineStart = text.length + 1;
  let cStart = -1;
  for (let i = closeIdx - 1; i >= 0; i--) {
    if (i < lineStart) {
      lineStart = text.lastIndexOf("\n", i) + 1;
      cStart = commentStart(text, lineStart, i + 1);
    }
    if ((cStart >= 0 && i >= cStart) || isEscapedAt(text, i)) continue;
    const c = text[i]!;
    if (c === closeChar) depth++;
    else if (c === openChar) {
      depth--;
      if (depth === 0) return i - 1;
    }
  }
  return -2;
}

function isCommandArgumentBrace(text: string, openIdx: number): boolean {
  let i = openIdx - 1;
  while (i >= 0 && (text[i] === " " || text[i] === "\t")) i--;
  while (i >= 0) {
    const ch = text[i]!;
    if ((ch === "}" || ch === "]") && !isEscapedAt(text, i)) {
      const next = skipBalancedGroupBackward(text, i, ch === "}" ? "{" : "[", ch);
      if (next < -1) return false;
      i = next;
      while (i >= 0 && (text[i] === " " || text[i] === "\t")) i--;
      continue;
    }
    break;
  }
  if (i >= 0 && text[i] === "*") {
    i--;
    while (i >= 0 && (text[i] === " " || text[i] === "\t")) i--;
  }
  return i >= 0 && commandEndingAt(text, i) !== null;
}

function isSizedDelimiter(text: string, idx: number): boolean {
  let i = idx - 1;
  while (i >= 0 && (text[i] === " " || text[i] === "\t")) i--;
  if (i < 0) return false;
  const cmd = commandEndingAt(text, i);
  return cmd !== null && SIZED_DELIM_COMMANDS.has(cmd.name);
}

function findBracketDeletion(
  text: string,
  pos: number,
  direction: "backward" | "forward",
): PairedDeletionPlan | null {
  // Always delete empty pair spanning caret (`{|} `, `(|)`, `[|]`) unless sized (`\left(\right)`)
  if (pos > 0 && pos < text.length) {
    const left = text[pos - 1]!;
    const right = text[pos]!;
    if (
      BRACKET_PAIRS[left] === right
      && !isEscapedAt(text, pos - 1)
      && !isInsideLineComment(text, pos - 1)
      && (left === "{" || (!isSizedDelimiter(text, pos - 1) && !isSizedDelimiter(text, pos)))
    ) {
      return { ranges: [{ from: pos - 1, to: pos + 1 }], caret: pos - 1 };
    }
  }

  const idx = direction === "backward" ? pos - 1 : pos;
  if (idx < 0 || idx >= text.length) return null;
  if (isEscapedAt(text, idx) || isInsideLineComment(text, idx)) return null;

  const ch = text[idx]!;
  if (BRACKET_PAIRS[ch]) {
    if (ch !== "{" && isSizedDelimiter(text, idx)) return null;
    const closeChar = BRACKET_PAIRS[ch]!;
    const partner = findMatchingCloser(text, idx, ch, closeChar);
    if (partner === -1) return null;
    if (ch === "{" && partner > idx + 1 && isCommandArgumentBrace(text, idx)) return null;
    if (ch !== "{" && isSizedDelimiter(text, partner)) return null;
    return {
      ranges: mergeRanges({ from: idx, to: idx + 1 }, { from: partner, to: partner + 1 }),
      caret: idx,
    };
  }

  if (REVERSE_BRACKETS[ch]) {
    if (ch !== "}" && isSizedDelimiter(text, idx)) return null;
    const openChar = REVERSE_BRACKETS[ch]!;
    const partner = findMatchingOpener(text, idx, openChar, ch);
    if (partner === -1) return null;
    if (openChar === "{" && partner + 1 < idx && isCommandArgumentBrace(text, partner)) return null;
    if (openChar !== "{" && isSizedDelimiter(text, partner)) return null;
    return {
      ranges: mergeRanges({ from: partner, to: partner + 1 }, { from: idx, to: idx + 1 }),
      caret: partner + 1 === idx ? partner : idx - 1,
    };
  }
  return null;
}

/**
 * Resolves paired deletion across `\begin{env}...\end{env}`, `\( \)`, `\[ \]`, `$ $`, `$$ $$`,
 * and `{ }`, `( )`, `[ ]` at `pos` for Backspace (`backward`) or Delete (`forward`).
 */
export function findPairedDeletion(
  text: string,
  pos: number,
  direction: "backward" | "forward",
): PairedDeletionPlan | null {
  const safePos = Math.max(0, Math.min(Math.trunc(pos), text.length));
  return (
    findEnvDeletion(text, safePos, direction)
    ?? findEscapedParenBracketDeletion(text, safePos, direction)
    ?? findDollarDeletion(text, safePos, direction)
    ?? findBracketDeletion(text, safePos, direction)
  );
}
