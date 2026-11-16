// Claude API 调用服务
import { mergeSystemPrompts } from '../config/systemPrompts';
import { recordApiUsage } from './apiUsage';
import { fitOpenAIChatPayload, compressVisionDataUrl } from '../utils/chatPayload';
import { readStreamChunkWithTimeout, readJsonWithTimeout, ReplyTimeoutError } from '../utils/replyTimeout';
import { describeChatNetworkError } from '../utils/networkError';
import {
  getSelectedOpenAIModel,
  getSelectedOpenAIReasoningEffort,
  OPENAI_LAST_SUCCESS_KEY
} from '../config/openaiModels';

const CHAT_PROXY_ENDPOINT = '/api/chat';
const USE_VERCEL_PROXY_KEY = 'useVercelProxy';

const useVercelProxy = () => localStorage.getItem(USE_VERCEL_PROXY_KEY) === 'true';

// Save the model returned by OpenAI and the effort accepted by the proxy.
// Only record a successful API response, never merely a UI choice.
function saveSuccessfulOpenAISelection(response, responseModel) {
  const model = String(responseModel || response.headers.get('X-SmallCloud-Requested-Model') || '');
  const effort = response.headers.get('X-SmallCloud-Reasoning-Effort');
  if (!model || !['low', 'medium', 'high'].includes(effort)) return;
  try {
    const record = { model, effort, at: new Date().toISOString() };
    localStorage.setItem(OPENAI_LAST_SUCCESS_KEY, JSON.stringify(record));
    window.dispatchEvent(new CustomEvent('smallcloud:model-used', { detail: record }));
  } catch { /* Storage is optional. */ }
}


/**
 * 带有自动重试机制的 fetch
 */
async function fetchWithRetry(url, options, maxRetries = 2, baseDelay = 1000) {
  let attempt = 0;
  while (attempt <= maxRetries) {
    // 增加超时控制：60秒超时
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    const fetchOptions = { ...options, signal: controller.signal };

    try {
      const response = await fetch(url, fetchOptions);
      clearTimeout(timeoutId);
      
      // 如果遇到中转服务器常见的 502/503/504 错误，也进行重试
      if (!response.ok && [502, 503, 504].includes(response.status) && attempt < maxRetries) {
        console.warn(`服务器返回 ${response.status}，准备重试...`);
        throw new Error(`Server Error: ${response.status}`);
      }
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      
      const isNetworkError = error.name === 'TypeError' && error.message.toLowerCase().includes('fetch');
      const isTimeout = error.name === 'AbortError';
      
      if (attempt >= maxRetries) {
        if (isNetworkError) {
          throw new Error('网络请求失败 (Failed to fetch)。这通常是因为中转API节点波动、超时或跨域被拦截，请稍后重试。');
        }
        if (isTimeout) {
          throw new Error('网络请求超时 (Timeout)。服务器响应时间过长。');
        }
        throw error;
      }
      
      attempt++;
      console.warn(`请求出现异常(${error.message})，${baseDelay * attempt}ms 后进行第 ${attempt} 次重试...`);
      await new Promise(resolve => setTimeout(resolve, baseDelay * attempt));
    }
  }
}

/**
 * 处理 Anthropic 流式响应
 */
async function handleAnthropicStream(response, onChunk) {
  const reader = response.body.getReader();
  const readStartedAt = Date.now();
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';

  while (true) {
    const remaining = 180000 - (Date.now() - readStartedAt);
    if (remaining <= 0) throw new ReplyTimeoutError();
    const { done, value } = await readStreamChunkWithTimeout(reader, Math.min(60000, remaining));
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n').filter(line => line.trim());

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            const text = parsed.delta.text;
            buffer += text;
            fullText += text;

            // 遇到换行就发送一个气泡
            if (onChunk && buffer.includes('\n')) {
              const parts = buffer.split('\n');
              for (let i = 0; i < parts.length - 1; i++) {
                if (parts[i].trim()) {
                  onChunk(parts[i]);
                }
              }
              buffer = parts[parts.length - 1];
            }
          }
        } catch (e) {
          // 忽略解析错误
        }
      }
    }
  }

  // 发送剩余内容
  if (onChunk && buffer.trim()) {
    onChunk(buffer);
  }

  return fullText;
}

/**
 * 处理 OpenAI 流式响应
 */
