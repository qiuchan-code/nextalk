<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import { settings } from '../lib/settings.js'
import { streamChat } from '../lib/client.js'
import { buildGroupSystemPrompt, traitsToSampling } from '../lib/prompt.js'
import { loadMessages, saveMessage, nextSeq } from '../lib/sessions.js'
import { get, newId, removeMany, STORES } from '../lib/db.js'
import { loadMemories, selectForPrompt } from '../lib/memory.js'
import { useGroups, openGroupSession, newGroupSession, listGroupSessions, groupDistill } from '../lib/groups.js'

/**
 * 群聊局。规矩是星野/CA 那套、也是你拍板的：
 * 没有自动轮转——"你点谁，谁才回"。你发消息后谁都不接话，
 * 想听谁的就点谁，方向盘一直在你手里。
 */

const props = defineProps({
  groupId: { type: String, required: true }
})
const emit = defineEmits(['back', 'edit'])

const groups = useGroups()
const group = ref(null)
const members = ref([]) // 由 charIds 解出的角色对象
const sessions = ref([])
const sessionId = ref('')
const messages = ref([])
const draft = ref('')
const busy = ref(false)
const errorText = ref('')
const listEl = ref(null)
const rewindTarget = ref(null)
const distilling = ref(false)

// 长按菜单
const menu = ref(null) // { id, x, y, items:[] }

let controller = null
let pressTimer = null
let pressStart = null

const nameMap = computed(() => {
  const m = new Map()
  for (const c of members.value) m.set(c.id, c.name)
  m.set('group', group.value?.name || '群')
  return m
})
function nameOf(charId) {
  return nameMap.value.get(charId) || '群友'
}

onMounted(async () => {
  groups.reload().catch(() => {})
  await init()
  window.visualViewport?.addEventListener('resize', onViewportResize)
})
onUnmounted(() => {
  window.visualViewport?.removeEventListener('resize', onViewportResize)
  clearPress()
})

async function init() {
  const g = await groups.getGroup(props.groupId)
  if (!g) {
    emit('back')
    return
  }
  group.value = g
  members.value = []
  for (const id of g.charIds || []) {
    const c = await getChar(id)
    if (c) members.value.push(c)
  }
  // 点开房间 = 回到最近那条没聊完的线
  const s = await openGroupSession(g.id)
  sessionId.value = s.id
  await loadSessions()
  await loadMsgs()
}

async function getChar(id) {
  return get(STORES.characters, id)
}

async function loadSessions() {
  sessions.value = await listGroupSessions(props.groupId)
}

async function loadMsgs() {
  messages.value = (await loadMessages(sessionId.value)).filter((m) => m.status !== 'streaming')
  scrollToBottom()
}

function makeMsg(role, text, charId = '') {
  return {
    id: newId('msg-'),
    seq: nextSeq(),
    sessionId: sessionId.value,
    role,
    charId,
    text,
    createdAt: Date.now(),
    parentId: messages.value.length ? messages.value[messages.value.length - 1].id : null,
    status: 'complete'
  }
}

// 括号动作/旁白（星野式）：（）和()都认，渲染成灰色
function segments(text) {
  if (!text) return [{ t: 's', v: '' }]
  const out = []
  const re = /（[^（）]*）|\([^()]*\)/g
  let last = 0
  let m
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: 's', v: text.slice(last, m.index) })
    out.push({ t: 'a', v: m[0] })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ t: 's', v: text.slice(last) })
  if (!out.length) out.push({ t: 's', v: text })
  return out
}

