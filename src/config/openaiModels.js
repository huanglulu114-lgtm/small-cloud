// Chat model preferences stored only in the user's browser.
// The Cloudflare Function separately validates every requested model ID.
export const OPENAI_MODEL_STORAGE_KEY = 'smallCloudOpenAIModel';
export const DEFAULT_OPENAI_MODEL = 'gpt-6-luna';
export const OPENAI_MODEL_OPTIONS = [
  { id: 'gpt-6-luna', label: 'GPT-6 Luna · 省钱、快速' },
  { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra · 新版、擅长写作' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna · 旧版' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra · 更高性能' }
];

export function getSelectedOpenAIModel() {
  const selected = localStorage.getItem(OPENAI_MODEL_STORAGE_KEY);
  return OPENAI_MODEL_OPTIONS.some(m => m.id === selected)
    ? selected
    : DEFAULT_OPENAI_MODEL;
}


// These are actual OpenAI API reasoning_effort parameters, not decorative labels.
export const OPENAI_REASONING_STORAGE_KEY = 'smallCloudOpenAIReasoningByModel';
export const OPENAI_LAST_SUCCESS_KEY = 'smallCloudOpenAILastSuccess';
export const OPENAI_REASONING_OPTIONS = [
  { value: 'low', label: '低 · 更快、通常更省 Token' },
  { value: 'medium', label: '中 · 均衡' },
  { value: 'high', label: '高 · 深度思考、可能更慢更贵' }
];
const reasoningValues = new Set(OPENAI_REASONING_OPTIONS.map(x => x.value));

export function getSelectedOpenAIReasoningEffort(model = getSelectedOpenAIModel()) {
  try {
    const saved = JSON.parse(localStorage.getItem(OPENAI_REASONING_STORAGE_KEY) || '{}');
    return reasoningValues.has(saved?.[model]) ? saved[model] : 'low';
  } catch { return 'low'; }
}

export function saveSelectedOpenAIReasoningEffort(model, effort) {
  if (!OPENAI_MODEL_OPTIONS.some(x => x.id === model) || !reasoningValues.has(effort)) {
    throw new Error('模型或推理档位不受支持');
  }
  let settings = {};
  try { settings = JSON.parse(localStorage.getItem(OPENAI_REASONING_STORAGE_KEY) || '{}') || {}; }
  catch { /* Ignore damaged preferences. */ }
  localStorage.setItem(OPENAI_REASONING_STORAGE_KEY, JSON.stringify({ ...settings, [model]: effort }));
}

export function getLastSuccessfulOpenAISelection() {
  try {
    const value = JSON.parse(localStorage.getItem(OPENAI_LAST_SUCCESS_KEY) || 'null');
    return value && typeof value.model === 'string' &&
      reasoningValues.has(value.effort) ? value : null;
  } catch { return null; }
}
