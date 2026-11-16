import { describe, expect, it } from "vitest";
import { normalizeLegacyChatMessages } from "../../functions/_shared/legacyChatPayload.js";

const image = (size) => ({
  role: "user", content: [{
    type: "image_url", image_url: { url: "data:image/jpeg;base64," + "A".repeat(size) }
  }]
});
const msg = (role, content) => ({ role, content });

describe("server-side legacy photo compatibility", () => {
  it("accepts a legacy photo request that exceeded the previous 250 KB gate", () => {
    const data = [msg("system", "记忆"), image(750000), msg("user", "老公……")];
    const result = normalizeLegacyChatMessages(data);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[1].content[0].image_url.url.length).toBeGreaterThan(750000);
    expect(result.messages[2].content).toBe("老公……");
    expect(data[1].content[0].image_url.url).toContain("AAAA");
  });

  it("keeps only the last image as model input", () => {
    const result = normalizeLegacyChatMessages([msg("system", "system"), image(100000), image(120000), msg("user", "说话")]);
    const imageParts = result.messages.flatMap(m => Array.isArray(m.content)
      ? m.content.filter(p => p.type === "image_url") : []);
    expect(imageParts).toHaveLength(1);
    expect(imageParts[0].image_url.url.length).toBeGreaterThan(120000);
  });

  it("explicitly marks extremely large photos as unreadable", () => {
    const result = normalizeLegacyChatMessages([image(4000000)]);
    expect(result.imageTooLarge).toBe(true);
    expect(result.messages[0].content[0].text).toContain("未能读取图片内容");
  });

  it("removes only outbound older turns when needed", () => {
    const messages = [msg("system", "规则"),
      msg("user", "老".repeat(7000)), msg("assistant", "答".repeat(7000)),
      msg("user", "现在怎么样")];
    const result = normalizeLegacyChatMessages(messages, { forwardLimit: 5000 });
    expect(result.messages).toEqual([msg("system", "规则"), msg("user", "现在怎么样")]);
    expect(messages).toHaveLength(4);
  });

  it("rejects one single overlong message with a useful error", () => {
    expect(() => normalizeLegacyChatMessages([msg("user", "X".repeat(8000))], { forwardLimit: 4000 }))
      .toThrow(/单条消息/);
  });
});
