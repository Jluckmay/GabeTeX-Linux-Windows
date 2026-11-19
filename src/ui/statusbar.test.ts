import { beforeAll, describe, expect, it } from "vitest";

let compileAnnouncement: typeof import("./statusbar").compileAnnouncement;

beforeAll(async () => {
  if (typeof window === "undefined") {
    (globalThis as unknown as { window: unknown }).window = globalThis;
  }
  ({ compileAnnouncement } = await import("./statusbar"));
});

describe("statusbar compile announcements", () => {
  const counts = "2 errors, 1 warnings";

  it("ignores idle and compiling states", () => {
    expect(compileAnnouncement({ state: { kind: "idle" }, purpose: "build", prevOutcome: null, summaryText: "Ready", countsText: counts })).toBeNull();
    expect(compileAnnouncement({ state: { kind: "compiling", purpose: "build" }, purpose: "build", prevOutcome: "succeeded", summaryText: "Compiling…", countsText: counts })).toBeNull();
  });

  it("always announces explicit builds", () => {
    expect(compileAnnouncement({ state: { kind: "succeeded" }, purpose: "build", prevOutcome: "succeeded", summaryText: "Compiled in 0.4 s", countsText: "0 errors, 0 warnings" }))
      .toBe("Compiled in 0.4 s (0 errors, 0 warnings)");
    expect(compileAnnouncement({ state: { kind: "failed" }, purpose: "build", prevOutcome: "failed", summaryText: "Compiled with errors", countsText: counts }))
      .toBe("Compiled with errors (2 errors, 1 warnings)");
    expect(compileAnnouncement({ state: { kind: "toolError", message: "No TeX distribution" }, purpose: "build", prevOutcome: "toolError", summaryText: "Cannot compile", countsText: counts }))
      .toBe("No TeX distribution");
  });

  it("suppresses repetitive live-compile success and speaks only on outcome transitions", () => {
    expect(compileAnnouncement({ state: { kind: "succeeded" }, purpose: "live", prevOutcome: null, summaryText: "Compiled in 0.2 s", countsText: "0 errors, 0 warnings" })).toBeNull();
    expect(compileAnnouncement({ state: { kind: "succeeded" }, purpose: "live", prevOutcome: "succeeded", summaryText: "Compiled in 0.2 s", countsText: "0 errors, 0 warnings" })).toBeNull();
    expect(compileAnnouncement({ state: { kind: "failed" }, purpose: "live", prevOutcome: "succeeded", summaryText: "Compiled with errors", countsText: counts }))
      .toBe("Compiled with errors (2 errors, 1 warnings)");
    expect(compileAnnouncement({ state: { kind: "failed" }, purpose: "live", prevOutcome: "failed", summaryText: "Compiled with errors", countsText: counts })).toBeNull();
    expect(compileAnnouncement({ state: { kind: "succeeded" }, purpose: "live", prevOutcome: "failed", summaryText: "Compiled in 0.3 s", countsText: "0 errors, 0 warnings" }))
      .toBe("Compiled in 0.3 s (0 errors, 0 warnings)");
    expect(compileAnnouncement({ state: { kind: "toolError", message: "pdflatex failed" }, purpose: "live", prevOutcome: "succeeded", summaryText: "Cannot compile", countsText: counts }))
      .toBe("pdflatex failed");
  });
});
