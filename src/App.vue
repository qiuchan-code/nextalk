<script setup>
import { ref, computed } from 'vue'
import Chat from './views/Chat.vue'
import Settings from './views/Settings.vue'
import { isConfigured } from './lib/settings.js'

// 没配 Key 的话直接把人送到设置页，省得对着一个不能用的输入框发呆
const view = ref(isConfigured() ? 'chat' : 'settings')

// 小彩蛋：标题旁边的手写批注按时间变
const subtitle = computed(() => {
  const h = new Date().getHours()
  if (h < 5) return '这个点还没睡…'
  if (h < 9) return '早上好呀'
  if (h < 12) return '上午'
  if (h < 14) return '午休时间'
  if (h < 18) return '下午茶？'
  if (h < 23) return '晚上好'
  return '夜深了'
})
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <h1 class="hand">纸片人</h1>
      <span class="note subtitle">{{ subtitle }}</span>
    </div>
    <nav class="nav">
      <button class="tab hand" :class="{ on: view === 'chat' }" @click="view = 'chat'">聊天</button>
      <button class="tab hand" :class="{ on: view === 'settings' }" @click="view = 'settings'">
        设置
      </button>
    </nav>
  </header>

  <main class="stage">
    <Chat v-show="view === 'chat'" @need-settings="view = 'settings'" />
    <Settings v-if="view === 'settings'" @done="view = 'chat'" />
  </main>
</template>

<style scoped>
.topbar {
  flex: none;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  padding: 10px 16px 8px;
  padding-top: calc(10px + env(safe-area-inset-top));
  border-bottom: 1.5px solid var(--line);
  /* 底边画成手撕纸的感觉：再叠一条歪的虚线 */
  position: relative;
}
.topbar::after {
  content: '';
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: -4px;
  height: 1px;
  border-bottom: 1px dashed rgba(150, 135, 105, 0.35);
  transform: rotate(-0.25deg);
}

.brand {
  display: flex;
  align-items: baseline;
  gap: 9px;
}
.brand h1 {
  margin: 0;
  font-size: 25px;
  letter-spacing: 2px;
  color: var(--ink);
  transform: rotate(-1.2deg);
}
.subtitle {
  transform: rotate(1deg);
  font-size: 13px;
}

.nav {
  display: flex;
  gap: 6px;
}
.tab {
  font-size: 15px;
  color: var(--ink-pencil);
  background: transparent;
  border: none;
  padding: 4px 10px 3px;
  cursor: pointer;
  border-bottom: 2.5px solid transparent;
}
.tab.on {
  color: var(--ink);
  /* 选中的标签像被荧光笔涂过 */
  background: linear-gradient(transparent 62%, rgba(244, 213, 108, 0.65) 62%);
  border-bottom-color: var(--ink);
}

.stage {
  flex: 1;
  min-height: 0; /* 关键：让子元素能正确滚动而不是撑破容器 */
  display: flex;
  flex-direction: column;
}
</style>
