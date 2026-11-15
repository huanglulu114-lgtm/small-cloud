
export async function onRequestPost({ request, env }) {
  const reply = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    });

  if (!env.OPENAI_API_KEY) {
    return reply({ error: { message: "API Key 未配置" } }, 503);
  }

  try {
    const raw = await request.text();

    if (raw.length > 250000) {
      return reply({ error: { message: "请求过大" } }, 413);
    }

    const body = JSON.parse(raw);

    if (!Array.isArray(body.messages) ||
        !body.messages.length ||
        body.messages.length > 80 ||
        !body.messages.every(m =>
          m && ["system", "user", "assistant"].includes(m.role) &&
          (typeof m.content === "string" || Array.isArray(m.content))
        )) {
      return reply({ error: { message: "消息格式错误或超出限制" } }, 400);
    }

    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: env.OPENAI_MODEL || "gpt-5.6-terra",
          messages: body.messages,
          stream: body.stream === true,
          reasoning_effort: "low",
          max_completion_tokens: 4096
        })
      }
    );

    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type":
          response.headers.get("Content-Type") || "application/json",
        "Cache-Control": "no-store"
      }
    });
  } catch {
    return reply({ error: { message: "接口请求失败" } }, 500);
  }
}
