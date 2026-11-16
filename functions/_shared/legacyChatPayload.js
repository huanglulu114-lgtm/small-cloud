// Defensive server-side compatibility for clients whose service worker still
// serves a pre-compression app bundle. No saved chat records are modified.
const MAX_SERVER_FORWARD_CHARS = 4_200_000;
const MAX_IMAGE_CHARS = 3_500_000;
const imagePart = part => part && part.type === "image_url" &&
  typeof part.image_url?.url === "string";

export function normalizeLegacyChatMessages(messages, {
  forwardLimit = MAX_SERVER_FORWARD_CHARS,
  imageLimit = MAX_IMAGE_CHARS
} = {}) {
  const normalized = messages.map(message => ({
    ...message,
    content: Array.isArray(message.content) ? message.content.map(part => ({
      ...part, ...(part?.image_url ? { image_url: { ...part.image_url } } : {})
    })) : message.content
  }));
  const images = [];
  normalized.forEach((message, index) => {
    if (!Array.isArray(message.content)) return;
    message.content.forEach((part, partIndex) => {
      if (imagePart(part)) images.push([index, partIndex]);
    });
  });

  // Older pictures no longer need to be repeatedly sent to the model.
  for (const [i, j] of images.slice(0, -1)) {
    normalized[i].content[j] = { type: "text", text: "[聊天里之前发过的照片]" };
  }
  let imageTooLarge = false;
  if (images.length) {
    const [i, j] = images.at(-1);
    const part = normalized[i].content[j];
    if (part.image_url.url.length > imageLimit) {
      normalized[i].content[j] = {
        type: "text",
        text: "[本次照片体积太大，本轮未能读取图片内容。请明确告诉用户需要重新发送较小的照片，不要假装看到了照片。]"
      };
      imageTooLarge = true;
    }
  }

  const serializedSize = () => JSON.stringify(normalized).length;
  // Remove old turns only from the outbound request, preserving the system
  // prompt, latest user turn, and the user's original local chat history.
  while (serializedSize() > forwardLimit) {
    const userIndices = normalized.flatMap((m, i) => m.role === "user" ? [i] : []);
    if (userIndices.length <= 1) break;
    normalized.splice(userIndices[0], userIndices[1] - userIndices[0]);
  }
  if (serializedSize() > forwardLimit) {
    const systems = normalized.filter(m => m.role === "system" &&
      typeof m.content === "string").sort((a, b) => b.content.length - a.content.length);
    for (const item of systems) {
      if (serializedSize() <= forwardLimit) break;
      const over = serializedSize() - forwardLimit + 1000;
      const max = Math.max(1500, item.content.length - over);
      if (max < item.content.length)
        item.content = item.content.slice(0, max) + "\n[其余历史背景已省略]";
    }
  }
  if (serializedSize() > forwardLimit) {
    const error = new Error("单条消息或照片仍然太大。请从小手机的最新版本重新发送较小的照片。");
    error.status = 413;
    throw error;
  }
  return { messages: normalized, imageTooLarge };
}
