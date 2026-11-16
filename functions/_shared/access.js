// Access validation used for private cloud synchronization.
// Every read and write requires a signed Cloudflare Access assertion.
function base64url(part) {
  const raw = part.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(raw.padEnd(Math.ceil(raw.length / 4) * 4, "=")), c => c.charCodeAt(0));
}

// A Pages Function may receive the signed Access JWT either as the
// Cloudflare-injected header or the browser's CF_Authorization cookie.
// Both forms MUST pass the same signature, expiry and audience checks.
export function getAccessJwt(request) {
  const header = String(request.headers.get("Cf-Access-Jwt-Assertion") || "").trim();
  if (header) return { token: header, source: "header" };
  const cookies = String(request.headers.get("Cookie") || "").split(";");
  const accessCookie = cookies.find(part => part.trim().startsWith("CF_Authorization="));
  if (accessCookie) {
    const raw = accessCookie.trim().slice("CF_Authorization=".length);
    let value = raw;
    try { value = decodeURIComponent(raw); } catch { /* Invalid cookie fails verification. */ }
    return { token: value, source: "cookie" };
  }
  return { token: "", source: "none" };
}

export async function accessIdentity(request, env) {
  // Never expose private backups through preview or alternate domains.
  if (new URL(request.url).hostname.toLowerCase() !== "small-cloud-2zs.pages.dev") return null;
  const { token } = getAccessJwt(request);
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(base64url(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(base64url(parts[1])));
    const issuer = String(payload.iss || "").replace(/\/$/, "");
    const issuerUrl = new URL(issuer);
    if (issuerUrl.protocol !== "https:" || issuerUrl.pathname !== "/" ||
        issuerUrl.search || issuerUrl.hash || issuerUrl.port ||
        issuerUrl.username || issuerUrl.password ||
        !/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(issuerUrl.hostname)) return null;

    const configuredTeam = String(env.CF_ACCESS_TEAM_DOMAIN || "").trim()
      .replace(/^https:\/\//i, "").replace(/\/$/, "").toLowerCase();
    if (configuredTeam && configuredTeam !== issuerUrl.hostname.toLowerCase()) return null;

    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.length || !auds.every(a =>
        typeof a === "string" && /^[a-f0-9]{32,64}$/i.test(a))) return null;
    if (env.CF_ACCESS_AUD && !auds.includes(env.CF_ACCESS_AUD)) return null;
    const now = Date.now() / 1000;
    if (header.alg !== "RS256" || typeof header.kid !== "string" ||
        !Number.isFinite(payload.exp) || payload.exp <= now ||
        (payload.nbf && payload.nbf > now) ||
        (payload.iat && payload.iat > now + 30)) return null;
    const certs = await fetch(issuer + "/cdn-cgi/access/certs");
    if (!certs.ok) return null;
    const keys = (await certs.json()).keys || [];
    const jwk = keys.find(k => k.kid === header.kid && k.kty === "RSA");
    if (!jwk) return null;
    const publicKey = await crypto.subtle.importKey("jwk", jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey,
      base64url(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
    if (!valid) return null;
    // Email OTP sign-ins on different phones resolve to the same account.
    const principal = typeof payload.email === "string" && payload.email.includes("@")
      ? "email:" + payload.email.trim().toLowerCase()
      : typeof payload.sub === "string" && payload.sub.length > 5
        ? "sub:" + payload.sub
        : null;
    if (!principal) return null;
    const digest = await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode(issuer + "|" + principal));
    const owner = Array.from(new Uint8Array(digest),
      b => b.toString(16).padStart(2, "0")).join("");
    return { owner };
  } catch {
    return null;
  }
}
