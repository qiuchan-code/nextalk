<script setup>
import { ref, watch, nextTick, computed, onMounted } from 'vue'
import { settings } from '../lib/settings.js'
import { streamChat } from '../lib/client.js'
import { buildSystemPrompt, traitsToSampling } from '../lib/prompt.js'
import { loadMessages, saveMessage } from '../lib/sessions.js'
import { newId } from '../lib/db.js'

const props = defineProps({
  character: { type: Object, required: true },
  sessionId: { type: String, required: true }
})
const emit = defineEmits(['back'])

const messages = ref([])
const draft = ref('')
const busy = ref(false)
const errorText = ref('')
const listEl = ref(null)
let controller = null

// 采样参数由角色的性格决定（不是摆设，真的会改生成结果）
const sampling = computed(() => traitsToSampling(props.character.traits, settings.maxTokens))

onMounted(loadMsgs)

async function loadMsgs() {
  const list = await loadMessages(props.sessionId)
  // 全新会话：把角色的开场白当作第一条就位
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
    sessionId: props.sessionId,
    role,
    text,
    createdAt: Date.now(),
    parentId: messages.value.length
      ? messages.value[messages.value.length - 1].id
      : null,
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

function stop() {
  controller?.abort()
  controller = null
  busy.value = false
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

  busy.value = true
  controller = new AbortController()

  let body = ''
  try {
    // 只把完整消息发给模型；开场白标记为 greeting 的也发（让模型接着自己刚说的话演）
    const history = messages.value
      .filter((m) => m.status !== 'streaming' && m.text.trim())
      .map((m) => ({ role: m.role, content: m.text }))

    const msgs = [{ role: 'system', content: buildSystemPrompt(props.character) }, ...history]

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
    // 一个字都没吐出来就失败了，把那条空白气泡删掉，免得留着占地方
    if (!reply.text) messages.value = messages.value.filter((m) => m !== reply)
  } finally {
    if (body) {
      // 有内容才算一条完整回复，进历史
      reply.status = 'complete'
      await saveMessage(reply).catch(() => {})
    } else if (reply.text) {
      // 吐了一半被中断，留半句话在界面上，但不写库
      reply.status = 'aborted'
    }
    // 完全没内容：既不显示也不入库
    busy.value = false
    controller = null
    scrollToBottom()
  }
}

function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    send()
  }
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
      <span class="note role">{{ character.backstory ? '人设加载好' : '没写人设，随便聊' }}</span>
    </header>

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
        <div class="bubble" :class="m.role">
          <span v-if="m.role === 'assistant'" class="tape mini"></span>
          <p class="text">{{ m.text }}<span v-if="m.status === 'streaming'" class="caret">▍</span></p>
          <span v-if="m.system === 'greeting'" class="hand tag">开场</span>
        </div>
      </div>

      <p v-if="errorText" class="error hand">{{ errorText }}</p>
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
.role {
  margin-left: auto;
  font-size: 12px;
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
