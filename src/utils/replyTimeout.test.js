import { describe, it, expect, vi } from "vitest";
import { ReplyTimeoutError, readStreamChunkWithTimeout, readJsonWithTimeout } from "./replyTimeout";

describe("AI reply timeout protection", () => {
  it("does not leave typing stuck when the stream body never sends a chunk", async () => {
    const reader = { read: () => new Promise(() => {}), cancel: vi.fn(() => Promise.resolve()) };
    await expect(readStreamChunkWithTimeout(reader, 10)).rejects.toBeInstanceOf(ReplyTimeoutError);
    expect(reader.cancel).toHaveBeenCalledOnce();
  });

  it("returns streaming content without waiting for a deadline", async () => {
    const value = { done: false, value: new Uint8Array([65, 66]) };
    const result = await readStreamChunkWithTimeout({
      read: () => Promise.resolve(value)
    }, 500);
    expect(result).toEqual(value);
  });

  it("shows an explicit error when the JSON body stalls", async () => {
    await expect(readJsonWithTimeout({
      json: () => new Promise(() => {})
    }, 10)).rejects.toThrow("等待 AI 回复超时");
  });

  it("allows normal non-streaming responses", async () => {
    const data = { choices: [{ message: { content: "你好" } }] };
    expect(await readJsonWithTimeout({ json: async () => data }, 100)).toEqual(data);
  });
});
