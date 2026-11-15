// Two-device cloud synchronization for small-cloud (Cloudflare Access + D1).
// Local records remain the source of truth until the user explicitly seeds
// their FIRST device. No remote snapshot may overwrite divergent local data.
import db from "./db";

const API = "/api/sync";
const META_KEY = "smallCloudSyncMetaV1";
const STATUS_EVENT = "smallcloud:sync-status";
const OMIT_TABLES = new Set(["contextJobs"]);
const SECRET_KEYS = new Set([
  "apikey", "password", "token", "accesstoken", "refreshtoken",
  "authorization", "secretkey", "clientsecret", "notiontoken"
]);
const PART_SIZE = 55000;
const MAX_PARTS = 160;

let inFlight = false;
let lastStatus = { code: "checking", label: "正在检查云端同步…" };
let stop = null;

export const getCloudSyncStatus = () => ({ ...lastStatus });
function setStatus(code, label, extra = {}) {
  lastStatus = { code, label, ...extra };
  window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: getCloudSyncStatus() }));
}

function readMeta(owner) {
  try {
    const saved = JSON.parse(localStorage.getItem(META_KEY) || "null");
    return saved?.owner === owner && Number.isSafeInteger(saved?.revision)
      ? saved : null;
  } catch { return null; }
}
function writeMeta(owner, revision, fingerprint) {
  localStorage.setItem(META_KEY, JSON.stringify({
    owner, revision, fingerprint, syncedAt: Date.now()
  }));
}

function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (!SECRET_KEYS.has(key.toLowerCase())) out[key] = stripSecrets(val);
    }
    return out;
  }
  return value;
}

function syncedTables() {
  return db.tables.filter(table => !OMIT_TABLES.has(table.name));
}
async function capture() {
  const tables = {};
  for (const table of syncedTables()) {
    const rows = await table.toArray();
    tables[table.name] = rows.map(row => {
      const copy = stripSecrets(row);
      // Never upload providers' authentication details or external API URLs.
      if (table.name === "apiProfiles") {
        delete copy.apiKey;
        delete copy.baseUrl;
        delete copy.groupId;
      }
      return copy;
    });
  }
  const json = JSON.stringify({ app: "xiaoshouji", version: 1, tables });
  const fingerprint = await hashText(json);
  const meaningful = ["roles", "conversations", "messages", "diaries",
    "memories", "stickers", "stickerLibraries", "worldBookEntries"].some(
    key => (tables[key] || []).length > 0
  );
  return { json, fingerprint, meaningful };
}

async function hashText(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}
async function compress(text) {
  if (typeof CompressionStream !== "function") throw new Error("浏览器暂不支持数据压缩");
  const buffer = await new Response(
    new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))
  ).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
async function decompress(base64) {
  if (typeof DecompressionStream !== "function") throw new Error("浏览器暂不支持解压");
  const binary = atob(base64);
  const data = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
  return new Response(
    new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"))
  ).text();
}