function scrollToBottom() {
  nextTick(() => {
    const el = listEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

function onViewportResize() {
  const input = document.activeElement
  if (input && input.classList?.contains('input')) scrollToBottom()
}

function tilt(id) {
  const n = (id * 2654435761) % 100
  return ((n / 100) * 1.6 - 0.8).toFixed(2)
}

// ————— 发送与流式 —————

/** 历史 → API 消息。群里谁说的话都要带名字，不然模型分不清谁是谁 */
function historyPayload(msgs) {
  const windowLen = settings.historyWindow || 14
  return msgs
    .filter((m) => m.status !== 'streaming' && m.text.trim())
    .slice(-windowLen)
    .map((m) =>
      m.role === 'user'
        ? { role: 'user', content: m.text }
        : { role: 'assistant', content: `${nameOf(m.charId)}：${m.text}` }
    )
}

async function streamReply(char, reply, prefixMsgs) {
  busy.value = true
  controller = new AbortController()
  let body = ''
  try {
    const mems = await loadMemories(char.id)
    const sel = selectForPrompt(mems)
    const injected = [
      ...sel.profiles,
      ...sel.events,
      ...(sel.relationship ? [sel.relationship] : [])
    ]
    const msgs = [
      {
        role: 'system',
        content: buildGroupSystemPrompt(char, {
          group: group.value,
          members: members.value,
          memories: injected,
          events: [],
          userName: ''
        })
      },
      ...historyPayload(prefixMsgs)
    ]
    const sampling = traitsToSampling(char.traits, settings.maxTokens)
    for await (const piece of streamChat({
      endpoint: settings.endpoint,
      apiKey: settings.apiKey,
      model: settings.model,
      messages: msgs,
      temperature: sampling.temperature,
      maxTokens: sampling.maxTokens,
      presencePenalty: sampling.presencePenalty,
      signal: controller.signal
    })) {
      reply.text += piece
      body += piece
      scrollToBottom()
    }
  } catch (err) {
    errorText.value = String(err.message || err)
    if (!reply.text) messages.value = messages.value.filter((m) => m !== reply)
  } finally {
    if (body) {
      reply.status = 'complete'
      await saveMessage(reply).catch(() => {})
      maybeDistill()
    } else if (reply.text) {
      reply.status = 'aborted'
    }
    busy.value = false
    controller = null
    scrollToBottom()
  }
}

/** 用户说一句：寄出去。不等接话——想听谁就点谁 */
async function send() {
  const text = draft.value.trim()
  if (!text || busy.value) return
  errorText.value = ''
  const userMsg = makeMsg('user', text)
  messages.value.push(userMsg)
  await saveMessage(userMsg)
  draft.value = ''
  scrollToBottom()
}

/** 点某个成员的头像：TA 来和你们搭话 */
async function speakAs(char) {
  if (busy.value || !char) return
  errorText.value = ''
  const reply = makeMsg('assistant', '', char.id)
  reply.status = 'streaming'
  messages.value.push(reply)
  scrollToBottom()
  await streamReply(char, reply, messages.value.slice(0, -1))
}

function stop() {
  controller?.abort()
  controller = null
  busy.value = false
}

// ————— 记忆提炼：每 N 条完整消息，给"出过场"的成员各提炼一次 —————

async function maybeDistill() {
  const count = messages.value.filter((m) => m.status === 'complete').length
  const n = settings.memoryEveryN || 8
  if (count < n) return
  const sid = sessionId.value // 记下当时那条线，中途切线就不记标记
  const markerKey = `gdistill.${sid}`
  const lastDone = Number(localStorage.getItem(markerKey) || 0)
  if (count <= lastDone || count % n !== 0) return
  if (distilling.value) return

  const chunk = messages.value.slice(-(settings.historyWindow * 2 || 28))
  // 只提炼这次出过场的成员：没说话的人没有新信息，省一次调用（也省一笔钱）
  const spoke = new Set(chunk.filter((m) => m.role !== 'user').map((m) => m.charId))
  const targets = members.value.filter((m) => spoke.has(m.id))
  if (!targets.length) {
    localStorage.setItem(markerKey, String(count))
    return
  }

  distilling.value = true
  try {
    for (const c of targets) {
      await groupDistill(c, chunk, nameOf)
    }
    if (sessionId.value === sid) localStorage.setItem(markerKey, String(count))
  } catch (err) {
    console.warn('群聊记忆提炼失败', err)
  } finally {
    distilling.value = false
  }
}

// ————— 长按出菜单（复制 / 重说 / 回溯）—————

function clearPress() {
  if (pressTimer) clearTimeout(pressTimer)
  pressTimer = null
  pressStart = null
}

function bubbleDown(m, e) {
  if (e.button !== undefined && e.button !== 0) return
  clearPress()
  pressStart = { x: e.clientX, y: e.clientY }
  pressTimer = setTimeout(() => {
    openMenu(m, e.clientX, e.clientY)
  }, 480)
}

function bubbleMove(e) {
  if (!pressStart) return
  const dx = e.clientX - pressStart.x
  const dy = e.clientY - pressStart.y
  if (dx * dx + dy * dy > 144) clearPress() // 手指移动了(滚动)，不当作长按
}

function bubbleUp() {
  clearPress()
}

function openMenu(m, x, y) {
  clearPress()
  const idx = messages.value.findIndex((mm) => mm.id === m.id)
  const last = messages.value.length - 1
  const items = []
  items.push({ label: '复制这段', fn: () => copyText(m.text) })
  // 重说：群聊里只给最后一条（前面的换台词，后面的剧情还对不上）
  if (m.role === 'assistant' && m.status === 'complete' && m.charId && idx === last) {
    items.push({ label: '重说', fn: () => regenerateLast() })
  }
  if (idx < last) {
    items.push({ label: '回溯到这里', fn: () => (rewindTarget.value = m) })
  }
  menu.value = { id: m.id, x, y, items }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
    } catch {}
    ta.remove()
  }
}

/** 重说 = 原地重演：同一句话再让它说一遍，流式地把旧字替换掉 */
async function regenerateLast() {
  const reply = messages.value[messages.value.length - 1]
  if (!reply || busy.value) return
  const char = members.value.find((m) => m.id === reply.charId)
  if (!char) return
  errorText.value = ''
  const oldText = reply.text
  reply.text = ''
  reply.status = 'streaming'
  await streamReply(char, reply, messages.value.slice(0, -1))
  if (reply.status === 'aborted') reply.text = oldText // 失败了把旧话还回来
}

// ————— 回溯确认 —————

async function confirmRewind() {
  const msg = rewindTarget.value
  rewindTarget.value = null
  if (!msg || busy.value) return
  errorText.value = ''
  const idx = messages.value.findIndex((m) => m.id === msg.id)
  const keep = messages.value.slice(0, idx + 1)
  const orphans = messages.value.slice(idx + 1).map((m) => m.id)
  messages.value = keep
  await removeMany(STORES.messages, orphans).catch(() => {})
  scrollToBottom()
}

function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    send()
  }
}

