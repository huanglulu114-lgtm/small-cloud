// Chat model preferences stored only in the user's browser.
// The Cloudflare Function separately validates every requested model ID.
export const OPENAI_MODEL_STORAGE_KEY = 'smallCloudOpenAIModel';
export const DEFAULT_OPENAI_MODEL = 'gpt-6-luna';
export const OPENAI_MODEL_OPTIONS = [
  { id: 'gpt-6-luna', label: 'GPT-6 Luna · 省钱、快速' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna · 旧版' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra · 更高性能' }
];

export function getSelectedOpenAIModel() {
  const selected = localStorage.getItem(OPENAI_MODEL_STORAGE_KEY);
  return OPENAI_MODEL_OPTIONS.some(m => m.id === selected)
    ? selected
    : DEFAULT_OPENAI_MODEL;
}
