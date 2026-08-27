<script setup>
import { ref, onMounted, computed } from 'vue'
import { loadEvents } from '../lib/memory.js'

const props = defineProps({
  sessionId: { type: String, required: true },
  characterName: { type: String, default: '它' }
})
const emit = defineEmits(['back'])

const events = ref([])
const loaded = ref(false)

onMounted(async () => {
  events.value = await loadEvents(props.sessionId)
  loaded.value = true
})

// 给每条小结贴个色签
const stamp = ['pink', 'blue', 'green', 'yellow']
const stampOf = (i) => stamp[i % stamp.length]

const sorted = computed(() => [...events.value].reverse()) // 新的在上
</script>

<template>
  <div class="book">
    <div class="book-head">
      <button class="btn ghost" @click="emit('back')">‹ 回到聊天</button>
      <h2 class="hand title">事件簿</h2>
      <span class="note sub">与「{{ characterName }}」的剧情小结</span>
    </div>

    <div class="list">
      <div v-if="loaded && !sorted.length" class="empty">
        <div class="empty-card paper-card">
          <span class="tape green"></span>
          <p class="hand big">还没写完</p>
          <p class="note">多聊几句，它会把重要的片段记成一则则小结放这里。</p>
        </div>
      </div>

      <div v-for="(e, i) in sorted" :key="e.id" class="entry paper-card" :style="{ '--t': (i % 2 ? 0.7 : -0.7) + 'deg' }">
        <span class="tape" :class="stampOf(i)"></span>
        <div class="entry-head">
          <span class="hand label">{{ e.title }}</span>
          <span class="note date">{{ new Date(e.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }}</span>
        </div>
        <p class="entry-text hand">{{ e.text }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.book {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.book-head {
  flex: none;
  padding: 10px 16px 8px;
  border-bottom: 1.5px dashed var(--line);
}
.title {
  margin: 0;
  font-size: 20px;
  letter-spacing: 1px;
  transform: rotate(-1deg);
}
.sub {
  font-size: 13px;
  color: var(--ink-pencil);
}

.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 22px 16px calc(24px + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  gap: 18px;
  align-items: center;
}

.empty {
  flex: 1;
  display: grid;
  place-items: center;
}
.empty-card {
  max-width: 300px;
  text-align: center;
  padding: 28px 26px;
  transform: rotate(-1.3deg);
}
.empty-card .big {
  font-size: 19px;
  margin: 6px 0 8px;
  color: var(--ink-soft);
}

.entry {
  width: 100%;
  max-width: 540px;
  transform: rotate(var(--t));
  padding: 16px 18px 13px;
}
.entry-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 6px;
}
.label {
  font-size: 16px;
  color: var(--ink);
}
.date {
  font-size: 12px;
  color: var(--ink-pencil);
  flex: none;
}
.entry-text {
  margin: 0;
  font-size: 15px;
  line-height: 1.8;
  color: var(--ink-soft);
}
</style>
