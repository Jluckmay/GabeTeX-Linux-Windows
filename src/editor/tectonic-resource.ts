/** Validate a downloaded resource and return a fresh, readable Response. */
export async function verifiedTectonicResponse(
  response: Response,
  url: string,
  expectedSha256?: string,
): Promise<Response> {
  if (!response.ok) {
    throw new Error(`Could not download ${url} (HTTP ${response.status}).`);
  }

  const bytes = await response.arrayBuffer();
  if (expectedSha256) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const actual = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
      const error = new Error(`Integrity check failed for ${url}: hash mismatch.`);
      Object.assign(error, { integrityFailure: true });
      throw error;
    }
  }

  return new Response(bytes, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}
