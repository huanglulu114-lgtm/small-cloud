import { accessIdentity } from "../_shared/access.js";

// Only connection health is returned; no page contents or secret keys are exposed.
export async function onRequestGet({ request, env }) {
  const reply = (data, status = 200) => Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
  });

  const identity = await accessIdentity(request, env);
  if (!identity) return reply({ connected: false, reason: "请先通过 Cloudflare Access 登录小手机" }, 403);

  const ids = String(env.NOTION_MEMORY_PAGE_IDS || "").split(",")
    .map(x => x.trim()).filter(x => /^[a-f0-9-]{32,36}$/i.test(x));
  if (!env.NOTION_TOKEN || !ids.length) {
    return reply({ connected: false, reason: "Notion 密钥或记忆页 ID 尚未配置" });
  }
  if (env.NOTION_MEMORY_ENABLED === "false") {
    return reply({ connected: false, reason: "Notion 记忆功能已在服务器关闭" });
  }

  try {
    const resp = await fetch(
      "https://api.notion.com/v1/blocks/" + encodeURIComponent(ids[0]) + "/children?page_size=3", {
        headers: { "Authorization": "Bearer " + env.NOTION_TOKEN, "Notion-Version": "2026-03-11" }
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