async function newLine() {
  if (busy.value) return
  const s = await newGroupSession(props.groupId)
  sessionId.value = s.id
  await loadSessions()
  await loadMsgs()
}

async function switchLine(sid) {
  if (sid === sessionId.value || busy.value) return
  sessionId.value = sid
  await loadMsgs()
}

function sessionLabel(s) {
  return '会话 ' + (sessions.value.indexOf(s) + 1)
}
</script>

<template>
  <div class="chat">
    <header class="chat-head">
      <button class="btn ghost" @click="emit('back')">‹ 回去</button>
      <div class="who" @click="emit('edit')">
        <span class="hand who-name">{{ group?.name || '房间' }}</span>
        <span class="hand who-sub">{{ members.length }} 人 · 点谁谁说话</span>
      </div>
      <button class="btn ghost new" :disabled="busy" @click="newLine">＋ 新对话</button>
    </header>

    <div v-if="sessions.length > 1" class="sessionbar">
      <button
        v-for="s in sessions"
        :key="s.id"
        class="session-chip hand"
        :class="{ on: s.id === sessionId }"
        @click="switchLine(s.id)"
      >
        {{ sessionLabel(s) }}
      </button>
    </div>

    <div ref="listEl" class="list">
      <div v-if="!messages.length" class="empty">
        <div class="empty-card paper-card">
          <span class="tape green"></span>
          <p class="hand empty-title">房间搭好了 :)</p>
          <p class="note">没有自动接话——你发消息后谁都先不吭声，想听谁的就点下面谁的头像，TA 来搭话。聊别人的事也行，比如让程哥点评一下林妹妹。</p>
        </div>
      </div>

      <div
        v-for="m in messages"
        :key="m.id"
        class="row"
        :class="m.role"
        :style="{ '--tilt': tilt(m.id) + 'deg' }"
      >
        <div v-if="m.role === 'assistant'" class="speak-meta">
          <img
            v-if="members.find((c) => c.id === m.charId)?.avatar"
            :src="members.find((c) => c.id === m.charId).avatar"
            class="mini-avatar"
            alt=""
          />
          <span v-else class="mini-avatar ph hand">{{ nameOf(m.charId).slice(0, 1) }}</span>
          <span class="hand who-said">{{ nameOf(m.charId) }}</span>
        </div>
        <div
          class="bubble"
          :class="m.role"
          @pointerdown="bubbleDown(m, $event)"
          @pointermove="bubbleMove($event)"
          @pointerup="bubbleUp"
          @pointercancel="bubbleUp"
          @pointerleave="bubbleUp"
          @contextmenu.prevent
        >
          <span v-if="m.role === 'assistant'" class="tape mini"></span>
          <p class="text">
            <template v-for="(seg, i) in segments(m.text)" :key="i">
              <span v-if="seg.t === 'a'" class="act">{{ seg.v }}</span>
              <template v-else>{{ seg.v }}</template>
            </template>
            <span v-if="m.status === 'streaming'" class="caret">▍</span>
          </p>
        </div>
      </div>

      <p v-if="errorText" class="error hand">{{ errorText }}</p>
    </div>

    <!-- 长按菜单 -->
    <div v-if="menu" class="dim" @click="menu = null"></div>
    <div v-if="menu" class="ctx paper-card" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
      <button v-for="it in menu.items" :key="it.label" class="ctx-item hand" @click="it.fn(); menu = null">
        {{ it.label }}
      </button>
    </div>

    <!-- 回溯确认条 -->
    <div v-if="rewindTarget" class="rewind-bar paper-card">
      <span class="hand rewind-text">从「{{ rewindTarget.text.slice(0, 20) }}…」重来？之后的话都会删掉。</span>
      <div class="rewind-actions">
        <button class="btn primary" @click="confirmRewind">确认</button>
        <button class="btn" @click="rewindTarget = null">取消</button>
      </div>
    </div>

    <p v-if="distilling" class="distill-note hand">正在替出场的人整理记忆…</p>

    <div class="composer-area">
      <!-- 成员条：点谁，谁接话 -->
      <div class="who-bar">
        <button
          v-for="c in members"
          :key="c.id"
          class="speaker"
          :disabled="busy"
          :title="`让「${c.name}」来接话`"
          @click="speakAs(c)"
        >
          <img v-if="c.avatar" :src="c.avatar" class="sp-avatar" alt="" />
          <span v-else class="sp-avatar ph hand">{{ c.name.slice(0, 1) }}</span>
          <span class="hand sp-name">{{ c.name }}</span>
        </button>
        <span v-if="members.length" class="who-tip hand">点谁接话</span>
        <p v-else class="hand no-member">成员都不在了，回首页改改这个房间吧。</p>
      </div>

      <div class="composer">
        <textarea
          v-model="draft"
          class="input"
          rows="1"
          placeholder="说点什么，或者直接点上面的人…"
          enterkeyhint="send"
          @keydown="onKeydown"
        ></textarea>
        <button v-if="busy" class="btn danger send" @click="stop">停</button>
        <button v-else class="btn primary send" :disabled="!draft.trim()" @click="send">寄出</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

