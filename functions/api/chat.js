import { getAccessJwt } from "../_shared/access.js";
import { normalizeLegacyChatMessages } from "../_shared/legacyChatPayload.js";

// Optional read-only Notion memories. Credentials belong in Cloudflare Secrets.
function decodePart(part) {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")), c => c.charCodeAt(0));
}
// Verify Cloudflare Access JWTs without a manual AUD lookup.
// The fallback is restricted to the Pages production host, which MUST remain
// protected by the Cloudflare Access application at the edge. Requests from
// any other deployment hostname fail closed. Explicit AUD/team vars still pin
// identity to the configured Access application when supplied.
async function verifiedAccess(request, env) {
  const productionHost = "small-cloud-2zs.pages.dev";
  if (new URL(request.url).hostname.toLowerCase() !== productionHost) return false;
  const parts = getAccessJwt(request).token.split(".");
  if (parts.length !== 3) return false;
  try {
    const header = JSON.parse(new TextDecoder().decode(decodePart(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(decodePart(parts[1])));
    const issuer = String(payload.iss || "").replace(/\/$/, "");
    const url = new URL(issuer);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(url.hostname) ||
      url.pathname !== "/" || url.search || url.hash) return false;

    const configuredTeam = String(env.CF_ACCESS_TEAM_DOMAIN || "").trim()
      .replace(/^https:\/\//i, "").replace(/\/$/, "").toLowerCase();
    if (configuredTeam && configuredTeam !== url.hostname.toLowerCase()) return false;

    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.length || !auds.every(a => typeof a === "string" &&
      /^[a-f0-9]{32,64}$/i.test(a))) return false;
    if (env.CF_ACCESS_AUD && !auds.includes(env.CF_ACCESS_AUD)) return false;

    const now = Date.now() / 1000;
    if (header.alg !== "RS256" || !header.kid || !Number.isFinite(payload.exp) ||
      payload.exp <= now || (payload.nbf && payload.nbf > now) ||
      (payload.iat && payload.iat > now + 30)) return false;

    const response = await fetch(issuer + "/cdn-cgi/access/certs");
    if (!response.ok) return false;
    const keys = (await response.json()).keys || [];
    const jwk = keys.find(k => k.kid === header.kid && k.kty === "RSA");
    if (!jwk) return false;
    const key = await crypto.subtle.importKey("jwk", jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodePart(parts[2]),
      new TextEncoder().encode(parts[0] + "." + parts[1]));
  } catch { return false; }
}

export async function onRequestPost({ request, env }) {
  const reply = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    });

  // No-charge POST probe: verify the same Access identity required by a
  // real chat POST, but return before reading messages or calling OpenAI.
  // This deliberately accepts no messages and cannot trigger generation.
  if (new URL(request.url).searchParams.get("probe") === "1") {
    if (!(await verifiedAccess(request, env))) {
      return reply({
        ok: false, stage: "access",
        message: "聊天 POST 未通过 Cloudflare Access 身份验证"
      }, 403);
    }
    if (!env.OPENAI_API_KEY) {
      return reply({
        ok: false, stage: "configuration",
        message: "服务器未配置 OPENAI_API_KEY"
      }, 503);
    }
    return reply({
      ok: true, stage: "post",
      message: "聊天 POST 通道与 Access 身份验证正常；未调用 OpenAI 生成"
    });
  }

  if (!env.OPENAI_API_KEY) {
    return reply({ error: { message: "API Key 未配置" } }, 503);
  }

  try {
    const raw = await request.text();

    // Older Safari PWA bundles may still include uncompressed photo data.
    // Parse within a bounded limit; normalize the outbound copy below.
    if (raw.length > 10_000_000) {
      return reply({ error: { message: "单次发送的数据超过上限（10MB）。请重新加载小手机，使用新版图片压缩功能；不要清除网站数据。" } }, 413);
    }

    const body = JSON.parse(raw);

    if (!Array.isArray(body.messages) ||
        !body.messages.length ||
        !body.messages.every(m =>
          m && ["system", "user", "assistant"].includes(m.role) &&
          (typeof m.content === "string" || Array.isArray(m.content))
        )) {
      return reply({ error: { message: "消息格式错误，请检查聊天内容" } }, 400);
    }

    // The UI stores an assistant reply as several short bubbles. A normal
    // 15-turn conversation can therefore exceed 80 API messages, even with
    // a small token budget. Keep recent context rather than rejecting it.
    // Do not touch any local chat history; only trim the outbound request.
    const systemMessages = body.messages.filter(m => m.role === "system").slice(0, 2);
    const recentMessages = body.messages.filter(m => m.role !== "system").slice(-120);
    const requestMessages = [...systemMessages, ...recentMessages];

    // This paid chat endpoint always requires a verified Cloudflare Access
    // session on the production Pages host, even when Notion is not enabled.
    if (!(await verifiedAccess(request, env))) {
      return reply({ error: { message: "请先通过 Cloudflare Access 验证身份" } }, 403);
    }

    // Notion pages are imported to each device's durable cache. The client
    // chooses a small relevant excerpt before making this chat request.
    // No Notion network reads or additional prompts happen on this endpoint.
    let messages;
    try {
      messages = normalizeLegacyChatMessages(requestMessages).messages;
    } catch (error) {
      if (error.status === 413) return reply({ error: { message: error.message } }, 413);
      throw error;
    }

    // Model choice is restricted to verified IDs; never accept arbitrary expensive IDs.
    const supportedModels = new Set([
      "gpt-6-luna", "gpt-6.1-terra", "gpt-5.6-luna", "gpt-5.6-terra"
    ]);
    // Reject unknown IDs instead of silently using a different model.
    if (body.model !== undefined &&
        (typeof body.model !== "string" || !supportedModels.has(body.model))) {
      return reply({ error: { message: "选择的模型暂不支持，请检查模型设置" } }, 400);
    }
    const model = body.model || (
      supportedModels.has(env.OPENAI_MODEL) ? env.OPENAI_MODEL : "gpt-6-luna"
    );

    // Send exactly the selected reasoning effort to OpenAI.
    // Old clients that omit it keep the previous low default.
    const supportedEfforts = new Set(["low", "medium", "high"]);
    const effort = body.reasoning_effort === undefined ? "low" : body.reasoning_effort;
    if (!supportedEfforts.has(effort)) {
      return reply({ error: { message: "推理档位不正确，仅支持低、中、高" } }, 400);
    }

    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages,
          stream: body.stream === true,
          ...(body.stream === true ? { stream_options: { include_usage: true } } : {}),
          reasoning_effort: effort,
          max_completion_tokens: effort === "high" ? 8192 :
            effort === "medium" ? 6144 : 4096
        })
      }
    );

    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type":
          response.headers.get("Content-Type") || "application/json",
        "Cache-Control": "no-store",
        "X-SmallCloud-Requested-Model": model,
        "X-SmallCloud-Reasoning-Effort": effort
      }
    });
  } catch {
    return reply({ error: { message: "接口请求失败" } }, 500);
  }
}


