import { describe, expect, it, vi } from "vitest";
import { fetchTectonicResource, verifiedTectonicResponse } from "./tectonic-resource.js";

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

  it("uses a mirror after a primary request fails and verifies the mirror bytes", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("bundle"));
    const hash = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("primary")) throw new Error("network unavailable");
      return new Response("bundle", { status: 200 });
    });

    const result = await fetchTectonicResource(
      "https://primary.test/engine.wasm",
      "https://mirror.test/engine.wasm",
      hash,
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await result.text()).toBe("bundle");
  });

  it("does not fall back when the primary resource fails integrity validation", async () => {
    const fetcher = vi.fn(async () => new Response("tampered", { status: 200 }));

    await expect(fetchTectonicResource(
      "https://primary.test/engine.wasm",
      "https://mirror.test/engine.wasm",
      "00",
      fetcher,
    )).rejects.toThrow("Integrity check failed");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled resource request after its timeout", async () => {
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));

    await expect(fetchTectonicResource(
      "https://primary.test/engine.wasm",
      null,
      undefined,
      fetcher,
      5,
    )).rejects.toMatchObject({ name: "AbortError" });
  });
});
