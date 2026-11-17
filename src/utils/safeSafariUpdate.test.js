import { describe, expect, it } from "vitest";
import { onRequestGet } from "../../functions/api/safe-update.js";

describe("safe Safari PWA refresh", () => {
  it("serves a standalone no-store page without touching the database", async () => {
    const response = await onRequestGet();
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(html).toContain('id="repair"');
    expect(html).toContain("reg.unregister()");
    expect(html).toContain("caches.delete(names[j])");
    expect(html).toContain("location.replace(");
    expect(html).toContain("本地聊天数据未触碰");
    expect(html).not.toMatch(/indexedDB\.deleteDatabase|localStorage\.clear|sessionStorage\.clear|document\.cookie\s*=/);
  });
});