// Read-only diagnosis. GET never creates a completion or reads local chat
// history. It only checks the same Access gate as POST, verifies that a
// server-side secret exists, and queries the OpenAI model catalog.
// Nothing sensitive is returned (no tokens, emails, conversation content,
// raw OpenAI responses or JWT claims).
export async function onRequestGet({ request, env }) {
  const json = (payload, status = 200) => Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Pragma": "no-cache"
    }
  });
  const url = new URL(request.url);
  if (url.searchParams.get("check") !== "1") {
    return json({ error: "这是聊天 API。无费用连接检测请使用 ?check=1" }, 404);
  }
  const version = "chat-health-2026-11-17-v1";
  const startedAt = Date.now();

  if (!(await verifiedAccess(request, env))) {
    return json({
      version,
      stage: "access",
      ok: false,
      message: "Cloudflare Access 登录凭证未通过聊天接口校验。请从正式小手机网页重新完成登录。"
    }, 403);
  }

  if (!env.OPENAI_API_KEY) {
    return json({
      version,
      stage: "configuration",
      ok: false,
      access: "passed",
      message: "服务器未设置 OPENAI_API_KEY"
    }, 503);
  }

  const allowedModels = [
    "gpt-6-luna", "gpt-6.1-terra", "gpt-5.6-luna", "gpt-5.6-terra"
  ];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const upstream = await fetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: { Authorization: "Bearer " + env.OPENAI_API_KEY },
      signal: controller.signal
    });
    const elapsedMs = Date.now() - startedAt;
    if (!upstream.ok) {
      const note = upstream.status === 401 ? "OpenAI API 密钥无效或已失效"
        : upstream.status === 429 ? "OpenAI 接口限制访问，请检查额度或速率限制"
        : upstream.status === 403 ? "OpenAI 拒绝访问，请检查账号或地区权限"
        : "OpenAI 模型列表接口返回状态 " + upstream.status;
      return json({
        version,
        stage: "openai",
        ok: false,
        access: "passed",
        openaiStatus: upstream.status,
        elapsedMs,
        message: note
      }, 200);
    }

    const responseBody = await upstream.json();
    const availableIds = new Set(
      Array.isArray(responseBody?.data) ? responseBody.data.map(item => item?.id) : []
    );
    const modelAvailability = Object.fromEntries(
      allowedModels.map(id => [id, availableIds.has(id)])
    );
    const visibleModelCount = allowedModels.filter(id => availableIds.has(id)).length;
    return json({
      version,
      stage: "ready",
      ok: true,
      access: "passed",
      openaiStatus: upstream.status,
      elapsedMs,
      supportedModelAvailability: modelAvailability,
      message: visibleModelCount
        ? "后台能连接 OpenAI；列出各个小手机可选模型是否出现在当前 API 密钥的模型列表里。"
        : "后台能连接 OpenAI，但小手机当前列出的四个模型均未出现在此 API 密钥的模型列表里；可能是模型名称或权限配置有误。"
    });
  } catch (error) {
    return json({
      version,
      stage: "openai_network",
      ok: false,
      access: "passed",
      elapsedMs: Date.now() - startedAt,
      message: error?.name === "AbortError"
        ? "Cloudflare 后台连接 OpenAI 超时"
        : "Cloudflare 后台连接 OpenAI 失败"
    });
  } finally {
    clearTimeout(timer);
  }
}
