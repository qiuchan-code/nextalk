<script setup>
import { ref, onMounted } from 'vue'
import { useCharacters } from '../lib/characters.js'
import { useGroups } from '../lib/groups.js'

defineProps({
  activeId: { type: String, default: '' }
})
const emit = defineEmits(['pick', 'create', 'edit', 'pick-group', 'edit-group'])

const chars = useCharacters()
const groups = useGroups()
const menuFor = ref('') // 当前展开菜单的角色 id
const menuGroupFor = ref('') // 当前展开菜单的房间 id
// 加载失败时给个看得见的原因，而不是永远"翻开中"
const loadError = ref('')
onMounted(() => {
  reloadAll()
})

function reloadAll() {
  loadError.value = ''
  chars.reload().catch((err) => {
    loadError.value = String(err?.message || err)
  })
  groups.reload().catch(() => {})
}

function toggleMenu(id) {
  menuFor.value = menuFor.value === id ? '' : id
}

async function del(id) {
  menuFor.value = ''
  const c = chars.state.list.find((x) => x.id === id)
  if (!confirm(`确定删掉「${c.name}」吗？它名下的会话、记忆都会一起消失。`)) return
  await chars.removeCharacter(id)
}

function toggleGroupMenu(id) {
  menuGroupFor.value = menuGroupFor.value === id ? '' : id
}

async function delGroup(id) {
  menuGroupFor.value = ''
  const g = groups.state.list.find((x) => x.id === id)
  if (!g) return
  if (!confirm(`确定拆掉「${g.name}」吗？这个房间里的聊天记录都会一起消失。角色们没事。`)) return
  await groups.removeGroup(id)
}

function memberChar(id) {
  return chars.state.list.find((c) => c.id === id)
}

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
        <div
          v-for="c in chars.state.list"
          :key="c.id"
          class="photo-wrap"
          :style="{ transform: `rotate(${tilt(c.name)}deg)` }"
        >
          <button class="photo" :class="{ on: c.id === activeId }" @click="emit('pick', c.id)">
            <div class="polaroid">
              <div v-if="c.avatar" class="img-holder">
                <img :src="c.avatar" :alt="c.name" />
              </div>
              <div v-else class="img-holder placeholder hand">{{ c.name.slice(0, 1) }}</div>
              <span class="tape"></span>
            </div>
            <span class="photo-name hand">{{ c.name }}</span>
          </button>
          <button class="more hand" @click.stop="toggleMenu(c.id)">⋯</button>
          <div v-if="menuFor === c.id" class="card-menu paper-card">
            <button class="menu-item hand" @click="emit('edit', c.id); menuFor = ''">改它</button>
            <button class="menu-item danger hand" @click="del(c.id)">删掉</button>
          </div>
        </div>
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

    <div v-else-if="loadError" class="empty">
      <div class="paper-card empty-card">
        <span class="tape pink"></span>
        <p class="hand big">打不开了</p>
        <p class="note">{{ loadError }}</p>
        <button class="btn primary start" @click="reloadAll">再试一次</button>
      </div>
    </div>

    <div v-else class="empty note">翻开中…</div>

    <!-- 房间：一组角色待在一起的群。规矩是点谁谁说话 -->
    <div v-if="groups.state.loaded && (groups.state.list.length || chars.state.list.length)" class="rooms">
      <h2 class="hand note intro">房间 <span class="count">× {{ groups.state.list.length }}</span></h2>

      <div v-if="groups.state.list.length" class="room-wall">
        <div v-for="g in groups.state.list" :key="g.id" class="room-wrap">
          <button
            class="room-card paper-card"
            :style="{ transform: `rotate(${tilt(g.name)}deg)` }"
            @click="emit('pick-group', g.id)"
          >
            <span class="tape blue mini-tape"></span>
            <span class="hand room-name">{{ g.name }}</span>
            <span class="note room-desc">{{ g.desc || '一个说不上来要干什么的群。' }}</span>
            <span class="room-members">
              <span v-for="id in g.charIds" :key="id" class="rm-avatar-wrap">
                <img v-if="memberChar(id)?.avatar" :src="memberChar(id).avatar" class="rm-avatar" alt="" />
                <span v-else class="rm-avatar ph hand">{{ (memberChar(id)?.name || '？').slice(0, 1) }}</span>
              </span>
            </span>
          </button>
          <button class="more room-more" @click.stop="toggleGroupMenu(g.id)">⋯</button>
          <div v-if="menuGroupFor === g.id" class="card-menu paper-card">
            <button class="menu-item hand" @click="emit('edit-group', g.id); menuGroupFor = ''">改房间</button>
            <button class="menu-item danger hand" @click="delGroup(g.id)">拆掉</button>
          </div>
        </div>
      </div>
      <p v-else class="note rooms-empty">还没有房间。房间＝拉几个角色待在一起的群，像真的群那样聊，也只对你一个人表演。</p>

      <div class="room-actions">
        <button
          class="btn room-add"
          :disabled="chars.state.list.length < 2"
          @click="emit('edit-group', '')"
        >
          ＋ 搭一个房间
        </button>
        <p v-if="chars.state.loaded && chars.state.list.length < 2" class="note rooms-empty">
          先捏至少两个角色，才有资格拉群。
        </p>
      </div>
    </div>
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

