const RESOURCE_FETCH_TIMEOUT_MS = 120_000;

/** Validate a downloaded resource and return a fresh, readable Response. */
export async function verifiedTectonicResponse(response, url, expectedSha256) {
  if (!response.ok) {
    throw new Error(`Could not download ${url} (HTTP ${response.status}).`);
  }

  const bytes = await response.arrayBuffer();
  if (expectedSha256) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const actual = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
    if (actual !== expectedSha256.toLowerCase()) {
      const error = new Error(`Integrity check failed for ${url}.`);
      error.integrityFailure = true;
      throw error;
    }
  }

  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function isIntegrityFailure(error) {
  return error instanceof Error && error.integrityFailure === true;
}

/** Fetch a pinned resource, with an abortable timeout and verified mirror fallback. */
export async function fetchTectonicResource(
  primaryUrl,
  fallbackUrl,
  expectedSha256,
  fetcher = fetch,
  timeoutMs = RESOURCE_FETCH_TIMEOUT_MS,
) {
  const readUrl = async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(url, { signal: controller.signal });
      return await verifiedTectonicResponse(response, url, expectedSha256);
    } finally {
      clearTimeout(timer);
    }
  };

  let primaryError;
  try {
    return await readUrl(primaryUrl);
  } catch (error) {
    if (isIntegrityFailure(error)) throw error;
    primaryError = error;
  }

  if (fallbackUrl && fallbackUrl !== primaryUrl) {
    try {
      return await readUrl(fallbackUrl);
    } catch (fallbackError) {
      if (isIntegrityFailure(fallbackError)) throw fallbackError;
      throw new Error(
        `Could not download Tectonic resource from either mirror (${primaryUrl}; ${fallbackUrl}). ` +
        `Primary error: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}; ` +
        `fallback error: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
      );
    }
  }

  throw primaryError;
}
