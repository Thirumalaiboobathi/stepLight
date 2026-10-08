/** Second-level labels that act like public suffixes (e.g. `co.uk`). Not exhaustive. */
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "co.in", "net.in", "org.in", "co.jp", "co.nz",
  "com.au", "net.au", "org.au", "com.br", "com.cn", "com.mx", "com.sg", "co.za", "com.tr",
]);

function isIpOrLocal(host: string): boolean {
  return host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

/**
 * Registrable domain ("site") of a URL, e.g. `shop.example.co.uk` → `example.co.uk`.
 * For localhost and IP addresses the port is included, so different local ports
 * count as different sites. Returns undefined for non-http(s) or invalid URLs.
 * @example registrableDomain("https://a.b.example.com/x") // "example.com"
 */
export function registrableDomain(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIpOrLocal(host)) return parsed.port ? `${host}:${parsed.port}` : host;
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

/**
 * True when both URLs resolve to known, different registrable domains.
 * @example isCrossSite("https://a.com", "https://b.com") // true
 */
export function isCrossSite(fromUrl: string | undefined, toUrl: string | undefined): boolean {
  const a = registrableDomain(fromUrl);
  const b = registrableDomain(toUrl);
  return a !== undefined && b !== undefined && a !== b;
}
