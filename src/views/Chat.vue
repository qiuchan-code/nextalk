<script setup>
import { ref, nextTick, computed, onMounted, onUnmounted } from 'vue'
import { settings } from '../lib/settings.js'
import { streamChat } from '../lib/client.js'
import { buildSystemPrompt, traitsToSampling } from '../lib/prompt.js'
import { loadMessages, saveMessage, nextSeq } from '../lib/sessions.js'
import { newId, removeMany, STORES } from '../lib/db.js'
import {
  loadMemories,
  selectForPrompt,
  distill,
  applyMemoryUpdates,
  recordScene,
  loadEvents
} from '../lib/memory.js'
import { alternateReplies, inspireReplies } from '../lib/suggest.js'

const props = defineProps({
  character: { type: Object, required: true },
  sessionId: { type: String, required: true },
  sessions: { type: Array, default: () => [] }
})
const emit = defineEmits(['back', 'switch', 'new', 'tail', 'events'])

const messages = ref([])
const draft = ref('')
const busy = ref(false)
const errorText = ref('')
const listEl = ref(null)
const rewindTarget = ref(null)
const distilling = ref(false)

// 长按菜单
const menu = ref(null) // { id, x, y, items:[] }
// 重说面板
const retry = ref(null) // { targetId, options:[{text,editing,draft}], loading, error }
// 灵感回复
const inspire = ref(null) // string[] | null
const inspireLoading = ref(false)

let controller = null
let pressTimer = null
let pressStart = null

const sampling = computed(() => traitsToSampling(props.character.traits, settings.maxTokens))

