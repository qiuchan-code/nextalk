<script setup>
import { ref, nextTick, computed, onMounted } from 'vue'
import { settings } from '../lib/settings.js'
import { streamChat } from '../lib/client.js'
import { buildSystemPrompt, traitsToSampling } from '../lib/prompt.js'
import { loadMessages, saveMessage, nextSeq } from '../lib/sessions.js'
import { newId, removeMany, STORES } from '../lib/db.js'

const props = defineProps({
  character: { type: Object, required: true },
  sessionId: { type: String, required: true },
  sessions: { type: Array, default: () => [] } // 这个角色的所有会话线
})
const emit = defineEmits(['back', 'switch', 'new', 'tail'])

const messages = ref([])
const draft = ref('')
const busy = ref(false)
const errorText = ref('')
const listEl = ref(null)
const rewindTarget = ref(null) // 待确认的回溯点消息
let controller = null

const sampling = computed(() => traitsToSampling(props.character.traits, settings.maxTokens))

onMounted(loadMsgs)

async function loadMsgs() {
  const list = await loadMessages(props.sessionId)
  // 全新会话：把角色的开场白当第一条就位
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

// —— 发送与流式 —————————————————————————

function historyPayload() {
  return messages.value
    .filter((m) => m.status !== 'streaming' && m.text.trim())
    .map((m) => ({ role: m.role, content: m.text }))
}

async function streamReply(reply) {
  busy.value = true
  controller = new AbortController()
  let body = ''
  try {
    const msgs = [{ role: 'system', content: buildSystemPrompt(props.character) }, ...historyPayload()]
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
    } else if (reply.text) {
      reply.status = 'aborted' // 吐一半被打断，留半句但不入库
    }
    busy.value = false
    controller = null
    scrollToBottom()
  }
  return body
}

