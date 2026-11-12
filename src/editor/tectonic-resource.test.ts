import { describe, expect, it } from "vitest";
import { verifiedTectonicResponse } from "./tectonic-resource";

describe("verifiedTectonicResponse", () => {
  it("returns readable bytes after consuming the original response", async () => {
    const original = new Response("wasm bytes", { status: 200 });
    const result = await verifiedTectonicResponse(original, "https://example.test/engine.wasm");

    expect(original.bodyUsed).toBe(true);
    expect(result).not.toBe(original);
    expect(await result.text()).toBe("wasm bytes");
  });

  it("checks SHA-256 before returning the resource", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("bundle"));
    const hash = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const result = await verifiedTectonicResponse(new Response("bundle"), "https://example.test/bundle", hash);

    expect(await result.text()).toBe("bundle");
    await expect(verifiedTectonicResponse(
      new Response("tampered"),
      "https://example.test/bundle",
      hash,
    )).rejects.toThrow("Integrity check failed");
  });

  it("rejects unsuccessful downloads", async () => {
    await expect(verifiedTectonicResponse(
      new Response("missing", { status: 404 }),
      "https://example.test/missing",
    )).rejects.toThrow("HTTP 404");
  });
});
