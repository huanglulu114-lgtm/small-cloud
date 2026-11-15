import { accessIdentity } from "../_shared/access.js";

const MAX_PART_SIZE = 55000;
const MAX_PARTS = 160;
const MAX_TOTAL_SIZE = 8_800_000;
const HEADER = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
let tablesInitialized = false;
const response = (data, status = 200) => Response.json(data, { status, headers: HEADER });

async function ready(db) {
  if (tablesInitialized) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS cloud_sync_heads (owner TEXT PRIMARY KEY, revision INTEGER NOT NULL, upload_id TEXT NOT NULL, sha256 TEXT NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS cloud_sync_parts (owner TEXT NOT NULL, upload_id TEXT NOT NULL, part_index INTEGER NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (owner, upload_id, part_index))")
  ]);
  tablesInitialized = true;
}

async function contextFor(request, env) {
  if (!env.CLOUD_DB) return { error: response({ error: "CLOUD_DB 尚未绑定", configured: false }, 503) };
  const origin = request.headers.get("Origin");
  if (origin && origin !== "https://small-cloud-2zs.pages.dev")
    return { error: response({ error: "不允许跨站同步" }, 403) };
  const identity = await accessIdentity(request, env);
  if (!identity) return { error: response({ error: "请先通过小手机的 Cloudflare 邮箱验证" }, 403) };
  try {
    await ready(env.CLOUD_DB);
    return { db: env.CLOUD_DB, owner: identity.owner };
  } catch {
    return { error: response({ error: "数据库还没准备好，请检查 CLOUD_DB 绑定" }, 503) };
  }
}

async function head(db, owner) {
  return db.prepare("SELECT revision, upload_id, sha256, updated_at FROM cloud_sync_heads WHERE owner = ?")
    .bind(owner).first();
}

export async function onRequestGet({ request, env }) {
  const ctx = await contextFor(request, env);
  if (ctx.error) return ctx.error;
  try {
    const state = await head(ctx.db, ctx.owner);
    if (!state) return response({ configured: true, owner: ctx.owner, revision: 0, sha256: null });
    const meta = { configured: true, owner: ctx.owner,
      revision: state.revision, sha256: state.sha256, updatedAt: state.updated_at };
    const url = new URL(request.url);
    if (url.searchParams.get("snapshot") !== "1") return response(meta);
    const result = await ctx.db.prepare(
      "SELECT part_index, payload FROM cloud_sync_parts WHERE owner = ? AND upload_id = ? ORDER BY part_index ASC"
    ).bind(ctx.owner, state.upload_id).all();
    const rows = result.results || [];
    if (!rows.length || rows.some((r, i) => r.part_index !== i))
      return response({ error: "云端快照暂时不完整，请稍后重试" }, 503);
    return response({ ...meta, data: rows.map(row => row.payload).join("") });
  } catch {
    return response({ error: "读取云端数据失败" }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  const ctx = await contextFor(request, env);
  if (ctx.error) return ctx.error;
  if (!(request.headers.get("Content-Type") || "").startsWith("application/json"))
    return response({ error: "请求格式不正确" }, 415);
  try {
    const raw = await request.text();
    if (raw.length > 1_100_000) return response({ error: "上传批次过大" }, 413);
    const body = JSON.parse(raw);
    const uploadId = body?.uploadId;
    if (typeof uploadId !== "string" || !/^[a-f0-9-]{36}$/i.test(uploadId))
      return response({ error: "上传标识不正确" }, 400);

    if (body.action === "parts") {
      if (!Array.isArray(body.parts) || body.parts.length < 1 || body.parts.length > 16 ||
        !body.parts.every(p => Number.isInteger(p.index) &&
          p.index >= 0 && p.index < MAX_PARTS && typeof p.data === "string" &&
          p.data.length > 0 && p.data.length <= MAX_PART_SIZE &&
          /^[A-Za-z0-9+/=]+$/.test(p.data))) {
        return response({ error: "上传分片无效" }, 400);
      }
      const time = Date.now();
      await ctx.db.batch(body.parts.map(p => ctx.db.prepare(
        "INSERT OR REPLACE INTO cloud_sync_parts (owner, upload_id, part_index, payload, created_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(ctx.owner, uploadId, p.index, p.data, time)));
      return response({ ok: true, uploaded: body.parts.length });
    }

    if (body.action === "commit") {
      const baseRevision = body.baseRevision;
      const partCount = body.partCount;
      if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 ||
        !Number.isInteger(partCount) || partCount < 1 || partCount > MAX_PARTS ||
        typeof body.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(body.sha256))
        return response({ error: "版本参数无效" }, 400);
      const parts = await ctx.db.prepare(
        "SELECT COUNT(*) as count, MAX(part_index) as last_index, SUM(LENGTH(payload)) as size FROM cloud_sync_parts WHERE owner = ? AND upload_id = ?"
      ).bind(ctx.owner, uploadId).first();
      if (Number(parts?.count) !== partCount ||
        Number(parts?.last_index) !== partCount - 1 ||
        Number(parts?.size) > MAX_TOTAL_SIZE)
        return response({ error: "上传不完整或数据超出容量" }, 413);
      // One atomic compare-and-swap: two devices cannot silently overwrite
      // each other's latest remote revision.
      const result = await ctx.db.prepare(
        "INSERT INTO cloud_sync_heads (owner, revision, upload_id, sha256, updated_at) VALUES (?, 1, ?, ?, ?) " +
        "ON CONFLICT(owner) DO UPDATE SET revision = cloud_sync_heads.revision + 1, " +
        "upload_id = excluded.upload_id, sha256 = excluded.sha256, updated_at = excluded.updated_at " +
        "WHERE cloud_sync_heads.revision = ? RETURNING revision"
      ).bind(ctx.owner, uploadId, body.sha256, Date.now(), baseRevision).first();
      if (!result) {
        const latest = await head(ctx.db, ctx.owner);
        return response({ error: "云端有更新，已暂停覆盖", conflict: true,
          revision: latest?.revision || 0 }, 409);
      }
      // Retain past snapshots briefly for in-flight readers and recovery.
      try {
        await ctx.db.prepare(
          "DELETE FROM cloud_sync_parts WHERE owner = ? AND upload_id != ? AND created_at < ?"
        ).bind(ctx.owner, uploadId, Date.now() - 10 * 60 * 1000).run();
      } catch { /* Best effort housekeeping only. */ }
      return response({ ok: true, revision: Number(result.revision) });
    }
    return response({ error: "未知操作" }, 400);
  } catch {
    return response({ error: "同步失败，本地记录没有被删除" }, 500);
  }
}
