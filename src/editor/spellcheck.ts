// Client-side spell checker for the GabeTeX editor (Tauri / Linux & Windows).
// Uses typo-js with Hunspell-compatible dictionaries bundled locally, so it works
// fully offline for both English (en_US) and Brazilian Portuguese (pt_BR).
//
// LaTeX markup (commands, math, comments, verbatim, …) is skipped so only prose
// is checked, mirroring the macOS app's NSSpellChecker delegate.

import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { StateField, StateEffect, type StateEffectType, Transaction } from "@codemirror/state";

const DICT_ROOT = "/dictionaries/";

interface TypoModule {
  default: new (locale: string, aff: string, dic: string) => TypoInstance;
}

interface TypoInstance {
  check(word: string): boolean;
  suggest(word: string): string[];
}

interface LoadedDict {
  typo: TypoInstance | null;
  promise: Promise<void>;
}

const dictionaries: Record<string, LoadedDict> = {
  en: { typo: null, promise: Promise.resolve() },
  "pt-BR": { typo: null, promise: Promise.resolve() },
};

function loadDictionary(language: string): Promise<void> {
  const entry = dictionaries[language];
  if (!entry) return Promise.reject(new Error(`Unsupported language: ${language}`));
  if (entry.typo) return Promise.resolve();

  entry.promise = (async () => {
    const TypoMod = (await import("typo-js")) as TypoModule;
    const key = language === "pt-BR" ? "pt" : "en";
    const [affResp, dicResp] = await Promise.all([
      fetch(`${DICT_ROOT}${key}.aff`),
      fetch(`${DICT_ROOT}${key}.dic`),
    ]);
    if (!affResp.ok || !dicResp.ok) {
      throw new Error(`Failed to load dictionary for ${language}`);
    }
    const [aff, dic] = await Promise.all([affResp.text(), dicResp.text()]);
    entry.typo = new TypoMod.default(
      language === "pt-BR" ? "pt_BR" : "en_US",
      aff,
      dic,
    );
  })();

  return entry.promise;
}

export function getDictionary(language: string): TypoInstance | null {
  return dictionaries[language]?.typo ?? null;
}

