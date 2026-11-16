import { describe, expect, it } from "vitest";
import { fitOpenAIChatPayload } from "./chatPayload";

const image = size => ({
  role: "user",
  content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64," + "A".repeat(size) } }]
});
const text = (role, content) => ({ role, content });

describe("OpenAI chat request size", () => {
  it("resizes an old original-quality photo and preserves the current user message", async () => {
    const old = image(340000);
    const request = { model: "gpt-6-luna", messages: [
      text("system", "角色提示词"),
      old,
      text("user", "老公……")
    ] };
    const reduced = await fitOpenAIChatPayload(request, {
      compressImage: async () => "data:image/jpeg;base64," + "B".repeat(45000)
    });
    expect(JSON.stringify(reduced).length).toBeLessThan(220001);
    expect(reduced.messages.at(-1).content).toBe("老公……");
    expect(JSON.stringify(old).length).toBeGreaterThan(340000);
    expect(reduced.messages.some(m => Array.isArray(m.content) &&
      m.content.some(p => p.image_url?.url?.includes("BBBB")))).toBe(true);
  });

  it("never resends many old images", async () => {
    const request = { messages: [
      text("system", "background"), image(15000), text("assistant", "看到了"),
      image(14000), text("user", "看最后一张")
    ] };
    const result = await fitOpenAIChatPayload(request);
    const images = result.messages.flatMap(m => Array.isArray(m.content)
      ? m.content.filter(p => p.type === "image_url") : []);
    expect(images).toHaveLength(1);
    expect(images[0].image_url.url).toContain("A".repeat(500));
  });

  it("reduces old conversation before trimming the system prompt", async () => {
    const request = { messages: [
      text("system", "人格".repeat(1200)),
      ...Array.from({ length: 14 }, (_, i) => [
        text("user", "请问" + "长".repeat(1800) + i),
        text("assistant", "回答" + "长".repeat(1800))
      ]).flat(),
      text("user", "最新消息")
    ] };
    const result = await fitOpenAIChatPayload(request, { maxChars: 25000 });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(25000);
    expect(result.messages.at(-1).content).toBe("最新消息");
    expect(result.messages[0].content).toBe("人格".repeat(1200));
  });

  it("throws instead of silently altering a single oversized user message", async () => {
    await expect(fitOpenAIChatPayload({ messages: [
      text("system", "设定"), text("user", "A".repeat(300000))
    ] })).rejects.toThrow(/太大/);
  });

  it("keeps a new image even if the photo is followed by a text message", async () => {
    const request = { messages: [
      text("system", "设定"), image(80000), text("user", "这张拍了啥？")
    ] };
    const result = await fitOpenAIChatPayload(request, {
      compressImage: async () => "data:image/jpeg;base64," + "Z".repeat(50000)
    });
    expect(result.messages[1].content[0].image_url.url).toContain("ZZZZ");
    expect(result.messages.at(-1).content).toContain("这张");
  });
});
