import { describe, expect, it } from "vitest";
import { parseMessageDirectives } from "./directiveParser";
import { explainInvisibleReply } from "./replyVisibility";

describe("invisible model reply diagnosis", () => {
  it("identifies an unavailable sticker-only reply instead of silently succeeding", () => {
    const text = "[表情:没有保存的表情]";
    expect(explainInvisibleReply(text, parseMessageDirectives(text))).toContain("本机没有对应的表情包");
  });

  it("explains an unexecuted wallet directive without pretending to send money", () => {
    const text = "[红包:这不是金额:给你]";
    expect(explainInvisibleReply(text, parseMessageDirectives(text))).toContain("特殊消息指令");
  });

  it("reports an empty model completion", () => {
    expect(explainInvisibleReply("  ", parseMessageDirectives("  "))).toContain("没有返回可显示");
  });

  it("reports a generic no-visible-message failure for other model output", () => {
    const text = "你好";
    expect(explainInvisibleReply(text, parseMessageDirectives(text))).toContain("没有生成可显示");
  });
});