async function send() {
  const text = draft.value.trim()
  if (!text || busy.value) return
  errorText.value = ''
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

// —— 重说 / 回溯 —————————————————————————

/** 重说：把最后一条回复删掉重新生成 */
async function retry(reply) {
  if (busy.value) return
  errorText.value = ''
  const idx = messages.value.findIndex((m) => m.id === reply.id)
  if (idx === -1) return
  const keep = messages.value.slice(0, idx)
  const orphans = messages.value.slice(idx).map((m) => m.id) // 这条回复和它后面的
  messages.value = keep
  await removeMany(STORES.messages, orphans).catch(() => {})
  const r = makeMsg('assistant', '')
  r.status = 'streaming'
  messages.value.push(r)
  scrollToBottom()
  await streamReply(r)
  emit('tail')
}

/** 点击某条消息，把它设成回溯点 */
function askRewind(msg) {
  const idx = messages.value.findIndex((m) => m.id === msg.id)
  if (idx === -1 || idx === messages.value.length - 1) return // 最后一条没必要回溯
  if (msg.system === 'greeting') return // 开场白不算节点
  rewindTarget.value = msg
}

async function confirmRewind() {
  const msg = rewindTarget.value
  rewindTarget.value = null
  if (!msg || busy.value) return
  errorText.value = ''
  const idx = messages.value.findIndex((m) => m.id === msg.id)
  const keep = messages.value.slice(0, idx + 1)
  const orphans = messages.value.slice(idx + 1).map((m) => m.id) // 它之后的全删
  messages.value = keep
  await removeMany(STORES.messages, orphans).catch(() => {})
  scrollToBottom()
  emit('tail')
  // 回溯后不自动生成，等你自己继续写下一句
}

function stop() {
  controller?.abort()
  controller = null
  busy.value = false
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
  <div class="chat">
    <header class="chat-head">
      <button class="btn ghost" @click="emit('back')">‹ 回去</button>
      <div class="who">
        <img v-if="character.avatar" :src="character.avatar" class="mini" alt="" />
        <span class="hand who-name">{{ character.name }}</span>
      </div>
      <button class="btn ghost new" @click="emit('new')">＋ 新对话</button>
    </header>

    <!-- 会话切换条 -->
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
        v-for="(m, i) in messages"
        :key="m.id"
        class="row"
        :class="m.role"
        :style="{ '--tilt': tilt(m.id) + 'deg' }"
      >
        <div class="bubble" :class="{ clickable: i < messages.length - 1 && m.system !== 'greeting' }" @click="askRewind(m)">
          <span v-if="m.role === 'assistant'" class="tape mini"></span>
          <p class="text">{{ m.text }}<span v-if="m.status === 'streaming'" class="caret">▍</span></p>
          <span v-if="m.system === 'greeting'" class="hand tag">开场</span>

          <!-- 最后一条它说的话：重说 -->
          <button
            v-if="m.role === 'assistant' && m.status === 'complete' && i === messages.length - 1"
            class="retry hand"
            @click.stop="retry(m)"
          >
            重说
          </button>
        </div>
      </div>

      <p v-if="errorText" class="error hand">{{ errorText }}</p>
    </div>

    <!-- 回溯确认条 -->
    <div v-if="rewindTarget" class="rewind-bar paper-card">
      <span class="hand rewind-text">
        从「{{ rewindTarget.text.slice(0, 12) || '这里' }}…」重来？之后的话都会删掉。
      </span>
      <button class="btn primary" @click="confirmRewind">确认</button>
      <button class="btn" @click="rewindTarget = null">取消</button>
    </div>

    <div class="composer">
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
  </div>
</template>

<style scoped>
.chat {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.chat-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1.5px dashed var(--line);
}
.btn.ghost {
  border-color: transparent;
  box-shadow: none;
  padding-left: 4px;
}
.btn.new {
  margin-left: auto;
  border: 1.5px dashed var(--ink-pencil);
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
  padding: 8px 14px 4px;
  overflow-x: auto;
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

.bubble {
  position: relative;
  max-width: min(78%, 560px);
  padding: 11px 14px;
  border-radius: 2px;
  box-shadow: var(--shadow-card);
  transform: rotate(var(--tilt));
}
.bubble.clickable {
  cursor: pointer;
}
.bubble.clickable:hover {
  box-shadow: var(--shadow-lift);
}
.bubble.user {
  background: var(--paper-sticky);
  border: 1px solid rgba(170, 145, 90, 0.3);
}
.bubble.user::after {
  content: '';
  position: absolute;
  right: 0;
  bottom: 0;
  border-width: 0 0 13px 13px;
  border-style: solid;
  border-color: transparent transparent rgba(190, 165, 105, 0.35) transparent;
}
.bubble.assistant {
  background: var(--paper-card);
  border: 1px solid var(--paper-edge);
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
  right: -22px;
  top: -9px;
  font-size: 11px;
  background: var(--paper-sticky);
  border: 1px solid rgba(170, 145, 90, 0.35);
  padding: 1px 6px;
  transform: rotate(4deg);
  color: var(--ink-soft);
}

.retry {
  position: absolute;
  left: 50%;
  bottom: -18px;
  transform: translateX(-50%);
  font-size: 12px;
  color: var(--ink-pencil);
  background: var(--paper-card);
  border: 1px dashed var(--line);
  border-radius: 10px;
  padding: 2px 11px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
}
.bubble:hover .retry,
.bubble.assistant .retry {
  opacity: 1;
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

.rewind-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0 14px 6px;
  padding: 10px 12px;
  transform: rotate(-0.4deg);
  border: 1.5px solid rgba(194, 85, 77, 0.45);
}
.rewind-text {
  flex: 1;
  font-size: 14px;
  color: var(--ink-red);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer {
  flex: none;
  display: flex;
  align-items: flex-end;
  gap: 9px;
  padding: 10px 14px;
  padding-bottom: calc(10px + env(safe-area-inset-bottom));
  border-top: 1.5px solid var(--line);
  background: rgba(255, 253, 246, 0.72);
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
