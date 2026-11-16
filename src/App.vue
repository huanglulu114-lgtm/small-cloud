<template>
  <div id="app">
    <router-view v-slot="{ Component, route }">
      <component :is="Component" :key="route.path" />
    </router-view>
    <button v-if="proactiveNotice" class="proactive-notice" type="button" @click="openProactiveChat">
      <strong>{{ proactiveNotice.roleName }} · 新消息</strong>
      <span>{{ proactiveNotice.preview }}</span>
    </button>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { startProactiveMessages } from './services/proactiveMessages';
import { startCloudSync } from './services/cloudSync';
import { syncNotionMemory } from './services/notionMemoryCache';

const router = useRouter();
const proactiveNotice = ref(null);
let stopProactive = null;
let stopSync = null;
let noticeTimer = null;
const showProactiveMessage = event => {
  proactiveNotice.value = event.detail;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { proactiveNotice.value = null; }, 9000);
};
const openProactiveChat = () => {
  if (proactiveNotice.value?.conversationId) {
    router.push('/chat/' + proactiveNotice.value.conversationId);
    proactiveNotice.value = null;
  }
};

const refreshNotionWhenVisible = () => {
  if (document.visibilityState === 'visible') void syncNotionMemory();
};
const updateVisualViewportHeight = () => {
  const height = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty('--vvh', `${height}px`);
};

onMounted(() => {
  stopProactive = startProactiveMessages(() => router.currentRoute.value.path);
  stopSync = startCloudSync();
  // Import once on this device, then check Notion edit times at most daily.
  void syncNotionMemory();
  document.addEventListener('visibilitychange', refreshNotionWhenVisible);
  window.addEventListener('smallcloud:proactive-message', showProactiveMessage);
  updateVisualViewportHeight();
  window.visualViewport?.addEventListener('resize', updateVisualViewportHeight);
});

onUnmounted(() => {
  stopProactive?.();
  stopSync?.();
  document.removeEventListener('visibilitychange', refreshNotionWhenVisible);
  if (noticeTimer) clearTimeout(noticeTimer);
  window.removeEventListener('smallcloud:proactive-message', showProactiveMessage);
  window.visualViewport?.removeEventListener('resize', updateVisualViewportHeight);
});
</script>

<style>
#app {
  width: 100%;
  height: 100%;
  background-color: #EDEDED;
  overflow: hidden;
}
.proactive-notice {
  position: fixed;
  top: calc(env(safe-area-inset-top) + 14px);
  left: 16px;
  right: 16px;
  z-index: 10000;
  width: calc(100% - 32px);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 14px 18px;
  border: none;
  border-radius: 16px;
  color: #38332f;
  background: #faf9f5;
  box-shadow: 0 6px 24px rgba(0,0,0,.18);
  font-size: 14px;
  text-align: left;
}
.proactive-notice span {
  display: block;
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 13px;
  color: #776f6b;
}
</style>
