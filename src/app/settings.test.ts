import { describe, expect, it, beforeAll } from "vitest";

beforeAll(() => {
  if (typeof window === "undefined") {
    (globalThis as unknown as { window: unknown }).window = globalThis;
  }
});

import { settings, DEFAULTS } from "./settings";

describe("settings store - autoSave", () => {
  it("has correct defaults for autoSave and autoSaveInterval", () => {
    expect(DEFAULTS.autoSave).toBe(false);
    expect(DEFAULTS.autoSaveInterval).toBe(30);
    expect(settings.get("autoSave")).toBe(false);
    expect(settings.get("autoSaveInterval")).toBe(30);
  });

  it("updates and notifies on autoSave change", () => {
    let notifiedKey = "";
    const unsub = settings.subscribe((k) => {
      notifiedKey = k;
    });

    settings.set("autoSave", true);
    expect(settings.get("autoSave")).toBe(true);
    expect(notifiedKey).toBe("autoSave");

    settings.set("autoSaveInterval", 60);
    expect(settings.get("autoSaveInterval")).toBe(60);
    expect(notifiedKey).toBe("autoSaveInterval");

    // reset
    settings.set("autoSave", false);
    settings.set("autoSaveInterval", 30);
    unsub();
  });
});
