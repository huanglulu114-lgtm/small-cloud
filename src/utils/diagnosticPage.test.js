import { describe, expect, it } from "vitest";
import { onRequestGet } from "../../functions/api/diagnose.js";

describe("standalone Safari diagnostic page", () => {
  it("renders useful text immediately without calling chat or OpenAI", async () => {
    const response = await onRequestGet();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const content = await response.text();
    expect(content).toContain("页面已正常打开");
    expect(content).toContain("diagnostic-html-2026-11-17-v1");
    expect(content).toContain("/api/chat?check=1");
    expect(content).toContain("无法连接检测接口");
  });
});