.photo-wrap {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
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
  transform: scale(1.03);
}

.more {
  position: absolute;
  top: -4px;
  right: -8px;
  width: 26px;
  height: 26px;
  font-size: 17px;
  line-height: 1;
  color: var(--ink-soft);
  background: var(--paper-card);
  border: 1px solid var(--paper-edge);
  border-radius: 50%;
  cursor: pointer;
  box-shadow: var(--shadow-card);
  transform: rotate(4deg);
  z-index: 2;
}

.card-menu {
  position: absolute;
  top: 20px;
  right: -6px;
  z-index: 3;
  min-width: 84px;
  padding: 5px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-shadow: var(--shadow-lift);
}
.menu-item {
  font-size: 14px;
  color: var(--ink);
  background: transparent;
  border: none;
  padding: 7px 10px;
  text-align: left;
  cursor: pointer;
  border-radius: 2px;
}
.menu-item:hover {
  background: rgba(201, 165, 90, 0.14);
}
.menu-item.danger {
  color: var(--ink-red);
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

/* ——— 房间：一排群名片 ——— */
.rooms {
  margin-top: 34px;
}
.room-wall {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.room-wrap {
  position: relative;
}
.room-card {
  display: block;
  width: 100%;
  max-width: 420px;
  text-align: left;
  padding: 13px 16px 12px;
  background: #fdfbf2;
  border: 1px solid var(--paper-edge);
  border-radius: 3px;
  cursor: pointer;
  box-shadow: var(--shadow-card);
  transition: transform 0.12s, box-shadow 0.12s;
}
.room-card:hover {
  transform: scale(1.005) !important; /* 不盖掉旋转，只轻微放大 */
  box-shadow: var(--shadow-lift);
}
.mini-tape {
  width: 54px;
  height: 17px;
  top: -8px;
  left: 30px;
  margin-left: 0;
  transform: rotate(-4deg);
}
.room-name {
  display: block;
  font-size: 17px;
  color: var(--ink);
  letter-spacing: 0.5px;
  margin: 6px 0 3px;
}
.room-desc {
  display: block;
  font-size: 13px;
  line-height: 1.6;
  margin: 0 0 9px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.room-members {
  display: flex;
  align-items: center;
  gap: -6px;
}
.rm-avatar-wrap {
  margin-right: -7px;
  position: relative;
}
.rm-avatar-wrap:first-child {
  margin-left: 3px;
}
.rm-avatar {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  object-fit: cover;
  border: 2px solid #fdfbf2;
  background: #efe8d6;
  display: grid;
  place-items: center;
  box-shadow: var(--shadow-card);
}
.rm-avatar.ph {
  font-size: 14px;
  color: var(--ink-pencil);
}
.room-more {
  top: 4px;
  right: 4px;
}
.rooms-empty {
  font-size: 13px;
  line-height: 1.7;
  margin: 2px 0 10px;
}
.room-actions .room-add {
  margin-top: 12px;
}
.room-actions .rooms-empty {
  margin: 10px 0 0;
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
