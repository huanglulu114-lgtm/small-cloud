import { describe, it, expect, vi, afterEach } from "vitest";
import { onRequestGet } from "../../functions/api/chat.js";

afterEach(() => vi.restoreAllMocks());

describe("zero-token chat health endpoint", () => {
  const base = "https://small-cloud-2zs.pages.dev/api/chat";
  it("requires explicit diagnostic query and never contacts OpenAI for normal GET", async () => {
    const upstream = vi.spyOn(globalThis, "fetch");
    const response = await onRequestGet({
      request: new Request(base), env: { OPENAI_API_KEY: "sk-not-real" }
    });
    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("does not call model API or reveal secrets without authenticated Access", async () => {
    const upstream = vi.spyOn(globalThis, "fetch");
    const response = await onRequestGet({
      request: new Request(base + "?check=1"), env: { OPENAI_API_KEY: "sk-VERY-SECRET" }
    });
    const data = await response.json();
    expect(response.status).toBe(403);
    expect(data.stage).toBe("access");
    expect(data.version).toContain("chat-health");
    expect(JSON.stringify(data)).not.toContain("sk-VERY-SECRET");
    expect(upstream).not.toHaveBeenCalled();
  });
});
