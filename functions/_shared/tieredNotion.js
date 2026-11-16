import { notionMemoryPageIds, notionToken } from "./notionMemory.js";
import { selectDetailPages, shouldLookUpRecentDiary } from "./notionPages.js";

// Notion API calls cost no LLM tokens. What matters is the amount of
// retrieved text sent to the model on each chat request.
const CORE_LIMIT = 850;
const TOPIC_LIMIT = 420;
const DETAIL_LIMIT = 1150;
const TOTAL_LIMIT = 3450;
const CACHE_TTL_MS = 30 * 60 * 1000; // per Worker isolate only
const MAX_RAW_CHARS = 24000;
const MAX_BLOCK_CALLS = 3;
const MAX_EXTRA_PAGES = 2;

const pageCache = new Map();
const pageInFlight = new Map();
let diaryCache = null;

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function notionHeaders(env) {
  return { Authorization: "Bearer " + notionToken(env), "Notion-Version": "2026-03-11" };
}

function extractBlockText(block) {
  return normalizeText((block[block.type]?.rich_text || []).map(piece =>
    piece.plain_text || piece.text?.content || "").join(""));
}

async function loadPage(env, id) {
  if (!id || !notionToken(env)) return [];
  const key = id;
  const current = pageCache.get(key);
  if (current && Date.now() - current.at < CACHE_TTL_MS) return current.lines;
  if (pageInFlight.has(key)) return pageInFlight.get(key);

  const task = (async () => {
    let cursor = null;
    let remaining = MAX_RAW_CHARS;
    let calls = 0;
    const lines = [];
    do {
      calls++;
      const url = "https://api.notion.com/v1/blocks/" + encodeURIComponent(id) +
        "/children?page_size=100" +
        (cursor ? "&start_cursor=" + encodeURIComponent(cursor) : "");
      const response = await fetch(url, { headers: notionHeaders(env) });
      if (!response.ok) throw Error("Notion page not accessible: " + response.status);
      const data = await response.json();
      for (const block of data.results || []) {
        const text = extractBlockText(block);
        if (!text) continue;
        const prefix = /^heading_[123]$/.test(block.type) ? "## " :
          ["bulleted_list_item", "numbered_list_item"].includes(block.type) ? "- " : "";
        const chunk = (prefix + text).slice(0, remaining);
        lines.push(chunk);
        remaining -= chunk.length;
        if (remaining <= 0) break;
      }
      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor && calls < MAX_BLOCK_CALLS && remaining > 0);
    pageCache.set(key, { lines, at: Date.now() });
    return lines;
  })();

  pageInFlight.set(key, task);
  try { return await task; }
  catch (error) {
    // A short-lived cached version can be used during transient Notion outages.
    if (current && Date.now() - current.at < 3 * 60 * 60 * 1000) return current.lines;
    throw error;
  } finally {
    if (pageInFlight.get(key) === task) pageInFlight.delete(key);
  }
}

const LIGHT_RULES = [
  { query: /加班|上班|公司|工作|审计|离职|报告|职场|老板|同事|senior|leader|ey/i, item: /工作压力|工作/ },
  { query: /吃|喝|饮料|早餐|午饭|晚饭|胃|拉肚子|奶|西红柿|食物/i, item: /生活偏好|乳糖/ },
  { query: /日语|日文|考试|学习|n1|n2|yoasobi|演唱会|日本|音乐/i, item: /日语|日娱|YOASOBI/ },
  { query: /焦虑|难受|崩溃|烦|累|哭|压力|害怕|情绪|不开心/i, item: /压力|疲劳|焦虑|安抚/ },
  { query: /今天|昨天|明天|刚才|周末|几点|现在|出门|回家|睡觉/i, item: /日期|当天位置|即时|日记/ },
  { query: /记忆|notion|小手机|红包|转账|主动发|模型|token|云端|聊天设置/i, item: /红包|转账|主动|API|费用|Token/i }
];

function latestUserText(messages) {
  const recent = messages.filter(item => item?.role === "user").slice(-2);
  return recent.map(item => {
    if (typeof item.content === "string") return item.content;
    if (Array.isArray(item.content)) return item.content
      .filter(part => part?.type === "text" && typeof part.text === "string")
      .map(part => part.text).join(" ");
    return "";
  }).join(" ").slice(-750);
}

function parseLightSections(lines) {
  const sections = Object.create(null);
  let section = "简介";
  sections[section] = [];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      section = line.slice(3).trim();
      if (!sections[section]) sections[section] = [];
    } else {
      sections[section].push(line);
    }
  }
  return sections;
}

export function selectTieredMemory(sections, messages) {
  if (!sections) return "";
  const core = (sections["角色与说话方式"] || sections["人物与关系"] || sections["简介"] || [])
    .join("\n").slice(0, CORE_LIMIT);
  const query = latestUserText(messages);
  const patterns = LIGHT_RULES.filter(rule => rule.query.test(query)).map(rule => rule.item);
  const topical = [];
  if (patterns.length) {
    for (const entry of [
      ...(sections["与用户相处时需记住的稳定习惯"] || []),
      ...(sections["聊天与功能"] || [])
    ]) {
      if (patterns.some(pattern => pattern.test(entry)) && !topical.includes(entry))
        topical.push(entry);
    }
  }
  const extra = topical.join("\n").slice(0, TOPIC_LIMIT);
  return [
    core ? "轻量核心：\n" + core : "",
    extra ? "相关稳定习惯：\n" + extra : ""
  ].filter(Boolean).join("\n\n");
}

