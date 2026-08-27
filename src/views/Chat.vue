<script setup>
import { ref, nextTick, computed } from 'vue'
import { settings, isConfigured } from '../lib/settings.js'
import { streamChat } from '../lib/client.js'

const emit = defineEmits(['need-settings'])

// Phase 0：消息先放内存里，刷新会丢。Phase 1 接上 IndexedDB 就持久了。
const messages = ref([])
const draft = ref('')
const busy = ref(false)
const errorText = ref('')
const listEl = ref(null)
let controller = null

const ready = computed(() => isConfigured())

function scrollToBottom() {
  nextTick(() => {
    const el = listEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

// 卡片歪多少度由 id 决定，这样同一条消息每次渲染角度一致，不会跳来跳去
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
  if (!ready.value) {
    emit('need-settings')
    return
  }

  errorText.value = ''
  messages.value.push({ id: Date.now(), role: 'user', text })
  draft.value = ''

  const reply = { id: Date.now() + 1, role: 'assistant', text: '', streaming: true }
  messages.value.push(reply)
  scrollToBottom()

  busy.value = true
  controller = new AbortController()

  try {
    const payload = messages.value
      .filter((m) => !m.streaming)
      .slice(-settings.historyWindow)
      .map((m) => ({ role: m.role, content: m.text }))

    for await (const piece of streamChat({
      endpoint: settings.endpoint,
      apiKey: settings.apiKey,
      model: settings.model,
      messages: payload,
      maxTokens: settings.maxTokens,
      signal: controller.signal
    })) {
      reply.text += piece
      scrollToBottom()
    }
  } catch (err) {
    errorText.value = String(err.message || err)
    // 一个字都没吐出来就失败了，那条空白气泡留着没意义
    if (!reply.text) messages.value = messages.value.filter((m) => m !== reply)
  } finally {
    reply.streaming = false
    busy.value = false
    controller = null
    scrollToBottom()
  }
}

function onKeydown(e) {
  // 回车发送，Shift+回车换行。中文输入法选字时的回车不算（isComposing）
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    send()
  }
}
</script>

<template>
  <div class="chat">
    <div ref="listEl" class="list">
      <div v-if="!messages.length" class="empty">
        <div class="empty-card paper-card">
          <span class="tape green"></span>
          <p class="hand big">还是空白的一页</p>
          <p class="note" v-if="ready">写点什么吧，随便聊聊也行。</p>
          <p class="note" v-else>先去<b>设置</b>里填个 API Key，不然它张不了嘴。</p>
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
          <p class="text">{{ m.text }}<span v-if="m.streaming" class="caret">▍</span></p>
        </div>
      </div>

      <p v-if="errorText" class="error hand">{{ errorText }}</p>
    </div>

    <div class="composer">
      <textarea
        v-model="draft"
        class="input"
        rows="1"
        placeholder="说点什么…"
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
  max-width: 300px;
}
.empty-card .big {
  font-size: 20px;
  margin: 6px 0 8px;
  color: var(--ink-soft);
}

.row {
  display: flex;
  max-width: 100%;
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

/* 自己说的话：黄便签，右下角有点翘起 */
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

/* 它说的话：白纸条，左上角贴了截胶带 */
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
  field-sizing: content; /* 支持的浏览器里输入框会跟着内容长高 */
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
