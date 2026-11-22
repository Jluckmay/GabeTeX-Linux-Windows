import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { latexLanguage } from "./latex";
import { expandSnippet, insertSnippetAt, parseSnippet, snippets } from "./snippet";
import { clampDropPos, dropPosField, setDropPosEffect } from "./index";
import { isInMathMode, prepareMathSymbolInsertion, hasPackageImport, planPackageImport } from "./mathContext";
import { findBeginAutoClose, findPairedDeletion } from "./pairEditing";
import { commandPrefixStart, enclosingArgument, environmentOpenedAtEndOf, isInCommandArgument } from "./scan";
import { autoClosers, autoPairInput, isMathAt, smartBackspace, smartDelete } from "./editing";
import { diagnosticRange } from "./diagnostics";
import { includeTargetAt, labelKeyAt } from "./mouse";

function tokens(doc: string): [string, string][] {
  const state = EditorState.create({ doc, extensions: latexLanguage });
  const tree = ensureSyntaxTree(state, doc.length, 5000)!;
  const out: [string, string][] = [];
  tree.iterate({
    enter(n) {
      if (n.type.isTop) return;
      const kind = n.name === "mathOpen" || n.name === "mathClose" ? "mathDelimiter" : n.name;
      out.push([kind, doc.slice(n.from, n.to)]);
    },
  });
  return out;
}

describe("latex tokenizer", () => {
  it("classifies commands, structure, environments and references", () => {
    const t = tokens("\\section{Intro}\\label{sec:a} \\foo");
    expect(t[0]).toEqual(["structureCommand", "\\section"]);
    expect(t).toContainEqual(["referenceArgument", "sec:a"]);
    expect(t).toContainEqual(["command", "\\label"]);
    expect(t[t.length - 1]).toEqual(["command", "\\foo"]);
  });

  it("handles \\begin{env} and math environments across lines", () => {
    const t = tokens("\\begin{equation}\na+\\alpha\n\\end{equation} x");
    expect(t[0]).toEqual(["mathDelimiter", "\\begin"]);
    expect(t).toContainEqual(["environmentName", "equation"]);
    expect(t).toContainEqual(["math", "a+"]);
    expect(t).toContainEqual(["mathCommand", "\\alpha"]);
    expect(t.filter((x) => x[0] === "mathDelimiter").map((x) => x[1])).toEqual(["\\begin", "\\end"]);
  });

  it("tracks inline and display math, comments and magic comments", () => {
    const t = tokens("% !TEX root = main.tex\n$x^2$ and \\[ \\frac{a}{b} \\] % note");
    expect(t[0]).toEqual(["magicComment", "% !TEX root = main.tex"]);
    expect(t).toContainEqual(["specialCharacter", "^"]);
    expect(t).toContainEqual(["mathCommand", "\\frac"]);
    expect(t[t.length - 1]).toEqual(["comment", "% note"]);
    expect(t.some(([k, s]) => k === "math" && s.includes("and"))).toBe(false);
  });

  it("reference arguments after optional brackets, and verbatim", () => {
    const t = tokens("\\usepackage[utf8]{inputenc}\n\\verb|\\x{| \\url{a%b}\n\\begin{verbatim}\n\\foo $\n\\end{verbatim}");
    expect(t).toContainEqual(["bracket", "["]);
    expect(t).toContainEqual(["referenceArgument", "inputenc"]);
    expect(t).toContainEqual(["verbatim", "|\\x{|"]);
    expect(t).toContainEqual(["verbatim", "a%b"]);
    expect(t).toContainEqual(["verbatim", "\\foo $"]);
    expect(t[t.length - 1]).toEqual(["brace", "}"]);
  });

  it("a blank line ends inline math", () => {
    const t = tokens("$a\n\nb");
    expect(t.some(([k, s]) => k === "math" && s === "b")).toBe(false);
  });
});

describe("snippets", () => {
  it("parses stops, defaults with braces, mirrors and final", () => {
    const s = parseSnippet("\\begin{${1:itemize}}\n\t\\item ${2:\\textbf{x}}$0\n\\end{$1}");
    expect(s.text).toBe("\\begin{itemize}\n\t\\item \\textbf{x}\n\\end{itemize}");
    expect(s.stops.map((r) => s.text.slice(r.from, r.to))).toEqual(["itemize", "\\textbf{x}"]);
    expect(s.mirrors[0]!.map((r) => s.text.slice(r.from, r.to))).toEqual(["itemize"]);
    expect(s.final).toBe(s.text.indexOf("\n\\end"));
    expect(parseSnippet("\\$ $x").text).toBe("\\$ $x");
  });
  it("expands indentation", () => {
    const e = expandSnippet(parseSnippet("a{\n\t${1:b}\n}"), "  ", "  ");
    expect(e.text).toBe("a{\n    b\n  }");
    expect(e.text.slice(e.stops[0]!.from, e.stops[0]!.to)).toBe("b");
  });
});

