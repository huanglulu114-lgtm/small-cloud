// Local, approximate per-request usage statistics. Never store API credentials here.
// Records start when this feature is installed and are scoped to this browser.
const STORAGE_KEY = 'xiaoshouji_api_usage_v1';
const BALANCE_KEY = 'xiaoshouji_api_balance_reference_v1';
const PRICE_USD_PER_MILLION = {
  // Standard API prices per million tokens; estimates exclude non-token charges.
  'gpt-6-luna': { input: 0.10, cached: 0.01, output: 0.50 },
  'gpt-5.6-luna': { input: 0.20, cached: 0.02, output: 1.20 },
  'gpt-5.6-terra': { input: 2, cached: 0.2, output: 12 },
  'gpt-4o-mini': { input: 0.15, cached: 0.075, output: 0.6 }
};

function readRecords() {
  try {
    const records = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(records) ? records : [];
  } catch { return []; }
}

function localDay(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function priceOf(model) {
  const name = String(model || '').toLowerCase();
  if (name.startsWith('gpt-6-luna')) return PRICE_USD_PER_MILLION['gpt-6-luna'];
  if (name.startsWith('gpt-5.6-luna')) return PRICE_USD_PER_MILLION['gpt-5.6-luna'];
  if (name.startsWith('gpt-5.6-terra')) return PRICE_USD_PER_MILLION['gpt-5.6-terra'];
  if (name.startsWith('gpt-4o-mini')) return PRICE_USD_PER_MILLION['gpt-4o-mini'];
  return null;
}

export function recordApiUsage(usage, model) {
  if (!usage || typeof usage !== 'object') return;
  const input = Number(usage.prompt_tokens ?? usage.input_tokens);
  const output = Number(usage.completion_tokens ?? usage.output_tokens);
  if (!Number.isFinite(input) || !Number.isFinite(output) ||
      input < 0 || output < 0) return;

  const cachedRaw = Number(usage.prompt_tokens_details?.cached_tokens ??
    usage.input_tokens_details?.cached_tokens ?? 0);
  const cached = Number.isFinite(cachedRaw)
    ? Math.min(input, Math.max(0, cachedRaw)) : 0;
  const price = priceOf(model);
  const cost = price
    ? ((input - cached) * price.input + cached * price.cached + output * price.output) / 1_000_000
    : null;

  try {
    const records = readRecords();
    records.push({
      date: new Date().toISOString(),
      model: String(model || 'unknown'),
      input, cached, output, cost
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(-3000)));
  } catch {
    // Browsers can disable storage; never interrupt chats for a statistics failure.
  }
}

const emptyTotals = () => ({ requests: 0, input: 0, cached: 0, output: 0, cost: 0, unknown: 0 });
function aggregate(records) {
  return records.reduce((acc, record) => {
    acc.requests += 1;
    acc.input += Number(record.input) || 0;
    acc.cached += Number(record.cached) || 0;
    acc.output += Number(record.output) || 0;
    if (Number.isFinite(record.cost)) acc.cost += record.cost;
    else acc.unknown++;
    return acc;
  }, emptyTotals());
}

export function getApiUsageSummary() {
  const records = readRecords();
  const today = localDay(new Date().toISOString());
  const month = today.slice(0, 7);
  const base = getBalanceReference();
  const costsSinceBalance = base
    ? aggregate(records.filter(r => new Date(r.date).getTime() >= new Date(base.date).getTime()))
    : null;
  return {
    today: aggregate(records.filter(r => localDay(r.date) === today)),
    month: aggregate(records.filter(r => localDay(r.date).startsWith(month))),
    all: aggregate(records),
    firstRecorded: records[0]?.date || null,
    balance: base,
    afterBalance: costsSinceBalance,
    estimatedRemaining: base && costsSinceBalance && costsSinceBalance.unknown === 0
      ? base.amount - costsSinceBalance.cost
      : null
  };
}

export function getBalanceReference() {
  try {
    const raw = JSON.parse(localStorage.getItem(BALANCE_KEY) || 'null');
    return raw && Number.isFinite(raw.amount) && raw.amount >= 0 &&
      Number.isFinite(new Date(raw.date).getTime()) ? raw : null;
  } catch { return null; }
}

export function saveBalanceReference(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || String(value).trim() === '') {
    throw new Error('请输入有效的美元余额');
  }
  const reference = { amount, date: new Date().toISOString() };
  localStorage.setItem(BALANCE_KEY, JSON.stringify(reference));
  return reference;
}
