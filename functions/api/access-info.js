// Setup-only diagnostic. Does not expose JWTs, cookies, emails or any secrets.
// The claims are decoded for display, NOT used as proof of authentication.
export async function onRequestGet({ request }) {
  const json = (data, status = 200) => new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
  });
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion") || "";
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    return json({ message: "没有收到 Cloudflare Access 的登录凭证，请先通过小手机的 Access 登录，再打开本页。" }, 401);
  }
  try {
    const raw = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = raw.padEnd(Math.ceil(raw.length / 4) * 4, "=");
    const payload = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(padded), c => c.charCodeAt(0))));
    const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
    const iss = String(payload.iss || "");
    if (typeof aud !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(aud) ||
      !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com\/?$/i.test(iss)) {
      return json({ message: "登录凭证中没有可识别的 Cloudflare Access 应用标识。" }, 422);
    }
    return json({
      CF_ACCESS_AUD: aud,
      CF_ACCESS_TEAM_DOMAIN: new URL(iss).hostname,
      note: "仅供填写 Cloudflare 环境变量；这些是尚未验证签名的令牌声明，不可用于身份认证。请勿分享完整 JWT 或登录 Cookie。"
    });
  } catch {
    return json({ message: "无法读取 Cloudflare Access 登录凭证。" }, 422);
  }
}
