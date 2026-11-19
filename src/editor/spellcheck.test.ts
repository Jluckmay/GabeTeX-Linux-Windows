import { describe, expect, it } from "vitest";
import { extractTexWords } from "./spellcheck";

describe("extractTexWords", () => {
  it("preserves prose after escaped percent and dollar signs", () => {
    const tex = "Growth was 50\\% faster and cost \\$100 today.";
    const words = extractTexWords(tex).map((w) => w.word);
    expect(words).toEqual(["Growth", "was", "50", "faster", "and", "cost", "100", "today"]);
  });

  it("extracts prose inside sectioning and formatting commands while skipping labels and math", () => {
    const tex = [
      "\\section[Short]{Introduction to Topology}\\label{sec:intro}",
      "We study \\textbf{compact} and \\emph{connected} spaces in \\cite{munkres}.",
      "\\begin{equation}x^2 + y^2 = z^2\\end{equation}",
      "Final paragraph after equation.",
    ].join("\n");
    const words = extractTexWords(tex).map((w) => w.word);
    expect(words).toEqual([
      "Introduction",
      "to",
      "Topology",
      "We",
      "study",
      "compact",
      "and",
      "connected",
      "spaces",
      "in",
      "Final",
      "paragraph",
      "after",
      "equation",
    ]);
  });
});
