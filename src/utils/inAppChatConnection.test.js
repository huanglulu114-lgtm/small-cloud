import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { onRequestPost } from "../../functions/api/chat.js";

describe("no-token chat connection checker", () => {
  it("blocks unauthenticated POST probes without contacting OpenAI", async () => {
    const upstream = vi.fn(() => { throw new Error("should not call upstream"); });
    vi.stubGlobal("fetch", upstream);
    try {
      const response = await onRequestPost({
        request: new Request("https://small-cloud-2zs.pages.dev/api/chat?probe=1", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"probe":true}'
        }),
        env: { OPENAI_API_KEY: "test-secret" }
      });
      expect(response.status).toBe(403);
      expect((await response.json()).stage).toBe("access");
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("exposes diagnosis inside the actual chat API settings screen", () => {
    const settings = readFileSync(new URL("../views/AppSettings.vue", import.meta.url), "utf8");
    const checker = readFileSync(new URL("../components/ChatConnectionCheck.vue", import.meta.url), "utf8");
    expect(settings).toContain("<chat-connection-check />");
    expect(checker).toContain("/api/chat?check=1");
    expect(checker).toContain("/api/chat?probe=1");
    expect(checker).toContain("不会发送聊天记录");
    expect(checker).not.toContain("callClaude(");
  });
});