.chat-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px 7px;
  background: rgba(255, 253, 246, 0.55);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border-bottom: 1px solid rgba(255, 255, 255, 0.35);
  position: relative;
  z-index: 3;
}
.btn.ghost {
  border-color: transparent;
  box-shadow: none;
  padding-left: 4px;
}
.btn.new {
  margin-left: auto;
  border: 1.5px dashed var(--ink-pencil);
  padding: 5px 10px;
}
.who {
  display: flex;
  align-items: baseline;
  gap: 8px;
  cursor: pointer;
}
.who-name {
  font-size: 17px;
}
.who-sub {
  font-size: 12px;
  color: var(--ink-soft);
}

.sessionbar {
  flex: none;
  display: flex;
  gap: 7px;
  padding: 8px 12px 4px;
  overflow-x: auto;
  background: rgba(255, 253, 246, 0.4);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.session-chip {
  flex: none;
  font-size: 13px;
  color: var(--ink-soft);
  background: var(--paper-card);
  border: 1px solid var(--paper-edge);
  border-radius: 12px;
  padding: 4px 12px;
  cursor: pointer;
  box-shadow: var(--shadow-card);
}
.session-chip.on {
  background: var(--paper-sticky);
  border-color: var(--ink);
  color: var(--ink);
}

.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 15px;
  scroll-behavior: smooth;
}

.empty {
  flex: 1;
  display: grid;
  place-items: center;
}
.empty-card {
  text-align: center;
  padding: 26px 30px;
  transform: rotate(-1.5deg);
  max-width: 340px;
}
.empty-title {
  font-size: 18px;
  margin: 4px 0 8px;
  color: var(--ink-soft);
}
.empty-card .note {
  line-height: 1.7;
}

.row {
  display: flex;
  flex-direction: column;
}
.row.user {
  align-items: flex-end;
}
.row.assistant {
  align-items: flex-start;
}

/* 群聊：说话人小头像 + 名字，贴在气泡上 */
.speak-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0 0 2px 2px;
  transform: rotate(-0.5deg);
}
.mini-avatar {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  object-fit: cover;
  border: 1px solid var(--paper-edge);
  background: #efe8d6;
  display: grid;
  place-items: center;
  box-shadow: var(--shadow-card);
}
.mini-avatar.ph {
  font-size: 13px;
  color: var(--ink-pencil);
}
.who-said {
  font-size: 12.5px;
  color: var(--ink-pencil);
}

