import { assetService } from "./db";
import { selectNotionMemory } from "../utils/notionRecall";

const INDEX_KEY = "notion-persistent:index:v1";
const PAGE_PREFIX = "notion-persistent:page:v1:";
const ORDER = ["light", "01", "02", "03", "07", "08", "09"];
const CHECK_INTERVAL = 24 * 60 * 60 * 1000;
const STATUS_EVENT = "smallcloud:notion-cache-status";

let inflight = null;
let latestStatus = { code: "idle", label: "尚未检查本机 Notion 记忆", pages: 0, total: ORDER.length };

function setStatus(code, label, extra = {}) {
  latestStatus = { ...latestStatus, code, label, ...extra };
  window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: { ...latestStatus } }));
}
export const getNotionCacheStatus = () => ({ ...latestStatus });

async function loadIndex() {
  const record = await assetService.get(INDEX_KEY);
  return record && typeof record === "object" && record.pages
    ? record : { lastChecked: 0, pages: {} };
}
async function cachedPages() {
  const entries = await Promise.all(ORDER.map(async key =>
    [key, await assetService.get(PAGE_PREFIX + key)]
  ));
  return Object.fromEntries(entries.filter(([, item]) => item && Array.isArray(item.lines)));
}
async function requestJson(url) {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || "无法连接 Notion 记忆接口");
  return data;
}

export async function refreshNotionCacheStatus() {
  try {
    const pages = await cachedPages();
    const count = Object.keys(pages).length;
    const index = await loadIndex();
    if (latestStatus.code !== "syncing") {
      setStatus(count ? "ready" : "empty",
        count ? "本机已保存 " + count + "/7 页 Notion 记忆" : "本机尚未导入 Notion 记忆",
        { pages: count, total: ORDER.length, lastChecked: index.lastChecked || null });
    }
    return getNotionCacheStatus();
  } catch (error) {
    setStatus("error", "本机记忆读取失败：" + error.message);
    return getNotionCacheStatus();
  }
}

// Notion's page metadata is checked at most daily. Full page contents are
// downloaded only on first import, explicit refresh, or a changed edit time.
export function syncNotionMemory({ force = false } = {}) {
  if (inflight) return inflight;
  inflight = (async () => {
    let index;
    try {
      index = await loadIndex();
      const existing = await cachedPages();
      if (!force && Date.now() - Number(index.lastChecked || 0) < CHECK_INTERVAL &&
          Object.keys(existing).length === ORDER.length) {
        await refreshNotionCacheStatus();
        return getNotionCacheStatus();
      }

      setStatus("syncing", "正在检查 Notion 更新…", {
        pages: Object.keys(existing).length, total: ORDER.length
      });
      const manifest = await requestJson("/api/notion-cache");
      if (!Array.isArray(manifest.pages) || !manifest.pages.length)
        throw new Error("没有可导入的 Notion 记忆页");

      let failures = 0;
      for (const remote of manifest.pages) {
        if (!ORDER.includes(remote.key)) continue;
        if (!remote.readable) {
          failures++;
          continue;
        }
        const cached = existing[remote.key];
        const previous = index.pages[remote.key];
        const unchanged = !force && cached && remote.lastEdited &&
          previous?.lastEdited === remote.lastEdited && !cached.truncated;
        if (unchanged) continue;

        try {
          setStatus("syncing", "正在保存 Notion " + remote.key + "…");
          const page = await requestJson("/api/notion-cache?page=" + encodeURIComponent(remote.key));
          if (!Array.isArray(page.lines)) throw new Error("返回的 Notion 页面格式不正确");
          const record = {
            key: remote.key, label: page.label || remote.label,
            lines: page.lines, truncated: Boolean(page.truncated),
            updatedAt: Date.now()
          };
          await assetService.set(PAGE_PREFIX + remote.key, record);
          index.pages[remote.key] = { lastEdited: remote.lastEdited || null };
          await assetService.set(INDEX_KEY, index);
        } catch (error) {
          failures++;
        }
      }

      index.lastChecked = failures ? 0 : Date.now();
      await assetService.set(INDEX_KEY, index);
      const pages = await cachedPages();
      const count = Object.keys(pages).length;
      const incomplete = Object.values(pages).some(page => page.truncated);
      setStatus(failures || incomplete ? "partial" : "ready",
        "本机已保存 " + count + "/7 页" +
          (failures ? "，有 " + failures + " 页同步失败" : "") +
          (incomplete ? "，部分长页面尚未完整导入" : ""),
        { pages: count, total: ORDER.length, lastChecked: index.lastChecked || null });
    } catch (error) {
      const pages = await cachedPages().catch(() => ({}));
      setStatus("error", "Notion 更新未完成，保留已有记忆：" + error.message,
        { pages: Object.keys(pages).length, total: ORDER.length });
    }
    return getNotionCacheStatus();
  })().finally(() => { inflight = null; });
  return inflight;
}

export async function persistentNotionPrompt(messages) {
  // First chat on a new phone waits for its initial import. Later chats use
  // IndexedDB only, without even making a Notion metadata request.
  try {
    const pages = await cachedPages();
    if (!Object.keys(pages).length) await syncNotionMemory();
    const all = Object.keys(pages).length ? pages : await cachedPages();
    const result = selectNotionMemory(all, messages);
    latestStatus.lastRecall = result.keys;
    return result.text;
  } catch {
    return "";
  }
}
