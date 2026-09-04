<script setup>
import { ref, computed } from 'vue'
import Home from './views/Home.vue'
import CharacterEdit from './views/CharacterEdit.vue'
import Chat from './views/Chat.vue'
import EventBook from './views/EventBook.vue'
import Settings from './views/Settings.vue'
import GroupEdit from './views/GroupEdit.vue'
import GroupChat from './views/GroupChat.vue'
import { isConfigured } from './lib/settings.js'
import { useCharacters } from './lib/characters.js'
import { listSessions, openSession, newSession } from './lib/sessions.js'
import { get, STORES } from './lib/db.js'

const view = ref(isConfigured() ? 'home' : 'settings')
const activeCharacter = ref(null)
const activeSessionId = ref('')
const activeEditId = ref('') // 正在编辑的角色 id，空 = 新建
// 当前角色的全部会话线，聊天气泡上方做切换
const charSessions = ref([])
const chars = useCharacters()
// 房间：当前打开/编辑的房间 id
const activeGroupId = ref('')

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

async function refreshCharSessions(charId) {
  charSessions.value = await listSessions(charId)
}

async function pickCharacter(id) {
  const char = await get(STORES.characters, id)
  if (!char) return
  const session = await openSession(char.id)
  activeCharacter.value = char
  activeSessionId.value = session.id
  await refreshCharSessions(char.id)
  view.value = 'chat'
}

async function switchSession(sid) {
  if (sid === activeSessionId.value) return
  activeSessionId.value = sid
}

async function createSession() {
  if (!activeCharacter.value) return
  const s = await newSession(activeCharacter.value.id)
  await refreshCharSessions(activeCharacter.value.id)
  activeSessionId.value = s.id
}

async function savedCharacter() {
  view.value = 'home'
  await chars.reload()
}

function backHome() {
  activeCharacter.value = null
  activeSessionId.value = ''
  view.value = 'home'
}

function startNew() {
  activeEditId.value = ''
  view.value = 'create'
}

function editCharacter(id) {
  activeEditId.value = id
  view.value = 'create'
}

function askSettings() {
  view.value = 'settings'
}

// ————— 房间 —————

function openGroup(id) {
  activeGroupId.value = id
  view.value = 'group'
}

function editGroup(id) {
  activeGroupId.value = id // '' = 新建
  view.value = 'group-edit'
}

function savedGroup(id) {
  if (id) {
    openGroup(id) // 新建/改完直接进群聊
  } else {
    view.value = 'home'
  }
}

function backFromGroupEdit() {
  if (activeGroupId.value) {
    view.value = 'group'
  } else {
    backHome()
  }
}
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <h1 class="hand">纸片人</h1>
      <span class="note subtitle">{{ subtitle }}</span>
    </div>
    <nav class="nav">
      <button
        class="tab hand"
        :class="{ on: view === 'home' || view === 'chat' || view === 'group' || view === 'group-edit' }"
        @click="backHome"
      >
        角色
      </button>
      <button class="tab hand" :class="{ on: view === 'settings' }" @click="askSettings">设置</button>
    </nav>
  </header>

  <main class="stage">
    <Home
      v-if="view === 'home'"
      :active-id="activeCharacter?.id || ''"
      @pick="pickCharacter"
      @create="startNew"
      @edit="editCharacter"
      @pick-group="openGroup"
      @edit-group="editGroup"
    />
    <CharacterEdit
      v-else-if="view === 'create'"
      :char-id="activeEditId"
      :key="activeEditId || 'new'"
      @save="savedCharacter"
      @cancel="backHome"
    />
    <Chat
      v-else-if="view === 'chat' && activeCharacter"
      :key="activeSessionId"
      :character="activeCharacter"
      :session-id="activeSessionId"
      :sessions="charSessions"
      @back="backHome"
      @switch="switchSession"
      @new="createSession"
      @tail="refreshCharSessions(activeCharacter.id)"
      @events="view = 'events'"
    />
    <EventBook
      v-else-if="view === 'events' && activeCharacter && activeSessionId"
      :session-id="activeSessionId"
      :character-name="activeCharacter.name"
      @back="view = 'chat'"
    />
    <GroupChat
      v-else-if="view === 'group' && activeGroupId"
      :key="activeGroupId"
      :group-id="activeGroupId"
      @back="backHome"
      @edit="editGroup(activeGroupId)"
    />
    <GroupEdit
      v-else-if="view === 'group-edit'"
      :group-id="activeGroupId"
      :key="activeGroupId || 'new-group'"
      @save="savedGroup"
      @cancel="backFromGroupEdit"
    />
    <Settings v-else-if="view === 'settings'" @done="view = 'home'" />
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
  background: linear-gradient(transparent 62%, rgba(244, 213, 108, 0.65) 62%);
  border-bottom-color: var(--ink);
}
.stage {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