.bubble {
  position: relative;
  max-width: min(80%, 560px);
  padding: 11px 15px;
  border-radius: 16px;
  box-shadow: var(--shadow-card);
  transform: rotate(var(--tilt));
  -webkit-user-select: none;
  user-select: none;
}
.bubble.user {
  background: #fbe7a3;
  border: 1px solid rgba(176, 146, 76, 0.4);
  border-bottom-right-radius: 4px;
}
.bubble.assistant {
  background: #fdfcf7;
  border: 1px solid var(--paper-edge);
  border-bottom-left-radius: 4px;
}
.tape.mini {
  width: 42px;
  height: 15px;
  top: -7px;
  left: 11px;
  margin-left: 0;
  transform: rotate(-5deg);
  background: var(--tape-pink);
}

.text {
  margin: 0;
  font-size: 15.5px;
  line-height: 1.78;
  white-space: pre-wrap;
  word-break: break-word;
}
.act {
  color: var(--ink-pencil);
  letter-spacing: 0.2px;
}
.caret {
  color: var(--ink-pencil);
  animation: blink 1s steps(2, start) infinite;
}
@keyframes blink {
  to {
    opacity: 0;
  }
}

.error {
  color: var(--ink-red);
  font-size: 14px;
  white-space: pre-wrap;
  line-height: 1.65;
  border-left: 3px solid var(--ink-red);
  padding: 7px 11px;
  background: rgba(194, 85, 77, 0.07);
  align-self: center;
  max-width: 560px;
}

/* 长按菜单 */
.dim {
  position: absolute;
  inset: 0;
  z-index: 8;
}
.ctx {
  position: fixed;
  z-index: 9;
  min-width: 128px;
  padding: 6px;
  display: flex;
  flex-direction: column;
  transform: translate(6px, 4px);
}
.ctx-item {
  font-size: 15px;
  color: var(--ink);
  background: transparent;
  border: none;
  text-align: left;
  padding: 9px 12px;
  cursor: pointer;
  border-radius: 2px;
}
.ctx-item:hover {
  background: rgba(201, 165, 90, 0.14);
}

.rewind-bar {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0 10px 6px;
  padding: 10px 12px;
  transform: rotate(-0.4deg);
  border: 1.5px solid rgba(194, 85, 77, 0.45);
  border-radius: 12px;
}
.rewind-text {
  font-size: 14px;
  color: var(--ink-red);
  line-height: 1.55;
  white-space: normal;
  word-break: break-word;
}
.rewind-actions {
  display: flex;
  gap: 8px;
}

.distill-note {
  flex: none;
  text-align: center;
  font-size: 12.5px;
  color: var(--ink-pencil);
  margin: 0 0 4px;
  animation: blink 1.6s steps(2, start) infinite;
}

.composer-area {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin: 0 10px;
  margin-bottom: calc(10px + env(safe-area-inset-bottom));
}

/* 成员条：一排小头像，点谁谁接话 */
.who-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow-x: auto;
  padding: 7px 8px;
  background: rgba(255, 253, 246, 0.72);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.5);
  border-radius: 18px;
  box-shadow: var(--shadow-card);
}
.speaker {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 2px 5px;
  background: transparent;
  border: 1.5px solid transparent;
  border-radius: 12px;
  cursor: pointer;
  transition: transform 0.1s;
}
.speaker:hover {
  transform: rotate(-2deg);
}
.speaker:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.speaker:active {
  border-color: var(--ink);
}
.sp-avatar {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  object-fit: cover;
  border: 1px solid var(--paper-edge);
  background: #efe8d6;
  display: grid;
  place-items: center;
  box-shadow: var(--shadow-card);
}
.sp-avatar.ph {
  font-size: 18px;
  color: var(--ink-pencil);
}
.sp-name {
  font-size: 11px;
  color: var(--ink-soft);
  max-width: 52px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.who-tip {
  flex: none;
  font-size: 12px;
  color: var(--ink-pencil);
  margin-left: auto;
  margin-right: 4px;
  transform: rotate(-2deg);
  white-space: nowrap;
}
.no-member {
  margin: 0;
  font-size: 13px;
  color: var(--ink-pencil);
  padding: 4px 2px;
}

.composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 7px 8px 7px 12px;
  background: rgba(255, 253, 246, 0.72);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.5);
  border-radius: 22px;
  box-shadow: var(--shadow-card);
  position: relative;
  z-index: 3;
}
.input {
  flex: 1;
  font-family: var(--font-body);
  font-size: 15.5px;
  line-height: 1.6;
  color: var(--ink);
  background: var(--paper-card);
  border: 1.5px dashed var(--line);
  border-radius: 3px;
  padding: 9px 11px;
  outline: none;
  resize: none;
  max-height: 30dvh;
  min-height: 42px;
  field-sizing: content;
}
.input:focus {
  border-color: var(--ink-blue);
  border-style: solid;
}
.send {
  flex: none;
  height: 42px;
}
</style>