function relevantExcerpt(lines, query, maxChars) {
  const clean = lines.filter(Boolean);
  if (!clean.length) return "";
  const words = (query.match(/[一-龥]{2,6}|[a-zA-Z0-9_]{2,}/g) || [])
    .map(w => w.toLowerCase()).filter(w => w.length >= 2).slice(0, 12);
  // Matching lines come first, not the first 1,000 characters of a long page.
  const sorted = clean.map((line, index) => {
    const text = line.toLowerCase();
    let score = 0;
    for (const word of words) {
      if (text.includes(word)) score += Math.min(15, word.length * 3);
      if (word.length >= 4) {
        for (let i = 0; i <= word.length - 2; i++) {
          if (text.includes(word.slice(i, i + 2))) score += 1;
        }
      }
    }
    return { line, index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);

  const best = sorted.filter(entry => entry.score > 0).slice(0, 12);
  // If matching is weak, include leading relevant context from the source.
  const chosen = best.length ? best : sorted.slice(0, 8);
  const ordered = chosen.sort((a, b) => a.index - b.index);
  let result = "";
  for (const entry of ordered) {
    const next = entry.line + "\n";
    if (result.length + next.length > maxChars) {
      const available = maxChars - result.length;
      if (available > 80) result += next.slice(0, available - 1) + "…";
      break;
    }
    result += next;
  }
  return result.trim();
}

function localToday() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function parseDiaryDate(title) {
  const m = String(title || "").match(/^(20\d\d)[.\-/](0?[1-9]|1[012])[.\-/](0?[1-9]|[12]\d|3[01])/);
  if (!m) return null;
  const iso = [m[1], m[2].padStart(2,"0"), m[3].padStart(2,"0")].join("-");
  const ms = Date.parse(iso + "T00:00:00Z");
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === iso
    ? { iso, ms } : null;
}

async function findRecentDiary(env) {
  if (diaryCache && Date.now() - diaryCache.at < 15 * 60 * 1000)
    return diaryCache.page;
  try {
    const resp = await fetch("https://api.notion.com/v1/search", {
      method: "POST",
      headers: { ...notionHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "2026", page_size: 100,
        sort: { direction: "descending", timestamp: "last_edited_time" }
      })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const todayMs = Date.parse(localToday() + "T00:00:00Z");
    const candidates = (data.results || []).map(page => {
      const title = (page.properties?.title?.title || page.title || [])
        .map?.(x => x.plain_text || x.text?.content || "").join("") || "";
      const stamp = parseDiaryDate(title);
      return page.object === "page" && stamp && page.id
        ? { id: page.id, title, stamp } : null;
    }).filter(Boolean).sort((a,b)=>b.stamp.ms-a.stamp.ms);
    // Only treat a dated record as "recent" when its heading is within
    // 3 days. Older records must not masquerade as today's status.
    const page = candidates.find(p => todayMs >= p.stamp.ms &&
      todayMs - p.stamp.ms <= 3 * 24 * 60 * 60 * 1000) || null;
    diaryCache = { at: Date.now(), page };
    return page;
  } catch { return null; }
}

export async function getTieredNotionMemory(env, messages) {
  if (!notionToken(env)) return "";
  const ids = notionMemoryPageIds(env);
  const query = latestUserText(messages);
  const chunks = [];

  if (ids.length) {
    try {
      const lightLines = await loadPage(env, ids[0]);
      const core = selectTieredMemory(parseLightSections(lightLines), messages);
      if (core) chunks.push(core);
    } catch { /* A missing light page does not prevent a permitted detail lookup. */ }
  }

  let details = selectDetailPages(query).slice(0, MAX_EXTRA_PAGES);
  if (shouldLookUpRecentDiary(query)) {
    const diary = await findRecentDiary(env);
    if (diary) {
      details = details.slice(0, MAX_EXTRA_PAGES - 1);
      details.push({ ...diary, key: "日记", label: diary.title });
    }
  }

  const results = await Promise.all(details.map(async item => {
    try {
      const lines = await loadPage(env, item.id);
      const excerpt = relevantExcerpt(lines, query, DETAIL_LIMIT);
      if (!excerpt) return null;
      const warning = item.key === "09" || item.key === "日记"
        ? "\n此页含历史日期；不得将旧状态当作今天的事实。"
        : "";
      return "按需资料 " + item.key + "｜" + item.label + "：\n" + excerpt + warning;
    } catch {
      return null; // Missing Notion integration permission; reported separately by health check.
    }
  }));
  chunks.push(...results.filter(Boolean));
  return chunks.join("\n\n").slice(0, TOTAL_LIMIT);
}
