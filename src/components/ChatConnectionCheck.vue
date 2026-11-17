<template>
  <div class="check-shell">
    <div class="check-heading">聊天连接诊断（不消耗生成 Token）</div>
    <p class="hint">直接在小手机内检测。不会发送聊天记录，也不会修改本地数据。</p>
    <button type="button" class="check-button" :disabled="checking" @click="runCheck">
      {{ checking ? '正在检测连接…' : '检测 Cloudflare 与 OpenAI' }}
    </button>
    <div v-if="resultTitle" class="check-result" :class="{ error: hasError }" role="status">
      <strong>{{ resultTitle }}</strong>
      <p v-for="(detail, index) in resultDetails" :key="index">{{ detail }}</p>
    </div>
    <p class="hint">若检测失败，先不要重复生成，也不要清除 Safari 网站数据。</p>
  </div>
</template>

<script setup>
import { ref, onUnmounted } from 'vue';
import { getSelectedOpenAIModel } from '../config/openaiModels';

const checking = ref(false);
const resultTitle = ref('');
const resultDetails = ref([]);
const hasError = ref(false);
let activeController = null;

onUnmounted(() => { if (activeController) activeController.abort(); });

async function requestProbe(path, method) {
  const controller = new AbortController();
  activeController = controller;
  const timeout = setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {})
      },
      ...(method === 'POST' ? { body: '{"probe":true}' } : {})
    });
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      return { ok: false, stage: 'access_redirect', message: 'Cloudflare 要求重新登录，聊天请求被跳转了。' };
    }
    if (!(response.headers.get('Content-Type') || '').includes('application/json')) {
      return { ok: false, stage: 'not_json', message: '后台没有返回 JSON；可能是登录页面或代理拦截。', httpStatus: response.status };
    }
    const data = await response.json();
    return { ...data, httpStatus: response.status };
  } catch (error) {
    return {
      ok: false,
      stage: error?.name === 'AbortError' ? 'timeout' : 'network',
      message: error?.name === 'AbortError'
        ? '请求超过 18 秒，可能被网络或 VPN 卡住。'
        : 'Safari 网络请求失败：' + String(error?.message || '未知错误')
    };
  } finally {
    clearTimeout(timeout);
    if (activeController === controller) activeController = null;
  }
}

async function runCheck() {
  if (checking.value) return;
  checking.value = true;
  hasError.value = false;
  resultTitle.value = '检查聊天后台中…';
  resultDetails.value = [];
  try {
    const get = await requestProbe('/api/chat?check=1', 'GET');
    if (!get.ok) {
      hasError.value = true;
      resultTitle.value = '连接检查未通过';
      resultDetails.value = [
        'GET 阶段：' + (get.stage || 'unknown'),
        get.httpStatus ? 'HTTP：' + get.httpStatus : '',
        get.message || '请检查 Cloudflare Access 与 VPN'
      ].filter(Boolean);
      return;
    }
    const selected = getSelectedOpenAIModel();
    const modelAvailability = get.supportedModelAvailability || {};
    const visible = modelAvailability[selected];
    resultDetails.value = [
      'GET：通过（OpenAI HTTP ' + (get.openaiStatus || '未知') + '）',
      '选中模型：' + selected,
      visible === true ? '当前模型：模型列表中可见'
        : visible === false ? '当前模型：OpenAI 模型列表中未列出，请核对模型 ID 与权限'
          : '当前模型：模型目录未提供可判断的信息'
    ];
    const post = await requestProbe('/api/chat?probe=1', 'POST');
    if (!post.ok) {
      hasError.value = true;
      resultTitle.value = 'GET 可用，但聊天 POST 通道异常';
      resultDetails.value.push('POST 阶段：' + (post.stage || 'unknown'));
      resultDetails.value.push(post.httpStatus ? 'HTTP：' + post.httpStatus : '');
      resultDetails.value.push(post.message || 'POST 请求未通过');
    } else {
      resultTitle.value = '基础连接测试通过';
      resultDetails.value.push('POST：通过（未发送模型生成请求）');
      if (visible === false) {
        hasError.value = true;
        resultTitle.value = '连接通过，但当前模型可能不可用';
      }
    }
  } finally {
    checking.value = false;
  }
}
</script>

<style scoped>
.check-shell {
  padding: 16px;
  margin: 12px 0 24px;
  background: rgba(127,127,127,.08);
  border-radius: 14px;
  color: inherit;
}
.check-heading { font-size: 15px; font-weight: 600; }
.hint { color: #777; font-size: 12px; margin: 9px 0; line-height: 1.6; }
.check-button {
  width: 100%; border: 0; border-radius: 10px; padding: 12px;
  background: #1778df; color: white; font-size: 14px; font-weight: 600;
}
.check-button:disabled { opacity: .6; }
.check-result { padding: 12px 0 0; font-size: 13px; line-height: 1.6; overflow-wrap:anywhere; }
.check-result p { margin-top: 7px; }
.check-result.error { color: #c23d31; }
</style>
