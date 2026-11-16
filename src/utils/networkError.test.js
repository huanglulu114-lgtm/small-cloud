import { describe, expect, it } from "vitest";
import { describeChatNetworkError } from "./networkError";

describe("Safari network interruption reporting", () => {
  it("turns Safari Load failed into a useful local-data-safe error", () => {
    const issue = describeChatNetworkError(new TypeError("Load failed"));
    expect(issue.message).toContain("VPN");
    expect(issue.message).toContain("聊天记录");
  });
  it("explains fetch errors on other browsers", () => {
    expect(describeChatNetworkError(new TypeError("Failed to fetch")).message)
      .toContain("网络连接中断");
  });
  it("does not hide API errors or successful model diagnostics", () => {
    const issue = new Error("模型暂不支持");
    expect(describeChatNetworkError(issue)).toBe(issue);
  });
  it("keeps distinct reply timeout errors", () => {
    const issue = Object.assign(new Error("等待 AI 回复超时"), { name: "ReplyTimeoutError" });
    expect(describeChatNetworkError(issue)).toBe(issue);
  });
});
