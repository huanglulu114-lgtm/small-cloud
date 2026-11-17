import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
describe("mobile startup safety", () => {
  it("displays a loading fallback even when JavaScript bundles cannot mount", () => {
    expect(page).toContain('id="startup-fallback"');
    expect(page).toContain("请勿删除浏览器网站数据或聊天记录");
    expect(page).toContain("hint.classList.add('failed')");
  });
  it("does not make remote CSS or optional scripts parser blocking", () => {
    expect(page).toContain('<script async src="https://cdn.tailwindcss.com"></script>');
    expect(page).toContain('media="print" onload="this.media=\'all\'"');
    expect(page).not.toContain('<script src="https://cdn.tailwindcss.com"></script>');
  });
  it("preserves the existing Vue app mount point", () => {
    expect(page).toContain('<div id="app">');
    expect(page).toContain('type="module" src="/src/main.js"');
  });
});
