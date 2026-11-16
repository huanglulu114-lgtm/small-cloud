// API request payload guard. The Cloudflare chat endpoint rejects bodies above
// 250,000 JS characters. Keep headroom without changing the saved conversation.
export const CHAT_BODY_SOFT_LIMIT = 220000;
const imageUrl = part => part?.type === "image_url" && typeof part.image_url?.url === "string";

export async function fitOpenAIChatPayload(payload, {
  maxChars = CHAT_BODY_SOFT_LIMIT,
  compressImage = async value => value
} = {}) {
  const prepared = {
    ...payload,
    messages: payload.messages.map(message => ({
      ...message,
      content: Array.isArray(message.content)
        ? message.content.map(part => ({ ...part, ...(part?.image_url ? { image_url: { ...part.image_url } } : {}) }))
        : message.content
    }))
  };
  const length = () => JSON.stringify(prepared).length;
  const images = [];
  prepared.messages.forEach((message, i) => {
    if (!Array.isArray(message.content)) return;
    message.content.forEach((part, j) => {
      if (imageUrl(part)) images.push({ i, j });
    });
  });

  // Older images should not be resent every time a user sends another text.
  // Keep only the most recent image in model context.
  for (const { i, j } of images.slice(0, -1)) {
    prepared.messages[i].content[j] = { type: "text", text: "[之前发送的图片]" };
  }

  const latest = images.at(-1);
  if (latest) {
    const part = prepared.messages[latest.i].content[latest.j];
    const url = part.image_url.url;
    if (url.startsWith("data:image/") && url.length > 65000) {
      const smaller = await compressImage(url, 65000);
      if (typeof smaller === "string" && smaller.startsWith("data:image/")) {
        part.image_url.url = smaller;
      }
    }
  }

  // Trim the oldest complete exchange from the outgoing request, never
  // the user's most recent message or any data in IndexedDB.
  while (length() > maxChars) {
    const indices = prepared.messages
      .map((message, i) => ({ role: message.role, i }))
      .filter(item => item.role !== "system")
      .map(item => item.i);
    if (indices.length <= 2) break;
    const start = indices[0];
    const second = indices[1];
    // Remove an old user turn together with all its assistant bubbles.
    const nextUser = prepared.messages.findIndex((m, i) => i > start && m.role === "user");
    const end = nextUser > start && nextUser < indices.at(-1) ? nextUser : second;
    prepared.messages.splice(start, Math.max(1, end - start));
  }

  // In uncommon cases an enormous character system prompt dominates the
  // payload even after normal context pruning. Keep the earliest (core)
  // instructions first and trim only the outbound copy.
  if (length() > maxChars) {
    const systems = prepared.messages.filter(m => m.role === "system" && typeof m.content === "string")
      .sort((a, b) => b.content.length - a.content.length);
    for (const system of systems) {
      if (length() <= maxChars) break;
      const over = length() - maxChars + 1000;
      const remaining = Math.max(1200, system.content.length - over);
      if (remaining < system.content.length) system.content = system.content.slice(0, remaining) + "\n[其余背景已省略]";
    }
  }

  if (length() > maxChars) {
    throw new Error("这次的消息或图片仍然太大，无法安全发送。请尝试较小的照片，已有聊天记录不会被删除。");
  }
  return prepared;
}

// Downscale legacy photos as well as new photos before they enter the API.
// The original locally displayed photos are never changed.
export function compressVisionDataUrl(dataUrl, targetChars = 65000) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/") ||
      dataUrl.length <= targetChars) return Promise.resolve(dataUrl);
  if (typeof Image === "undefined" || typeof document === "undefined")
    return Promise.resolve(dataUrl);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error("无法读取照片进行压缩"));
    image.onload = () => {
      try {
        let result = dataUrl;
        for (const [maxSide, quality] of [
          [768, 0.75], [640, 0.65], [512, 0.55], [384, 0.48],
          [320, 0.42], [256, 0.38], [192, 0.32]
        ]) {
          const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("浏览器无法处理图片");
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
          result = canvas.toDataURL("image/jpeg", quality);
          if (result.length <= targetChars) break;
        }
        resolve(result);
      } catch (error) {
        reject(error);
      }
    };
    image.src = dataUrl;
  });
}