async function handleOpenAIStream(response, onChunk) {
  const reader = response.body.getReader();
  const readStartedAt = Date.now();
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';
  let pending = '';
  let finalUsage = null;
  let responseModel = '';

  function processLine(line) {
    if (!line.startsWith('data:')) return;
    const eventData = line.slice(5).trim();
    if (!eventData || eventData === '[DONE]') return;
    try {
      const parsed = JSON.parse(eventData);
      if (parsed.model) responseModel = parsed.model;
      if (parsed.usage) finalUsage = parsed.usage;
      const text = parsed.choices?.[0]?.delta?.content;
      if (typeof text !== 'string' || !text) return;
      buffer += text;
      fullText += text;
      if (onChunk && buffer.includes('\n')) {
        const parts = buffer.split('\n');
        for (let i = 0; i < parts.length - 1; i++) {
          if (parts[i].trim()) onChunk(parts[i]);
        }
        buffer = parts[parts.length - 1];
      }
    } catch {
      // Some streaming events are not JSON.
    }
  }

  while (true) {
    const remaining = 180000 - (Date.now() - readStartedAt);
    if (remaining <= 0) throw new ReplyTimeoutError();
    const { done, value } = await readStreamChunkWithTimeout(reader, Math.min(60000, remaining));
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let lineEnd;
    while ((lineEnd = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, lineEnd).trim();
      pending = pending.slice(lineEnd + 1);
      processLine(line);
    }
  }
  pending += decoder.decode();
  if (pending.trim()) processLine(pending.trim());

  if (finalUsage) recordApiUsage(finalUsage, responseModel);
  if (responseModel) saveSuccessfulOpenAISelection(response, responseModel);
  if (onChunk && buffer.trim()) onChunk(buffer);
  return fullText;
}

/**
 * 调用 Claude API
 * @param {Object} role - 角色配置
 * @param {Array} messages - 消息历史
 * @param {Function} onChunk - 流式回调（可选）
 * @returns {Promise<string>} - AI 回复内容
 */
export async function callClaude(role, messages, onChunk = null) {
  const { apiKey, baseUrl, model, apiFormat, systemPrompt, skipSystemPromptMerge = false } = role;

  // OpenAI 使用服务器端加密密钥；Anthropic 保持原有客户端配置。
  if (apiFormat === 'anthropic' && !apiKey) {
    throw new Error('请配置 Anthropic API Key');
  }

  // 聊天界面会先通过 promptBuilder 统一拼接完整提示词，避免重复追加内置指令。
  const finalSystemPrompt = skipSystemPromptMerge
    ? (systemPrompt || '')
    : mergeSystemPrompts(systemPrompt);

  console.log('📤 发送给API的系统提示词（前200字符）:', finalSystemPrompt.substring(0, 200));
  console.log('📤 消息数量:', messages.length);

  // Show a meaningful message for Safari's "Load failed" instead of an
  // opaque API error. The original local messages remain untouched.
  try {
    if (apiFormat === 'anthropic') {
      return await callAnthropicAPI(baseUrl, apiKey, model, finalSystemPrompt, messages, onChunk);
    } else if (!apiFormat || apiFormat === 'openai') {
      return await callOpenAIAPI(baseUrl, apiKey, model, finalSystemPrompt, messages, onChunk);
    } else {
      throw new Error('不支持的 API 格式');
    }
  } catch (error) {
    throw describeChatNetworkError(error);
  }
}

/**
 * 调用 Anthropic 官方 API
 */
