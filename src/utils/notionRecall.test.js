import { describe, expect, it } from "vitest";
import { selectNotionMemory } from "./notionRecall";

const light = { label: "轻量记忆", lines: [
  "## 角色与说话方式", "沉稳，表达自然，允许提出自己的意见。",
  "## 其他", "这里还有不少历史背景。"
] };
const pages = {
  light,
  "01": { label: "互动", lines: ["## 说话方式", "自然回应，不要每句复述。"] },
  "02": { label: "用户档案", lines: [
    "## 学校", "此前在一所大学学习。",
    "## 工作", "工作地点：星河科技有限公司。工作时间为早上九点。"
  ] },
  "07": { label: "长期项目", lines: ["## 项目", "小手机使用 Notion 保存历史记忆。"] },
  "08": { label: "偏好", lines: ["## 饮食", "喜欢热汤面。"] }
};
const user = content => [{ role: "user", content }];

describe("persistent Notion recall", () => {
  it("recognizes natural questions about work, without requiring a magic phrase", () => {
    const result = selectNotionMemory(pages, user("我在哪上班来着？"));
    expect(result.keys).toContain("02");
    expect(result.text).toContain("星河科技有限公司");
  });

  it("reads only a stable core for greetings", () => {
    const result = selectNotionMemory(pages, user("早呀"));
    expect(result.keys).toEqual(["light"]);
    expect(result.text).not.toContain("星河科技");
  });

  it("never supplies more than two detailed pages", () => {
    const result = selectNotionMemory(pages, user("我们上次讨论小手机的时候说话什么语气？"));
    expect(result.keys.filter(key => key !== "light").length).toBeLessThanOrEqual(2);
  });

  it("does not fabricate a record if the device has no cache", () => {
    expect(selectNotionMemory({}, user("我在哪上班？"))).toEqual({ text: "", keys: [] });
  });

  it("caps prompt size without discarding the stored original", () => {
    const huge = { ...pages, "02": {
      label: "用户档案",
      lines: ["## 工作", "工作地点：" + "大".repeat(10000)]
    } };
    const result = selectNotionMemory(huge, user("我在哪上班？"));
    expect(result.text.length).toBeLessThan(2000);
    expect(huge["02"].lines[1].length).toBeGreaterThan(10000);
  });
});