// 聊天区背景：颜色或自定义壁纸，空 = 纸质默认
const chatBgStyle = computed(() => {
  if (settings.chatBgImage) {
    return {
      backgroundImage: `url(${settings.chatBgImage})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center'
    }
  }
  if (settings.chatBgColor) return { backgroundColor: settings.chatBgColor }
  return {}
})

onMounted(() => {
  loadMsgs()
  window.visualViewport?.addEventListener('resize', onViewportResize)
})
onUnmounted(() => {
  window.visualViewport?.removeEventListener('resize', onViewportResize)
  clearPress()
})

function onViewportResize() {
  const input = document.activeElement
  if (input && input.classList?.contains('input')) scrollToBottom()
}

async function loadMsgs() {
  const list = await loadMessages(props.sessionId)
  if (list.length === 0 && props.character.greeting?.trim()) {
    const greeting = makeMsg('assistant', props.character.greeting.trim())
    greeting.system = 'greeting'
    await saveMessage(greeting)
    messages.value = [greeting]
  } else {
    messages.value = list
  }
  scrollToBottom()
}

function makeMsg(role, text) {
  return {
    id: newId('msg-'),
    seq: nextSeq(),
    sessionId: props.sessionId,
    role,
    text,
    createdAt: Date.now(),
    parentId: messages.value.length ? messages.value[messages.value.length - 1].id : null,
    status: 'complete'
  }
}

function scrollToBottom() {
  nextTick(() => {
    const el = listEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

function tilt(id) {
  const n = (id * 2654435761) % 100
  return ((n / 100) * 1.6 - 0.8).toFixed(2)
}

// ————— 发送与流式 —————

function historyPayload() {
  const windowLen = settings.historyWindow || 14
  return messages.value
    .filter((m) => m.status !== 'streaming' && m.text.trim())
    .slice(-windowLen)
    .map((m) => ({ role: m.role, content: m.text }))
}

async function streamReply(reply) {
  busy.value = true
  controller = new AbortController()
  let body = ''
  try {
    const [mems, evs] = await Promise.all([
      loadMemories(props.character.id),
      loadEvents(props.sessionId)
    ])
    const sel = selectForPrompt(mems)
    const injected = [
      ...sel.profiles,
      ...sel.events,
      ...(sel.relationship ? [sel.relationship] : [])
    ]
    const msgs = [
      { role: 'system', content: buildSystemPrompt(props.character, { memories: injected, events: evs }) },
      ...historyPayload()
    ]
    for await (const piece of streamChat({
      endpoint: settings.endpoint,
      apiKey: settings.apiKey,
      model: settings.model,
      messages: msgs,
      temperature: sampling.value.temperature,
      maxTokens: sampling.value.maxTokens,
      presencePenalty: sampling.value.presencePenalty,
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
  return body
}

async function maybeDistill() {
  const count = messages.value.filter((m) => m.status === 'complete').length
  const n = settings.memoryEveryN || 8
  if (count < n) return
  const markerKey = `distill.${props.sessionId}`
  const lastDone = Number(localStorage.getItem(markerKey) || 0)
  if (count <= lastDone || count % n !== 0) return
  if (distilling.value) return

  distilling.value = true
  try {
    const chunk = messages.value.slice(-(settings.historyWindow * 2 || 28))
    const res = await distill(props.character, chunk)
    if (res) {
      await applyMemoryUpdates(props.character.id, res.updates)
      await recordScene(props.sessionId, res.scene)
      localStorage.setItem(markerKey, String(count))
      emit('tail')
    }
  } catch (err) {
    console.warn('记忆后台任务出错', err)
  } finally {
    distilling.value = false
  }
}

async function send() {
  const text = draft.value.trim()
  if (!text || busy.value) return
  errorText.value = ''
  inspire.value = null
  const userMsg = makeMsg('user', text)
  messages.value.push(userMsg)
  await saveMessage(userMsg)
  draft.value = ''
  const reply = makeMsg('assistant', '')
  reply.status = 'streaming'
  messages.value.push(reply)
  scrollToBottom()
  await streamReply(reply)
  emit('tail')
}

function stop() {
  controller?.abort()
  controller = null
  busy.value = false
}

// ————— 长按出菜单（复制 / 重说 / 回溯）————

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
  if (m.role === 'assistant' && m.status === 'complete' && m.system !== 'greeting') {
    items.push({ label: '重说', fn: () => openRetry(m) })
  }
  if (idx < last && m.system !== 'greeting') {
    items.push({ label: '回溯到这里', fn: () => (rewindTarget.value = m) })
  }
  menu.value = { id: m.id, x, y, items }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // 老浏览器 / 非安全上下文兜底
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy') } catch {}
    ta.remove()
  }
}

// ————— 重说：多条备选 + 改写 —————

function openRetry(target) {
  menu.value = null
  retry.value = { targetId: target.id, options: [], loading: true, error: '' }
  generateAlternatives()
}

async function generateAlternatives() {
  const r = retry.value
  if (!r) return
  r.loading = true
  r.error = ''
  const idx = messages.value.findIndex((mm) => mm.id === r.targetId)
  const ctx = messages.value
    .slice(0, idx)
    .filter((m) => m.status !== 'streaming' && m.text.trim())
    .map((m) => ({ role: m.role, content: m.text }))
  const alts = await alternateReplies(props.character, ctx, 3)
  if (!retry.value) return
  retry.value.options = alts.map((text) => ({ text, editing: false, draft: text }))
  retry.value.loading = false
  if (!alts.length) retry.value.error = '没生成出备选，可能是网络或模型问题，点下面再试一次'
}

function startEdit(opt) {
  opt.editing = true
  opt.draft = opt.text
}
function commitEdit(opt) {
  opt.text = opt.draft.trim() || opt.text
  opt.editing = false
}
function cancelEdit(opt) {
  opt.draft = opt.text
  opt.editing = false
}
function chooseAlt(opt) {
  applyChosen(opt.text)
}

async function applyChosen(text) {
  const r = retry.value
  retry.value = null
  if (!r) return
  const idx = messages.value.findIndex((mm) => mm.id === r.targetId)
  if (idx === -1) return
  const keep = messages.value.slice(0, idx)
  const orphans = messages.value.slice(idx).map((mm) => mm.id)
  const newReply = makeMsg('assistant', text)
  newReply.parentId = keep.length ? keep[keep.length - 1].id : null
  messages.value = [...keep, newReply]
  await removeMany(STORES.messages, orphans).catch(() => {})
  await saveMessage(newReply).catch(() => {})
  emit('tail')
}

// ————— 灵感回复 —————

function toggleInspire() {
  if (inspire.value && inspire.value.length) {
    inspire.value = null // 收起灵感框
    return
  }
  loadInspiration()
}

async function loadInspiration() {
  if (inspireLoading.value) return
  inspireLoading.value = true
  const hist = messages.value
    .slice(-8)
    .map((m) => `${m.role === 'user' ? '用户' : props.character.name}：${(m.text || '').slice(0, 120)}`)
    .join('\n')
  try {
    inspire.value = await inspireReplies(props.character, hist, 3)
  } catch {
    inspire.value = []
  } finally {
    inspireLoading.value = false
  }
}

function pickInspire(t) {
  draft.value = t
  inspire.value = null
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
  emit('tail')
}

function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    send()
  }
}

function sessionLabel(s) {
  return '会话 ' + (props.sessions.indexOf(s) + 1)
}
</script>

<template>
  <div class="chat" :style="chatBgStyle">
    <header class="chat-head">
      <button class="btn ghost" @click="emit('back')">‹ 回去</button>
      <div class="who">
        <img v-if="character.avatar" :src="character.avatar" class="mini" alt="" />
        <span class="hand who-name">{{ character.name }}</span>
      </div>
      <button class="btn ghost new" @click="emit('new')">＋ 新对话</button>
      <button class="btn ghost new" @click="emit('events')">事件簿</button>
    </header>

    <div v-if="sessions.length > 1" class="sessionbar">
      <button
        v-for="s in sessions"
        :key="s.id"
        class="session-chip hand"
        :class="{ on: s.id === sessionId }"
        @click="emit('switch', s.id)"
      >
        {{ sessionLabel(s) }}
      </button>
    </div>

    <div ref="listEl" class="list">
      <div v-if="!messages.length" class="empty">
        <div class="empty-card paper-card">
          <span class="tape green"></span>
          <p class="note">{{ character.greeting || '说句话，让它开个头吧。' }}</p>
        </div>
      </div>

      <div
        v-for="m in messages"
        :key="m.id"
        class="row"
        :class="m.role"
        :style="{ '--tilt': tilt(m.id) + 'deg' }"
      >
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
          <p class="text">{{ m.text }}<span v-if="m.status === 'streaming'" class="caret">▍</span></p>
          <span v-if="m.system === 'greeting'" class="hand tag">开场</span>
        </div>
      </div>

      <p v-if="errorText" class="error hand">{{ errorText }}</p>
    </div>

    <!-- 长按菜单 -->
    <div v-if="menu" class="dim" @click="menu = null; "></div>
    <div v-if="menu" class="ctx paper-card" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
      <button v-for="it in menu.items" :key="it.label" class="ctx-item hand" @click="it.fn(); menu = null">
        {{ it.label }}
      </button>
    </div>

    <!-- 回溯确认条 -->
    <div v-if="rewindTarget" class="rewind-bar paper-card">
      <span class="hand rewind-text">
        从「{{ rewindTarget.text.slice(0, 20) }}…」重来？之后的话都会删掉。
      </span>
      <div class="rewind-actions">
        <button class="btn primary" @click="confirmRewind">确认</button>
        <button class="btn" @click="rewindTarget = null">取消</button>
      </div>
    </div>

    <!-- 灵感回复 -->
    <div v-if="inspire && inspire.length" class="inspire">
      <div class="inspire-head">
        <span class="hand inspire-label">灵感 · 你可以这么说</span>
        <button class="mini-btn hand" :disabled="inspireLoading" @click="loadInspiration">换一批</button>
      </div>
      <div class="inspire-list">
        <button v-for="t in inspire" :key="t" class="chip hand" @click="pickInspire(t)">{{ t }}</button>
      </div>
    </div>

    <div class="composer">
      <button
        class="bulb hand"
        :class="{ on: !!(inspire && inspire.length) }"
        :disabled="busy"
        :title="inspire && inspire.length ? '收起灵感' : '灵感回复'"
        @click="toggleInspire"
      >
        💡
      </button>
      <textarea
        v-model="draft"
        class="input"
        rows="1"
        :placeholder="`跟 ${character.name} 说点什么…`"
        enterkeyhint="send"
        @keydown="onKeydown"
      ></textarea>
      <button v-if="busy" class="btn danger send" @click="stop">停</button>
      <button v-else class="btn primary send" :disabled="!draft.trim()" @click="send">寄出</button>
    </div>

    <!-- 重说面板 -->
    <div v-if="retry" class="sheet-overlay" @click.self="retry = null">
      <div class="sheet-panel paper-card">
        <span class="tape blue"></span>
        <header class="sheet-head">
          <span class="hand title">换个说法</span>
          <div class="sheet-actions">
            <button class="btn ghost" :disabled="retry.loading" @click="generateAlternatives">换一批</button>
            <button class="btn ghost" @click="retry = null">关闭</button>
          </div>
        </header>
        <p v-if="retry.loading" class="hand loading-tip">正在想 3 种不同说法…</p>
        <p v-else-if="retry.error" class="error hand">{{ retry.error }}</p>

        <div v-if="!retry.loading" class="alts">
          <div v-for="(o, i) in retry.options" :key="i" class="alt">
            <span class="alt-num hand">{{ i + 1 }}</span>
            <textarea v-if="o.editing" v-model="o.draft" class="field edit-box" rows="3"></textarea>
            <p v-else class="alt-text hand">{{ o.text }}</p>
            <div class="alt-actions">
              <template v-if="!o.editing">
                <button class="mini-btn hand" @click="chooseAlt(o)">用这句</button>
                <button class="mini-btn hand" @click="startEdit(o)">改写</button>
              </template>
              <template v-else>
                <button class="mini-btn primary hand" @click="commitEdit(o)">定稿</button>
                <button class="mini-btn hand" @click="cancelEdit(o)">取消</button>
              </template>
            </div>
          </div>
        </div>
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
  /* 半透明毛玻璃，浮在角色大图上，字不糊又保沉浸 */
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
  align-items: center;
  gap: 7px;
}
.mini {
  width: 30px;
  height: 30px;
  border-radius: 4px;
  object-fit: cover;
  border: 1px solid var(--paper-edge);
  box-shadow: var(--shadow-card);
}
.who-name {
  font-size: 18px;
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
  max-width: 320px;
}

.row {
  display: flex;
}
.row.user {
  justify-content: flex-end;
}
.row.assistant {
  justify-content: flex-start;
}

/* 气泡：明确不透明，用户是黄便签、角色是白纸条，边界清晰不眼花 */
.bubble {
  position: relative;
  max-width: min(80%, 560px);
  padding: 11px 15px;
  border-radius: 16px; /* 圆角便签，不生硬 */
  box-shadow: var(--shadow-card);
  transform: rotate(var(--tilt));
  -webkit-user-select: none;
  user-select: none; /* 不让长按选中字，改用菜单复制 */
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
.tag {
  position: absolute;
  right: -20px;
  top: -9px;
  font-size: 11px;
  background: var(--paper-sticky);
  border: 1px solid rgba(170, 145, 90, 0.35);
  padding: 1px 6px;
  transform: rotate(4deg);
  color: var(--ink-soft);
}

.text {
  margin: 0;
  font-size: 15.5px;
  line-height: 1.78;
  white-space: pre-wrap;
  word-break: break-word;
}
.caret {
  color: var(--ink-pencil);
  animation: blink 1s steps(2, start) infinite;
}
@keyframes blink {
  to { opacity: 0; }
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

/* 回溯确认条：文字自动换行，不再被截断 */
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

/* 灵感 */
.inspire {
  flex: none;
  margin: 0 10px 6px;
  padding: 10px 12px;
  background: rgba(255, 253, 246, 0.92);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1.5px dashed var(--ink-pencil);
  border-radius: 14px;
  box-shadow: var(--shadow-card);
}
.inspire-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.inspire-label {
  font-size: 13px;
  color: var(--ink-soft);
}
.inspire-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
  max-height: 30dvh;
  overflow-y: auto;
}
.chip {
  font-size: 14.5px;
  color: var(--ink);
  background: var(--paper-sticky);
  border: 1px solid rgba(176, 146, 76, 0.35);
  border-radius: 12px;
  text-align: left;
  padding: 8px 11px;
  cursor: pointer;
}
.chip:active {
  background: #f8dc86;
}

.mini-btn {
  font-size: 13px;
  color: var(--ink);
  background: var(--paper-card);
  border: 1px solid var(--line);
  border-radius: 2px;
  padding: 4px 10px;
  cursor: pointer;
}
.mini-btn.primary {
  background: var(--paper-sticky);
  border-color: var(--ink);
}
.mini-btn:disabled {
  opacity: 0.5;
}

.composer {
  flex: none;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  margin: 0 10px;
  margin-bottom: calc(10px + env(safe-area-inset-bottom));
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
/* 灯泡：灵感回复开关 */
.bulb {
  flex: none;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  font-size: 19px;
  line-height: 1;
  display: grid;
  place-items: center;
  background: rgba(253, 243, 200, 0.85);
  border: 1px solid rgba(176, 146, 76, 0.45);
  cursor: pointer;
  box-shadow: var(--shadow-card);
  transition: box-shadow 0.1s;
}
.bulb.on {
  background: #fce9a8;
  border-color: var(--ink);
  box-shadow: 0 0 0 2px var(--ink), var(--shadow-card);
}
.bulb:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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

/* 重说面板：底部弹层 */
.sheet-overlay {
  position: absolute;
  inset: 0;
  z-index: 10;
  background: rgba(90, 75, 50, 0.22);
  display: flex;
  align-items: flex-end;
  justify-content: center;
}
.sheet-panel {
  width: 100%;
  max-width: 560px;
  max-height: 82dvh;
  display: flex;
  flex-direction: column;
  padding: 18px 16px calc(16px + env(safe-area-inset-bottom));
  border-radius: 8px 8px 0 0;
  transform: none;
}
.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.sheet-head .title {
  font-size: 18px;
  letter-spacing: 1px;
}
.sheet-actions {
  display: flex;
  gap: 2px;
}
.sheet-actions .btn.ghost {
  border-color: transparent;
  box-shadow: none;
  padding: 4px 8px;
  font-size: 14px;
  color: var(--ink-soft);
}
.sheet-actions .btn.ghost:disabled {
  opacity: 0.4;
}
.loading-tip {
  color: var(--ink-soft);
  text-align: center;
  padding: 30px 0;
}
.alts {
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.alt {
  position: relative;
  border: 1px solid var(--paper-edge);
  border-radius: 12px;
  padding: 10px 12px 10px 36px;
  background: #fbf7ec;
  box-shadow: var(--shadow-card);
}
.alt-num {
  position: absolute;
  left: 9px;
  top: 10px;
  font-size: 14px;
  color: var(--ink-pencil);
}
.alt-text {
  margin: 0;
  font-size: 15px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}
.edit-box {
  width: 100%;
  font-size: 15px;
  line-height: 1.6;
  color: var(--ink);
  background: var(--paper-card);
  border: 1.5px dashed var(--ink-blue);
  border-radius: 3px;
  padding: 8px 9px;
  outline: none;
  resize: vertical;
}
.alt-actions {
  display: flex;
  gap: 7px;
  margin-top: 9px;
  justify-content: flex-end;
}
</style>
