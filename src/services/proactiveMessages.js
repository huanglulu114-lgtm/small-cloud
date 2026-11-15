// Lightweight, opt-in autonomous messages while the small-cloud app is open.
// Browser storage is local: this does not create push notifications for a closed app.
import { conversationService, messageService } from './db';
import { chatOrchestrator } from './chatOrchestrator';

export const PROACTIVE_ENABLED_KEY = 'smallCloudProactiveEnabled';
export const PROACTIVE_WALLET_KEY = 'smallCloudProactiveWalletEnabled';
const STATE_KEY = 'smallCloudProactiveStateV1';
const LOCK_KEY = 'smallCloudProactiveLockV1';
const EVENT_NAME = 'smallcloud:proactive-message';
const MIN_IDLE_MS = 2 * 60 * 60 * 1000;
const MIN_GAP_MS = 4 * 60 * 60 * 1000;
const MAX_PER_DAY = 2;
let checking = false;

const localDay = () => {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')].join('-');
};

function loadState() {
  try {
    const state = JSON.parse(localStorage.getItem(STATE_KEY) || '{}');
    return state.day === localDay()
      ? state
      : { day: localDay(), count: 0, lastAttempt: 0, lastSuccess: 0 };
  } catch {
    return { day: localDay(), count: 0, lastAttempt: 0, lastSuccess: 0 };
  }
}

function acquireLock() {
  const now = Date.now();
  try {
    const old = JSON.parse(localStorage.getItem(LOCK_KEY) || '{}');
    if (old.until > now) return null;
    const token = String(now) + ':' + Math.random().toString(36).slice(2);
    localStorage.setItem(LOCK_KEY, JSON.stringify({ token, until: now + 120000 }));
    if (JSON.parse(localStorage.getItem(LOCK_KEY) || '{}').token === token) return token;
  } catch { return null; }
  return null;
}

function releaseLock(token) {
  try {
    const current = JSON.parse(localStorage.getItem(LOCK_KEY) || '{}');
    if (current.token === token) localStorage.removeItem(LOCK_KEY);
  } catch {
    // Optional feature must not interrupt navigation or manual chat.
  }
}

async function selectConversation() {
  const all = (await conversationService.getAll()).filter(c => !c.source && c.role);
  if (!all.length) return null;
  // Prefer the requested companion. Avoid unsolicited messages from arbitrary
  // characters when there are multiple independent roles.
  const named = all.filter(c => c.role.name?.trim() === '叶洵');
  if (named.length) return named.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  return all.length === 1 ? all[0] : null;
}

export async function checkForProactiveMessage(currentPath = '') {
  if (checking || localStorage.getItem(PROACTIVE_ENABLED_KEY) === 'false' ||
      document.visibilityState !== 'visible') return;

  // No intrusive calls at night or while the current conversation is open.
  const hour = new Date().getHours();
  if (hour < 9 || hour >= 22 || currentPath.startsWith('/chat/')) return;

  checking = true;
  let token = null;
  try {
    const state = loadState();
    const now = Date.now();
    if (state.count >= MAX_PER_DAY || now - state.lastSuccess < MIN_GAP_MS ||
        now - state.lastAttempt < 60 * 60 * 1000) return;

    const conv = await selectConversation();
    if (!conv) return;

    const msgs = await messageService.getByConversation(conv.id);
    if (msgs.length === 0 || !msgs.some(m => m.role === 'user')) return;
    const latest = msgs[msgs.length - 1];
    const latestAt = Number(latest.timestamp || conv.updatedAt || 0);
    if (!latestAt || now - latestAt < MIN_IDLE_MS) return;

    token = acquireLock();
    if (!token) return;
    const next = { ...state, lastAttempt: now };
    localStorage.setItem(STATE_KEY, JSON.stringify(next));

    const result = await chatOrchestrator.reply({
      roleId: conv.roleId,
      conversationId: conv.id,
      channel: 'wechat',
      trigger: 'proactive'
    });
    const created = result.createdMessages || [];
    if (!created.length) return;

    const latestState = loadState();
    localStorage.setItem(STATE_KEY, JSON.stringify({
      ...latestState,
      day: localDay(),
      count: (latestState.count || 0) + 1,
      lastSuccess: Date.now()
    }));
    const text = created.find(m => m.type === 'text')?.content ||
      (created.some(m => m.type === 'transfer') ? '[虚拟转账]' : '[虚拟红包]');
    window.dispatchEvent(new CustomEvent(EVENT_NAME, {
      detail: { conversationId: conv.id, roleName: conv.role.name || '新消息', preview: text.slice(0, 90) }
    }));
  } catch (error) {
    // Proactive calls are best effort. Never interrupt manual messages.
    console.warn('主动消息暂时未发送:', error.message);
  } finally {
    if (token) releaseLock(token);
    checking = false;
  }
}

export function startProactiveMessages(getPath = () => '') {
  const run = () => { void checkForProactiveMessage(getPath()); };
  const timer = setInterval(run, 90 * 1000);
  const startup = setTimeout(run, 8000);
  const visible = () => { if (document.visibilityState === 'visible') run(); };
  document.addEventListener('visibilitychange', visible);
  return () => {
    clearTimeout(startup);
    clearInterval(timer);
    document.removeEventListener('visibilitychange', visible);
  };
}