/** Word-like token: letters (incl. accents), digits, apostrophes, @, _. */
const wordRe = /[A-Za-zÀ-ÖØ-öø-ÿ0-9_@]+(?:['’][A-Za-zÀ-ÖØ-öø-ÿ]+)*/g;

interface WordToken {
  word: string;
  start: number;
  end: number;
  line: number;
}

/** Extracts checkable prose words from LaTeX source, skipping markup. */
export function extractTexWords(text: string): WordToken[] {
  const words: WordToken[] = [];
  let segmentStart = 0;
  let index = 0;
  let line = 1;

  const countNewlines = (s: string, from: number, to: number): number => {
    let n = 0;
    for (let i = from; i < to; i++) if (s.charCodeAt(i) === 10) n++;
    return n;
  };

  const advanceLine = (to: number): void => {
    line += countNewlines(text, segmentStart, to);
    segmentStart = to;
  };

  const flush = (end: number): void => {
    const segment = text.slice(segmentStart, end);
    wordRe.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = wordRe.exec(segment)) !== null) {
      words.push({
        word: match[0],
        start: segmentStart + match.index,
        end: segmentStart + match.index + match[0].length,
        line,
      });
    }
  };

  const mathEnvironments = new Set([
    "equation", "equation*", "align", "align*", "alignat", "alignat*",
    "gather", "gather*", "multline", "multline*", "flalign", "flalign*",
    "eqnarray", "eqnarray*", "displaymath", "math",
  ]);
  const literalEnvironments = new Set([
    "verbatim", "verbatim*", "lstlisting", "lstlisting*",
    "minted", "minted*", "plainTeX",
  ]);

  const skipMathDelimiter = (s: string, i: number, delim: string): number => {
    if (delim === "$$") {
      const end = s.indexOf("$$", i + 2);
      return end === -1 ? s.length : end + 2;
    }
    let j = i + 1;
    while (j < s.length) {
      if (s.charCodeAt(j) === 36 && !isEscaped(s, j)) return j + 1;
      j++;
    }
    return s.length;
  };

  const skipTexWhitespace = (s: string, i: number): number => {
    while (i < s.length && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
    return i;
  };

  const readTexGroup = (s: string, i: number): { value: string; end: number } | null => {
    if (i >= s.length) return null;
    const c = s.charCodeAt(i);
    if (c === 123) {
      let depth = 0, j = i;
      while (j < s.length) {
        const ch = s.charCodeAt(j);
        if (ch === 123 && !isEscaped(s, j)) depth++;
        else if (ch === 125 && !isEscaped(s, j)) {
          depth--;
          if (depth === 0) return { value: s.slice(i + 1, j), end: j + 1 };
        }
        j++;
      }
      return null;
    }
    if (c === 91) {
      let depth = 0, j = i;
      while (j < s.length) {
        const ch = s.charCodeAt(j);
        if (ch === 91 && !isEscaped(s, j)) depth++;
        else if (ch === 93 && !isEscaped(s, j)) {
          depth--;
          if (depth === 0) return { value: s.slice(i + 1, j), end: j + 1 };
        }
        j++;
      }
      return null;
    }
    return null;
  };

  const isEscaped = (s: string, i: number): boolean => {
    let n = 0;
    for (let k = i - 1; k >= 0 && s.charCodeAt(k) === 92; k--) n++;
    return (n & 1) === 1;
  };

  while (index < text.length) {
    const c = text.charCodeAt(index);

    if (c === 37) {
      flush(index);
      const newline = text.indexOf("\n", index);
      if (newline === -1) { advanceLine(text.length); break; }
      advanceLine(newline + 1);
      continue;
    }

    if (c === 36) {
      flush(index);
          const delim = text.charCodeAt(index + 1) === 36 ? "$$" : "$";
      index = skipMathDelimiter(text, index, delim);
      advanceLine(index);
      continue;
    }

    if (c === 92) {
      flush(index);
      index++;
      const rest = text.slice(index);
      const commandMatch = /^[A-Za-z@]+/.exec(rest);
      const command = commandMatch ? commandMatch[0] : "";
      index += command.length;

          if (text.charCodeAt(index) === 42 &&
        /^(verb|lstinline|mintinline|newcommand|renewcommand|providecommand|newenvironment|renewenvironment)$/.test(command)) {
        index++;
      }

      if (command === "begin" || command === "end") {
        index = skipTexWhitespace(text, index);
        const group = readTexGroup(text, index);
        if (group) {
          index = group.end;
          const env = group.value.replace(/\*$/, "");
          if (command === "begin" &&
            (mathEnvironments.has(env) || literalEnvironments.has(group.value))) {
            const escaped = group.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const closing = new RegExp("\\\\end\\s*\\{\\s*" + escaped + "\\s*\\}");
            const m = closing.exec(text.slice(index));
            index = m !== null ? index + m.index + m[0].length : text.length;
          }
        }
        advanceLine(index);
        continue;
      }

      if (command === "verb" || command === "lstinline" || command === "mintinline") {
        index = skipTexWhitespace(text, index);
        if (command === "mintinline") {
          const group = readTexGroup(text, index);
          if (group) index = group.end;
        }
        const delim = text[index];
        if (delim) {
          const end = text.indexOf(delim, index + 1);
          index = end === -1 ? text.length : end + 1;
        }
        advanceLine(index);
        continue;
      }

      if (command === "href") {
        index = skipTexWhitespace(text, index);
        const group = readTexGroup(text, index);
        if (group) index = group.end;
        advanceLine(index);
        continue;
      }

      if (command === "foreignlanguage") {
        index = skipTexWhitespace(text, index);
        const group = readTexGroup(text, index);
        if (group) index = group.end;
        advanceLine(index);
        continue;
      }

      while (index < text.length) {
        const nc = text.charCodeAt(index);
        if (nc === 123 || nc === 91) {
          const group = readTexGroup(text, index);
          if (!group) break;
          index = group.end;
        } else if (nc === 32 || nc === 9) {
          index++;
        } else break;
      }
      advanceLine(index);
      continue;
    }

    index++;
  }

  flush(text.length);
  return words;
}

interface SpellIssue {
  word: string;
  from: number;
  to: number;
  line: number;
  suggestions: string[];
}

/** Checks a document's prose words against the dictionary for `language`. */
export async function checkDocument(
  text: string,
  language: string,
  ignored: Set<string>,
): Promise<SpellIssue[]> {
  await loadDictionary(language);
  const typo = getDictionary(language);
  if (!typo) return [];

  const locale = language === "pt-BR" ? "pt-BR" : "en-US";
  const tokens = extractTexWords(text);
  const issues: SpellIssue[] = [];

  for (const token of tokens) {
    if (token.word.length > 40) continue;
    if (/\d/.test(token.word)) continue;
    if (/^[A-Z]{2,}$/.test(token.word)) continue;

    const key = token.word.toLocaleLowerCase(locale);
    if (ignored.has(key)) continue;
    if (typo.check(token.word)) continue;

    const suggestions = typo.suggest(token.word).slice(0, 3);
    issues.push({
      word: token.word,
      from: token.start,
      to: token.end,
      line: token.line,
      suggestions,
    });
  }

  return issues;
}

// MARK: CodeMirror integration

const SPELL_UNDERLINE = Decoration.mark({ class: "gx-diag gx-diag-spell" });

interface SpellAnchor { from: number; to: number; word: string }

interface SpellState {
  anchors: SpellAnchor[];
  deco: DecorationSet | null;
}

const spellField = StateField.define<SpellState>({
  create(): SpellState {
    return { anchors: [], deco: null };
  },
  update(value: SpellState, tr: Transaction): SpellState {
    let next: SpellState = { anchors: value.anchors.slice(), deco: value.deco };
    if (tr.docChanged) {
      next.anchors = next.anchors.map((a) => ({
        from: tr.changes.mapPos(a.from, -1),
        to: Math.max(tr.changes.mapPos(a.to, 1), tr.changes.mapPos(a.from, -1)),
        word: a.word,
      }));
    }
    for (const e of tr.effects) {
      if (e.is(setSpellEffect)) {
        next.anchors = e.value.map((i) => ({ from: i.from, to: i.to, word: i.word }));
      }
    }
    const deco = next.anchors.length
      ? Decoration.set(next.anchors.map((a) => SPELL_UNDERLINE.range(a.from, a.to)), true)
      : Decoration.none;
    return { anchors: next.anchors, deco };
  },
  provide: (f: StateField<SpellState>) =>
    EditorView.decorations.from(f, (v: SpellState) => v.deco ?? Decoration.none),
});

const setSpellEffect: StateEffectType<SpellIssue[]> = StateEffect.define<SpellIssue[]>();

export { setSpellEffect, spellField };
