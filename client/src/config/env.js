const DEFAULT_API_URL =
  "https://tourist-safery-system-production.up.railway.app";

function stripWrappingQuotes(value = "") {
  return String(value)
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

function normalizeApiBaseUrl(input) {
  const raw = stripWrappingQuotes(input);
  if (!raw) return DEFAULT_API_URL;

  let candidate = raw;

  // Handle accidental protocol-less values like:
  // "tourist-safery-system-production.up.railway.app"
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    const isLocalhost =
      /^localhost(?::\d+)?(?:\/|$)/i.test(candidate) ||
      /^127\.0\.0\.1(?::\d+)?(?:\/|$)/.test(candidate);

    candidate = `${isLocalhost ? "http" : "https"}://${candidate}`;
  }

  try {
    const url = new URL(candidate);

    // If someone mistakenly sets an endpoint as base URL, strip known endpoint tails.
    const cleanedPath = url.pathname
      .replace(
        /\/+(auth\/login|auth\/register|api\/check-username|me|my-card)$/i,
        "",
      )
      .replace(/\/+$/, "");

    const base = `${url.origin}${cleanedPath}`;
    return base || DEFAULT_API_URL;
  } catch {
    return DEFAULT_API_URL;
  }
}

export const API_URL = normalizeApiBaseUrl(import.meta.env.VITE_API_URL);

export const CONTRACT_ADDRESS = stripWrappingQuotes(
  import.meta.env.VITE_CONTRACT_ADDRESS ||
    "0x69CF417682ADA3b9caa92637B7C0a877D43dbcF9",
);

export function toApiUrl(path = "") {
  if (!path) return API_URL;

  const incoming = String(path).trim();
  if (!incoming) return API_URL;

  // Already absolute URL
  if (/^https?:\/\//i.test(incoming)) return incoming;

  const normalizedPath = incoming.startsWith("/") ? incoming : `/${incoming}`;
  return `${API_URL}${normalizedPath}`;
}
