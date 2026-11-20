import { describe, expect, it } from "vitest";
import { MATH_SYMBOL_CATEGORIES, filterMathSymbols, insertionTextForSymbol } from "./mathSymbols";

describe("mathSymbols catalog", () => {
  it("contains all 14 categories with valid unique codes", () => {
    expect(MATH_SYMBOL_CATEGORIES).toHaveLength(14);
    const total = MATH_SYMBOL_CATEGORIES.reduce((sum, c) => sum + c.symbols.length, 0);
    expect(total).toBeGreaterThanOrEqual(350);
    for (const cat of MATH_SYMBOL_CATEGORIES) {
      expect(cat.symbols.length).toBeGreaterThan(0);
      for (const sym of cat.symbols) {
        expect(sym.display.length).toBeGreaterThan(0);
        expect(sym.code.length).toBeGreaterThan(0);
        expect(sym.name.length).toBeGreaterThan(0);
      }
    }
  });

  it("filters symbols by LaTeX code, English name, package, or translated category", () => {
    const fracHits = filterMathSymbols("\\frac");
    expect(fracHits.some((c) => c.id === "structures" && c.symbols.some((s) => s.code === "\\frac{}{}"))).toBe(true);

    const amssymbHits = filterMathSymbols("amssymb");
    expect(amssymbHits.length).toBeGreaterThan(2);
    for (const cat of amssymbHits) {
      expect(cat.symbols.every((s) => s.pkg === "amssymb")).toBe(true);
    }

    const ptHits = filterMathSymbols("gregas", (k) =>
      k === "Greek Lowercase" ? "Gregas Minúsculas" : k === "Greek Uppercase" ? "Gregas Maiúsculas" : k,
    );
    expect(ptHits.map((c) => c.id)).toEqual(["greekLower", "greekUpper"]);
  });

  it("returns snippet templates when defined and raw code otherwise", () => {
    const alpha = MATH_SYMBOL_CATEGORIES.find((c) => c.id === "greekLower")!.symbols.find((s) => s.code === "\\alpha")!;
    const frac = MATH_SYMBOL_CATEGORIES.find((c) => c.id === "structures")!.symbols.find((s) => s.code === "\\frac{}{}")!;
    expect(insertionTextForSymbol(alpha)).toBe("\\alpha");
    expect(insertionTextForSymbol(frac)).toBe("\\frac{${1}}{${2}}");
  });
});