async function requestJson(url, options) {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...options });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const message = json?.error || (
      response.status === 403 ? "登录状态失效，请重新登录小手机" :
      response.status === 503 ? "尚未连接云端数据库" : "云端同步请求失败"
    );
    const error = new Error(message);
    error.status = response.status;
    error.conflict = json?.conflict === true;
    throw error;
  }
  return json;
}
const fetchMeta = () => requestJson(API);
const fetchSnapshot = () => requestJson(API + "?snapshot=1");
const post = body => requestJson(API, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

async function upload(local, owner, revision) {
  const data = await compress(local.json);
  if (data.length > PART_SIZE * MAX_PARTS)
    throw new Error("本地图片或表情包太大，超出当前同步容量；记录仍保存在手机中");
  const uploadId = crypto.randomUUID();
  const parts = [];
  for (let i = 0; i < data.length; i += PART_SIZE)
    parts.push({ index: parts.length, data: data.slice(i, i + PART_SIZE) });
  // Upload in batches to stay below D1 free-plan per-invocation query limits.
  for (let index = 0; index < parts.length; index += 12) {
    await post({ action: "parts", uploadId, parts: parts.slice(index, index + 12) });
  }
  const commit = await post({
    action: "commit", uploadId, baseRevision: revision,
    partCount: parts.length, sha256: local.fingerprint
  });
  writeMeta(owner, commit.revision, local.fingerprint);
  setStatus("synced", "已同步到云端", { revision: commit.revision });
  return commit.revision;
}

async function applyRemote(remote, owner, expectedFingerprint) {
  // Never wipe a half-written message draft when another device updates.
  const active = document.activeElement;
  if (active && (active.matches?.("textarea, input[type='text'], input:not([type]), [contenteditable='true']"))) {
    setStatus("pending", "另一部手机有新记录，退出输入框后自动更新");
    return;
  }
  const fresh = await capture();
  if (fresh.fingerprint !== expectedFingerprint) {
    setStatus("conflict", "本机聊天刚有变化，已暂停覆盖，请再次检查");
    return;
  }
  const json = await decompress(remote.data);
  const sha = await hashText(json);
  if (sha !== remote.sha256) throw new Error("云端数据校验失败，未修改本机记录");
  const payload = JSON.parse(json);
  if (payload?.app !== "xiaoshouji" || !payload.tables ||
      !Array.isArray(payload.tables.roles) ||
      !Array.isArray(payload.tables.messages))
    throw new Error("云端记录格式不正确，未修改本机记录");

  // Recheck immediately before the destructive transaction. A new local
  // message during decompression must never be overwritten.
  const checkedAgain = await capture();
  if (checkedAgain.fingerprint !== expectedFingerprint) {
    setStatus("conflict", "同步时本机增加了新记录，已暂停以防覆盖");
    return;
  }
  const tables = syncedTables();
  // API credentials stay on their own device even when sharing model presets.
  const existingProfiles = db.apiProfiles ? await db.apiProfiles.toArray() : [];
  const credentials = new Map(existingProfiles.map(p => [p.id, {
    apiKey: p.apiKey || "", baseUrl: p.baseUrl || "", groupId: p.groupId || ""
  }]));
  await db.transaction("rw", ...tables, async () => {
    for (const table of tables) {
      const rows = payload.tables[table.name];
      if (!Array.isArray(rows)) continue;
      await table.clear();
      if (rows.length) {
        const entries = table.name === "apiProfiles"
          ? rows.map(row => ({ ...row, ...(credentials.get(row.id) || {}) }))
          : rows;
        await table.bulkPut(entries);
      }
    }
  });
  const current = await capture();
  writeMeta(owner, remote.revision, current.fingerprint);
  setStatus("synced", "已从云端更新", { revision: remote.revision });
  // Chat screens keep an in-memory snapshot: refresh after the atomic import.
  window.location.reload();
}

async function syncInner({ initialize = false } = {}) {
  const remote = await fetchMeta();
  if (!remote?.configured || !remote?.owner)
    throw new Error("云端数据库暂未配置");

  const local = await capture();
  const saved = readMeta(remote.owner);
  if (remote.revision === 0) {
    if (initialize && local.meaningful) {
      await upload(local, remote.owner, 0);
    } else {
      setStatus("seed", local.meaningful
        ? "待首次同步：请在有聊天记录的原手机点「设为云端初始记录」"
        : "云端还没有记录，请先在原手机初始化");
    }
    return;
  }

  if (!saved) {
    if (local.meaningful) {
      setStatus("conflict", "这台手机已有独立记录，已暂停以防覆盖", {
        revision: remote.revision
      });
    } else {
      const full = await fetchSnapshot();
      if (full.revision !== remote.revision) return;
      await applyRemote(full, remote.owner, local.fingerprint);
    }
    return;
  }

  if (saved.revision === remote.revision) {
    if (saved.fingerprint !== local.fingerprint) {
      await upload(local, remote.owner, saved.revision);
    } else {
      setStatus("synced", "两部手机记录已同步", { revision: remote.revision });
    }
    return;
  }
  if (saved.revision < remote.revision && saved.fingerprint === local.fingerprint) {
    const full = await fetchSnapshot();
    if (full.revision !== remote.revision) return;
    await applyRemote(full, remote.owner, local.fingerprint);
    return;
  }
  setStatus("conflict", "两部手机都有新记录，已暂停以防互相覆盖", {
    revision: remote.revision
  });
}

export async function checkCloudSync(options = {}) {
  if (inFlight || document.visibilityState === "hidden") return getCloudSyncStatus();
  if (!navigator.onLine) {
    setStatus("offline", "当前离线，聊天仍保存在本机");
    return getCloudSyncStatus();
  }
  inFlight = true;
  try {
    await syncInner(options);
  } catch (error) {
    if (error.conflict) {
      setStatus("conflict", "云端已有更新，已暂停覆盖本机记录");
    } else if (error.status === 503) {
      setStatus("unconfigured", "等待 Cloudflare D1 数据库连接");
    } else {
      setStatus("error", error.message || "同步未完成，本机记录仍然保留");
    }
  } finally {
    inFlight = false;
  }
  return getCloudSyncStatus();
}

export async function initializeCloudFromThisDevice() {
  if (inFlight) return;
  const local = await capture();
  if (!local.meaningful) {
    setStatus("seed", "这台手机还没有聊天记录，请使用原手机初始化");
    return;
  }
  if (!confirm("确定把【这台手机】的聊天记录设为云端初始版本吗？请只在保存着完整聊天记录的原手机操作。")) return;
  await checkCloudSync({ initialize: true });
}

export function startCloudSync() {
  if (stop) return stop;
  const run = () => { void checkCloudSync(); };
  const timer = setInterval(run, 25 * 1000);
  const startup = setTimeout(run, 1800);
  const visible = () => { if (document.visibilityState === "visible") run(); };
  window.addEventListener("online", run);
  window.addEventListener("focus", run);
  document.addEventListener("visibilitychange", visible);
  stop = () => {
    clearInterval(timer);
    clearTimeout(startup);
    window.removeEventListener("online", run);
    window.removeEventListener("focus", run);
    document.removeEventListener("visibilitychange", visible);
    stop = null;
  };
  return stop;
}
