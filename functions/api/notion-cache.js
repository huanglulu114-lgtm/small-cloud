import { accessIdentity } from "../_shared/access.js";
import { notionMemoryPageIds, notionToken } from "../_shared/notionMemory.js";
import { DETAIL_PAGE_CATALOG } from "../_shared/notionPages.js";

// Read-only, Access-protected export for the device's persistent Notion cache.
// This endpoint never accepts arbitrary Notion page IDs from the browser.
const HOST = "https://small-cloud-2zs.pages.dev";
const MAX_CALLS_PER_PAGE = 45;
const MAX_PAGE_CHARS = 160000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const reply = (data, status = 200) => Response.json(data, {
  status,
  headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
});

function catalog(env) {
  const lightId = notionMemoryPageIds(env)[0];
  return [
    ...(lightId ? [{ key: "light", id: lightId, label: "小手机｜叶洵轻量记忆" }] : []),
    ...DETAIL_PAGE_CATALOG.map(({ key, id, label }) => ({ key, id, label }))
  ];
}

async function notionGet(env, path) {
  const token = notionToken(env);
  if (!token) throw new Error("Notion 凭证未配置");
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch("https://api.notion.com/v1/" + path, {
      headers: { Authorization: "Bearer " + token, "Notion-Version": "2026-03-11" }
    });
    if (response.status === 429 && attempt < 3) {
      await sleep(1100 * (attempt + 1));
      continue;
    }
    if (!response.ok) {
      const error = new Error(response.status === 403 || response.status === 404
        ? "Notion 页面没有授权给「小手机」" : "Notion API 返回 " + response.status);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }
  throw new Error("Notion 请求次数过多");
}

function blockText(block) {
  const data = block[block.type] || {};
  if (block.type === "child_page" || block.type === "child_database")
    return data.title || "";
  if (block.type === "table_row")
    return (data.cells || []).map(cell =>
      cell.map(item => item.plain_text || item.text?.content || "").join("")).join(" | ");
  const richText = data.rich_text || data.caption || [];
  return richText.map(part => part.plain_text || part.text?.content || "").join("");
}

async function fullPage(env, id) {
  const lines = [];
  let calls = 0;
  let chars = 0;
  let truncated = false;

  async function visit(blockId, depth) {
    let cursor = null;
    do {
      if (calls >= MAX_CALLS_PER_PAGE || chars >= MAX_PAGE_CHARS) {
        truncated = true;
        return;
      }
      calls++;
      const url = "blocks/" + encodeURIComponent(blockId) + "/children?page_size=100" +
        (cursor ? "&start_cursor=" + encodeURIComponent(cursor) : "");
      const result = await notionGet(env, url);
      for (const block of result.results || []) {
        const content = blockText(block).trim();
        if (content) {
          const prefix = /^heading_[123]$/.test(block.type) ? "## " :
            ["bulleted_list_item", "numbered_list_item", "to_do"].includes(block.type) ? "- " : "";
          const line = ("  ".repeat(depth) + prefix + content).slice(0, MAX_PAGE_CHARS - chars);
          lines.push(line);
          chars += line.length + 1;
        }
        if (chars >= MAX_PAGE_CHARS) {
          truncated = true;
          return;
        }
        if (block.has_children && depth < 4 && !["child_page", "child_database"].includes(block.type)) {
          await visit(block.id, depth + 1);
          if (truncated) return;
        } else if (block.has_children && depth >= 4) {
          truncated = true;
        }
      }
      cursor = result.has_more ? result.next_cursor : null;
    } while (cursor);
  }

  await visit(id, 0);
  return { lines, truncated, blockCalls: calls };
}

export async function onRequestGet({ request, env }) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== HOST) return reply({ error: "不允许跨站访问" }, 403);
  if (!(await accessIdentity(request, env))) return reply({ error: "请先登录小手机" }, 403);
  if (!notionToken(env) || env.NOTION_MEMORY_ENABLED === "false")
    return reply({ error: "Notion 尚未配置" }, 503);

  const items = catalog(env);
  const url = new URL(request.url);
  const pageKey = url.searchParams.get("page");
  if (pageKey !== null) {
    const page = items.find(item => item.key === pageKey);
    if (!page) return reply({ error: "无效的记忆页" }, 400);
    try {
      const content = await fullPage(env, page.id);
      return reply({ key: page.key, label: page.label, ...content });
    } catch (error) {
      return reply({ error: error.message || "Notion 页面读取失败" }, 502);
    }
  }

  const pages = [];
  for (const page of items) {
    try {
      const info = await notionGet(env, "pages/" + encodeURIComponent(page.id));
      pages.push({
        key: page.key, label: page.label,
        lastEdited: info.last_edited_time || info.created_time || null,
        readable: true
      });
    } catch {
      pages.push({ key: page.key, label: page.label, readable: false });
    }
    // Keep well below Notion's normal integration request-rate limit.
    await sleep(370);
  }
  return reply({ pages });
}
