// iOS Safari often throws TypeError("Load failed") when a VPN or network
// transition interrupts fetch or an already-open response stream.
export function describeChatNetworkError(error) {
  const message = String(error?.message || "");
  const name = String(error?.name || "");
  if (name === "ReplyTimeoutError") return error;
  if (name === "AbortError")
    return new Error("AI 请求超时，可能是网络或 VPN 中断。检查连接后再重新生成。");
  if (/(?:load failed|failed to fetch|networkerror|network request failed|network connection was lost|the internet connection appears to be offline)/i.test(message))
    return new Error("网络连接中断（Safari：Load failed）。请确认 VPN 稳定、能正常打开网页，再重新生成。聊天记录已经保存在本机。");
  return error;
}