async function callAnthropicAPI(baseUrl, apiKey, model, systemPrompt, messages, onChunk) {
  const useStream = localStorage.getItem('useStreamAPI') === 'true';
  const useProxy = useVercelProxy();

  // 构建 API URL
  const url = baseUrl
    ? (baseUrl.endsWith('/messages') ? baseUrl :
       baseUrl.endsWith('/v1') ? `${baseUrl}/messages` :
       `${baseUrl}/v1/messages`)
    : 'https://api.anthropic.com/v1/messages';

  const requestBody = {
    model: model || 'claude-3-5-sonnet-20241022',
    max_tokens: 4096,
    system: systemPrompt || '',
    messages: messages,
    stream: useStream
  };

  const response = await fetchWithRetry(useProxy ? CHAT_PROXY_ENDPOINT : url, {
    method: 'POST',
    headers: useProxy
      ? { 'Content-Type': 'application/json' }
      : {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
    body: JSON.stringify(useProxy
      ? { ...requestBody, apiKey, baseUrl, apiFormat: 'anthropic' }
      : requestBody)
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `API 请求失败: ${response.status}`);
  }

  // 流式响应（useStream=true，或服务端强制返回了 SSE 格式）
  const isSSE = (response.headers.get('Content-Type') || '').includes('text/event-stream');
  if (useStream || isSSE) {
    return await handleAnthropicStream(response, onChunk);
  }

  const data = await response.json();
  return data.content[0].text;
}

/**
 * 调用 OpenAI 兼容 API
 */
async function callOpenAIAPI(baseUrl, apiKey, model, systemPrompt, messages, onChunk) {
  const useStream = localStorage.getItem('useStreamAPI') === 'true';
  const openaiMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;

  // 从同源 Cloudflare Pages Function 调用 OpenAI。
  // API Key 只存在 Cloudflare 的 OPENAI_API_KEY Secret 中，不发送到浏览器。
  // 模型由小手机设置控制，服务端再次验证模型 ID 和密钥。
  const payload = await fitOpenAIChatPayload({
    messages: openaiMessages,
    stream: useStream,
    model: getSelectedOpenAIModel(),
    reasoning_effort: getSelectedOpenAIReasoningEffort()
  }, { compressImage: compressVisionDataUrl });
  // A stalled request should not be silently retried: retries can create
  // duplicate model charges while the earlier request is still running.
  const response = await fetchWithRetry(CHAT_PROXY_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }, 0);

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `API 请求失败: ${response.status}`);
  }

  const isSSE = (response.headers.get('Content-Type') || '').includes('text/event-stream');
  if (useStream || isSSE) {
    const text = await handleOpenAIStream(response, onChunk);
    if (!text.trim()) throw new Error('模型本次没有返回文字。请尝试降低推理档位或更换模型后重新生成。');
    return text;
  }

  const data = await readJsonWithTimeout(response);
  recordApiUsage(data.usage, data.model);
  saveSuccessfulOpenAISelection(response, data.model);
  const text = data.choices?.[0]?.message?.content || '';
  if (!String(text).trim()) throw new Error('模型本次没有返回文字。请尝试降低推理档位或更换模型后重新生成。');
  return text;
}

export async function callClaudeVision(role, imageBase64, mimeType, contextMessages = []) {
  const { apiKey, baseUrl, model, apiFormat, systemPrompt } = role;
  const useProxy = useVercelProxy();

  if (apiFormat === 'anthropic' && !apiKey) {
    throw new Error('请配置 Anthropic API Key');
  }

  // 合并内置提示词和用户提示词
  const finalSystemPrompt = mergeSystemPrompts(systemPrompt);

  // 图片消息放在最后一条 user 消息里
  const imageUserMessage = {
    role: 'user',
    content: [
      {
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data: imageBase64 }
      },
      { type: 'text', text: '请结合我们的对话内容，描述或回应这张图片。' }
    ]
  };

  if (apiFormat === 'anthropic') {
    const messages = [...contextMessages, imageUserMessage];

    // 构建 API URL
    const url = baseUrl
      ? (baseUrl.endsWith('/messages') ? baseUrl :
         baseUrl.endsWith('/v1') ? `${baseUrl}/messages` :
         `${baseUrl}/v1/messages`)
      : 'https://api.anthropic.com/v1/messages';

    const requestBody = {
      model: model || 'claude-3-5-sonnet-20241022',
      max_tokens: 4096,
      system: finalSystemPrompt || '',
      messages
    };

    const response = await fetchWithRetry(useProxy ? CHAT_PROXY_ENDPOINT : url, {
      method: 'POST',
      headers: useProxy
        ? { 'Content-Type': 'application/json' }
        : {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
      body: JSON.stringify(useProxy
        ? { ...requestBody, apiKey, baseUrl, apiFormat: 'anthropic' }
        : requestBody)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error?.message || `API 请求失败: ${response.status}`);
    }
    const data = await response.json();
    return data.content[0].text;

  } else {
    // OpenAI 图像消息同样使用服务器端的 API Key。
    const openaiImageMessage = {
      role: 'user',
      content: [
        { type: 'text', text: '请结合我们的对话内容，描述或回应这张图片。' },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
      ]
    };
    const messages = finalSystemPrompt
      ? [{ role: 'system', content: finalSystemPrompt }, ...contextMessages, openaiImageMessage]
      : [...contextMessages, openaiImageMessage];

    const payload = await fitOpenAIChatPayload({
      messages, stream: false,
      model: getSelectedOpenAIModel(),
      reasoning_effort: getSelectedOpenAIReasoningEffort()
    }, { compressImage: compressVisionDataUrl });
    const response = await fetchWithRetry(CHAT_PROXY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error?.message || `API 请求失败: ${response.status}`);
    }
    const data = await response.json();
    recordApiUsage(data.usage, data.model);
    saveSuccessfulOpenAISelection(response, data.model);
    return data.choices?.[0]?.message?.content || '';
  }
}

/**
 * 将文件转换为 Base64
 */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