describe("scanning", () => {
  it("environment at end of head", () => {
    expect(environmentOpenedAtEndOf("  \\begin{tabular}{cc}")).toBe("tabular");
    expect(environmentOpenedAtEndOf("% \\begin{x}")).toBeNull();
  });
  it("completion triggers", () => {
    expect(commandPrefixStart("a \\sec", 6)).toBe(2);
    expect(commandPrefixStart("a \\", 3)).toBe(-1);
    expect(isInCommandArgument("\\ref{eq:", 8)).toBe(true);
    expect(isInCommandArgument("{eq:", 4)).toBe(false);
    expect(enclosingArgument("\\cref[x]{a,b}", 11)?.command).toBe("cref");
  });
  it("math detection", () => {
    const doc = "text $a + b$ more";
    const state = EditorState.create({ doc, extensions: latexLanguage });
    expect(isMathAt(state, doc.indexOf("+"))).toBe(true);
    expect(isMathAt(state, doc.indexOf("more"))).toBe(false);
  });
  it("diagnostic ranges and navigation targets", () => {
    const state = EditorState.create({ doc: "x\n  \\foo bar  \n\\input{chap/one} \\ref{a, b}" });
    expect(diagnosticRange({ severity: "error", message: "", path: "", line: 2, source: "latex" }, state.doc))
      .toEqual([4, 12]);
    expect(diagnosticRange({ severity: "error", message: "", path: "", line: 2, column: 3, source: "latex" }, state.doc))
      .toEqual([4, 8]);
    const l3 = state.doc.line(3).from;
    expect(includeTargetAt(state, l3 + 9)).toBe("chap/one");
    expect(labelKeyAt(state, l3 + state.doc.line(3).text.indexOf("b}"))).toBe("b");
  });
});

describe("math symbol drop caret field", () => {
  it("clamps coordinates and updates drop decoration on setDropPosEffect", () => {
    expect(clampDropPos(-5, 10)).toBe(0);
    expect(clampDropPos(25, 10)).toBe(10);
    expect(clampDropPos(4.8, 10)).toBe(4);

    let state = EditorState.create({ doc: "alpha + beta", extensions: dropPosField });
    expect(state.field(dropPosField).size).toBe(0);

    state = state.update({ effects: setDropPosEffect.of(6) }).state;
    expect(state.field(dropPosField).size).toBe(1);
    const iter = state.field(dropPosField).iter();
    expect(iter.from).toBe(6);

    state = state.update({ effects: setDropPosEffect.of(999) }).state;
    expect(state.field(dropPosField).iter().from).toBe(12);

    state = state.update({ effects: setDropPosEffect.of(null) }).state;
    expect(state.field(dropPosField).size).toBe(0);
  });
});

