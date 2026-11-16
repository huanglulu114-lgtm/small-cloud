// A model completion can be nonempty yet create zero chat bubbles when it
// contains only unsupported special directives (e.g. an unsaved sticker).
// Report that as a failure rather than silently dropping the reply.
export function explainInvisibleReply(rawText, parsed) {
  if (!String(rawText ?? '').trim()) {
    return "模型这次没有返回可显示的文字。请检查模型设置，再尝试生成。";
  }
  const directives = parsed?.directives || [];
  if (!parsed?.cleanText && directives.length && directives.every(item => item.type === "sticker")) {
    return "模型只发送了表情包指令，但本机没有对应的表情包，所以没显示出来。你的消息还在，可以检查表情包设置后重新生成。";
  }
  if (!parsed?.cleanText && directives.length) {
    return "模型返回了特殊消息指令，但本次没有成功生成任何可显示的消息。请检查对应功能设置后再试。";
  }
  return "模型已返回内容，但小手机没有生成可显示的聊天消息。请重新打开对话，若仍出现请检查 API 和消息格式设置。";
}
