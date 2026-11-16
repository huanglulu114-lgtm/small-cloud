import { accessIdentity, getAccessJwt } from "../_shared/access.js";
import { notionMemoryPageIds, notionToken } from "../_shared/notionMemory.js";

// Only connection health is returned; no page contents or secret keys are exposed.
export async function onRequestGet({ request, env }) {
  const reply = (data, status = 200) => Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
  });

  const identity = await accessIdentity(request, env);
  if (!identity) {
    const { source } = getAccessJwt(request);
    return reply({
      connected: false,
      reason: source === "none"
        ? "检测接口没有收到 Cloudflare Access 登录凭证。请重新打开小手机，完成邮箱验证码登录后再检测。"
        : "已收到 Cloudflare Access 登录凭证，但签名、有效期或应用权限校验未通过。可能是登录过期或 Access 应用配置不匹配。",
      accessDiagnostic: source === "none" ? "missing_credentials" : "verification_failed"
    }, 403);
  }

  const ids = notionMemoryPageIds(env);
  if (!notionToken(env)) {
    // Safe diagnostics: names and existence only. Never return token values.
    // This distinguishes a missing Pages binding from a misspelled or empty one.
    const relevantNames = Object.keys(env || {})
      .filter(name => /notion/i.test(name)).slice(0, 8);
    const expectedPresent = Object.prototype.hasOwnProperty.call(env, "NOTION_TOKEN");
    const reason = expectedPresent
      ? "运行时找到了 NOTION_TOKEN 变量名，但它的值为空或不可读取；需要核对密钥内容。"
      : relevantNames.length
        ? "生产函数收到的 Notion 相关变量名：" + relevantNames.join("、") +
          "；但没有收到可用的 NOTION_TOKEN。注意名称大小写和多余空格。"
        : "生产函数没有收到任何 Notion 相关变量。后台列表里的密钥尚未进入当前 Pages Functions 运行环境。";
    return reply({ connected: false, reason, bindingNames: relevantNames, expectedPresent });
  }
  if (!ids.length) {
    return reply({ connected: false, reason: "Notion 记忆页 ID 格式不正确" });
  }
  if (env.NOTION_MEMORY_ENABLED === "false") {
    return reply({ connected: false, reason: "Notion 记忆功能已在服务器关闭" });
  }

  try {
    const resp = await fetch(
      "https://api.notion.com/v1/blocks/" + encodeURIComponent(ids[0]) + "/children?page_size=3", {
        headers: { "Authorization": "Bearer " + notionToken(env), "Notion-Version": "2026-03-11" }
      }
    );
    if (!resp.ok) {
      const reason = resp.status === 401 ? "Notion 令牌无效，请在 Cloudflare 检查 NOTION_TOKEN"
        : resp.status === 403 || resp.status === 404
          ? "Notion 页面尚未授权给「小手机」连接，或页面 ID 不正确"
          : "Notion 接口返回 " + resp.status;
      return reply({ connected: false, reason, status: resp.status });
    }
    const body = await resp.json();
    return reply({
      connected: true,
      mode: "read-only",
      pageCount: ids.length,
      previewBlocks: (body.results || []).length,
      message: "已经成功读取授权的 Notion 记忆页；当前小手机只读，不会自动修改 Notion。"
    });
  } catch {
    return reply({ connected: false, reason: "连接 Notion 时网络出错" }, 502);
  }
}
