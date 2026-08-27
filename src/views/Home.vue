<script setup>
import { onMounted } from 'vue'
import { useCharacters } from '../lib/characters.js'

defineProps({
  activeId: { type: String, default: '' }
})
const emit = defineEmits(['pick', 'create'])

const chars = useCharacters()
onMounted(chars.reload)

// 每个角色的卡片歪向不同方向，用它的名字哈希，稳一点（不随渲染随机跳）
function tilt(name) {
  let n = 0
  for (const c of name) n = (n * 31 + c.charCodeAt(0)) & 0xffff
  return ((n / 0xffff) * 2.2 - 1.1).toFixed(1)
}
</script>

<template>
  <div class="home">
    <template v-if="chars.state.loaded && chars.state.list.length">
      <h2 class="hand note intro">你的角色们 <span class="count">× {{ chars.state.list.length }}</span></h2>

      <!-- 像贴在纸上的照片墙，故意不排成整齐网格 -->
      <div class="wall">
        <button
          v-for="c in chars.state.list"
          :key="c.id"
          class="photo"
          :class="{ on: c.id === activeId }"
          :style="{ transform: `rotate(${tilt(c.name)}deg)` }"
          @click="emit('pick', c.id)"
        >
          <div class="polaroid">
            <div v-if="c.avatar" class="img-holder">
              <img :src="c.avatar" :alt="c.name" />
            </div>
            <div v-else class="img-holder placeholder hand">{{ c.name.slice(0, 1) }}</div>
            <span class="tape"></span>
          </div>
          <span class="photo-name hand">{{ c.name }}</span>
        </button>
      </div>

      <button class="btn add" @click="emit('create')">＋ 捏一个新的</button>
    </template>

    <div v-else-if="chars.state.loaded" class="empty">
      <div class="paper-card empty-card">
        <span class="tape pink"></span>
        <p class="hand big">还没有角色</p>
        <p class="note">先捏一个，设定它的名字、性格和背景，让它开始跟你说话。</p>
        <button class="btn primary start" @click="emit('create')">去捏第一个</button>
      </div>
    </div>

    <div v-else class="empty note">翻开中…</div>
  </div>
</template>

<style scoped>
.home {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 16px calc(26px + env(safe-area-inset-bottom));
}

.intro {
  color: var(--ink-soft);
  margin: 2px 0 16px;
  transform: rotate(-0.8deg);
}
.count {
  font-size: 13px;
  color: var(--ink-pencil);
}

.wall {
  display: flex;
  flex-wrap: wrap;
  gap: 18px 14px;
}

.photo {
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  transition: transform 0.12s;
}
.photo:hover {
  transform: scale(1.03) !important;
}

.polaroid {
  /* 照片纸是纯白硬纸，摆在米黄纸面上 */
  background: #fbf8f0;
  border: 1px solid var(--paper-edge);
  padding: 6px 6px 4px;
  box-shadow: var(--shadow-card);
  position: relative;
}
.photo.on .polaroid {
  box-shadow: 0 0 0 2px var(--ink), var(--shadow-card);
}

.img-holder {
  width: 128px;
  height: 128px;
  display: grid;
  place-items: center;
  overflow: hidden;
  background: #efe8d6;
}
.img-holder img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.img-holder.placeholder {
  font-size: 52px;
  color: var(--ink-pencil);
}

.photo-name {
  font-size: 16px;
  color: var(--ink);
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.add {
  margin-top: 24px;
}

.empty {
  height: 100%;
  display: grid;
  place-items: center;
}
.empty-card {
  max-width: 320px;
  text-align: center;
  padding: 30px 28px;
  transform: rotate(-1.2deg);
}
.empty-card .big {
  font-size: 20px;
  margin: 8px 0;
  color: var(--ink-soft);
}
.start {
  margin-top: 14px;
}
</style>
