import { notionMemoryPageIds, notionToken } from "./notionMemory.js";

// Keep memory small in every OpenAI request. Notion API reads do not consume
// model tokens, but sending large pages to the model does.
const CORE_LIMIT = 850;
const TOPIC_LIMIT = 500;
const TOTAL_LIMIT = 1400;
const CACHE_TTL_MS = 60 * 60 * 1000; // best-effort per Worker isolate
const MAX_SOURCE_CHARS = 22000;
const MAX_FETCHES = 8;

let cached = null;
let inFlight = null;

function normalizeLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function downloadSnapshot(env) {
  const ids = notionMemoryPageIds(env);
  const token = notionToken(env);
  if (!token || !ids.length) return null;

  const key = ids.join(",");
  const now = Date.now();
  if (cached?.key === key && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.sections;
  }
  if (inFlight?.key === key) return inFlight.promise;

  const promise = (async () => {
    const sections = Object.create(null);
    let current = "简介";
    sections[current] = [];
    let remainingChars = MAX_SOURCE_CHARS;
    let fetchesLeft = MAX_FETCHES;

    const headers = {
      Authorization: "Bearer " + token,
      "Notion-Version": "2026-03-11"
    };

    async function readBlocks(blockId, nested = false) {
      if (!fetchesLeft || !remainingChars) return;
      fetchesLeft--;
      const response = await fetch(
        "https://api.notion.com/v1/blocks/" + encodeURIComponent(blockId) +
        "/children?page_size=100", { headers }
      );
      if (!response.ok) throw Error("Notion read failed: " + response.status);
      const data = await response.json();
      for (const block of data.results || []) {
        if (!remainingChars) break;
        const text = normalizeLine((block[block.type]?.rich_text || [])
          .map(piece => piece.plain_text || piece.text?.content || "").join(""));
        if (/^heading_[123]$/.test(block.type) && text) {
          current = text;
          if (!sections[current]) sections[current] = [];
        } else if (text) {
          const prefix = ["bulleted_list_item", "numbered_list_item"].includes(block.type) ? "- " : "";
          sections[current].push((prefix + text).slice(0, remainingChars));
          remainingChars -= text.length;
        }
        if (!nested && block.has_children &&
            ["toggle", "paragraph", "bulleted_list_item", "numbered_list_item"].includes(block.type)) {
          await readBlocks(block.id, true);
        }
      }
    }

    // The first ID is the lightweight memory page. Other authorized pages can
    // be added later, but must not be read wholesale on every chat.
    await readBlocks(ids[0]);
    cached = { key, timestamp: Date.now(), sections };
    return sections;
  })();

  inFlight = { key, promise };
  try { return await promise; }
  catch (error) {
    // A stale, previously verified snapshot is better than breaking chat.
    if (cached?.key === key) return cached.sections;
    throw error;
  } finally {
    if (inFlight?.promise === promise) inFlight = null;
  }
}

const RULES = [
  { query: /加班|上班|公司|工作|审计|离职|报告|职场|老板|同事|senior|leader|ey/i, item: /工作压力|工作/ },
  { query: /吃|喝|饮料|早餐|午饭|晚饭|胃|拉肚子|奶|西红柿|食物/i, item: /生活偏好|乳糖/ },
  { query: /日语|日文|考试|学习|n1|n2|yoasobi|演唱会|日本|音乐/i, item: /日语|日娱|YOASOBI/ },
  { query: /焦虑|难受|崩溃|烦|累|哭|压力|害怕|情绪|不开心/i, item: /压力|疲劳|焦虑|安抚/ },
  { query: /今天|昨天|明天|刚才|周末|几点|现在|出门|回家|睡觉/i, item: /日期|当天位置|即时|日记/ },
  { query: /记忆|notion|小手机|红包|转账|主动发|模型|token|云端|聊天设置/i, item: /红包|转账|主动|API|费用|Token/i }
];

function latestUserText(messages) {
  return messages.filter(message => message?.role === "user")
    .slice(-2).map(message => typeof message.content === "string"
      ? message.content : Array.isArray(message.content)
        ? message.content.filter(p => p?.type === "text" && typeof p.text === "string")
          .map(p => p.text).join(" ")
        : "").join(" ").slice(-700);
}

export function selectTieredMemory(sections, messages) {
  if (!sections) return "";
  const core = (sections["角色与说话方式"] || sections["人物与关系"] || sections["简介"] || [])
    .join("\n").slice(0, CORE_LIMIT);

  const query = latestUserText(messages);
  const patterns = RULES.filter(rule => rule.query.test(query)).map(rule => rule.item);
  const topical = [];
  if (patterns.length) {
    const eligible = [
      ...(sections["与用户相处时需记住的稳定习惯"] || []),
      ...(sections["聊天与功能"] || [])
    ];
    for (const entry of eligible) {
      if (!patterns.some(pattern => pattern.test(entry))) continue;
      if (!topical.includes(entry)) topical.push(entry);
    }
  }

  const additions = topical.join("\n").slice(0, TOPIC_LIMIT);
  const result = [
    core ? "稳定核心：\n" + core : "",
    additions ? "仅与当前话题有关的补充：\n" + additions : ""
  ].filter(Boolean).join("\n\n");

  return result.slice(0, TOTAL_LIMIT);
}

export async function getTieredNotionMemory(env, messages) {
  const sections = await downloadSnapshot(env);
  return selectTieredMemory(sections, messages);
}
