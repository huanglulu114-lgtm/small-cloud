<template>
  <div class="usage-page">
    <header class="topbar">
      <button class="back" aria-label="返回" @click="router.back()">‹</button>
      <strong>API 用量与余额</strong>
      <button class="refresh" @click="refresh">刷新</button>
    </header>

    <main>
      <div class="section-title">本机聊天消耗 · 美元预估</div>
      <section class="card">
        <div class="metrics">
          <div>
            <div class="muted">今天</div>
            <div class="large">{{ usd(stats.today.cost) }}</div>
            <div class="muted small">{{ stats.today.requests }} 次请求</div>
          </div>
          <div>
            <div class="muted">本月</div>
            <div class="large">{{ usd(stats.month.cost) }}</div>
            <div class="muted small">{{ stats.month.requests }} 次请求</div>
          </div>
        </div>
        <div class="divider"></div>
        <div class="line"><span>累计输入 Token</span><strong>{{ number(stats.all.input) }}</strong></div>
        <div class="line"><span>其中缓存 Token</span><strong>{{ number(stats.all.cached) }}</strong></div>
        <div class="line"><span>累计输出 Token</span><strong>{{ number(stats.all.output) }}</strong></div>
        <div class="line"><span>累计聊天请求</span><strong>{{ number(stats.all.requests) }}</strong></div>
        <div class="line"><span>累计预估费用</span><strong>{{ usd(stats.all.cost) }}</strong></div>
      </section>
      <p class="hint">仅统计这台设备从安装此功能后成功返回 Token 用量的聊天。费用按照已识别模型的公开价格估算，不是实际账单；其他设备、应用、折扣和税费不在内。</p>
      <p class="hint" v-if="!stats.firstRecorded">目前还没有用量记录。下一次聊天成功后会开始统计。</p>
      <p class="hint warning" v-if="stats.all.unknown">有 {{ stats.all.unknown }} 次模型价格未识别，以上预估费用不包含这些请求。</p>

      <div class="section-title">官方账户余额</div>
      <section class="card">
        <div class="line"><span>预付余额</span><strong>到 OpenAI 官网查看</strong></div>
        <p class="hint inside">普通聊天 API Key 无法查询整个组织的真实余额。不要把本机预估费用当成账户余额。</p>
        <a class="link primary" href="https://platform.openai.com/settings/organization/billing/overview" target="_blank" rel="noopener noreferrer">查看官方余额与充值</a>
        <a class="link secondary" href="https://platform.openai.com/usage" target="_blank" rel="noopener noreferrer">查看官方用量和费用</a>
      </section>

      <div class="section-title">余额参考（可选）</div>
      <section class="card">
        <div class="line">
          <label for="balance-amount">手动记下官网余额（USD）</label>
          <input id="balance-amount" v-model="balanceInput" type="number" inputmode="decimal" min="0" step="0.01" placeholder="10.00"/>
        </div>
        <div v-if="stats.balance" class="line"><span>记录时间</span><span>{{ date(stats.balance.date) }}</span></div>
        <div v-if="stats.balance" class="line"><span>本机推算剩余</span><strong>{{ stats.estimatedRemaining === null ? '无法估算' : usd(stats.estimatedRemaining) }}</strong></div>
        <button class="save" @click="saveBalance">保存余额快照</button>
        <p v-if="balanceError" class="error">{{ balanceError }}</p>
        <p class="hint inside">参考余额需手动从官网填一次。推算只扣除这台设备之后记录的费用，忽略充值、退款及其他用量，不是真实的实时余额。</p>
      </section>
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { getApiUsageSummary, saveBalanceReference } from '../services/apiUsage';

const router = useRouter();
const stats = ref(getApiUsageSummary());
const balanceInput = ref('');
const balanceError = ref('');
const number = value => new Intl.NumberFormat('en-US').format(value || 0);
const usd = value => {
  if (!Number.isFinite(value)) return '未知';
  const digits = value !== 0 && Math.abs(value) < 0.01 ? 5 : 2;
  return '$' + Number(value).toFixed(digits);
};
const date = iso => new Date(iso).toLocaleString('zh-CN', { hour12: false });
function refresh() {
  stats.value = getApiUsageSummary();
}
function saveBalance() {
  try {
    saveBalanceReference(balanceInput.value);
    balanceError.value = '';
    refresh();
  } catch (error) {
    balanceError.value = error.message;
  }
}
onMounted(() => {
  refresh();
  if (stats.value.balance) balanceInput.value = String(stats.value.balance.amount);
});
</script>

<style scoped>
.usage-page { height: 100dvh; overflow: hidden; background: #f5f4ed; color: #5c504d; display: flex; flex-direction: column; font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; }
.topbar { display: flex; align-items: center; justify-content: space-between; height: 58px; padding: 0 18px; flex: none; background: #faf9f5; font-size: 17px; }
.back, .refresh { border: 0; background: none; color: #c57455; font-weight: 600; }
.back { font-size: 30px; line-height: 1; padding: 5px 14px 5px 0; }
.refresh { font-size: 14px; }
main { overflow-y: auto; padding: 4px 18px calc(45px + env(safe-area-inset-bottom)); }
.section-title { font-size: 13px; font-weight: 600; color: #978e86; margin: 26px 5px 11px; }
.card { background: #faf9f5; border-radius: 19px; padding: 21px 20px; box-shadow: 0 7px 24px rgba(132,100,71,.06); }
.metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.large { font-size: 25px; font-weight: 750; margin: 10px 0 5px; letter-spacing: -.4px; overflow-wrap: anywhere; }
.muted { color: #978e86; font-size: 13px; }
.small { font-size: 12px; }
.divider { border-top: 1px solid #e9e4dd; margin: 20px 0 7px; }
.line { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 0; font-size: 14px; }
.line span:first-child { color: #978e86; }
.line strong { text-align: right; font-size: 14px; }
.line input { background: white; border: 1px solid #e0d8cf; padding: 10px; border-radius: 10px; width: 115px; min-width: 0; text-align: right; color: #5c504d; font-size: 16px; }
.hint { font-size: 12px; line-height: 1.7; color: #978e86; margin: 12px 5px; }
.hint.inside { margin: 10px 0; }
.warning, .error { color: #ba5944; }
.error { font-size: 12px; }
.link { display: block; text-align: center; padding: 13px; border-radius: 13px; font-size: 14px; font-weight: 650; margin: 13px 0 0; text-decoration: none; }
.primary, .save { background: #cb795b; color: white; }
.secondary { border: 1px solid #cb795b; color: #cb795b; }
.save { width: 100%; padding: 13px; font-size: 14px; font-weight: 650; border: 0; border-radius: 13px; margin: 10px 0 2px; }
</style>