describe("math mode detection and auto-wrapping", () => {
  it("detects inline, display, environment, nested \\text, comments, escapes, and verbatim", () => {
    expect(isInMathMode("plain text", 5)).toBe(false);
    expect(isInMathMode("a $x + y$ b", 1)).toBe(false);
    expect(isInMathMode("a $x + y$ b", 5)).toBe(true);
    expect(isInMathMode("a $x + y$ b", 11)).toBe(false);
    expect(isInMathMode("$$", 1)).toBe(true);
    expect(isInMathMode("$$x$$", 3)).toBe(true);
    expect(isInMathMode("$$x$$ ", 6)).toBe(false);
    expect(isInMathMode("See \\(a\\) and \\[b\\]", 7)).toBe(true);
    expect(isInMathMode("See \\(a\\) and \\[b\\]", 16)).toBe(true);
    expect(isInMathMode("See \\(a\\) and \\[b\\]", 11)).toBe(false);

    const eqDoc = "\\begin{align*}\n  x = 1\n\\end{align*}\ntext";
    expect(isInMathMode(eqDoc, eqDoc.indexOf("x = 1"))).toBe(true);
    expect(isInMathMode(eqDoc, eqDoc.indexOf("text"))).toBe(false);

    const nestedText = "$a + \\text{hi $x$ there} + b$";
    expect(isInMathMode(nestedText, nestedText.indexOf("hi "))).toBe(false);
    expect(isInMathMode(nestedText, nestedText.indexOf("$x$") + 1)).toBe(true);
    expect(isInMathMode(nestedText, nestedText.indexOf("+ b"))).toBe(true);

    expect(isInMathMode("Cost \\$5 and % $not math\nplain", 29)).toBe(false);
    expect(isInMathMode("\\begin{verbatim}$x$\\end{verbatim} tail", 18)).toBe(false);
    expect(isInMathMode("$a\n\nb", 4)).toBe(false);
  });

  it("wraps symbols outside math mode and merges consecutively without creating $$", () => {
    expect(prepareMathSymbolInsertion("Hello world", 6, 6, "\\alpha")).toEqual({
      from: 6, to: 6, text: "$\\alpha$", moveAfterClosingDollar: false,
    });

    expect(prepareMathSymbolInsertion("Matrix:\n", 8, 8, "\\begin{pmatrix}\n  ${1}\n\\end{pmatrix}")).toEqual({
      from: 8, to: 8, text: "\\[\n\\begin{pmatrix}\n  ${1}\n\\end{pmatrix}\n\\]", moveAfterClosingDollar: false,
    });

    // Inside existing math -> raw snippet
    expect(prepareMathSymbolInsertion("See $a + b$", 7, 7, "\\beta")).toEqual({
      from: 7, to: 7, text: "\\beta", moveAfterClosingDollar: false,
    });

    // Immediately after closing single `$` -> merges inside and steps past `$`
    expect(prepareMathSymbolInsertion("Hello $\\alpha$world", 14, 14, "\\beta")).toEqual({
      from: 13, to: 13, text: "\\beta", moveAfterClosingDollar: true,
    });

    // Immediately before opening single `$` -> merges inside
    expect(prepareMathSymbolInsertion("Hello $\\alpha$", 6, 6, "\\beta")).toEqual({
      from: 7, to: 7, text: "\\beta", moveAfterClosingDollar: false,
    });

    // Adjacent to closing `$$` -> does NOT merge as inline; starts a new `$...$`
    expect(prepareMathSymbolInsertion("$$x$$ ", 5, 5, "\\alpha")).toEqual({
      from: 5, to: 5, text: "$\\alpha$", moveAfterClosingDollar: false,
    });
  });

  it("detects and plans package auto-imports without duplicating or touching fragments", () => {
    const doc = "\\documentclass{article}\n\\usepackage{amsmath, graphicx}\n\\begin{document}\nHi\n\\end{document}";
    expect(hasPackageImport(doc, "amsmath")).toBe(true);
    expect(hasPackageImport(doc, "graphicx")).toBe(true);
    expect(hasPackageImport(doc, "amssymb")).toBe(false);
    expect(planPackageImport(doc, "amsmath")).toBeNull();

    expect(hasPackageImport("\\usepackage{mathtools}\n\\begin{document}", "amsmath")).toBe(true);
    expect(hasPackageImport("\\usepackage{amssymb}\n\\begin{document}", "amsfonts")).toBe(true);

    const planAfterUse = planPackageImport(doc, "amssymb");
    expect(planAfterUse).toEqual({
      offset: "\\documentclass{article}\n\\usepackage{amsmath, graphicx}\n".length,
      text: "\\usepackage{amssymb}\n",
    });

    const docOnlyClass = "\\documentclass[11pt]{article}\n\\begin{document}\n\\end{document}";
    expect(planPackageImport(docOnlyClass, "eurosym")).toEqual({
      offset: "\\documentclass[11pt]{article}\n".length,
      text: "\\usepackage{eurosym}\n",
    });

    // Fragment without preamble returns null
    expect(planPackageImport("\\section{Intro}\nHello", "amssymb")).toBeNull();
  });

  it("handles paired delimiter deletion and \\begin auto-close", () => {
    // Brackets (empty & non-empty + command brace guard)
    expect(findPairedDeletion("{}", 1, "backward")).toEqual({ ranges: [{ from: 0, to: 2 }], caret: 0 });
    expect(findPairedDeletion("()", 2, "backward")).toEqual({ ranges: [{ from: 0, to: 2 }], caret: 0 });
    expect(findPairedDeletion("[]", 0, "forward")).toEqual({ ranges: [{ from: 0, to: 2 }], caret: 0 });
    expect(findPairedDeletion("{abc}", 5, "backward")).toEqual({
      ranges: [{ from: 0, to: 1 }, { from: 4, to: 5 }],
      caret: 3,
    });
    expect(findPairedDeletion("(a+b)", 0, "forward")).toEqual({
      ranges: [{ from: 0, to: 1 }, { from: 4, to: 5 }],
      caret: 0,
    });
    expect(findPairedDeletion("\\section{Intro}", 15, "backward")).toBeNull();

    // Math `$...$`, `$$...$$`, `\(...\)`, `\[...\]`
    expect(findPairedDeletion("$x$", 3, "backward")).toEqual({
      ranges: [{ from: 0, to: 1 }, { from: 2, to: 3 }],
      caret: 1,
    });
    expect(findPairedDeletion("$$", 1, "backward")).toEqual({ ranges: [{ from: 0, to: 2 }], caret: 0 });
    expect(findPairedDeletion("\\(x\\)", 2, "backward")).toEqual({
      ranges: [{ from: 0, to: 2 }, { from: 3, to: 5 }],
      caret: 0,
    });
    expect(findPairedDeletion("\\[x\\]", 0, "forward")).toEqual({
      ranges: [{ from: 0, to: 2 }, { from: 3, to: 5 }],
      caret: 0,
    });

    // Environments (empty vs non-empty)
    const emptyEnv = "\\begin{equation}\n  \n\\end{equation}";
    expect(findPairedDeletion(emptyEnv, 16, "backward")).toEqual({
      ranges: [{ from: 0, to: emptyEnv.length }],
      caret: 0,
    });
    const fullEnv = "\\begin{equation}\n  x = 1\n\\end{equation}";
    const delFull = findPairedDeletion(fullEnv, 0, "forward");
    expect(delFull).toEqual({
      ranges: [
        { from: 0, to: "\\begin{equation}\n".length },
        { from: "\\begin{equation}\n  x = 1".length, to: fullEnv.length },
      ],
      caret: 0,
    });

    // Immediate \begin{env} close on }
    const opened = findBeginAutoClose("  \\begin{align}", 15, "  ");
    expect(opened).toEqual({
      insert: "\n    \n  \\end{align}",
      caretOffset: 5,
    });
    expect(findBeginAutoClose("\\begin{align}\n\\end{align}", 13, "  ")).toBeNull();
  });

  it("handles v1.1.2 regressions: balanced $$ below, command args, \\left/\\right, \\alpha space, single/multi-line preamble, atomic undo & autoClosers eviction", () => {
    // 1. Empty $|$ and |$$ with balanced $$...$$ later in document
    const docWithDisplayBelow = "Hello $$\n\n$$\na^2+b^2=c^2\n$$";
    expect(findPairedDeletion(docWithDisplayBelow, 7, "backward")).toEqual({
      ranges: [{ from: 6, to: 8 }],
      caret: 6,
    });
    expect(findPairedDeletion(docWithDisplayBelow, 6, "forward")).toEqual({
      ranges: [{ from: 6, to: 8 }],
      caret: 6,
    });
    // Still pairs when unmatched closing $$ follows (display equation itself)
    expect(findPairedDeletion("$$x + y$$", 0, "forward")).toEqual({
      ranges: [{ from: 0, to: 2 }, { from: 7, to: 9 }],
      caret: 0,
    });

    // 2. findForwardUnescapedSingleDollar skips $$
    expect(findPairedDeletion("$x + $$y$$$", 0, "forward")).toEqual({
      ranges: [{ from: 0, to: 1 }, { from: 10, to: 11 }],
      caret: 0,
    });

    // 3. Optional/multi-argument command braces, \\\section{}, and \left(...\right) are preserved
    expect(findPairedDeletion("\\usepackage[T1]{fontenc}", 24, "backward")).toBeNull();
    expect(findPairedDeletion("\\sqrt[3]{x}", 11, "backward")).toBeNull();
    expect(findPairedDeletion("\\frac{a}{b}", 11, "backward")).toBeNull();
    expect(findPairedDeletion("\\begin{tabular}{cc}", 19, "backward")).toBeNull();
    expect(findPairedDeletion("\\\\\\section{Intro}", 17, "backward")).toBeNull();
    expect(findPairedDeletion("\\left( x \\right)", 5, "backward")).toBeNull();
    expect(findPairedDeletion("\\left( x \\right)", 15, "backward")).toBeNull();
    expect(findPairedDeletion("\\left( x \\right)", 5, "forward")).toBeNull();

    // 4. Stepping inside opening $ adds separating space before letters when snippet ends with command letters
    expect(prepareMathSymbolInsertion("Hello $x$", 6, 6, "\\alpha")).toEqual({
      from: 7,
      to: 7,
      text: "\\alpha ",
      moveAfterClosingDollar: false,
    });

    // 5. Same-line \documentclass...\begin{document}, multi-line \usepackage, and invalid package names
    expect(planPackageImport("\\documentclass{article}\\begin{document}", "amssymb")).toEqual({
      offset: "\\documentclass{article}".length,
      text: "\n\\usepackage{amssymb}\n",
    });
    const multilinePkg = "\\documentclass{article}\n\\usepackage[\n  T1\n]{fontenc}\n\\begin{document}";
    expect(hasPackageImport(multilinePkg, "fontenc")).toBe(true);
    expect(hasPackageImport(multilinePkg, "amsmath}\n\\input{evil}%")).toBe(false);
    expect(planPackageImport(multilinePkg, "amsmath}\n\\input{evil}%")).toBeNull();

    // 6. Atomic single-step Undo for preamble + snippet & MapMode.TrackDel eviction in autoClosers
    let st2 = EditorState.create({
      doc: "\\textbf{}",
      selection: { anchor: 8 },
      extensions: [history(), autoClosers, autoPairInput],
    });
    const view2 = {
      get state() { return st2; },
      composing: false,
      dispatch(spec: Parameters<EditorState["update"]>[0]) { st2 = st2.update(spec).state; },
    } as unknown as EditorView;
    const inputHandlers = st2.facet(EditorView.inputHandler);
    expect(inputHandlers.length).toBeGreaterThan(0);
    // Simulate typing `{` inside `\textbf{|}` -> `\textbf{{|}}` with closer tracked at index 9
    expect(inputHandlers[0]!(view2, 8, 8, "{", () => { throw new Error("unused"); })).toBe(true);
    expect(st2.doc.toString()).toBe("\\textbf{{}}");
    expect(st2.field(autoClosers)).toEqual([9]);
    // Backspace deletes `{}` leaving `\textbf{|}`; autoClosers must NOT retain offset 8 (preexisting `}`)
    expect(smartBackspace(view2)).toBe(true);
    expect(st2.doc.toString()).toBe("\\textbf{}");
    expect(st2.field(autoClosers)).toEqual([]);
    // Typing `}` must now insert `}` normally instead of skipping over the outer preexisting `}`
    expect(inputHandlers[0]!(view2, 8, 8, "}", () => { throw new Error("unused"); })).toBe(false);

    // Same for smartDelete inside `\textbf{{|}}`
    let stDel = EditorState.create({
      doc: "\\textbf{}",
      selection: { anchor: 8 },
      extensions: [history(), autoClosers, autoPairInput],
    });
    const viewDel = {
      get state() { return stDel; },
      composing: false,
      dispatch(spec: Parameters<EditorState["update"]>[0]) { stDel = stDel.update(spec).state; },
    } as unknown as EditorView;
    expect(stDel.facet(EditorView.inputHandler)[0]!(viewDel, 8, 8, "{", () => { throw new Error("unused"); })).toBe(true);
    stDel = stDel.update({ selection: { anchor: 8 } }).state;
    expect(smartDelete(viewDel)).toBe(true);
    expect(stDel.doc.toString()).toBe("\\textbf{}");
    expect(stDel.field(autoClosers)).toEqual([]);

    // Single-transaction insertSnippetAt + one-step Undo
    let st3 = EditorState.create({
      doc: "\\documentclass{article}\n\\begin{document}\nhi\n\\end{document}",
      extensions: [history(), snippets()],
    });
    const view3 = {
      get state() { return st3; },
      dispatch(spec: Parameters<EditorState["update"]>[0]) { st3 = st3.update(spec).state; },
    } as unknown as EditorView;
    const docText = st3.doc.toString();
    const hiPos = docText.indexOf("hi");
    const pkgPlan = planPackageImport(docText, "amssymb")!;
    const mathPlan = prepareMathSymbolInsertion(docText, hiPos, hiPos, "\\mathbb{R}");
    insertSnippetAt(view3, mathPlan.text, mathPlan.from, mathPlan.to, "  ", {
      preambleChange: { from: pkgPlan.offset, to: pkgPlan.offset, insert: pkgPlan.text },
      moveAfterClosingDollar: mathPlan.moveAfterClosingDollar,
    });
    expect(st3.doc.toString()).toContain("\\usepackage{amssymb}");
    expect(st3.doc.toString()).toContain("$\\mathbb{R}$hi");
    expect(undo(view3)).toBe(true);
    expect(st3.doc.toString()).toBe("\\documentclass{article}\n\\begin{document}\nhi\n\\end{document}");
  });
});
