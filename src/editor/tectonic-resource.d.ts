export function verifiedTectonicResponse(
  response: Response,
  url: string,
  expectedSha256?: string,
): Promise<Response>;

export function fetchTectonicResource(
  primaryUrl: string,
  fallbackUrl: string | null,
  expectedSha256?: string,
  fetcher?: typeof fetch,
  timeoutMs?: number,
): Promise<Response>;
